// src/lib/services/telegramBotController.ts

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/settings';
import { dbService } from '../db';
import { createLogger } from '../logger';
import { ExchangeService } from './exchange';
import { MLService } from './mlService';
import { Condition, type TradeSignal } from '../../types';
import { closeAndCleanUp } from '../..';
import { excursionCache } from './excursionHistoryCache';

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
    private userStates: Map<number, AlertState> = new Map();
    private cleanupInterval: NodeJS.Timeout | null = null;

    /**
 * Initializes the Telegram bot in polling mode.
 *
 * Responsibilities:
 *   • Validates required Telegram configuration
 *   • Stores dependencies (exchange, mlService)
 *   • Creates the TelegramBot instance with optimized polling settings
 *   • Registers all command and event listeners
 *   • Starts periodic cleanup of stale user interaction states
 *
 * @param exchange - ExchangeService instance for fetching market data and executing trades
 * @param mlService - MLService instance for model status and training control
 * @throws {Error} If required Telegram credentials are missing
 */
    constructor(
        private readonly exchange: ExchangeService,
        private readonly mlService: MLService
    ) {
        // === 1. Validate required configuration ===
        if (!config.telegram?.token) {
            throw new Error('FATAL: Telegram bot token is missing from config (TELEGRAM_BOT_TOKEN)');
        }
        if (!config.telegram?.chatId) {
            throw new Error('FATAL: Authorized Telegram chat ID is missing from config (TELEGRAM_CHAT_ID)');
        }

        // === 2. Store dependencies and config ===
        this.authorizedChatId = config.telegram.chatId;

        // === 3. Initialize the TelegramBot client ===
        this.bot = new TelegramBot(config.telegram.token, {
            polling: {
                interval: 2000,      // or 1 – immediate retry after response (true long polling)
                autoStart: true,  // optional, default is true
                params: {
                    timeout: 30,  // Keep 30s – Telegram holds the connection up to ~30-60s if no updates
                    limit: 100,   // default, fine
                },
            },
        });

        this.bot.on('polling_error', (error: any) => {
            // Log the error using your custom logger instead of letting it crash
            logger.warn('Telegram Polling Error (Connection dropped)', {
                code: error.code,
                message: error.message
            });
        });

        this.bot.on('error', (error: any) => {
            logger.error('General Telegram Bot Error', { error });
        });

        logger.info('Telegram Bot client initialized', {
            chatId: this.authorizedChatId,
            polling: true,
        });

        // === 4. Register all command handlers and event listeners ===
        this.registerListeners();

        // === 5. Start background cleanup of stale user states ===
        this.startStateCleanup();

        logger.info('TelegramBotController fully initialized and ready');
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
     * Registers all command handlers, regex-based commands, and global event listeners.
     *
     * Design:
     *   • Uses node-telegram-bot-api's onText() for exact and regex commands
     *   • Groups commands logically for readability
     *   • Centralizes all listener registration in one place
     *   • Ensures no duplicate registrations
     *
     * @private
     */
    private registerListeners(): void {
        // =================================================================
        // TELEGRAM COMMAND REGISTRATION – Centralized & Grouped
        // =================================================================

        // 1. Basic & Help Commands
        this.bot.onText(/\/start|\/help/, this.handleHelp.bind(this));

        // 2. System Status & Control
        this.bot.onText(/\/status/, this.handleStatus.bind(this));
        this.bot.onText(/\/stopbot/, this.handleStopBot.bind(this));

        // 3. Custom Alert Management
        this.bot.onText(/\/alerts/, this.handleAlerts.bind(this));
        this.bot.onText(/\/create_alert/, this.handleCreateAlertStart.bind(this));
        this.bot.onText(/\/edit_alert/, this.handleEditAlertStart.bind(this));
        this.bot.onText(/\/delete_alert/, this.handleDeleteAlertStart.bind(this));

        // 4. ML Model Control & Monitoring
        this.bot.onText(/\/ml_status/, this.handleMLStatus.bind(this));
        this.bot.onText(/\/ml_pause/, this.handleMLPause.bind(this));
        this.bot.onText(/\/ml_resume/, this.handleMLResume.bind(this));
        this.bot.onText(/\/ml_train/, this.handleMLForceTrain.bind(this));
        this.bot.onText(/\/ml_samples/, this.handleMLSamples.bind(this));
        this.bot.onText(/\/ml_performance/, this.handleMLPerformance.bind(this));

        // 5. Live Trading & Position Monitoring
        this.bot.onText(/\/positions/, this.handlePositions.bind(this));
        this.bot.onText(/\/trades/, this.handleTrades.bind(this));

        // 6. Taken Trade Analytics (new performance stats for filtered trades)
        this.bot.onText(/\/takenstats(?:\s+(.+))?/, this.handleTakenStats.bind(this));
        this.bot.onText(/\/takensymbols(?:\s+(\d+))?/, this.handleTakenSymbols.bind(this));
        this.bot.onText(/\/takenvsall/, this.handleTakenVsAll.bind(this));

        // 7. Excursion & Regime Diagnostics
        this.bot.onText(/\/excursions(?:\s+(.+))?/, this.handleExcursions.bind(this));

        // =================================================================
        // 8. Global Event Listeners (non-command input)
        // =================================================================
        // Handles free-text input during multi-step workflows (e.g., entering period/target)
        this.bot.on('message', this.handleMessage.bind(this));

        // Handles all inline keyboard interactions (selections, pagination, actions)
        this.bot.on('callback_query', this.handleCallbackQuery.bind(this));

        logger.info('All Telegram command and event listeners registered successfully');
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
 * Handles free-text messages during multi-step alert configuration workflows.
 *
 * Supported steps:
 *   • enter_period  → Parses integer period (1–500) for indicators like RSI/EMA
 *   • select_target → Parses number, range (min-max), or indicator reference
 *
 * Features:
 *   • Strict validation with helpful error messages
 *   • Automatic state progression on success
 *   • Ignores non-stateful messages (commands handled separately)
 *
 * @param msg - Incoming Telegram message
 * @private
 */
    private handleMessage = async (msg: TelegramBot.Message): Promise<void> => {
        const chatId = msg.chat.id;

        // Security check
        if (!this.isAuthorized(chatId)) {
            await this.sendMessage(
                'Unauthorized access. This bot only responds to messages from its configured primary chat ID.'
            );
            return;
        }

        // Only process text messages in active workflow states
        const state = this.userStates.get(chatId);
        if (!state || !msg.text) return;

        const text = msg.text.trim();

        try {
            // === STEP: Entering period for indicators (e.g., RSI(14)) ===
            if (state.step === 'enter_period') {
                const period = parseInt(text, 10);

                if (isNaN(period) || period < 1 || period > 500) {
                    await this.bot.sendMessage(
                        chatId,
                        '❌ Invalid period. Please enter a whole number between 1 and 500 (e.g., 14, 50, 200).'
                    );
                    return;
                }

                if (state.temp) {
                    state.temp.period = period;
                }

                state.step = 'select_operator';
                this.updateUserState(chatId, state);

                await this.sendOperatorSelection(
                    chatId,
                    state.temp?.indicator as Condition['indicator']
                );
                return;
            }

            // === STEP: Entering target value (number, range, or indicator) ===
            if (state.step === 'select_target') {
                let target: number | string | number[];

                if (state.temp?.operator === 'is_in_range') {
                    // Format: "20-80" or "30 - 70"
                    const parts = text.split('-').map(p => parseFloat(p.trim()));
                    if (parts.length !== 2 || parts.some(isNaN) || parts[0] >= parts[1]) {
                        throw new Error('Invalid range format. Use: min-max (e.g., 20-80)');
                    }
                    target = parts;
                } else if (['crosses_above', 'crosses_below'].includes(state.temp?.operator || '')) {
                    // Allow indicator reference (e.g., "ema_200") or number
                    const validIndicators = [
                        'close', 'high', 'low', 'volume',
                        'rsi', 'ema', 'sma', 'macd_line', 'macd_signal',
                        'bb_upper', 'bb_lower'
                    ];
                    const isValidIndicator = validIndicators.includes(text.toLowerCase()) ||
                        /^ema_\d+$/i.test(text) ||
                        /^sma_\d+$/i.test(text);

                    if (isValidIndicator) {
                        target = text.toLowerCase();
                    } else {
                        const num = parseFloat(text);
                        if (isNaN(num)) throw new Error('Expected a number or valid indicator (e.g., ema_200)');
                        target = num;
                    }
                } else {
                    // Standard numeric comparison
                    const num = parseFloat(text);
                    if (isNaN(num)) throw new Error('Expected a numeric value (e.g., 70)');
                    target = num;
                }

                // Save condition and return to menu
                if (state.temp) {
                    state.temp.target = target;
                    state.data.conditions.push(state.temp as Condition);
                }
                delete state.temp;

                state.step = 'conditions_menu';
                this.updateUserState(chatId, state);

                await this.sendConditionsMenu(chatId, state.data);
                return;
            }

            // If we reach here: message not expected in current step
            await this.bot.sendMessage(
                chatId,
                '⚠️ Unexpected input. Use the buttons or follow the current prompt.'
            ).catch((e) => {
                logger.error('', { error: e })
            });
        } catch (error: any) {
            logger.warn('Invalid input in alert workflow', {
                chatId,
                step: state.step,
                input: text,
                error: error.message,
            });

            await this.bot.sendMessage(
                chatId,
                `❌ ${error.message || 'Invalid input. Please try again.'}`
            );
        }
    };

    /**
 * Handles the /stopbot command.
 * Stops the Telegram bot, clears all user states, and optionally releases DB lock.
 * Only works in production (when bot is actually running via worker).
 * @param msg - Incoming Telegram message.
 * @private
 */
    private handleStopBot = async (msg: TelegramBot.Message): Promise<void> => {
        const chatId = msg.chat.id;
        if (!this.isAuthorized(chatId)) return;

        logger.warn('Stopbot command received', { user: msg.from?.username || msg.from?.id });

        try {
            // 1. Stop polling immediately
            // closeAndCleanUp is a Promise that resolves to the actual cleanup function; await it first, then call it.
            const cleanupFn = await closeAndCleanUp;
            if (typeof cleanupFn === 'function') {
                await cleanupFn();
            } else {
                logger.warn('closeAndCleanUp did not return a callable cleanup function');
            }

            // 3. Clear all user states from memory
            const clearedCount = this.userStates.size;
            this.userStates.clear();
            logger.info(`Cleared ${clearedCount} user states from memory`);
        } catch (error) {
            logger.error('Unexpected error in /stopbot handler', { error });
            await this.bot.sendMessage(chatId, 'Error during shutdown. Check logs.');
        }
    }

    /**
 * Handles all callback queries from inline keyboards.
 *
 * Routes actions based on callback_data prefix:
 *   • Symbol/timeframe/indicator/operator selection
 *   • Pagination (alerts, positions, trades)
 *   • Alert CRUD actions (save, cancel, delete)
 *
 * Features:
 *   • Full state management
 *   • Comprehensive error handling with user feedback
 *   • Always acknowledges query (prevents "loading" spinner)
 *
 * @param query - Incoming callback query
 * @private
 */
    private handleCallbackQuery = async (query: TelegramBot.CallbackQuery): Promise<void> => {
        const chatId = query.message?.chat.id ?? query.from.id;

        if (!this.isAuthorized(chatId)) {
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Unauthorized', show_alert: true });
            return;
        }

        const data = query.data;
        if (!data) {
            await this.bot.answerCallbackQuery(query.id);
            return;
        }

        // Load or initialize state
        let state = this.userStates.get(chatId);
        if (!state) {
            state = {
                mode: 'create',
                step: '',
                data: { symbol: '', timeframe: '', conditions: [] },
                page: 0,
                lastActivity: Date.now(),
            };
            this.userStates.set(chatId, state);
        }
        this.updateUserState(chatId, state);

        try {
            // =================================================================
            // Alert Creation Flow
            // =================================================================
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

                const needsPeriod = ['rsi', 'ema', 'sma', 'macd_line', 'macd_signal', 'bb_upper', 'bb_lower'].includes(indicator);
                state.step = needsPeriod ? 'enter_period' : 'select_operator';

                if (needsPeriod) {
                    await this.bot.sendMessage(
                        chatId,
                        `Enter the **Period** for ${indicator.toUpperCase()} (e.g., 14):`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await this.sendOperatorSelection(chatId, indicator);
                }

            } else if (data.startsWith('alert_select_operator:')) {
                const operator = data.split(':')[1] as Condition['operator'];
                if (state.temp) state.temp.operator = operator;
                state.step = 'select_target';

                const indicatorName = (state.temp?.indicator || 'Value').toUpperCase();
                let prompt = `Enter value for ${indicatorName} `;

                if (operator === 'is_in_range') {
                    prompt += '(format: min-max, e.g., 20-80)';
                } else if (['crosses_above', 'crosses_below'].includes(operator)) {
                    prompt += '(number or indicator, e.g., 10000 or ema_200)';
                } else {
                    prompt += '(e.g., 70)';
                }

                await this.bot.sendMessage(chatId, prompt);

            } else if (data === 'alert_remove_last') {
                if (state.data.conditions.length > 0) {
                    state.data.conditions.pop();
                }
                await this.sendConditionsMenu(chatId, state.data);

            } else if (data === 'alert_save') {
                if (!state.data.symbol || !state.data.timeframe || state.data.conditions.length === 0) {
                    await this.bot.answerCallbackQuery(query.id, {
                        text: 'Incomplete alert! Add symbol, timeframe, and conditions.',
                        show_alert: true,
                    });
                    return;
                }

                if (state.mode === 'create') {
                    const newId = await dbService.createAlert({
                        symbol: state.data.symbol,
                        timeframe: state.data.timeframe,
                        conditions: state.data.conditions,
                        status: 'active',
                    });
                    await this.bot.sendMessage(chatId, `✅ Alert created successfully! ID: ${newId}`);
                } else if (state.mode === 'edit' && state.alertId) {
                    await dbService.updateAlert(Number(state.alertId), state.data);
                    await this.bot.sendMessage(chatId, `✅ Alert ${state.alertId} updated successfully!`);
                }

                this.userStates.delete(chatId);

            } else if (data === 'alert_cancel') {
                this.userStates.delete(chatId);
                await this.bot.sendMessage(chatId, 'Operation cancelled.');

                // =================================================================
                // Edit / Delete Flows
                // =================================================================
            } else if (data.startsWith('alert_edit_select:')) {
                const alertId = data.split(':')[1];
                const alert = await dbService.getAlertsById(Number(alertId));
                if (!alert) {
                    await this.bot.sendMessage(chatId, `Alert ${alertId} not found.`);
                    return;
                }
                state.mode = 'edit';
                state.alertId = alertId;
                state.data = {
                    symbol: alert.symbol,
                    timeframe: alert.timeframe,
                    conditions: alert.conditions,
                };
                state.step = 'conditions_menu';
                await this.sendConditionsMenu(chatId, state.data);

            } else if (data.startsWith('alert_delete_confirm:')) {
                const alertId = data.split(':')[1];
                await this.bot.sendMessage(chatId, `⚠️ Confirm deletion of alert ${alertId}?`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Yes, delete', callback_data: `alert_delete_yes:${alertId}` }],
                            [{ text: 'Cancel', callback_data: 'alert_cancel' }],
                        ],
                    },
                });

            } else if (data.startsWith('alert_delete_yes:')) {
                const alertId = data.split(':')[1];
                await dbService.deleteAlert(Number(alertId));
                await this.bot.sendMessage(chatId, `🗑️ Alert ${alertId} deleted.`);
                this.userStates.delete(chatId);

                // =================================================================
                // Pagination
                // =================================================================
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

            // Always acknowledge the callback
            await this.bot.answerCallbackQuery(query.id);

        } catch (error: any) {
            logger.error('Error in callback query handler', {
                chatId,
                data,
                error: error.message,
                stack: error.stack,
            });

            await this.bot.answerCallbackQuery(query.id, {
                text: 'An error occurred. Operation cancelled.',
                show_alert: true,
            });

            this.userStates.delete(chatId);
            await this.bot.sendMessage(chatId, '❌ Unexpected error. Workflow cancelled.');
        }
    };
    /**
     * Sends a paginated symbol selection keyboard.
     *
     * Features:
     *   • Alphabetically sorted symbols for easier navigation
     *   • Clear page indicator
     *   • Responsive Next/Previous buttons
     *   • Graceful handling of empty symbol list
     *
     * @param chatId - Target Telegram chat ID
     * @param page - Current page (0-based)
     * @private
     */
    private async sendSymbolSelection(chatId: number, page: number = 0): Promise<void> {
        let symbols = Array.from(this.exchange.getSupportedSymbols());

        if (symbols.length === 0) {
            await this.bot.sendMessage(
                chatId,
                '❌ No trading pairs available. Exchange connection may be down or not initialized yet.'
            );
            return;
        }

        // Sort alphabetically for consistent, predictable ordering
        symbols = symbols.sort((a, b) => a.localeCompare(b));

        const totalPages = Math.ceil(symbols.length / PAGE_SIZE);
        const start = page * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, symbols.length);
        const pageSymbols = symbols.slice(start, end);

        const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = pageSymbols.map(symbol => [
            { text: symbol, callback_data: `alert_select_symbol:${symbol}` }
        ]);

        // Add navigation row if needed
        const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
        if (page > 0) {
            navigationRow.push({ text: '⬅️ Previous', callback_data: `alert_next_symbols:${page - 1}` });
        }
        if (end < symbols.length) {
            navigationRow.push({ text: 'Next ➡️', callback_data: `alert_next_symbols:${page + 1}` });
        }
        if (navigationRow.length > 0) {
            inlineKeyboard.push(navigationRow);
        }

        const message = totalPages > 1
            ? `**Step 1: Select Symbol** (Page ${page + 1}/${totalPages})\n\nChoose a trading pair:`
            : '**Step 1: Select Symbol**\n\nChoose a trading pair:';

        await this.bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
    }

    /**
     * Sends a compact timeframe selection keyboard.
     *
     * Features:
     *   • 2-column layout for better mobile experience
     *   • Clear labels with full names
     *   • Consistent with common crypto timeframes
     *
     * @param chatId - Target Telegram chat ID
     * @private
     */
    private async sendTimeframeSelection(chatId: number): Promise<void> {
        const timeframes = [
            { value: '1m', label: '1 Minute' },
            { value: '5m', label: '5 Minutes' },
            { value: '15m', label: '15 Minutes' },
            { value: '30m', label: '30 Minutes' },
            { value: '1h', label: '1 Hour' },
            { value: '4h', label: '4 Hours' },
            { value: '1d', label: '1 Day' },
            { value: '1w', label: '1 Week' },
        ];

        // 2-column grid layout
        const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = [];
        for (let i = 0; i < timeframes.length; i += 2) {
            const row = [
                { text: timeframes[i].label, callback_data: `alert_select_timeframe:${timeframes[i].value}` }
            ];
            if (i + 1 < timeframes.length) {
                row.push({
                    text: timeframes[i + 1].label,
                    callback_data: `alert_select_timeframe:${timeframes[i + 1].value}`
                });
            }
            inlineKeyboard.push(row);
        }

        await this.bot.sendMessage(chatId, '**Step 2: Select Timeframe**\n\nChoose the candle interval for your alert:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
    }

    /**
     * Sends an indicator selection keyboard with grouped layout.
     *
     * Features:
     *   • Logical grouping (price, volume, oscillators, bands)
     *   • Clean uppercase labels
     *   • 2–3 column layout for density
     *
     * @param chatId - Target Telegram chat ID
     * @private
     */
    private async sendIndicatorSelection(chatId: number): Promise<void> {
        const indicators = [
            // Price & Volume
            { value: 'close', label: 'CLOSE' },
            { value: 'high', label: 'HIGH' },
            { value: 'low', label: 'LOW' },
            { value: 'volume', label: 'VOLUME' },

            // Oscillators & Momentum
            { value: 'rsi', label: 'RSI' },
            { value: 'macd_line', label: 'MACD Line' },
            { value: 'macd_signal', label: 'MACD Signal' },

            // Moving Averages
            { value: 'ema', label: 'EMA' },
            { value: 'sma', label: 'SMA' },

            // Bollinger Bands
            { value: 'bb_upper', label: 'BB Upper' },
            { value: 'bb_lower', label: 'BB Lower' },
        ];

        const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = [];
        for (let i = 0; i < indicators.length; i += 3) {
            const row: TelegramBot.InlineKeyboardButton[] = [];
            for (let j = 0; j < 3 && i + j < indicators.length; j++) {
                const ind = indicators[i + j];
                row.push({
                    text: ind.label,
                    callback_data: `alert_select_indicator:${ind.value}`
                });
            }
            inlineKeyboard.push(row);
        }

        await this.bot.sendMessage(chatId, '**Choose Indicator**\n\nSelect the technical indicator for your condition:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
    }

    /**
 * Sends an operator selection keyboard tailored to the chosen indicator.
 *
 * Features:
 *   • Human-readable operator labels (e.g., "Crosses Above" instead of "crosses_above")
 *   • Logical grouping in 3-column layout for faster selection
 *   • Clear prompt with context
 *
 * @param chatId - Target Telegram chat ID
 * @param indicator - The currently selected indicator
 * @private
 */
    private async sendOperatorSelection(chatId: number, indicator: Condition['indicator']): Promise<void> {
        // Human-readable mapping for better UX
        const operatorMap: Array<{ value: Condition['operator']; label: string }> = [
            { value: 'crosses_above', label: 'Crosses Above ↗️' },
            { value: 'crosses_below', label: 'Crosses Below ↘️' },
            { value: '>', label: 'Greater Than >' },
            { value: '<', label: 'Less Than <' },
            { value: '>=', label: 'Greater or Equal ≥' },
            { value: '<=', label: 'Less or Equal ≤' },
            { value: 'is_equal', label: 'Equals =' },
            { value: 'is_not_equal', label: 'Not Equal ≠' },
            { value: 'is_in_range', label: 'In Range [min-max]' },
        ];

        // 3-column grid for compact, fast selection
        const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = [];
        for (let i = 0; i < operatorMap.length; i += 3) {
            const row: TelegramBot.InlineKeyboardButton[] = [];
            for (let j = 0; j < 3 && i + j < operatorMap.length; j++) {
                const op = operatorMap[i + j];
                row.push({
                    text: op.label,
                    callback_data: `alert_select_operator:${op.value}`
                });
            }
            inlineKeyboard.push(row);
        }

        await this.bot.sendMessage(
            chatId,
            `**Choose Operator for ${indicator.toUpperCase()}**\n\nSelect how the indicator should trigger the alert:`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineKeyboard },
            }
        );
    }

    /**
 * Sends the main conditions menu with live preview and action buttons.
 *
 * Features:
 *   • Clean, formatted current configuration summary
 *   • Logical condition display with periods and targets
 *   • Dynamic action buttons (only show relevant ones)
 *   • Professional layout with status indicators
 *
 * @param chatId - Target Telegram chat ID
 * @param data - Current alert configuration state
 * @private
 */
    private async sendConditionsMenu(chatId: number, data: AlertState['data']): Promise<void> {
        // Build symbol/timeframe header
        const header = data.symbol && data.timeframe
            ? `**${data.symbol}** • ${data.timeframe.toUpperCase()}`
            : 'Not set yet';

        // Format conditions list
        let conditionsText: string;
        if (data.conditions.length === 0) {
            conditionsText = '_No conditions added yet_';
        } else {
            conditionsText = data.conditions
                .map((c, idx) => {
                    const period = c.period ? `(${c.period})` : '';
                    const target = Array.isArray(c.target)
                        ? c.target.join('–')
                        : c.target ?? '(pending)';

                    return `${idx + 1}. ${c.indicator.toUpperCase()}${period} ${c.operator.replace(/_/g, ' ')} ${target}`;
                })
                .join('\n');
        }

        // Build message
        const messageLines = [
            `*Current Alert Configuration* 🔧`,
            '',
            `**Pair:** ${header}`,
            '',
            `**Conditions (${data.conditions.length}):**`,
            '```',
            conditionsText,
            '```',
            '',
            `*Actions:*`,
        ];

        // Dynamic keyboard based on state
        const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: '➕ Add Condition', callback_data: 'alert_add_condition' }]
        ];

        if (data.conditions.length > 0) {
            inlineKeyboard.push([
                { text: '➖ Remove Last', callback_data: 'alert_remove_last' }
            ]);

            // Only show Save if configuration is complete
            if (data.symbol && data.timeframe && data.conditions.length > 0) {
                inlineKeyboard.push([
                    { text: '💾 Save Alert', callback_data: 'alert_save' }
                ]);
            }
        }

        inlineKeyboard.push([
            { text: '❌ Cancel', callback_data: 'alert_cancel' }
        ]);

        await this.bot.sendMessage(chatId, messageLines.join('\n'), {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
    }

    /**
 * Sends a paginated list of all active custom alerts.
 *
 * Features:
 *   • Clear formatting with ID, symbol, timeframe, conditions
 *   • Human-readable last trigger time
 *   • Responsive pagination with page counter
 *   • Empty state handling
 *
 * @param chatId - Target Telegram chat ID
 * @param page - Current page (0-based)
 * @private
 */
    private async sendAlertsList(chatId: number, page: number = 0): Promise<void> {
        try {
            const allAlerts = await dbService.getActiveAlerts();

            if (allAlerts.length === 0) {
                await this.bot.sendMessage(
                    chatId,
                    'ℹ️ *No active custom alerts*\n\nUse `/create_alert` to set up your first alert.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            const totalPages = Math.ceil(allAlerts.length / PAGE_SIZE);
            const start = page * PAGE_SIZE;
            const end = Math.min(start + PAGE_SIZE, allAlerts.length);
            const pageAlerts = allAlerts.slice(start, end);

            const alertSummaries = pageAlerts.map((alert: any) => {
                const conditions = alert.conditions
                    .map((c: any) => {
                        const period = c.period ? `(${c.period})` : '';
                        const target = Array.isArray(c.target)
                            ? c.target.join('–')
                            : c.target ?? '(any)';

                        return `${c.indicator.toUpperCase()}${period} ${c.operator.replace(/_/g, ' ')} ${target}`;
                    })
                    .join(' AND ');

                const lastTriggered = alert.lastAlertAt
                    ? new Date(alert.lastAlertAt).toLocaleString()
                    : 'Never';

                return [
                    `**ID:** \`${alert.id}\` • **${alert.symbol}** • \`${alert.timeframe.toUpperCase()}\``,
                    `**Conditions:** ${conditions}`,
                    `**Last Triggered:** ${lastTriggered}`,
                ].join('\n');
            });

            // Navigation row
            const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
            if (page > 0) {
                navigationRow.push({
                    text: '⬅️ Previous',
                    callback_data: `alerts_page:${page - 1}`
                });
            }
            if (end < allAlerts.length) {
                navigationRow.push({
                    text: 'Next ➡️',
                    callback_data: `alerts_page:${page + 1}`
                });
            }

            const message = [
                `**Active Custom Alerts** 🔔`,
                `Page ${page + 1} of ${totalPages}`,
                '',
                ...alertSummaries
            ].join('\n\n');

            await this.bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: navigationRow.length > 0
                    ? { inline_keyboard: [navigationRow] }
                    : undefined,
            });
        } catch (error: any) {
            logger.error('Error listing active alerts', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to retrieve alerts. Please try again later.');
        }
    }

    /**
     * Sends a paginated selection menu for editing an existing alert.
     *
     * @param chatId - Target Telegram chat ID
     * @param page - Current page (0-based)
     * @private
     */
    private async sendEditAlertSelection(chatId: number, page: number = 0): Promise<void> {
        try {
            const alerts = await dbService.getActiveAlerts();

            if (alerts.length === 0) {
                await this.bot.sendMessage(chatId, 'ℹ️ No active alerts available to edit.');
                return;
            }

            const totalPages = Math.ceil(alerts.length / PAGE_SIZE);
            const start = page * PAGE_SIZE;
            const end = Math.min(start + PAGE_SIZE, alerts.length);
            const pageAlerts = alerts.slice(start, end);

            const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = pageAlerts.map(alert => [
                {
                    text: `#${alert.id} • ${alert.symbol} • ${alert.timeframe.toUpperCase()}`,
                    callback_data: `alert_edit_select:${alert.id}`
                }
            ]);

            // Pagination
            const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
            if (page > 0) {
                navigationRow.push({ text: '⬅️ Previous', callback_data: `edit_alerts_page:${page - 1}` });
            }
            if (end < alerts.length) {
                navigationRow.push({ text: 'Next ➡️', callback_data: `edit_alerts_page:${page + 1}` });
            }
            if (navigationRow.length > 0) {
                inlineKeyboard.push(navigationRow);
            }

            await this.bot.sendMessage(
                chatId,
                `**Select Alert to Edit** ✏️\nPage ${page + 1}/${totalPages}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: inlineKeyboard },
                }
            );
        } catch (error: any) {
            logger.error('Error loading alerts for edit', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to load alerts for editing.');
        }
    }

    /**
     * Sends a paginated selection menu for deleting an alert (with confirmation step).
     *
     * @param chatId - Target Telegram chat ID
     * @param page - Current page (0-based)
     * @private
     */
    private async sendDeleteAlertSelection(chatId: number, page: number = 0): Promise<void> {
        try {
            const alerts = await dbService.getActiveAlerts();

            if (alerts.length === 0) {
                await this.bot.sendMessage(chatId, 'ℹ️ No active alerts available to delete.');
                return;
            }

            const totalPages = Math.ceil(alerts.length / PAGE_SIZE);
            const start = page * PAGE_SIZE;
            const end = Math.min(start + PAGE_SIZE, alerts.length);
            const pageAlerts = alerts.slice(start, end);

            const inlineKeyboard: TelegramBot.InlineKeyboardButton[][] = pageAlerts.map(alert => [
                {
                    text: `🗑️ #${alert.id} • ${alert.symbol} • ${alert.timeframe.toUpperCase()}`,
                    callback_data: `alert_delete_confirm:${alert.id}`
                }
            ]);

            // Pagination
            const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
            if (page > 0) {
                navigationRow.push({ text: '⬅️ Previous', callback_data: `delete_alerts_page:${page - 1}` });
            }
            if (end < alerts.length) {
                navigationRow.push({ text: 'Next ➡️', callback_data: `delete_alerts_page:${page + 1}` });
            }
            if (navigationRow.length > 0) {
                inlineKeyboard.push(navigationRow);
            }

            await this.bot.sendMessage(
                chatId,
                `**Select Alert to Delete** 🗑️\nPage ${page + 1}/${totalPages}\n\n⚠️ This action cannot be undone.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: inlineKeyboard },
                }
            );
        } catch (error: any) {
            logger.error('Error loading alerts for deletion', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to load alerts for deletion.');
        }
    }

    /**
     * Sends a paginated list of currently open positions.
     *
     * Features:
     *   • Clean, structured formatting with key metrics
     *   • Page counter and responsive navigation
     *   • Handles empty states and exchange errors gracefully
     *   • Optimized for readability on mobile
     *
     * @param chatId - Target Telegram chat ID
     * @param page - Current page (0-based)
     * @private
     */
    private async sendPositionsList(chatId: number, page: number = 0): Promise<void> {
        try {
            const symbols = this.exchange.getSupportedSymbols();

            if (symbols.length === 0) {
                await this.bot.sendMessage(chatId, '❌ No trading pairs available. Exchange may not be initialized.');
                return;
            }

            // Fetch all positions across symbols
            const allPositions: { symbol: string; position: any }[] = [];
            for (const symbol of symbols) {
                try {
                    const positions = await this.exchange.getPositions(symbol);
                    positions.forEach(p => allPositions.push({ symbol, position: p }));
                } catch (err) {
                    logger.warn(`Failed to fetch positions for ${symbol}`, { error: err });
                    // Continue with others
                }
            }

            if (allPositions.length === 0) {
                await this.bot.sendMessage(chatId, 'ℹ️ *No open positions currently.*\n\nAll clear! 📈', { parse_mode: 'Markdown' });
                return;
            }

            const totalPages = Math.ceil(allPositions.length / PAGE_SIZE);
            const start = page * PAGE_SIZE;
            const end = Math.min(start + PAGE_SIZE, allPositions.length);
            const pagePositions = allPositions.slice(start, end);

            const positionSummaries = pagePositions.map(({ symbol, position }) => {
                const side = position.side === 'long' ? 'LONG 🟢' : 'SHORT 🔴';
                const contracts = position.contracts ?? 0;
                const entryPrice = position.entryPrice?.toFixed(8) ?? 'N/A';
                const unrealizedPnl = (position.unrealizedPnl ?? 0).toFixed(2);
                const pnlColor = parseFloat(unrealizedPnl) >= 0 ? '🟢' : '🔴';

                return [
                    `**${symbol}** • ${side}`,
                    `   Contracts: ${contracts}`,
                    `   Entry: $${entryPrice}`,
                    `   Unrealized PnL: ${pnlColor} ${unrealizedPnl} USDT`,
                ].join('\n');
            });

            // Navigation row
            const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
            if (page > 0) {
                navigationRow.push({ text: '⬅️ Previous', callback_data: `positions_page:${page - 1}` });
            }
            if (end < allPositions.length) {
                navigationRow.push({ text: 'Next ➡️', callback_data: `positions_page:${page + 1}` });
            }

            const message = [
                `**Open Positions** 📈`,
                `Page ${page + 1} of ${totalPages} • Total: ${allPositions.length}`,
                '',
                ...positionSummaries
            ].join('\n\n');

            await this.bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: navigationRow.length > 0
                    ? { inline_keyboard: [navigationRow] }
                    : undefined,
            });
        } catch (error: any) {
            logger.error('Error fetching open positions', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to retrieve positions. Exchange may be temporarily unavailable.');
        }
    }

    /**
     * Sends a paginated list of recently closed trades (last 24 hours).
     *
     * Features:
     *   • Shows profit/loss with color indicators
     *   • Human-readable timestamps
     *   • Handles partial failures per symbol
     *   • Clear empty state
     *
     * @param chatId - Target Telegram chat ID
     * @param page - Current page (0-based)
     * @private
     */
    private async sendTradesList(chatId: number, page: number = 0): Promise<void> {
        try {
            const symbols = this.exchange.getSupportedSymbols();

            if (symbols.length === 0) {
                await this.bot.sendMessage(chatId, '❌ No trading pairs available.');
                return;
            }

            const since = Date.now() - 24 * 60 * 60 * 1000; // Last 24 hours
            const allTrades: { symbol: string; trade: any }[] = [];

            for (const symbol of symbols) {
                try {
                    const trades = await this.exchange.getClosedTrades(symbol, since);
                    trades.forEach(t => allTrades.push({ symbol, trade: t }));
                } catch (err) {
                    logger.warn(`Failed to fetch closed trades for ${symbol}`, { error: err });
                }
            }

            if (allTrades.length === 0) {
                await this.bot.sendMessage(chatId, 'ℹ️ *No closed trades in the last 24 hours.*\n\nQuiet market or no activity.', { parse_mode: 'Markdown' });
                return;
            }

            // Sort newest first
            allTrades.sort((a, b) => (b.trade.timestamp || b.trade.datetime || 0) - (a.trade.timestamp || a.trade.datetime || 0));

            const totalPages = Math.ceil(allTrades.length / PAGE_SIZE);
            const start = page * PAGE_SIZE;
            const end = Math.min(start + PAGE_SIZE, allTrades.length);
            const pageTrades = allTrades.slice(start, end);

            const tradeSummaries = pageTrades.map(({ symbol, trade }) => {
                const side = trade.side === 'buy' ? 'BUY 🟢' : 'SELL 🔴';
                const amount = (trade.amount ?? 0).toFixed(6);
                const price = trade.price?.toFixed(8) ?? 'N/A';
                const profit = (trade.info?.realized_pnl ?? trade.realizedPnl ?? 0);
                const profitStr = profit.toFixed(2);
                const pnlColor = profit >= 0 ? '🟢' : '🔴';
                const timestamp = trade.datetime
                    ? new Date(trade.datetime).toLocaleString()
                    : trade.timestamp
                        ? new Date(trade.timestamp).toLocaleString()
                        : 'Unknown';

                return [
                    `**${symbol}** • ${side}`,
                    `   Amount: ${amount}`,
                    `   Price: $${price}`,
                    `   Profit: ${pnlColor} ${profitStr} USDT`,
                    `   Time: ${timestamp}`,
                ].join('\n');
            });

            // Navigation
            const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
            if (page > 0) {
                navigationRow.push({ text: '⬅️ Previous', callback_data: `trades_page:${page - 1}` });
            }
            if (end < allTrades.length) {
                navigationRow.push({ text: 'Next ➡️', callback_data: `trades_page:${page + 1}` });
            }

            const message = [
                `**Recent Closed Trades** 📉`,
                `Last 24 hours • Page ${page + 1} of ${totalPages} • Total: ${allTrades.length}`,
                '',
                ...tradeSummaries
            ].join('\n\n');

            await this.bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: navigationRow.length > 0
                    ? { inline_keyboard: [navigationRow] }
                    : undefined,
            });
        } catch (error: any) {
            logger.error('Error fetching closed trades', { error });
            await this.bot.sendMessage(chatId, '❌ Failed to retrieve trade history. Exchange may be unavailable.');
        }
    }

    /**
 * Handles the /start and /help commands.
 *
 * Displays a comprehensive, up-to-date command reference with:
 *   • Clear categories
 *   • Emojis for visual hierarchy
 *   • Accurate descriptions
 *   • Professional formatting
 *
 * This is the primary onboarding and reference point for users.
 *
 * @param msg - Incoming Telegram message
 * @private
 */
    private handleHelp = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const helpText = [
            '🤖 *Crypto Scanner Bot — Command Reference*',
            '',
            '*🔧 Alert Management*',
            '• `/alerts` — List all active custom alerts (paginated)',
            '• `/create_alert` — Step-by-step wizard to create a new alert',
            '• `/edit_alert` — Modify an existing alert',
            '• `/delete_alert` — Delete an alert (with confirmation)',
            '',
            '*📊 Monitoring & Analytics*',
            '• `/status` — Bot health, lock, heartbeat, balance, and exchange status',
            '• `/positions` — View current open positions',
            '• `/trades` — Recent closed trades (last 24 hours)',
            '• `/excursions [symbol]` — Show MAE/MFE excursion stats for a symbol',
            '',
            '*🧠 Machine Learning Controls*',
            '• `/ml_status` — Model training status and sample count',
            '• `/ml_pause` — Temporarily pause ML training',
            '• `/ml_resume` — Resume ML training',
            '• `/ml_train` — Force immediate model retraining',
            '• `/ml_samples` — Training sample breakdown by symbol',
            '• `/ml_performance` — Overall strategy performance metrics',
            '',
            '*⚙️ System Control*',
            '• `/stopbot` — Emergency shutdown (releases lock, clears state)',
            '',
            '*ℹ️ Help*',
            '• `/start` or `/help` — Show this message',
            '',
            '👤 Only authorized administrators can use these commands.',
            '💡 Tip: Use inline keyboards during workflows for the best experience!',
        ].join('\n');

        await this.bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    };

    /**
 * Handles the /status command.
 *
 * Provides a comprehensive real-time health report including:
 *   • Worker lock status
 *   • Last heartbeat timestamp
 *   • Exchange connection state
 *   • Account balance
 *   • Trading mode indicator
 *
 * @param msg - Incoming Telegram message
 * @private
 */
    private handleStatus = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        try {
            const lockStatus = await dbService.getLock();
            const heartbeatData = await dbService.getHeartbeatCount();
            const balance = await this.exchange.getAccountBalance();
            const isLive = config.autoTrade.enabled;

            const lastHeartbeat = heartbeatData
                ? new Date(heartbeatData).toLocaleString()
                : 'Never';

            const statusLines = [
                '*📊 Bot Status Report*',
                '',
                `*Mode:* ${isLive ? '🟢 **LIVE TRADING**' : '🔵 Testnet / Paper Mode'}`,
                `*Worker:* ${lockStatus ? '🔒 Running (Locked)' : '🟢 Idle (Unlocked)'}`,
                `*Last Heartbeat:* ${lastHeartbeat}`,
                `*Exchange:* ${this.exchange.isInitialized() ? '✅ Connected' : '❌ Disconnected'}`,
                `*Balance:* $${balance?.toFixed(2) ?? 'N/A'} USDT`,
                '',
                '✅ All systems nominal',
            ];

            await this.bot.sendMessage(msg.chat.id, statusLines.join('\n'), { parse_mode: 'Markdown' });
        } catch (error: any) {
            logger.error('Error generating status report', { error });

            await this.bot.sendMessage(
                msg.chat.id,
                '❌ Unable to retrieve full status.\n\nSome services may be unavailable. Check logs for details.'
            );
        }
    };

    /**
 * Handles the /alerts command.
 *
 * Initiates the paginated view of all active custom alerts.
 * Sets workflow state and jumps directly to the list.
 *
 * @param msg - Incoming Telegram message
 * @private
 */
    private handleAlerts = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;

        // Set state for consistent pagination handling
        this.updateUserState(chatId, {
            mode: 'alerts',
            step: 'view_alerts',
            page: 0,
            lastActivity: Date.now(),
        });

        await this.sendAlertsList(chatId, 0);
    };

    /**
     * Handles the /create_alert command.
     *
     * Starts the multi-step alert creation wizard:
     *   1. Symbol selection
     *   2. Timeframe
     *   3. Conditions
     *
     * Validates exchange readiness before beginning.
     *
     * @param msg - Incoming Telegram message
     * @private
     */
    private handleCreateAlertStart = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;

        try {
            const symbols = Array.from(this.exchange.getSupportedSymbols());

            if (symbols.length === 0) {
                await this.bot.sendMessage(
                    chatId,
                    '❌ Cannot start alert creation.\n\nExchange connection not ready or no trading pairs available.'
                );
                return;
            }

            // Initialize clean state for creation workflow
            this.updateUserState(chatId, {
                mode: 'create',
                step: 'select_symbol',
                data: { symbol: '', timeframe: '', conditions: [] },
                page: 0,
                lastActivity: Date.now(),
            });

            await this.bot.sendMessage(chatId, '🔔 *Create New Custom Alert*\n\nLet\'s begin! First, choose a trading pair:', {
                parse_mode: 'Markdown',
            });

            await this.sendSymbolSelection(chatId, 0);
        } catch (error: any) {
            logger.error('Failed to initiate alert creation', { error, chatId });
            await this.bot.sendMessage(
                chatId,
                '❌ Unable to start alert creation.\n\nPlease try again later or check exchange connection.'
            );
        }
    };

    /**
     * Handles the /edit_alert command.
     *
     * Initiates selection of an existing alert for modification.
     * Sets edit mode state and shows paginated selection menu.
     *
     * @param msg - Incoming Telegram message
     * @private
     */
    private handleEditAlertStart = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;

        this.updateUserState(chatId, {
            mode: 'edit',
            step: 'select_alert',
            page: 0,
            lastActivity: Date.now(),
        });

        await this.bot.sendMessage(chatId, '✏️ *Edit Existing Alert*\n\nSelect the alert you want to modify:', {
            parse_mode: 'Markdown',
        });

        await this.sendEditAlertSelection(chatId, 0);
    };

    /**
     * Handles the /delete_alert command.
     *
     * Initiates deletion workflow with confirmation.
     * Shows paginated list with delete buttons.
     *
     * @param msg - Incoming Telegram message
     * @private
     */
    private handleDeleteAlertStart = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;

        this.updateUserState(chatId, {
            mode: 'delete',
            step: 'delete_alert',
            page: 0,
            lastActivity: Date.now(),
        });

        await this.bot.sendMessage(
            chatId,
            '🗑️ *Delete Alert*\n\n⚠️ This action is permanent and cannot be undone.\n\nSelect an alert to remove:',
            { parse_mode: 'Markdown' }
        );

        await this.sendDeleteAlertSelection(chatId, 0);
    };

    /**
 * Handles the /ml_status command.
 *
 * Displays comprehensive ML model status:
 *   • Training paused/resumed state
 *   • Model loaded or fresh
 *   • Sample counts and readiness
 *
 * @param msg - Incoming Telegram message
 * @private
 */
    private handleMLStatus = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;

        try {
            const status = await this.mlService.getStatus();

            await this.bot.sendMessage(
                chatId,
                `**🤖 Machine Learning Status**\n\n${status}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error: any) {
            logger.error('Failed to retrieve ML status', { error, chatId });
            await this.bot.sendMessage(chatId, '❌ Unable to fetch ML status at this time.');
        }
    };

    /**
     * Handles the /takenstats command.
     * Displays statistics for simulations marked as `was_taken = true`.
     *
     * Usage:
     *   /takenstats                → overall stats across all symbols
     *   /takenstats BTC/USDT       → stats filtered to a specific symbol
     */
    private handleTakenStats = async (msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> => {
        // Early authorization check
        if (msg.chat.id.toString() !== this.authorizedChatId) {
            return;
        }

        // Extract optional symbol filter from command argument
        const symbolFilter = match?.[1]?.trim();

        try {
            // Fetch stats (with optional symbol filter)
            const stats = await dbService.getTakenSimulationStats({
                symbol: symbolFilter || undefined,
            });

            // Build message content
            const lines: string[] = [];

            // Header
            if (symbolFilter) {
                lines.push(`**Taken Trade Stats for ${this.escape(symbolFilter)}**`);
            } else {
                lines.push('**Taken Trade Statistics \\(All Symbols\\)**');
            }

            lines.push(`Total taken trades: **${this.escape(stats.totalTaken)}**`);

            if (stats.totalTaken === 0) {
                lines.push('');
                lines.push(this.escape('No taken trades have been recorded yet.'));
            } else {
                // Performance summary
                lines.push(`Wins: **${stats.wins}** \\(${this.formatPercent(stats.winRate, 1)}\\)`);
                lines.push(`Win rate: **${this.formatPercent(stats.winRate, 1)}**`);
                lines.push(`Average R\\-multiple: **${this.formatR(stats.avgRMultiple)}**`);
                lines.push(`Average PnL: **${this.escape((stats.avgPnL.toFixed(4)))}**`);
                lines.push(`Total realized PnL: **${this.escape(stats.totalPnL.toFixed(4))}**`);

                // Outcome distribution
                lines.push('');
                lines.push('**Outcome Breakdown**');
                lines.push(`• Take Profit: ${this.escape(stats.outcomes.tp)}`);
                lines.push(`• Partial TP:   ${this.escape(stats.outcomes.partial_tp)}`);
                lines.push(`• Stop Loss:    ${this.escape(stats.outcomes.sl)}`);
                lines.push(`• Timeout:      ${this.escape(stats.outcomes.timeout)}`);
            }

            // Timestamp / freshness note
            lines.push('');
            lines.push(`🕒 Updated: ${this.escape(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }))} WAT`);

            // Send formatted message
            await this.sendMessage(lines.join('\n'), {
                parse_mode: 'MarkdownV2',
            });

            logger.info('Sent taken stats response', {
                chatId: msg.chat.id,
                symbol: symbolFilter || 'all',
                totalTaken: stats.totalTaken,
            });
        } catch (error) {
            // Log detailed error for debugging
            logger.error('Failed to handle /takenstats command', {
                chatId: msg.chat.id,
                symbolFilter,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });

            // User-friendly error message
            await this.sendMessage(
                'Sorry, there was an error fetching the taken trade statistics.\n' +
                'Please check the logs or try again later.',
                { parse_mode: 'Markdown' }
            );
        }
    };

    /**
     * Handles the /takensymbols command.
     * Displays the top symbols ranked by number of taken (filtered/executed) simulations.
     *
     * Usage examples:
     *   /takensymbols          → shows top 10 symbols
     *   /takensymbols 5        → shows top 5 symbols
     *   /takensymbols 20       → shows top 20 symbols (clamped between 3–30)
     */
    private handleTakenSymbols = async (
        msg: TelegramBot.Message,
        match: RegExpExecArray | null
    ): Promise<void> => {
        // Security: only respond to authorized user
        if (msg.chat.id.toString() !== this.authorizedChatId) {
            return;
        }

        // Parse and clamp the optional limit argument (3–30, default 10)
        let limit = 10;
        if (match?.[1]) {
            const parsed = parseInt(match[1], 10);
            if (!isNaN(parsed)) {
                limit = Math.min(Math.max(3, parsed), 30);
            }
        }

        try {
            // Fetch top symbols from database
            const topSymbols = await dbService.getTakenStatsBySymbol(limit);

            // Prepare message content
            const lines: string[] = [
                `**Top ${limit} Symbols by Taken Trades**`,
                '',
            ];

            if (topSymbols.length === 0) {
                lines.push('No taken trades have been recorded yet\\.');
                lines.push(this.escape('Once some filtered trades occur, top performers will appear here.'));
            } else {
                // Build ranked list
                topSymbols.forEach((s, index) => {
                    const rank = index + 1;
                    const winRateStr = this.formatPercent(s.winRate, 1);
                    const avgRStr = this.formatR(s.avgR);

                    lines.push(
                        `${rank}\\. **${this.escape(s.symbol)}**` +
                        ` — ${this.escape(s.totalTaken)} trades` +
                        ` — Win rate: **${winRateStr}**` +
                        ` — Avg R: **${avgRStr}**`
                    );
                });

                // Optional footer note
                lines.push('');
                lines.push('Sorted by number of taken trades \\(descending\\)\\.');
            }

            // Add data freshness indicator
            lines.push('');
            lines.push(
                `🕒 Updated: ${this.escape(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }))} WAT`
            );

            // Send formatted response
            await this.sendMessage(lines.join('\n'), {
                parse_mode: 'MarkdownV2',
            });

            // Log success for usage tracking / debugging
            logger.info('Sent top taken symbols response', {
                chatId: msg.chat.id,
                requestedLimit: limit,
                returnedCount: topSymbols.length,
            });
        } catch (error) {
            // Detailed error logging
            logger.error('Failed to handle /takensymbols command', {
                chatId: msg.chat.id,
                requestedLimit: limit,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack?.slice(0, 300) : undefined,
            });

            // User-friendly error message
            await this.sendMessage(
                'Sorry, could not fetch the top symbols statistics right now.\n' +
                'Please check the logs or try again later.',
                { parse_mode: 'Markdown' }
            );
        }
    };

    /**
 * Handles the /takenvsall command.
 * Shows a quick comparison between:
 *   - Total number of closed simulations
 *   - Number of simulations marked as taken (filtered/executed)
 *   - Percentage of simulations that passed the excursion/regime filter
 *
 * Purpose: Helps evaluate how selective the filtering logic is.
 */
    private handleTakenVsAll = async (msg: TelegramBot.Message): Promise<void> => {
        // Early exit if not authorized user
        if (msg.chat.id.toString() !== this.authorizedChatId) {
            return;
        }

        try {
            // Fetch comparison counts from DB
            const counts = await dbService.getTakenVsTotalCount();

            // Build message content
            const lines: string[] = [
                '**Taken vs All Simulations**',
                '',
                `Total closed simulations: **${this.escape((counts.totalSims.toLocaleString()))}**`,
                `Taken \\(filtered/executed\\): **${this.escape(counts.takenSims.toLocaleString())}**`,
            ];

            // Only show percentage if we have valid data
            if (counts.totalSims > 0) {
                lines.push(
                    `Percentage taken: **${this.formatPercent(counts.takenPercentage, 1)}**`
                );
            } else {
                lines.push('Percentage taken: **N/A** \\(no simulations yet\\)');
            }

            lines.push('');

            // Interpretation / context
            if (counts.takenSims === 0) {
                lines.push('⚠️ No trades have passed the excursion filter yet\\.');
                lines.push('This could mean: limited data, strict regime rules, or no strong signals\\.');
            } else if (counts.takenPercentage < 20) {
                lines.push(this.escape('The filter is currently **very selective** (<20%).'));
                lines.push('This is good for quality — but may limit trade frequency\\.');
            } else if (counts.takenPercentage > 60) {
                lines.push(this.escape('The filter is **quite permissive** (>60%).'));
                lines.push('Consider tightening regime rules if too many weak trades are passing\\.');
            } else {
                lines.push('The filter is moderately selective — balanced approach\\.');
            }

            // Add freshness timestamp (helps user know data is current)
            lines.push('');
            lines.push(
                `🕒 Stats as of ${this.escape(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }))} WAT`
            );

            // Send the formatted message
            await this.sendMessage(lines.join('\n'), {
                parse_mode: 'MarkdownV2',
            });

            // Log successful response (useful for monitoring usage)
            logger.info('Sent taken vs all stats response', {
                chatId: msg.chat.id,
                totalSims: counts.totalSims,
                takenSims: counts.takenSims,
                takenPct: counts.takenPercentage.toFixed(1),
            });
        } catch (error) {
            // Detailed logging for debugging
            logger.error('Failed to handle /takenvsall command', {
                chatId: msg.chat.id,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack?.slice(0, 300) : undefined,
            });

            // User-friendly fallback message
            await this.sendMessage(
                'Sorry, could not fetch the taken vs all comparison right now.\n' +
                'Please check the logs or try again later.',
                { parse_mode: 'Markdown' }
            );
        }
    };

    /**
     * Handles the /ml_pause command.
     *
     * Pauses ongoing ML model training.
     * Provides confirmation and logs action.
     *
     * @param msg - Incoming Telegram message
     * @private
     */
    private handleMLPause = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;
        const username = msg.from?.username || msg.from?.first_name || 'unknown';

        try {
            this.mlService.pauseTraining();

            await this.bot.sendMessage(chatId, '⏸️ *ML training has been paused.*\n\nNew samples will be collected but no retraining will occur until resumed.');
            logger.info('ML training paused by user', { username, chatId });
        } catch (error: any) {
            logger.error('Error pausing ML training', { error, username });
            await this.bot.sendMessage(chatId, '❌ Failed to pause ML training.');
        }
    };

    /**
     * Handles the /ml_resume command.
     *
     * Resumes paused ML model training.
     *
     * @param msg - Incoming Telegram message
     * @private
     */
    private handleMLResume = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;
        const username = msg.from?.username || msg.from?.first_name || 'unknown';

        try {
            this.mlService.resumeTraining();

            await this.bot.sendMessage(chatId, '▶️ *ML training has been resumed.*\n\nRetraining will occur automatically when sufficient new samples are available.');
            logger.info('ML training resumed by user', { username, chatId });
        } catch (error: any) {
            logger.error('Error resuming ML training', { error, username });
            await this.bot.sendMessage(chatId, '❌ Failed to resume ML training.');
        }
    };

    /**
     * Handles the /ml_train command.
     *
     * Forces an immediate retraining of the ML model regardless of sample threshold.
     *
     * @param msg - Incoming Telegram message
     * @private
     */
    private handleMLForceTrain = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;
        const username = msg.from?.username || msg.from?.first_name || 'unknown';

        try {
            await this.bot.sendMessage(chatId, '🔄 *Forcing ML model retraining...*\n\nThis may take 30\\-90 seconds depending on sample count.');

            await this.mlService.forceRetrain();

            await this.bot.sendMessage(chatId, '✅ *ML model retraining completed successfully!*');
            logger.info('Forced ML retraining completed', { username, chatId });
        } catch (error: any) {
            logger.error('Error during forced ML training', { error, username });
            await this.bot.sendMessage(chatId, '❌ Failed to complete forced training.\n\nCheck logs for details.');
        }
    };

    /**
     * Handles the /ml_samples command.
     *
     * Shows a detailed breakdown of training samples by symbol.
     *
     * @param msg - Incoming Telegram message
     * @private
     */
    private handleMLSamples = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;

        try {
            const summary = await this.mlService.getSampleSummary();

            await this.bot.sendMessage(
                chatId,
                `**📈 Training Sample Summary**\n\n${summary}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error: any) {
            logger.error('Error fetching training sample summary', { error, chatId });
            await this.bot.sendMessage(chatId, '❌ Unable to retrieve sample summary.');
        }
    };

    /**
     * Handles the /ml_performance command.
     *
     * Displays overall strategy performance metrics derived from simulations.
     *
     * @param msg - Incoming Telegram message
     * @private
     */
    private handleMLPerformance = async (msg: TelegramBot.Message): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;

        try {
            const metrics = await this.mlService.getPerformanceMetrics();

            await this.bot.sendMessage(
                chatId,
                `**📊 Strategy Performance Metrics**\n\n${metrics}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error: any) {
            logger.error('Error fetching performance metrics', { error, chatId });
            await this.bot.sendMessage(chatId, '❌ Unable to retrieve performance metrics.');
        }
    };

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
 * Updates (or creates) a user's workflow state and refreshes activity timestamp.
 *
 * Purpose:
 *   • Centralizes all state mutations
 *   • Ensures `lastActivity` is always current (critical for stale cleanup)
 *   • Provides safe defaults for new users
 *
 * Used throughout multi-step workflows (alert creation, editing, pagination).
 *
 * @param chatId - Telegram chat ID of the user
 * @param newState - Partial state updates to merge
 * @private
 */
    private updateUserState(chatId: number, newState: Partial<AlertState>): void {
        // Retrieve existing state or initialize with clean defaults
        const currentState: AlertState = this.userStates.get(chatId) || {
            mode: 'create',                    // Default workflow mode
            step: '',
            data: {
                symbol: '',
                timeframe: '',
                conditions: [],
            },
            temp: undefined,
            alertId: undefined,
            page: 0,
            lastActivity: Date.now(),
        };

        // Merge updates and always refresh activity timestamp
        const updatedState: AlertState = {
            ...currentState,
            ...newState,
            // Ensure nested objects are properly merged
            data: {
                ...currentState.data,
                ...(newState.data || {}),
            },
            lastActivity: Date.now(),
        };

        // Store back in map
        this.userStates.set(chatId, updatedState);

        logger.debug('User state updated', {
            chatId,
            mode: updatedState.mode,
            step: updatedState.step,
            symbol: updatedState.data.symbol,
            conditionsCount: updatedState.data.conditions.length,
        });
    }

    /**
  * Handles the /excursions [symbol] command.
  *
  * Displays real-time pure directional excursion statistics for a symbol:
  *   • Total simulations (combined count for context only)
  *   • Breakdown: how many buys vs sells
  *   • Separate regime stats for Buy and Sell sides (no combined aggregates)
  *   • Individual simulation details: time ago, outcome, duration, MFE/MAE, time-to-excursions
  *
  * Pure directional 2026+ rules:
  *   - All stats (MFE/MAE/ratio/duration/outcomes) come exclusively from buy/sell aggregates
  *   - No combined MFE/MAE/ratio/win rate used — only total sample count shown for context
  *   - Shows both sides separately if they have data
  *   - Lists up to 10 most recent individual sims with full details
  *
  * @param msg - Telegram message object
  * @param match - RegExp match array (symbol from command)
  */
    private handleExcursions = async (msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> => {
        if (!this.isAuthorized(msg.chat.id)) return;

        const chatId = msg.chat.id;
        const symbolInput = match?.[1]?.trim().toUpperCase();

        // Robust MarkdownV2 escape
        const escape = (value: string | number | undefined): string => {
            if (value === undefined || value === null) return '';
            const str = String(value);
            return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
        };


        if (!symbolInput) {
            await this.bot.sendMessage(
                chatId,
                `*Usage:* \`/excursions BTC/USDT\`\n\nShows pure directional excursion stats and individual simulation details for a symbol\\.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        try {
            // Fetch current regime (cache with pure directional aggregates)
            const regime = excursionCache.getRegime(symbolInput);

            if (!regime || regime.recentSampleCount === 0) {
                await this.bot.sendMessage(
                    chatId,
                    `ℹ️ *No excursion data yet for ${escape(symbolInput)}*\n\nWaiting for first simulation to complete\\.`,
                    { parse_mode: 'Markdown' }
                );
                return;
            } ``

            const lines: string[] = [`**Excursion Analysis: ${symbolInput}** 📊`];

            // ── Total count (only combined field shown – for context) ──────────────────────
            const totalSims = regime.recentSampleCount;
            const buySims = regime.buy?.sampleCount ?? 0;
            const sellSims = regime.sell?.sampleCount ?? 0;

            lines.push(`Total recent sims: **${escape(totalSims)}** \\(Buys: ${escape(buySims)}, Sells: ${escape(sellSims)}\\)`);

            // ── BUY SIDE REGIME ─────────────────────────────────────────────────────────────
            if (regime.buy && regime.buy.sampleCount > 0) {
                const buy = regime.buy;
                const durMin = (buy.avgDurationMs / 60000).toFixed(1);
                const maeAbs = Math.abs(buy.mae);
                const ratioColor = buy.excursionRatio > 2.0 ? '🟢' : buy.excursionRatio < 1.0 ? '🔴' : '🟡';

                lines.push('');
                lines.push(`**Buy / Long Regime** \\(${escape(buy.sampleCount)} sims\\)`);
                lines.push(`MFE: **\\+${escape(buy.mfe.toFixed(2))}%**`);
                lines.push(`MAE: **\\-${escape(maeAbs.toFixed(2))}%**`);
                lines.push(`Ratio: **${escape(buy.excursionRatio.toFixed(2))}** ${ratioColor}`);
                lines.push(`Avg duration: **${escape(durMin)} min**`);

                const oc = buy.outcomeCounts;
                const total = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
                if (total > 0) {
                    const tpPct = ((oc.tp + oc.partial_tp) / total * 100).toFixed(0);
                    const slPct = (oc.sl / total * 100).toFixed(0);
                    lines.push(`Outcomes: **${escape(tpPct)}% wins** / **${escape(slPct)}% SL** / ${escape(oc.timeout)} timeouts`);
                }

                if (maeAbs >= 2.5) {
                    lines.push('⚠️ High drawdown risk on buy side');
                }
            } else {
                lines.push('');
                lines.push('**Buy / Long Regime:** No data yet');
            }

            // ── SELL SIDE REGIME ────────────────────────────────────────────────────────────
            if (regime.sell && regime.sell.sampleCount > 0) {
                const sell = regime.sell;
                const durMin = (sell.avgDurationMs / 60000).toFixed(1);
                const maeAbs = Math.abs(sell.mae);
                const ratioColor = sell.excursionRatio > 2.0 ? '🟢' : sell.excursionRatio < 1.0 ? '🔴' : '🟡';

                lines.push('');
                lines.push(`**Sell / Short Regime** \\(${escape(sell.sampleCount)} sims\\)`);
                lines.push(`MFE: **\\+${sell.mfe.toFixed(2)}%**`);
                lines.push(`MAE: **\\-${escape(maeAbs.toFixed(2))}%**`);
                lines.push(`Ratio: **${escape(sell.excursionRatio.toFixed(2))}** ${ratioColor}`);
                lines.push(`Avg duration: **${escape(durMin)} min**`);
                const oc = sell.outcomeCounts;
                const total = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
                if (total > 0) {
                    const tpPct = ((oc.tp + oc.partial_tp) / total * 100).toFixed(0);
                    const slPct = (oc.sl / total * 100).toFixed(0);
                    lines.push(`Outcomes: **${escape(tpPct)}% wins** / **${escape(slPct)}% SL** / ${escape(oc.timeout)} timeouts`);
                }

                if (maeAbs >= 2.5) {
                    lines.push('⚠️ High drawdown risk on sell side');
                }
            } else {
                lines.push('');
                lines.push('**Sell / Short Regime:** No data yet');
            }

            // ── INDIVIDUAL SIMULATION DETAILS ──────────────────────────────────────────────
            if (regime.historyJson && regime.historyJson.length > 0) {
                lines.push('');
                lines.push('**Recent Individual Simulations** \\(newest first\\)');

                const now = Date.now();
                regime.historyJson.forEach((entry, index) => {
                    const ageMs = now - entry.timestamp;
                    const ageMin = Math.floor(ageMs / 60000);
                    const ageStr = ageMin < 60 ? `${ageMin} min ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60} min ago`;

                    const durMin = (entry.durationMs / 60000).toFixed(1);
                    const mfeStr = `+${entry.mfe.toFixed(2)}%`;
                    const maeStr = `-${Math.abs(entry.mae).toFixed(2)}%`;

                    const timeToMFE = entry.timeToMFE_ms > 0 ? `${(entry.timeToMFE_ms / 1000).toFixed(0)}s` : 'n/a';
                    const timeToMAE = entry.timeToMAE_ms > 0 ? `${(entry.timeToMAE_ms / 1000).toFixed(0)}s` : 'n/a';

                    lines.push(`**\\#${index + 1}** ${escape(ageStr)} • ${escape(entry.direction.toUpperCase())} • ${escape(entry.outcome.toUpperCase())}`);
                    lines.push(`Duration: ${escape(durMin)} min • MFE: ${escape(mfeStr)} • MAE: ${escape(maeStr)}`);
                    lines.push(`Time to MFE: ${escape(timeToMFE)} • Time to MAE: ${escape(timeToMAE)}`);
                    lines.push('─');
                });
            } else {
                lines.push('');
                lines.push('No individual simulation details available yet\\.');
            }

            // ── FINAL MESSAGE ───────────────────────────────────────────────────────────────
            await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
        } catch (error: any) {
            logger.error('Error in /excursions command', { symbol: symbolInput, error });
            await this.sendMessage('❌ Failed to retrieve excursion statistics. Please try again later.');
        }
    };

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
     * Sends a formatted Telegram alert for a generated signal.
     *
     * UPDATED DESIGN (2026+ pure directional):
     *   • Receives FINAL adjusted TradeSignal from AutoTradeService (may be reversed)
     *   • Direction, SL/TP, confidence, reason[] are final (post-excursion)
     *   • Regime summary & individual sims are fetched fresh (always up-to-date)
     *   • Pure directional: all stats (MFE/MAE/ratio/duration/outcomes) from buy/sell aggregates only
     *   • No combined MFE/MAE/ratio/win rate — only total sample count for context
     *   • Shows both sides separately (transparency)
     *   • Lists all recent individual simulations (up to 10) with full details
     *   • Alert sent even in simulation-only mode or on skip (with "Skipped" note)
     *
     * @param symbol Trading pair (e.g. 'BTC/USDT')
     * @param signal FINAL adjusted TradeSignal (post-excursion)
     * @param price Current price at signal time
     * @param tradeExecuted Flag if a live order was placed (default: true)
     */
    public async sendSignalAlert(
        symbol: string,
        signal: TradeSignal,
        price: number,
        tradeExecuted: boolean = true
    ): Promise<void> {
        // Robust MarkdownV2 escape
        const escape = (value: string | number | undefined): string => {
            if (value === undefined || value === null) return '';
            const str = String(value);
            return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
        };

        const lines: string[] = [];

        // ── Top note if no live trade placed or skipped ────────────────────────────────
        if (!tradeExecuted) {
            lines.push('🔔 **SIGNAL ALERT ONLY** \\(auto\\-trade disabled or skipped\\)');
        }

        // ── Header with final direction + reversal tag ─────────────────────────────────
        const signalEmoji =
            signal.signal === 'buy' ? '🟢 LONG' :
                signal.signal === 'sell' ? '🔴 SHORT' : '🟡 HOLD';

        const wasReversed = signal.reason.some(r => r.includes('REVERSED') || r.includes('reverse'));

        lines.push(`**${signalEmoji} SIGNAL** ${wasReversed ? '↔️ REVERSED ' : ''}${escape(symbol)}`);
        lines.push(`**Price:** $${escape(price.toFixed(6))}`);

        // ── Confidence & key levels ────────────────────────────────────────────────────
        if (signal.confidence > 0) {
            lines.push(`**Confidence:** ${escape(signal.confidence.toFixed(1))}%`);
        }

        if (signal.mlConfidence !== undefined) {
            lines.push(`**ML Confidence:** ${escape(signal.mlConfidence.toFixed(1))}%`);
        }

        if (signal.stopLoss) {
            lines.push(`**SL:** $${escape(signal.stopLoss.toFixed(6))}`);
        }

        if (signal.takeProfit) {
            const rrApprox = signal.takeProfit && signal.stopLoss
                ? Math.abs((signal.takeProfit - price) / (price - signal.stopLoss)).toFixed(1)
                : 'N/A';

            lines.push(`**TP:** $${escape(signal.takeProfit.toFixed(6))} \\(≈${escape(rrApprox)}R\\)`);
        }

        if (signal.trailingStopDistance) {
            lines.push(`**Trailing:** ${escape(signal.trailingStopDistance.toFixed(6))}`);
        }

        // ── FETCH FRESH REGIME ─────────────────────────────────────────────────────────
        const regime = excursionCache.getRegime(symbol);

        if (!regime || regime.recentSampleCount === 0) {
            lines.push('');
            lines.push('**No recent regime data** – limited history');
        } else {
            // ── TOTAL SIMS CONTEXT (combined count only – no other combined stats) ──────
            const totalSims = regime.recentSampleCount;
            const buySims = regime.buy?.sampleCount ?? 0;
            const sellSims = regime.sell?.sampleCount ?? 0;

            lines.push('');
            lines.push(`**Total recent sims:** ${totalSims} \\(Buys: ${buySims}, Sells: ${sellSims}\\)`);

            // ── BUY / LONG SIDE ─────────────────────────────────────────────────────────
            if (regime.buy && regime.buy.sampleCount > 0) {
                const buy = regime.buy;
                const durMin = (buy.avgDurationMs / 60000).toFixed(1);
                const maeAbs = Math.abs(buy.mae);
                const ratioColor = buy.excursionRatio > 2.0 ? '🟢' : buy.excursionRatio < 1.0 ? '🔴' : '🟡';

                lines.push('');
                lines.push(`**Buy / Long Regime** \\(${buy.sampleCount} sims\\)`);
                lines.push(`MFE: **\\+${escape(buy.mfe.toFixed(2))}%**`);
                lines.push(`MAE: **\\-${escape(maeAbs.toFixed(2))}%**`);
                lines.push(`Ratio: **${escape(buy.excursionRatio.toFixed(2))}** ${ratioColor}`);
                lines.push(`Avg Duration: **${escape(durMin)} min**`);

                const oc = buy.outcomeCounts;
                const total = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
                if (total > 0) {
                    const tpPct = ((oc.tp + oc.partial_tp) / total * 100).toFixed(0);
                    const slPct = (oc.sl / total * 100).toFixed(0);
                    lines.push(`Outcomes: **${escape(tpPct)}% wins** / **${escape(slPct)}% SL** / ${escape(oc.timeout)} timeouts`);
                }

                if (maeAbs >= 2.5) lines.push('⚠️ High drawdown risk on buy side');

                // ← SL Streak warning
                if (regime.slStreakBuy && regime.slStreakBuy >= 2) {
                    const icon = regime.slStreakBuy >= 3 ? '🔥' : '⚠️';
                    lines.push(`${icon} **${regime.slStreakBuy} consecutive SL** on buy side`);
                }
            } else {
                lines.push('');
                lines.push('**Buy / Long Regime:** No data yet');
            }

            // ── SELL / SHORT SIDE ───────────────────────────────────────────────────────
            if (regime.sell && regime.sell.sampleCount > 0) {
                const sell = regime.sell;
                const durMin = (sell.avgDurationMs / 60000).toFixed(1);
                const maeAbs = Math.abs(sell.mae);
                const ratioColor = sell.excursionRatio > 2.0 ? '🟢' : sell.excursionRatio < 1.0 ? '🔴' : '🟡';

                lines.push('');
                lines.push(`**Sell / Short Regime** \\(${escape(sell.sampleCount)} sims\\)`);
                lines.push(`MFE: **\\+${escape(sell.mfe.toFixed(2))}%**`);
                lines.push(`MAE: **\\-${escape(maeAbs.toFixed(2))}%**`);
                lines.push(`Ratio: **${escape(sell.excursionRatio.toFixed(2))}** ${ratioColor}`);
                lines.push(`Avg Duration: **${escape(durMin)} min**`);
                const oc = sell.outcomeCounts;
                const total = oc.tp + oc.partial_tp + oc.sl + oc.timeout;
                if (total > 0) {
                    const tpPct = ((oc.tp + oc.partial_tp) / total * 100).toFixed(0);
                    const slPct = (oc.sl / total * 100).toFixed(0);
                    lines.push(`Outcomes: **${escape(tpPct)}% wins** / **${escape(slPct)}% SL** / ${escape(oc.timeout)} timeouts`);
                }

                if (maeAbs >= 2.5) lines.push('⚠️ High drawdown risk on sell side');

                // ← SL Streak warning
                if (regime.slStreakSell && regime.slStreakSell >= 2) {
                    const icon = regime.slStreakSell >= 3 ? '🔥' : '⚠️';
                    lines.push(`${icon} **${regime.slStreakSell} consecutive SL** on sell side`);
                }
            } else {
                lines.push('');
                lines.push('**Sell / Short Regime:** No data yet');
            }
        }

        // ── Strategy + Excursion Reasons (from passed extended array) ──────────────────
        if (signal.reason?.length > 0) {
            lines.push('');
            lines.push('**Signal Reasons & Excursion Notes:**');
            signal.reason.forEach(r => lines.push(`• ${escape(r)}`));
        }

        // ── Timestamp ────────────────────────────────────────────────────────────────
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        lines.push('');
        lines.push(`🕒 ${escape(timestamp)}`);

        // ── SEND MESSAGE ──────────────────────────────────────────────────────────────
        const message = lines.join('\n');

        try {
            await this.sendMessage(message, { parse_mode: 'MarkdownV2' });
            logger.info(`Signal alert sent for ${symbol} (${signal.signal}${wasReversed ? ' REVERSED' : ''})`, {
                tradeExecuted
            });
        } catch (err) {
            logger.error('Failed to send signal alert', {
                symbol,
                signal: signal.signal,
                error: err instanceof Error ? err.message : String(err)
            });
        }
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
 * Sends a message to the pre-configured authorized chat.
 *
 * Used throughout the bot for:
 *   • Trade signal alerts
 *   • Custom alert triggers
 *   • Command responses and confirmations
 *   • System notifications
 *
 * All messages are routed through this method to ensure:
 *   • Consistent logging
 *   • Centralized error handling
 *   • Single point of truth for the target chat ID
 *
 * @param message - The message content (supports MarkdownV2 if parse_mode is set)
 * @param options - Optional Telegram sendMessage options (e.g., parse_mode, reply_markup)
 * @throws {Error} Re-throws any Telegram API error for upstream handling
 */
    public async sendMessage(
        message: string,
        options?: TelegramBot.SendMessageOptions
    ): Promise<void> {
        try {
            await this.bot.sendMessage(this.authorizedChatId, message, options);

            // Log a short preview for traceability (avoid flooding logs with huge messages)
            const preview = message.length > 100 ? message.substring(0, 97) + '...' : message;
            logger.info('Telegram message sent successfully', {
                chatId: this.authorizedChatId,
                preview,
                hasMarkup: !!options?.reply_markup,
                parseMode: options?.parse_mode,
            });
        } catch (error: any) {
            logger.error('Failed to send message to Telegram', {
                chatId: this.authorizedChatId,
                errorMessage: error.message,
                errorCode: error.code,
                response: error.response?.body,
            });

            // Re-throw to allow callers to handle gracefully (e.g., retry or fallback)
            throw error;
        }
    }

    private formatPercent(value: number, decimals = 1): string {
        return this.escape(value.toFixed(decimals) + '%');
    }

    private formatR(value: number): string {
        return this.escape(value.toFixed(2) + 'R');
    }

    private escape = (value: string | number | undefined): string => {
        if (value === undefined || value === null) return '';
        const str = String(value);
        return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
    };
}
