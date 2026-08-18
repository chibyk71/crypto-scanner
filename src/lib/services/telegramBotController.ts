// src/lib/services/telegramBotController.ts
// Thin orchestrator — all handler/menu logic lives under src/lib/services/telegram/

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/settings';
import { createLogger } from '../logger';
import { ExchangeService } from './exchange';
import { MLService } from './mlService';
import type { TradeSignal } from '../../types';
import type { TelegramContext } from './telegram/context';
import { UserStateManager } from './telegram/state/userStateManager';

import { handleHelp, handleStatus, handleStopBot } from './telegram/handlers/helpStatus';
import { handleAlerts, handleCreateAlertStart, handleEditAlertStart, handleDeleteAlertStart } from './telegram/handlers/alertCrud';
import { handleMessage, handleCallbackQuery } from './telegram/handlers/alertWorkflow';
import {
    handleMLStatus, handleMLReload, handleExportTrainingData,
    handleMLPause, handleMLResume, handleMLForceTrain,
    handleMLSamples, handleMLPerformance,
} from './telegram/handlers/mlCommands';
import {
    handleTakenStats, handleTakenSymbols, handleTakenVsAll, handleExcursions,
} from './telegram/handlers/tradeAnalytics';
import { handlePositions, handleTrades } from './telegram/handlers/positionsTrades';
import { sendSignalAlert as sendSignalAlertImpl } from './telegram/signalAlert';

const logger = createLogger('TelegramBot');

/**
 * Manages the Telegram bot's interactive command interface.
 * - Operates in polling mode to listen for user commands and messages.
 * - Supports alert creation/editing/deletion, trading mode switching, ML training control, and performance monitoring.
 * - Integrates with ExchangeService for market data and MLService for model interactions.
 *
 * Handler/menu logic has been extracted to src/lib/services/telegram/{handlers,menus,state,utils}/.
 * This class retains construction, listener wiring, public API, and the TelegramContext factory.
 */
export class TelegramBotController {
    private bot: TelegramBot;
    private readonly authorizedChatId: string;
    private readonly stateManager: UserStateManager;

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
        this.stateManager = new UserStateManager();

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
        this.stateManager.startCleanup(this.bot);

        logger.info('TelegramBotController fully initialized and ready');
    }

    /**
     * Builds the TelegramContext bag passed to every extracted handler/menu.
     * Always returns the same userStates Map reference.
     */
    private getContext(): TelegramContext {
        return {
            bot: this.bot,
            exchange: this.exchange,
            mlService: this.mlService,
            authorizedChatId: this.authorizedChatId,
            userStates: this.stateManager.map,
            isAuthorized: (chatId: number) => this.isAuthorized(chatId),
            sendMessage: (message, options) => this.sendMessage(message, options),
            updateUserState: (chatId, newState) => this.stateManager.updateUserState(chatId, newState),
        };
    }

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
     * Wiring only — each listener delegates to an extracted handler function.
     * Order of registration is preserved exactly from the original.
     */
    private registerListeners(): void {
        // TEMP DEBUG — remove after fixing
        this.bot.on('message', (msg) => {
            console.log('=== INCOMING MESSAGE ===');
            console.log('From chat ID:', msg.chat.id);
            console.log('From user ID:', msg.from?.id);
            console.log('Text:', msg.text);
            console.log('Your configured TELEGRAM_CHAT_ID:', this.authorizedChatId);
            console.log('Match?', String(msg.chat.id) === this.authorizedChatId);
            console.log('========================');
        });
        // =================================================================
        // TELEGRAM COMMAND REGISTRATION – Centralized & Grouped
        // =================================================================

        // 1. Basic & Help Commands
        this.bot.onText(/\/start|\/help/, (msg) => handleHelp(this.getContext(), msg));

        // 2. System Status & Control
        this.bot.onText(/\/status/, (msg) => handleStatus(this.getContext(), msg));
        this.bot.onText(/\/stopbot/, (msg) => handleStopBot(this.getContext(), msg));

        // 3. Custom Alert Management
        this.bot.onText(/\/alerts/, (msg) => handleAlerts(this.getContext(), msg));
        this.bot.onText(/\/create_alert/, (msg) => handleCreateAlertStart(this.getContext(), msg));
        this.bot.onText(/\/edit_alert/, (msg) => handleEditAlertStart(this.getContext(), msg));
        this.bot.onText(/\/delete_alert/, (msg) => handleDeleteAlertStart(this.getContext(), msg));

        // 4. ML Model Control & Monitoring
        this.bot.onText(/\/ml_status/, (msg) => handleMLStatus(this.getContext(), msg));
        this.bot.onText(/\/ml_pause/, (msg) => handleMLPause(this.getContext(), msg));
        this.bot.onText(/\/ml_resume/, (msg) => handleMLResume(this.getContext(), msg));
        this.bot.onText(/\/ml_train/, (msg) => handleMLForceTrain(this.getContext(), msg));
        this.bot.onText(/\/ml_samples/, (msg) => handleMLSamples(this.getContext(), msg));
        this.bot.onText(/\/ml_performance/, (msg) => handleMLPerformance(this.getContext(), msg));
        this.bot.onText(/\/ml_reload/, (msg) => handleMLReload(this.getContext(), msg));
        this.bot.onText(/\/export_training_data/, (msg) => handleExportTrainingData(this.getContext(), msg));

        // 5. Live Trading & Position Monitoring
        this.bot.onText(/\/positions/, (msg) => handlePositions(this.getContext(), msg));
        this.bot.onText(/\/trades/, (msg) => handleTrades(this.getContext(), msg));

        // 6. Taken Trade Analytics (new performance stats for filtered trades)
        this.bot.onText(/\/takenstats(?:\s+(.+))?/, (msg, match) => handleTakenStats(this.getContext(), msg, match));
        this.bot.onText(/\/takensymbols(?:\s+(\d+))?/, (msg, match) => handleTakenSymbols(this.getContext(), msg, match));
        this.bot.onText(/\/takenvsall/, (msg) => handleTakenVsAll(this.getContext(), msg));

        // 7. Excursion & Regime Diagnostics
        this.bot.onText(/\/excursions(?:\s+(.+))?/, (msg, match) => handleExcursions(this.getContext(), msg, match));

        // =================================================================
        // 8. Global Event Listeners (non-command input)
        // =================================================================
        // Handles free-text input during multi-step workflows (e.g., entering period/target)
        this.bot.on('message', (msg) => handleMessage(this.getContext(), msg));

        // Handles all inline keyboard interactions (selections, pagination, actions)
        this.bot.on('callback_query', (query) => handleCallbackQuery(this.getContext(), query));

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
     * Sends a formatted Telegram alert for a generated signal.
     * Thin public delegation to the extracted implementation.
     * Called externally by AutoTradeService — signature must remain unchanged.
     */
    public async sendSignalAlert(
        symbol: string,
        signal: TradeSignal,
        price: number,
        regimeScore?: number,
        tradeExecuted: boolean = true
    ): Promise<void> {
        return sendSignalAlertImpl(this.getContext(), symbol, signal, price, regimeScore, tradeExecuted);
    }

    public stop(): void {
        this.bot.stopPolling();
        logger.info('Telegram Bot stopped polling.');
        this.stateManager.stopCleanup();
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
                messagePreview: message,
            });

            // Re-throw to allow callers to handle gracefully (e.g., retry or fallback)
            throw error;
        }
    }
}
