/**
 * Provides functionality for interacting with the Telegram Bot API.
 * The `node-telegram-bot-api` package is used to send messages, photos, and documents to Telegram chats.
 * @see https://www.npmjs.com/package/node-telegram-bot-api
 */
import TelegramBot, { type SendMessageOptions } from 'node-telegram-bot-api';

/**
 * Imports the application configuration, including Telegram-specific settings (bot token and chat IDs).
 * The configuration is used to initialize the Telegram bot and target chats.
 */
import { config } from '../config/settings';

/**
 * Imports a logger utility to log Telegram-related events and errors.
 * The logger is configured with a context of 'TelegramService' for categorized logging.
 */
import { createLogger } from '../logger';

/**
 * Initializes a logger instance for Telegram-related logging.
 * Logs are tagged with the 'TelegramService' context for easy filtering and debugging.
 */
const logger = createLogger('TelegramService');

/**
 * Manages interactions with the Telegram Bot API, including sending messages, photos, and documents.
 * Encapsulates the Telegram bot instance and supports multiple chat IDs for flexible communication.
 * Operates in non-polling mode, suitable for sending notifications without listening for incoming updates.
 */
export class TelegramService {
    /**
     * The Telegram bot instance, initialized with the bot token from the configuration.
     * @private
     */
    private bot: TelegramBot;

    /**
     * The Telegram chat IDs where messages, photos, and documents will be sent.
     * Supports multiple chat IDs for broadcasting notifications.
     * @private
     */
    private chatId: string;

    /**
     * Initializes the Telegram service by validating configuration and setting up the Telegram bot.
     * Ensures that the bot token and at least one chat ID are provided in the configuration.
     * The bot is configured in non-polling mode, optimized for sending notifications.
     * @throws {Error} If the Telegram bot token or chat IDs are missing in the configuration.
     */
    constructor() {
        if (!config.telegram.token) {
            logger.error('Telegram Bot token is missing in config');
            throw new Error('Telegram Bot token is missing in config');
        }

        // Support both single chatId and chatIds array for backward compatibility
        if (config.telegram.chatId) {
            this.chatId = config.telegram.chatId;
        } else if (config.telegram.chatId) {
            this.chatId = config.telegram.chatId;
        } else {
            logger.error('Telegram chatId or chatIds array is missing in config');
            throw new Error('Telegram chatId or chatIds array is missing in config');
        }

        // Initialize the Telegram bot with the provided token, disabling polling
        this.bot = new TelegramBot(config.telegram.token, { polling: false });
        logger.info('TelegramService initialized', { chatIds: this.chatId });
    }

    /**
     * Sends a text message to all configured Telegram chats.
     * Logs the success or failure of the operation for each chat ID.
     * @param message - The text message to send to the Telegram chats.
     * @returns {Promise<void>} A promise that resolves when all messages are sent or errors are handled.
     * @example
     * ```typescript
     * const telegram = new TelegramService();
     * await telegram.sendMessage('Price alert: BTC/USDT reached $50,000!');
     * ```
     */
    async sendMessage(message: string, option?: SendMessageOptions): Promise<void> {
        try {
            await this.bot.sendMessage(this.chatId, message, option);
            logger.info('Telegram message sent', { chatId: this.chatId, message });
        } catch (error) {
            logger.error('Failed to send Telegram message', { chatId: this.chatId, message, error });
        }
    }

    /**
     * Sends a photo to all configured Telegram chats with an optional caption.
     * Logs the success or failure of the operation for each chat ID.
     * @param photoUrl - The URL of the photo to send.
     * @param caption - An optional caption to accompany the photo.
     * @returns {Promise<void>} A promise that resolves when all photos are sent or errors are handled.
     * @example
     * ```typescript
     * const telegram = new TelegramService();
     * await telegram.sendPhoto('https://example.com/chart.png', 'BTC/USDT price chart');
     * ```
     */
    async sendPhoto(photoUrl: string, caption?: string): Promise<void> {
        try {
            await this.bot.sendPhoto(this.chatId, photoUrl, { caption });
            logger.info('Telegram photo sent', { chatId: this.chatId, photoUrl, caption });
        } catch (error) {
            logger.error('Failed to send Telegram photo', { chatId: this.chatId, photoUrl, caption, error });
        }
    }
}
