/**
 * TelegramBotController manages the interactive command interface for the Telegram Bot.
 * It operates in polling mode to listen for incoming user messages and commands,
 * supporting alert creation, editing, and deletion with multi-step workflows.
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/settings';
import { dbService } from '../db';
import { createLogger } from '../logger';
import { ExchangeService } from './exchange';
import { Condition } from '../../types';

const logger = createLogger('TelegramBot');

/**
 * State interface for managing multi-step alert creation and editing.
 */
interface AlertState {
    mode: 'create' | 'edit' | 'delete';
    step: 'select_symbol' | 'select_timeframe' | 'conditions_menu' | 'select_indicator' | 'enter_period' | 'select_operator' | 'select_target' | 'edit_menu' | '';
    data: {
        symbol: string;
        timeframe: string;
        conditions: Condition[];
    };
    temp?: Partial<Condition>;
    alertId?: string;
    symbolPage?: number;
    lastActivity: number;
}

// Clear state after 30 minutes of inactivity if a multi-step command is pending.
const STATE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Manages the interactive command interface for the Telegram Bot.
 * It operates in polling mode to listen for incoming user messages and commands.
 */
export class TelegramBotController {
    private bot: TelegramBot;
    private readonly authorizedChatId: string;
    private readonly exchange: ExchangeService;
    private userStates: Map<number, AlertState> = new Map();
    private cleanupInterval: NodeJS.Timeout | null = null;

    /**
     * Initializes the bot in polling mode and registers command listeners.
     * @param exchange - The ExchangeService instance to get symbols and data.
     */
    constructor(exchange: ExchangeService) {
        if (!config.telegram.token) {
            throw new Error('Telegram Bot token is missing in config');
        }
        if (!config.telegram.chatId) {
            throw new Error('Telegram chatId (Authorized Chat ID) is missing in config');
        }

        this.authorizedChatId = config.telegram.chatId;
        this.exchange = exchange;

        this.bot = new TelegramBot(config.telegram.token, {
            polling: {
                interval: 300,
                params: { timeout: 30 }
            }
        });
        logger.info('Telegram Bot initialized and started polling for commands with optimized settings.');

        this.registerListeners();
        this.startStateCleanup();
    }

    /**
     * Sets up webhook mode as an alternative to polling for production/high-traffic use.
     * @param webhookUrl - The public HTTPS URL for the webhook.
     */
    public async setupWebhook(webhookUrl: string): Promise<void> {
        try {
            await this.bot.setWebHook(webhookUrl);
            this.bot.stopPolling();
            logger.info(`Webhook set up at ${webhookUrl}. Polling stopped.`);
        } catch (error) {
            logger.error('Failed to set up webhook', { error });
        }
    }

    /**
     * Registers all command handlers and event listeners for the bot.
     */
    private registerListeners(): void {
        this.bot.onText(/\/start|\/help/, this.handleHelp);
        this.bot.onText(/\/status/, this.handleStatus);
        this.bot.onText(/\/alerts/, this.handleAlerts);
        this.bot.onText(/\/create_alert/, this.handleCreateAlertStart);
        this.bot.onText(/\/edit_alert/, this.handleEditAlertStart);
        this.bot.onText(/\/delete_alert/, this.handleDeleteAlertStart);

        this.bot.on('message', this.handleMessage);
        this.bot.on('callback_query', this.handleCallbackQuery);
    }

    /**
     * Helper to check if the message or query comes from the authorized chat.
     */
    private isAuthorized(chatId: number): boolean {
        return String(chatId) === this.authorizedChatId;
    }

    /**
     * Handles all incoming messages, including stateful input for alert creation/editing.
     */
    private handleMessage = async (msg: TelegramBot.Message): Promise<void> => {
        const chatId = msg.chat.id;
        if (!this.isAuthorized(chatId)) {
            await this.bot.sendMessage(chatId, 'Unauthorized access. This bot only responds to messages from its configured primary chat ID.');
            logger.warn('Unauthorized access attempt.', { chatId, username: msg.from?.username });
            return;
        }

        const state = this.userStates.get(chatId);
        if (!state || !msg.text) return;

        const text = msg.text.trim();

        // Handle period input for indicators
        if (state.step === 'enter_period') {
            const period = parseInt(text, 10);
            if (isNaN(period) || period <= 0 || period > 500) {
                await this.bot.sendMessage(chatId, 'Invalid input. Please enter a positive whole number for the period (e.g., 14).');
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
                    // Check if the input is a valid indicator or a number
                    const validIndicators = ['close', 'high', 'low', 'volume', 'rsi', 'ema', 'sma', 'macd_line', 'macd_signal', 'bb_upper', 'bb_lower'];
                    if (validIndicators.includes(text) || text.match(/^(ema|sma)_[0-9]+$/)) {
                        target = text; // Indicator reference (e.g., 'ema_200')
                    } else {
                        const num = parseFloat(text);
                        if (isNaN(num)) throw new Error('Invalid number or indicator');
                        target = num;
                    }
                } else {
                    // For >, <, >=, <=, is_equal, is_not_equal
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
     */
    private handleCallbackQuery = async (query: TelegramBot.CallbackQuery): Promise<void> => {
        const chatId = query.message?.chat.id ?? query.from.id;
        if (!this.isAuthorized(chatId)) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const data = query.data;
        if (!data) return;

        const state: AlertState = this.userStates.get(chatId) || {
            mode: 'create',
            step: '',
            data: { symbol: '', timeframe: '', conditions: [] },
            symbolPage: 0,
            temp: {},
            lastActivity: Date.now()
        };
        this.updateUserState(chatId, state);

        try {
            if (data.startsWith('alert_select_symbol:')) {
                state.data.symbol = data.split(':')[1];
                state.step = 'select_timeframe';
                await this.sendTimeframeSelection(chatId);
            } else if (data.startsWith('alert_next_symbols:')) {
                state.symbolPage = parseInt(data.split(':')[1], 10);
                await this.sendSymbolSelection(chatId, state.symbolPage);
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
                if (state.mode === 'create') {
                    const newAlert = await dbService.createAlert({
                        symbol: state.data.symbol,
                        timeframe: state.data.timeframe,
                        conditions: state.data.conditions,
                        status: 'active'
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
                        conditions: alert.conditions
                    };
                    state.step = 'edit_menu';
                    await this.sendEditMenu(chatId);
                }
            } else if (data === 'alert_edit_symbol') {
                state.step = 'select_symbol';
                await this.sendSymbolSelection(chatId, 0);
            } else if (data === 'alert_edit_timeframe') {
                state.step = 'select_timeframe';
                await this.sendTimeframeSelection(chatId);
            } else if (data === 'alert_edit_conditions') {
                state.step = 'conditions_menu';
                await this.sendConditionsMenu(chatId, state.data);
            } else if (data.startsWith('alert_delete_confirm:')) {
                const alertId = data.split(':')[1];
                await this.bot.sendMessage(chatId, `Confirm delete alert ${alertId}?`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Yes', callback_data: `alert_delete_yes:${alertId}` }],
                            [{ text: 'No', callback_data: 'alert_cancel' }]
                        ]
                    }
                });
            } else if (data.startsWith('alert_delete_yes:')) {
                const alertId = data.split(':')[1];
                await dbService.deleteAlert(Number(alertId));
                await this.bot.sendMessage(chatId, `Alert ${alertId} deleted.`);
                this.userStates.delete(chatId);
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
     * Sends symbol selection keyboard.
     */
    private async sendSymbolSelection(chatId: number, page: number = 0): Promise<void> {
        const symbols = Array.from(this.exchange.getSupportedSymbols());
        const pageSize = 6;
        const start = page * pageSize;
        const pageSymbols = symbols.slice(start, start + pageSize);

        const inlineKeyboard = pageSymbols.map(symbol => ([{ text: symbol, callback_data: `alert_select_symbol:${symbol}` }]));
        if (start + pageSize < symbols.length) {
            inlineKeyboard.push([{ text: 'Next Page', callback_data: `alert_next_symbols:${page + 1}` }]);
        }
        if (page > 0) {
            inlineKeyboard.push([{ text: 'Previous Page', callback_data: `alert_next_symbols:${page - 1}` }]);
        }

        await this.bot.sendMessage(chatId, 'Step 1: Choose a Symbol:', {
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
    }

    /**
     * Sends timeframe selection keyboard.
     */
    private async sendTimeframeSelection(chatId: number): Promise<void> {
        const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
        const inlineKeyboard = timeframes.map(tf => ([{ text: tf, callback_data: `alert_select_timeframe:${tf}` }]));

        await this.bot.sendMessage(chatId, 'Step 2: Choose a Timeframe:', {
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
    }

    /**
     * Sends indicator selection keyboard.
     */
    private async sendIndicatorSelection(chatId: number): Promise<void> {
        const indicators = ['close', 'high', 'low', 'volume', 'rsi', 'ema', 'sma', 'macd_line', 'macd_signal', 'bb_upper', 'bb_lower'];
        const inlineKeyboard = indicators.map(ind => ([{ text: ind.toUpperCase(), callback_data: `alert_select_indicator:${ind}` }]));

        await this.bot.sendMessage(chatId, 'Choose Indicator:', {
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
    }

    /**
     * Sends operator selection keyboard based on indicator.
     */
    private async sendOperatorSelection(chatId: number, indicator: Condition['indicator']): Promise<void> {
        const operators: Condition['operator'][] = ['crosses_above', 'crosses_below', '>', '<', '>=', '<=', 'is_equal', 'is_not_equal', 'is_in_range'];
        const inlineKeyboard = operators.map(op => ([{ text: op, callback_data: `alert_select_operator:${op}` }]));

        await this.bot.sendMessage(chatId, `Choose Operator for ${indicator.toUpperCase()}:`, {
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
    }

    /**
     * Sends conditions menu with current conditions and actions.
     */
    private async sendConditionsMenu(chatId: number, data: AlertState['data']): Promise<void> {
        const conditionsText = data.conditions.length
            ? data.conditions.map(c => {
                  const period = c.period ? `(${c.period})` : '';
                  const target = Array.isArray(c.target) ? c.target.join('-') : c.target;
                  return `  - ${c.indicator.toUpperCase()}${period} ${c.operator} ${target || '(No Target)'}`;
              }).join('\n')
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
            parse_mode: 'Markdown'
        });
    }

    /**
     * Sends edit menu for selected alert.
     */
    private async sendEditMenu(chatId: number): Promise<void> {
        const inlineKeyboard = [
            [{ text: 'Edit Symbol', callback_data: 'alert_edit_symbol' }],
            [{ text: 'Edit Timeframe', callback_data: 'alert_edit_timeframe' }],
            [{ text: 'Edit Conditions', callback_data: 'alert_edit_conditions' }],
            [{ text: 'Save', callback_data: 'alert_save' }],
            [{ text: 'Cancel', callback_data: 'alert_cancel' }]
        ];

        await this.bot.sendMessage(chatId, 'Edit Alert:', {
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
    }

    /**
     * Handles the /start and /help commands.
     */
    private handleHelp = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;
        const helpText = '🤖 *Market Scanner Bot Commands*:\n\n' +
            '• `/status` - Check the operational health and last heartbeat.\n' +
            '• `/alerts` - List all active custom alerts.\n' +
            '• `/create_alert` - Start the process to set up a new custom alert.\n' +
            '• `/edit_alert` - Edit an existing alert.\n' +
            '• `/delete_alert` - Delete an existing alert.\n' +
            '• `/help` - Show this message.';

        await this.bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    }

    /**
     * Handles the /status command. Checks the database lock and exchange status.
     */
    private handleStatus = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            const lockStatus = await dbService.getLock();
            const heartbeat = await dbService.getHeartbeatCount();

            const statusLines = [
                '**Worker Status Report** 📊',
                `\n*Operational Status*: ${lockStatus ? '🔴 RUNNING (LOCKED)' : '🟢 IDLE (UNLOCKED)'}`,
                `\n*Last Heartbeat*: ${heartbeat ? new Date(heartbeat).toLocaleString() : 'N/A'}`,
                `\n*Exchange Connection*: ${this.exchange.isInitialized() ? '✅ Connected' : '❌ Disconnected'}`
            ];

            await this.bot.sendMessage(msg.chat.id, statusLines.join('\n'), { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('Error fetching status data:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to fetch worker status. Database error.');
        }
    }

    /**
     * Handles the /alerts command. Lists all active custom alerts.
     */
    private handleAlerts = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;
        try {
            const allAlerts = await dbService.getActiveAlerts();

            if (!allAlerts.length) {
                await this.bot.sendMessage(msg.chat.id, 'No custom alerts are currently active. Use `/create_alert` to add one.');
                return;
            }

            const alertSummaries = allAlerts.slice(0, 10).map((alert: any) => {
                const conditions = alert.conditions.map((c: any) => {
                    const period = c.period ? `(${c.period})` : '';
                    const target = Array.isArray(c.target) ? c.target.join('-') : c.target;
                    return `${c.indicator.toUpperCase()}${period} ${c.operator} ${target}`;
                }).join(' & ');
                const lastTriggered = alert.lastAlertAt ? new Date(alert.lastAlertAt).toLocaleString() : 'Never';
                return `**ID: ${alert.id}** (${alert.timeframe}) - ${alert.symbol}\n  Conditions: ${conditions}\n  Last Trigger: ${lastTriggered}`;
            });

            const response = ['**Active Custom Alerts (Top 10)** 🔔:', ...alertSummaries].join('\n\n');
            await this.bot.sendMessage(msg.chat.id, response, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('Error listing alerts:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to retrieve alerts. Database error.');
        }
    }

    /**
     * Handles the initial step of the /create_alert command.
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
                symbolPage: 0
            });

            await this.sendSymbolSelection(chatId, 0);
        } catch (error) {
            logger.error('Error starting alert creation:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to start alert creation. Exchange error.');
        }
    }

    /**
     * Handles the initial step of the /edit_alert command.
     */
    private handleEditAlertStart = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            const alerts = await dbService.getActiveAlerts();
            if (!alerts.length) {
                await this.bot.sendMessage(msg.chat.id, 'No active alerts to edit.');
                return;
            }

            const inlineKeyboard = alerts.map(alert => ([{ text: `${alert.id} - ${alert.symbol} (${alert.timeframe})`, callback_data: `alert_edit_select:${alert.id}` }]));

            await this.bot.sendMessage(msg.chat.id, 'Select Alert to Edit:', {
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        } catch (error) {
            logger.error('Error starting alert edit:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to start alert edit.');
        }
    }

    /**
     * Handles the initial step of the /delete_alert command.
     */
    private handleDeleteAlertStart = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            const alerts = await dbService.getActiveAlerts();
            if (!alerts.length) {
                await this.bot.sendMessage(msg.chat.id, 'No active alerts to delete.');
                return;
            }

            const inlineKeyboard = alerts.map(alert => ([{ text: `${alert.id} - ${alert.symbol} (${alert.timeframe})`, callback_data: `alert_delete_confirm:${alert.id}` }]));

            await this.bot.sendMessage(msg.chat.id, 'Select Alert to Delete:', {
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        } catch (error) {
            logger.error('Error starting alert delete:', error);
            await this.bot.sendMessage(msg.chat.id, '❌ Failed to start alert delete.');
        }
    }

    /**
     * Updates the user state with new data and refreshes the last activity timestamp.
     */
    private updateUserState(chatId: number, newState: Partial<AlertState>): void {
        const currentState = this.userStates.get(chatId) || {
            mode: 'create',
            step: '',
            data: { symbol: '', timeframe: '', conditions: [] },
            lastActivity: Date.now()
        };

        this.userStates.set(chatId, {
            ...currentState,
            ...newState,
            lastActivity: Date.now()
        });
    }

    /**
     * Starts the periodic check to clean up stale user states.
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
     * @param message - The message to send.
     */
    public async sendMessage(message: string): Promise<void> {
        try {
            await this.bot.sendMessage(this.authorizedChatId, message, { parse_mode: 'Markdown' });
            logger.info('Message sent to Telegram', { message: message.substring(0, 50) });
        } catch (error) {
            logger.error('Failed to send Telegram message', { error });
        }
    }
}
