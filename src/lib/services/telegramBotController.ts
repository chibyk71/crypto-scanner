// src/lib/services/telegramBotController.ts

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/settings';
import { dbService } from '../db';
import { createLogger } from '../logger';
import { ExchangeService } from './exchange';
import { MLService } from './mlService';
import { Condition } from '../../types';

const logger = createLogger('TelegramBot');

/**
 * State interface for managing multi-step alert creation and editing workflows.
 * - Tracks the mode, step, and data for alert configuration.
 * - Includes pagination for symbol, alert, position, and trade selection.
 */
interface AlertState {
    mode: 'create' | 'edit' | 'delete' | 'alerts' | 'positions' | 'trades';
    step: 'select_symbol' | 'select_timeframe' | 'conditions_menu' | 'select_indicator' | 'enter_period' | 'select_operator' | 'select_target' | 'edit_menu' | 'select_alert' | 'delete_alert' | 'view_alerts' | 'view_positions' | 'view_trades' | '';
    data: {
        symbol: string;
        timeframe: string;
        conditions: Condition[];
    };
    temp?: Partial<Condition>;
    alertId?: string;
    page?: number;
    lastActivity: number;
}

/**
 * Timeout for clearing stale user states (30 minutes).
 */
const STATE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Page size for pagination (alerts, positions, trades).
 */
const PAGE_SIZE = 5;

/**
 * Manages the Telegram bot's interactive command interface.
 * - Operates in polling mode to listen for user commands and messages.
 * - Supports alert creation/editing/deletion, trading mode switching, ML training control, and performance monitoring.
 * - Integrates with ExchangeService for market data and MLService for model interactions.
 */
export class TelegramBotController {
    private bot: TelegramBot;
    private readonly authorizedChatId: string;
    private readonly exchange: ExchangeService;
    private readonly mlService: MLService;
    private userStates: Map<number, AlertState> = new Map();
    private cleanupInterval: NodeJS.Timeout | null = null;

    /**
     * Initializes the Telegram bot in polling mode.
     * - Validates configuration and sets up command listeners.
     * @param exchange - ExchangeService instance for market data and trading.
     * @param mlService - MLService instance for model training and predictions.
     * @throws {Error} If Telegram token or chat ID is missing.
     */
    constructor(exchange: ExchangeService, mlService: MLService) {
        if (!config.telegram.token) {
            throw new Error('Telegram Bot token is missing in config');
        }
        if (!config.telegram.chatId) {
            throw new Error('Telegram chatId (Authorized Chat ID) is missing in config');
        }

        this.authorizedChatId = config.telegram.chatId;
        this.exchange = exchange;
        this.mlService = mlService;

        this.bot = new TelegramBot(config.telegram.token, {
            polling: {
                interval: 300,
                params: { timeout: 30 },
            },
        });
        logger.info('Telegram Bot initialized and started polling for commands with optimized settings.');

        this.registerListeners();
        this.startStateCleanup();
    }

    /**
     * Sets up webhook mode for production/high-traffic use.
     * - Stops polling and configures the bot to receive updates via webhook.
     * @param webhookUrl - Public HTTPS URL for the webhook.
     * @throws {Error} If webhook setup fails.
     */
    public async setupWebhook(webhookUrl: string): Promise<void> {
        try {
            await this.bot.setWebHook(webhookUrl);
            this.bot.stopPolling();
            logger.info(`Webhook set up at ${webhookUrl}. Polling stopped.`);
        } catch (error) {
            logger.error('Failed to set up webhook', { error });
            throw error;
        }
    }

    /**
     * Registers all command handlers and event listeners for the bot.
     * - Includes commands for alerts, status, mode switching, ML training, and trade monitoring.
     * @private
     */
    private registerListeners(): void {
        this.bot.onText(/\/start|\/help/, this.handleHelp);
        this.bot.onText(/\/status/, this.handleStatus);
        this.bot.onText(/\/alerts/, this.handleAlerts);
        this.bot.onText(/\/create_alert/, this.handleCreateAlertStart);
        this.bot.onText(/\/edit_alert/, this.handleEditAlertStart);
        this.bot.onText(/\/delete_alert/, this.handleDeleteAlertStart);
        this.bot.onText(/\/ml_status/, this.handleMLStatus);
        this.bot.onText(/\/ml_pause/, this.handleMLPause);
        this.bot.onText(/\/ml_resume/, this.handleMLResume);
        this.bot.onText(/\/ml_train/, this.handleMLForceTrain);
        this.bot.onText(/\/ml_samples/, this.handleMLSamples);
        this.bot.onText(/\/ml_performance/, this.handleMLPerformance);
        this.bot.onText(/\/positions/, this.handlePositions);
        this.bot.onText(/\/trades/, this.handleTrades);

        this.bot.on('message', this.handleMessage);
        this.bot.on('callback_query', this.handleCallbackQuery);
    }

    /**
     * Checks if a message or query comes from the authorized chat.
     * @param chatId - Chat ID to verify.
     * @returns {boolean} True if authorized, false otherwise.
     * @private
     */
    private isAuthorized(chatId: number): boolean {
        const isAuthorized = String(chatId) === this.authorizedChatId;
        if (!isAuthorized) {
            logger.warn('Unauthorized access attempt', { chatId });
        }
        return isAuthorized;
    }

    /**
     * Handles all incoming messages, including stateful input for alert creation/editing.
     * - Processes period and target inputs for alert conditions.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleMessage = async (msg: TelegramBot.Message): Promise<void> => {
        const chatId = msg.chat.id;
        if (!this.isAuthorized(chatId)) {
            await this.bot.sendMessage(chatId, 'Unauthorized access. This bot only responds to messages from its configured primary chat ID.');
            return;
        }

        const state = this.userStates.get(chatId);
        if (!state || !msg.text) return;

        const text = msg.text.trim();

        // Handle period input for indicators
        if (state.step === 'enter_period') {
            const period = parseInt(text, 10);
            if (isNaN(period) || period <= 0 || period > 500) {
                await this.bot.sendMessage(chatId, 'Invalid input. Please enter a positive whole number for the period (1-500, e.g., 14).');
                return;
            }
            if (state.temp) state.temp.period = period;
            state.step = 'select_operator';
            this.updateUserState(chatId, state);
            await this.sendOperatorSelection(chatId, state.temp?.indicator as Condition['indicator']);
            return;
        }

        // Handle target input (number, range, or indicator)
        if (state.step === 'select_target') {
            try {
                let target: number | string | number[];
                if (state.temp?.operator === 'is_in_range') {
                    const parts = text.split('-').map(p => parseFloat(p.trim()));
                    if (parts.length !== 2 || parts.some(isNaN) || parts[0] >= parts[1]) {
                        throw new Error('Invalid range');
                    }
                    target = parts as number[];
                } else if (['crosses_above', 'crosses_below'].includes(state.temp?.operator || '')) {
                    const validIndicators = ['close', 'high', 'low', 'volume', 'rsi', 'ema', 'sma', 'macd_line', 'macd_signal', 'bb_upper', 'bb_lower'];
                    if (validIndicators.includes(text) || text.match(/^(ema|sma)_[0-9]+$/)) {
                        target = text;
                    } else {
                        const num = parseFloat(text);
                        if (isNaN(num)) throw new Error('Invalid number or indicator');
                        target = num;
                    }
                } else {
                    const num = parseFloat(text);
                    if (isNaN(num)) throw new Error('Invalid number');
                    target = num;
                }

                if (state.temp) {
                    state.temp.target = target;
                    state.data.conditions.push(state.temp as Condition);
                }
                delete state.temp;
                state.step = 'conditions_menu';
                this.updateUserState(chatId, state);
                await this.sendConditionsMenu(chatId, state.data);
            } catch (error) {
                await this.bot.sendMessage(chatId, 'Invalid input. Please enter a number, range (min-max, e.g., 20-80), or indicator (e.g., ema_200).');
            }
        }
    }

    /**
     * Handles callback queries from inline keyboards.
     * - Processes selections for symbols, timeframes, indicators, operators, and alert actions.
     * @param query - Incoming callback query from Telegram.
     * @private
     */
    private handleCallbackQuery = async (query: TelegramBot.CallbackQuery): Promise<void> => {
        const chatId = query.message?.chat.id ?? query.from.id;
        if (!this.isAuthorized(chatId)) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const data = query.data;
        if (!data) {
            await this.bot.answerCallbackQuery(query.id);
            return;
        }

        const state: AlertState = this.userStates.get(chatId) || {
            mode: 'create',
            step: '',
            data: { symbol: '', timeframe: '', conditions: [] },
            page: 0,
            lastActivity: Date.now(),
        };
        this.updateUserState(chatId, state);

        try {
            if (data.startsWith('alert_select_symbol:')) {
                state.data.symbol = data.split(':')[1];
                state.step = 'select_timeframe';
                await this.sendTimeframeSelection(chatId);
            } else if (data.startsWith('alert_next_symbols:')) {
                state.page = parseInt(data.split(':')[1], 10);
                await this.sendSymbolSelection(chatId, state.page);
            } else if (data.startsWith('alert_select_timeframe:')) {
                state.data.timeframe = data.split(':')[1];
                state.step = 'conditions_menu';
                await this.sendConditionsMenu(chatId, state.data);
            } else if (data === 'alert_add_condition') {
                state.step = 'select_indicator';
                await this.sendIndicatorSelection(chatId);
            } else if (data.startsWith('alert_select_indicator:')) {
                const indicator = data.split(':')[1] as Condition['indicator'];
                state.temp = { indicator };
                const indicatorTypes = ['rsi', 'ema', 'sma', 'macd_line', 'macd_signal', 'bb_upper', 'bb_lower'];
                if (indicatorTypes.includes(indicator)) {
                    state.step = 'enter_period';
                    await this.bot.sendMessage(chatId, `Enter the **Period** for ${indicator.toUpperCase()} (e.g., 14, 20):`, { parse_mode: 'Markdown' });
                } else {
                    state.step = 'select_operator';
                    await this.sendOperatorSelection(chatId, indicator);
                }
            } else if (data.startsWith('alert_select_operator:')) {
                const operator = data.split(':')[1] as Condition['operator'];
                if (state.temp) state.temp.operator = operator;
                state.step = 'select_target';
                const indicatorName = state.temp?.indicator?.toUpperCase() || 'Value';
                let prompt = '';
                if (operator === 'is_in_range') {
                    prompt = `Enter range for ${indicatorName} as MIN-MAX (e.g., 20-80):`;
                } else if (['crosses_above', 'crosses_below'].includes(operator)) {
                    prompt = `Enter target for ${indicatorName} (number or indicator, e.g., 10000 or ema_200):`;
                } else {
                    prompt = `Enter trigger value for ${indicatorName} (e.g., 70):`;
                }
                await this.bot.sendMessage(chatId, prompt);
            } else if (data === 'alert_remove_last') {
                state.data.conditions.pop();
                await this.sendConditionsMenu(chatId, state.data);
            } else if (data === 'alert_save') {
                if (state.data.symbol === '' || state.data.timeframe === '' || state.data.conditions.length === 0) {
                    await this.bot.sendMessage(chatId, 'Incomplete alert configuration. Please ensure symbol, timeframe, and at least one condition are set.');
                    return;
                }
                if (state.mode === 'create') {
                    const newAlert = await dbService.createAlert({
                        symbol: state.data.symbol,
                        timeframe: state.data.timeframe,
                        conditions: state.data.conditions,
                        status: 'active',
                    });
                    await this.bot.sendMessage(chatId, `Alert created with ID: ${newAlert}`);
                } else if (state.mode === 'edit' && state.alertId) {
                    await dbService.updateAlert(Number(state.alertId), state.data);
                    await this.bot.sendMessage(chatId, `Alert ${state.alertId} updated.`);
                }
                this.userStates.delete(chatId);
            } else if (data === 'alert_cancel') {
                this.userStates.delete(chatId);
                await this.bot.sendMessage(chatId, 'Operation cancelled.');
            } else if (data.startsWith('alert_edit_select:')) {
                const alertId = data.split(':')[1];
                const alert = await dbService.getAlertsById(Number(alertId));
                if (alert) {
                    state.mode = 'edit';
                    state.alertId = alertId;
                    state.data = {
                        symbol: alert.symbol,
                        timeframe: alert.timeframe,
                        conditions: alert.conditions,
                    };
                    state.step = 'edit_menu';
                    await this.sendEditMenu(chatId);
                } else {
                    await this.bot.sendMessage(chatId, `Alert ${alertId} not found.`);
                }
            } else if (data.startsWith('alert_delete_confirm:')) {
                const alertId = data.split(':')[1];
                await this.bot.sendMessage(chatId, `Confirm delete alert ${alertId}?`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Yes', callback_data: `alert_delete_yes:${alertId}` }],
                            [{ text: 'No', callback_data: 'alert_cancel' }],
                        ],
                    },
                });
            } else if (data.startsWith('alert_delete_yes:')) {
                const alertId = data.split(':')[1];
                await dbService.deleteAlert(Number(alertId));
                await this.bot.sendMessage(chatId, `Alert ${alertId} deleted.`);
                this.userStates.delete(chatId);
            } else if (data.startsWith('alerts_page:')) {
                state.page = parseInt(data.split(':')[1], 10);
                await this.sendAlertsList(chatId, state.page);
            } else if (data.startsWith('edit_alerts_page:')) {
                state.page = parseInt(data.split(':')[1], 10);
                await this.sendEditAlertSelection(chatId, state.page);
            } else if (data.startsWith('delete_alerts_page:')) {
                state.page = parseInt(data.split(':')[1], 10);
                await this.sendDeleteAlertSelection(chatId, state.page);
            } else if (data.startsWith('positions_page:')) {
                state.page = parseInt(data.split(':')[1], 10);
                await this.sendPositionsList(chatId, state.page);
            } else if (data.startsWith('trades_page:')) {
                state.page = parseInt(data.split(':')[1], 10);
                await this.sendTradesList(chatId, state.page);
            }

            await this.bot.answerCallbackQuery(query.id);
        } catch (error) {
            logger.error('Error handling callback query', { error });
            await this.bot.answerCallbackQuery(query.id, { text: 'An error occurred.' });
            this.userStates.delete(chatId);
            await this.bot.sendMessage(chatId, '❌ An unexpected error occurred. Operation cancelled.');
        }
    }

    /**
     * Sends symbol selection keyboard with pagination.
     * - Displays supported symbols from ExchangeService.
     * @param chatId - Telegram chat ID.
     * @param page - Current page number for pagination.
     * @private
     */
    private async sendSymbolSelection(chatId: number, page: number = 0): Promise<void> {
        const symbols = Array.from(this.exchange.getSupportedSymbols());
        if (symbols.length === 0) {
            await this.bot.sendMessage(chatId, '❌ No supported symbols available. Please ensure exchange is initialized.');
            return;
        }
        const start = page * PAGE_SIZE;
        const pageSymbols = symbols.slice(start, start + PAGE_SIZE);

        const inlineKeyboard = pageSymbols.map(symbol => [{ text: symbol, callback_data: `alert_select_symbol:${symbol}` }]);
        if (start + PAGE_SIZE < symbols.length) {
            inlineKeyboard.push([{ text: 'Next Page', callback_data: `alert_next_symbols:${page + 1}` }]);
        }
        if (page > 0) {
            inlineKeyboard.push([{ text: 'Previous Page', callback_data: `alert_next_symbols:${page - 1}` }]);
        }

        await this.bot.sendMessage(chatId, `Step 1: Choose a Symbol (Page ${page + 1}):`, {
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
    }

    /**
     * Sends timeframe selection keyboard.
     * @param chatId - Telegram chat ID.
     * @private
     */
    private async sendTimeframeSelection(chatId: number): Promise<void> {
        const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
        const inlineKeyboard = timeframes.map(tf => [{ text: tf, callback_data: `alert_select_timeframe:${tf}` }]);

        await this.bot.sendMessage(chatId, 'Step 2: Choose a Timeframe:', {
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
    }

    /**
     * Sends indicator selection keyboard for alert conditions.
     * @param chatId - Telegram chat ID.
     * @private
     */
    private async sendIndicatorSelection(chatId: number): Promise<void> {
        const indicators = ['close', 'high', 'low', 'volume', 'rsi', 'ema', 'sma', 'macd_line', 'macd_signal', 'bb_upper', 'bb_lower'];
        const inlineKeyboard = indicators.map(ind => [{ text: ind.toUpperCase(), callback_data: `alert_select_indicator:${ind}` }]);

        await this.bot.sendMessage(chatId, 'Choose Indicator:', {
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
    }

    /**
     * Sends operator selection keyboard based on the selected indicator.
     * @param chatId - Telegram chat ID.
     * @param indicator - Selected indicator for the condition.
     * @private
     */
    private async sendOperatorSelection(chatId: number, indicator: Condition['indicator']): Promise<void> {
        const operators: Condition['operator'][] = ['crosses_above', 'crosses_below', '>', '<', '>=', '<=', 'is_equal', 'is_not_equal', 'is_in_range'];
        const inlineKeyboard = operators.map(op => [{ text: op, callback_data: `alert_select_operator:${op}` }]);

        await this.bot.sendMessage(chatId, `Choose Operator for ${indicator.toUpperCase()}:`, {
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
    }

    /**
     * Sends conditions menu with current alert settings and actions.
     * @param chatId - Telegram chat ID.
     * @param data - Current alert data (symbol, timeframe, conditions).
     * @private
     */
    private async sendConditionsMenu(chatId: number, data: AlertState['data']): Promise<void> {
        const conditionsText = data.conditions.length
            ? data.conditions
                  .map(c => {
                      const period = c.period ? `(${c.period})` : '';
                      const target = Array.isArray(c.target) ? c.target.join('-') : c.target;
                      return `  - ${c.indicator.toUpperCase()}${period} ${c.operator} ${target || '(No Target)'}`;
                  })
                  .join('\n')
            : 'None';

        const message = `*Current Alert Settings:*\n*Symbol*: ${data.symbol} (${data.timeframe})\n\n*Conditions:*\n\`\`\`\n${conditionsText}\n\`\`\`\n\n*Actions:*`;

        const inlineKeyboard = [[{ text: '➕ Add Condition', callback_data: 'alert_add_condition' }]];
        if (data.conditions.length > 0) {
            inlineKeyboard.push([{ text: '➖ Remove Last Condition', callback_data: 'alert_remove_last' }]);
            inlineKeyboard.push([{ text: '✅ Save Alert', callback_data: 'alert_save' }]);
        }
        inlineKeyboard.push([{ text: '❌ Cancel', callback_data: 'alert_cancel' }]);

        await this.bot.sendMessage(chatId, message, {
            reply_markup: { inline_keyboard: inlineKeyboard },
            parse_mode: 'Markdown',
        });
    }

    /**
     * Sends edit menu for modifying an existing alert.
     * @param chatId - Telegram chat ID.
     * @private
     */
    private async sendEditMenu(chatId: number): Promise<void> {
        const inlineKeyboard = [
            [{ text: 'Edit Symbol', callback_data: 'alert_edit_symbol' }],
            [{ text: 'Edit Timeframe', callback_data: 'alert_edit_timeframe' }],
            [{ text: 'Edit Conditions', callback_data: 'alert_edit_conditions' }],
            [{ text: 'Save', callback_data: 'alert_save' }],
            [{ text: 'Cancel', callback_data: 'alert_cancel' }],
        ];

        await this.bot.sendMessage(chatId, 'Edit Alert:', {
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
    }

    /**
     * Sends paginated list of active alerts.
     * @param chatId - Telegram chat ID.
     * @param page - Current page number.
     * @private
     */
    private async sendAlertsList(chatId: number, page: number = 0): Promise<void> {
        try {
            const allAlerts = await dbService.getActiveAlerts();
            if (!allAlerts.length) {
                await this.bot.sendMessage(chatId, 'No custom alerts are currently active. Use `/create_alert` to add one.');
                return;
            }

            const start = page * PAGE_SIZE;
            const pageAlerts = allAlerts.slice(start, start + PAGE_SIZE);
            const alertSummaries = pageAlerts.map((alert: any) => {
                const conditions = alert.conditions.map((c: any) => {
                    const period = c.period ? `(${c.period})` : '';
                    const target = Array.isArray(c.target) ? c.target.join('-') : c.target;
                    return `${c.indicator.toUpperCase()}${period} ${c.operator} ${target}`;
                }).join(' & ');
                const lastTriggered = alert.lastAlertAt ? new Date(alert.lastAlertAt).toLocaleString() : 'Never';
                return `**ID: ${alert.id}** (${alert.timeframe}) - ${alert.symbol}\n  Conditions: ${conditions}\n  Last Trigger: ${lastTriggered}`;
            });

            const inlineKeyboard = [];
            if (start + PAGE_SIZE < allAlerts.length) {
                inlineKeyboard.push([{ text: 'Next Page', callback_data: `alerts_page:${page + 1}` }]);
            }
            if (page > 0) {
                inlineKeyboard.push([{ text: 'Previous Page', callback_data: `alerts_page:${page - 1}` }]);
            }

            const response = [`**Active Custom Alerts (Page ${page + 1})** 🔔:`, ...alertSummaries].join('\n\n');
            await this.bot.sendMessage(chatId, response, {
                reply_markup: { inline_keyboard: inlineKeyboard },
                parse_mode: 'Markdown',
            });
        } catch (error) {
            logger.error('Error listing alerts', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to retrieve alerts. Database error.');
        }
    }

    /**
     * Sends paginated list of alerts for editing.
     * @param chatId - Telegram chat ID.
     * @param page - Current page number.
     * @private
     */
    private async sendEditAlertSelection(chatId: number, page: number = 0): Promise<void> {
        try {
            const alerts = await dbService.getActiveAlerts();
            if (!alerts.length) {
                await this.bot.sendMessage(chatId, 'No active alerts to edit.');
                return;
            }

            const start = page * PAGE_SIZE;
            const pageAlerts = alerts.slice(start, start + PAGE_SIZE);
            const inlineKeyboard = pageAlerts.map(alert => [
                { text: `${alert.id} - ${alert.symbol} (${alert.timeframe})`, callback_data: `alert_edit_select:${alert.id}` },
            ]);

            if (start + PAGE_SIZE < alerts.length) {
                inlineKeyboard.push([{ text: 'Next Page', callback_data: `edit_alerts_page:${page + 1}` }]);
            }
            if (page > 0) {
                inlineKeyboard.push([{ text: 'Previous Page', callback_data: `edit_alerts_page:${page - 1}` }]);
            }

            await this.bot.sendMessage(chatId, `Select Alert to Edit (Page ${page + 1}):`, {
                reply_markup: { inline_keyboard: inlineKeyboard },
            });
        } catch (error) {
            logger.error('Error listing alerts for edit', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to start alert edit.');
        }
    }

    /**
     * Sends paginated list of alerts for deletion.
     * @param chatId - Telegram chat ID.
     * @param page - Current page number.
     * @private
     */
    private async sendDeleteAlertSelection(chatId: number, page: number = 0): Promise<void> {
        try {
            const alerts = await dbService.getActiveAlerts();
            if (!alerts.length) {
                await this.bot.sendMessage(chatId, 'No active alerts to delete.');
                return;
            }

            const start = page * PAGE_SIZE;
            const pageAlerts = alerts.slice(start, start + PAGE_SIZE);
            const inlineKeyboard = pageAlerts.map(alert => [
                { text: `${alert.id} - ${alert.symbol} (${alert.timeframe})`, callback_data: `alert_delete_confirm:${alert.id}` },
            ]);

            if (start + PAGE_SIZE < alerts.length) {
                inlineKeyboard.push([{ text: 'Next Page', callback_data: `delete_alerts_page:${page + 1}` }]);
            }
            if (page > 0) {
                inlineKeyboard.push([{ text: 'Previous Page', callback_data: `delete_alerts_page:${page - 1}` }]);
            }

            await this.bot.sendMessage(chatId, `Select Alert to Delete (Page ${page + 1}):`, {
                reply_markup: { inline_keyboard: inlineKeyboard },
            });
        } catch (error) {
            logger.error('Error listing alerts for delete', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to start alert delete.');
        }
    }

    /**
     * Sends paginated list of open positions.
     * @param chatId - Telegram chat ID.
     * @param page - Current page number.
     * @private
     */
    private async sendPositionsList(chatId: number, page: number = 0): Promise<void> {
        try {
            const symbols = this.exchange.getSupportedSymbols();
            if (symbols.length === 0) {
                await this.bot.sendMessage(chatId, '❌ No supported symbols available.');
                return;
            }

            const allPositions: { symbol: string; position: any }[] = [];
            for (const symbol of symbols) {
                const positions = await this.exchange.getPositions(symbol);
                positions.forEach(p => allPositions.push({ symbol, position: p }));
            }

            if (allPositions.length === 0) {
                await this.bot.sendMessage(chatId, 'No open positions.');
                return;
            }

            const start = page * PAGE_SIZE;
            const pagePositions = allPositions.slice(start, start + PAGE_SIZE);
            const positionSummaries = pagePositions.map(({ symbol, position }) => {
                const side = position.side === 'long' ? 'Buy' : 'Sell';
                const contracts = position.contracts ?? 0;
                const entryPrice = position.entryPrice ?? 'N/A';
                const unrealizedPnl = position.unrealizedPnl ?? 0;
                return `**${symbol}** (${side})\n  Contracts: ${contracts}\n  Entry Price: ${entryPrice}\n  Unrealized PnL: ${unrealizedPnl.toFixed(2)} USDT`;
            });

            const inlineKeyboard = [];
            if (start + PAGE_SIZE < allPositions.length) {
                inlineKeyboard.push([{ text: 'Next Page', callback_data: `positions_page:${page + 1}` }]);
            }
            if (page > 0) {
                inlineKeyboard.push([{ text: 'Previous Page', callback_data: `positions_page:${page - 1}` }]);
            }

            const response = [`**Open Positions (Page ${page + 1})** 📈:`, ...positionSummaries].join('\n\n');
            await this.bot.sendMessage(chatId, response, {
                reply_markup: { inline_keyboard: inlineKeyboard },
                parse_mode: 'Markdown',
            });
        } catch (error) {
            logger.error('Error fetching positions', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to fetch positions. Exchange error.');
        }
    }

    /**
     * Sends paginated list of recent closed trades.
     * @param chatId - Telegram chat ID.
     * @param page - Current page number.
     * @private
     */
    private async sendTradesList(chatId: number, page: number = 0): Promise<void> {
        try {
            const symbols = this.exchange.getSupportedSymbols();
            if (symbols.length === 0) {
                await this.bot.sendMessage(chatId, '❌ No supported symbols available.');
                return;
            }

            const since = Date.now() - 24 * 60 * 60 * 1000; // Last 24 hours
            const allTrades: { symbol: string; trade: any }[] = [];
            for (const symbol of symbols) {
                const trades = await this.exchange.getClosedTrades(symbol, since);
                trades.forEach(t => allTrades.push({ symbol, trade: t }));
            }

            if (allTrades.length === 0) {
                await this.bot.sendMessage(chatId, 'No recent closed trades.');
                return;
            }

            const start = page * PAGE_SIZE;
            const pageTrades = allTrades.slice(start, start + PAGE_SIZE);
            const tradeSummaries = pageTrades.map(({ symbol, trade }) => {
                const side = trade.side === 'buy' ? 'Buy' : 'Sell';
                const amount = trade.amount ?? 0;
                const price = trade.price ?? 'N/A';
                const profit = trade.info?.realized_pnl ?? 0;
                const timestamp = trade.datetime ? new Date(trade.datetime).toLocaleString() : 'N/A';
                return `**${symbol}** (${side})\n  Amount: ${amount}\n  Price: ${price}\n  Profit: ${profit.toFixed(2)} USDT\n  Time: ${timestamp}`;
            });

            const inlineKeyboard = [];
            if (start + PAGE_SIZE < allTrades.length) {
                inlineKeyboard.push([{ text: 'Next Page', callback_data: `trades_page:${page + 1}` }]);
            }
            if (page > 0) {
                inlineKeyboard.push([{ text: 'Previous Page', callback_data: `trades_page:${page - 1}` }]);
            }

            const response = [`**Recent Closed Trades (Last 24 Hours, Page ${page + 1})** 📉:`, ...tradeSummaries].join('\n\n');
            await this.bot.sendMessage(chatId, response, {
                reply_markup: { inline_keyboard: inlineKeyboard },
                parse_mode: 'Markdown',
            });
        } catch (error) {
            logger.error('Error fetching trades', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to fetch trades. Exchange error.');
        }
    }

    /**
     * Handles the /start and /help commands.
     * - Displays available commands and their descriptions.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleHelp = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;
        const helpText = '🤖 *Market Scanner Bot Commands*:\n\n' +
            '• `/start` - Display this help message.\n' +
            '• `/help` - Display this help message.\n' +
            '• `/status` - Check worker health, lock status, and exchange connection.\n' +
            '• `/alerts` - List all active custom alerts with pagination.\n' +
            '• `/create_alert` - Create a new custom alert with step-by-step configuration.\n' +
            '• `/edit_alert` - Edit an existing alert (symbol, timeframe, conditions).\n' +
            '• `/delete_alert` - Delete an existing alert with confirmation.\n' +
            '• `/mode` - Switch between testnet and live trading modes.\n' +
            '• `/ml_status` - Check ML model training status and sample count.\n' +
            '• `/ml_pause` - Pause ML model training.\n' +
            '• `/ml_resume` - Resume ML model training.\n' +
            '• `/ml_train` - Force immediate ML model training.\n' +
            '• `/ml_samples` - View summary of training samples by symbol.\n' +
            '• `/ml_performance` - View trading performance metrics.\n' +
            '• `/positions` - List open trading positions with pagination.\n' +
            '• `/trades` - List recent closed trades (last 24 hours) with pagination.\n';

        await this.bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    }

    /**
     * Handles the /status command.
     * - Reports worker status, lock state, heartbeat, exchange connection, and trading mode.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleStatus = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            const lockStatus = await dbService.getLock();
            const heartbeat = await dbService.getHeartbeatCount();
            const balance = await this.exchange.getAccountBalance();

            const statusLines = [
                '**Worker Status Report** 📊',
                `\n*Operational Status*: ${lockStatus ? '🔴 RUNNING (LOCKED)' : '🟢 IDLE (UNLOCKED)'}`,
                `\n*Last Heartbeat*: ${heartbeat ? new Date(heartbeat).toLocaleString() : 'N/A'}`,
                `\n*Exchange Connection*: ${this.exchange.isInitialized() ? '✅ Connected' : '❌ Disconnected'}`,
                `\n*Account Balance*: ${balance?.toFixed(2)} USDT`,
            ];

            await this.bot.sendMessage(msg.chat.id, statusLines.join('\n'), { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('Error fetching status data', { error });
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to fetch worker status. Database or exchange error.');
        }
    }

    /**
     * Handles the /alerts command.
     * - Initiates paginated alert listing.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleAlerts = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;
        this.updateUserState(msg.chat.id, { mode: 'alerts', step: 'view_alerts', page: 0 });
        await this.sendAlertsList(msg.chat.id, 0);
    }

    /**
     * Handles the /create_alert command.
     * - Initiates the alert creation workflow by prompting for symbol selection.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleCreateAlertStart = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            const symbols = Array.from(this.exchange.getSupportedSymbols());
            if (symbols.length === 0) {
                await this.bot.sendMessage(msg.chat.id, '❌ Exchange is not initialized or has no supported symbols.');
                return;
            }

            const chatId = msg.chat.id;
            this.updateUserState(chatId, {
                mode: 'create',
                step: 'select_symbol',
                data: { symbol: '', timeframe: '', conditions: [] },
                page: 0,
            });

            await this.sendSymbolSelection(chatId, 0);
        } catch (error) {
            logger.error('Error starting alert creation', { error });
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to start alert creation. Exchange error.');
        }
    }

    /**
     * Handles the /edit_alert command.
     * - Initiates paginated alert selection for editing.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleEditAlertStart = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;
        this.updateUserState(msg.chat.id, { mode: 'edit', step: 'select_alert', page: 0 });
        await this.sendEditAlertSelection(msg.chat.id, 0);
    }

    /**
     * Handles the /delete_alert command.
     * - Initiates paginated alert selection for deletion.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleDeleteAlertStart = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;
        this.updateUserState(msg.chat.id, { mode: 'delete', step: 'delete_alert', page: 0 });
        await this.sendDeleteAlertSelection(msg.chat.id, 0);
    }

    /**
     * Handles the /ml_status command.
     * - Displays the current ML training status.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleMLStatus = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            const status = await this.mlService.getTrainingStatus();
            await this.bot.sendMessage(msg.chat.id, `**ML Training Status** 🤖\n\n${status}`, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('Error fetching ML training status', { error });
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to fetch ML training status.');
        }
    }

    /**
     * Handles the /ml_pause command.
     * - Pauses ML model training.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleMLPause = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            this.mlService.pauseTraining();
            await this.bot.sendMessage(msg.chat.id, 'ML training paused.');
            logger.info('ML training paused', { user: msg.from?.username });
        } catch (error) {
            logger.error('Error pausing ML training', { error });
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to pause ML training.');
        }
    }

    /**
     * Handles the /ml_resume command.
     * - Resumes ML model training.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleMLResume = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            this.mlService.resumeTraining();
            await this.bot.sendMessage(msg.chat.id, 'ML training resumed.');
            logger.info('ML training resumed', { user: msg.from?.username });
        } catch (error) {
            logger.error('Error resuming ML training', { error });
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to resume ML training.');
        }
    }

    /**
     * Handles the /ml_train command.
     * - Forces immediate ML model training.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleMLForceTrain = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            await this.mlService.forceTrain();
            await this.bot.sendMessage(msg.chat.id, 'ML model training forced successfully.');
            logger.info('Forced ML model training', { user: msg.from?.username });
        } catch (error) {
            logger.error('Error forcing ML training', { error });
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to force ML training.');
        }
    }

    /**
     * Handles the /ml_samples command.
     * - Displays a summary of training samples by symbol.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleMLSamples = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            const summary = await this.mlService.getSampleSummary();
            await this.bot.sendMessage(msg.chat.id, `**Training Sample Summary** 📈\n\n${summary}`, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('Error fetching ML sample summary', { error });
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to fetch training sample summary.');
        }
    }

    /**
     * Handles the /ml_performance command.
     * - Displays trading performance metrics.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleMLPerformance = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            const metrics = await this.mlService.getPerformanceMetrics();
            await this.bot.sendMessage(msg.chat.id, `**Trading Performance Metrics** 📊\n\n${metrics}`, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('Error fetching ML performance metrics', { error });
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to fetch performance metrics.');
        }
    }

    /**
     * Handles the /positions command.
     * - Initiates paginated position listing.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handlePositions = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;
        this.updateUserState(msg.chat.id, { mode: 'positions', step: 'view_positions', page: 0 });
        await this.sendPositionsList(msg.chat.id, 0);
    }

    /**
     * Handles the /trades command.
     * - Initiates paginated trade listing.
     * @param msg - Incoming Telegram message.
     * @private
     */
    private handleTrades = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;
        this.updateUserState(msg.chat.id, { mode: 'trades', step: 'view_trades', page: 0 });
        await this.sendTradesList(msg.chat.id, 0);
    }

    /**
     * Updates the user state with new data and refreshes the last activity timestamp.
     * @param chatId - Telegram chat ID.
     * @param newState - Partial state to update.
     * @private
     */
    private updateUserState(chatId: number, newState: Partial<AlertState>): void {
        const currentState = this.userStates.get(chatId) || {
            mode: 'create',
            step: '',
            data: { symbol: '', timeframe: '', conditions: [] },
            page: 0,
            lastActivity: Date.now(),
        };

        this.userStates.set(chatId, {
            ...currentState,
            ...newState,
            lastActivity: Date.now(),
        });
    }

    /**
     * Starts periodic cleanup of stale user states.
     * - Removes states inactive for longer than STATE_TIMEOUT_MS.
     * @private
     */
    private startStateCleanup(): void {
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            let cleanedCount = 0;

            this.userStates.forEach((state, chatId) => {
                if (now - state.lastActivity > STATE_TIMEOUT_MS) {
                    this.userStates.delete(chatId);
                    cleanedCount++;
                    this.bot.sendMessage(chatId, '⌛ Your previous command session timed out due to inactivity. Please start a new command.');
                }
            });

            if (cleanedCount > 0) {
                logger.info(`State cleanup completed. Removed ${cleanedCount} expired states.`);
            }
        }, 5 * 60 * 1000);
    }

    /**
     * Stops the bot from polling and clears the cleanup interval.
     */
    public stop(): void {
        this.bot.stopPolling();
        logger.info('Telegram Bot stopped polling.');

        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            logger.info('State cleanup interval cleared.');
        }
    }

    /**
     * Sends a message to the authorized chat ID.
     * - Used for alerts and notifications.
     * @param message - Message to send.
     * @throws {Error} If sending the message fails.
     */
    public async sendMessage(message: string, options?: TelegramBot.SendMessageOptions): Promise<void> {
        try {
            await this.bot.sendMessage(this.authorizedChatId, message, options);
            logger.info('Message sent to Telegram', { message: message.substring(0, 50) });
        } catch (error) {
            logger.error('Failed to send Telegram message', { error });
            throw error;
        }
    }
}
