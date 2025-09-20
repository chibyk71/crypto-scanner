// src/lib/service/telegram.ts

/**
 * Provides functionality for interacting with the Telegram Bot API.
 * The `node-telegram-bot-api` package is used to send messages, photos, and documents to Telegram chats.
 * @see https://www.npmjs.com/package/node-telegram-bot-api
 */
import TelegramBot from 'node-telegram-bot-api';

/**
 * Imports the application configuration, including Telegram-specific settings (bot token and chat ID).
 * The configuration is used to initialize the Telegram bot and target chat.
 */
import { config } from '../config/settings';

/**
 * Manages interactions with the Telegram Bot API, including sending messages, photos, and documents.
 * Encapsulates the Telegram bot instance and chat ID, ensuring a single point of control for Telegram communications.
 */
export class TelegramService {
    /**
     * The Telegram bot instance, initialized with the bot token from the configuration.
     * @private
     */
    private bot: TelegramBot;

    /**
     * The Telegram chat ID where messages, photos, and documents will be sent.
     * @private
     */
    private chatId: string;

    /**
     * Initializes the Telegram service by validating configuration and setting up the Telegram bot.
     * Ensures that the bot token and chat ID are provided in the configuration before proceeding.
     * The bot is configured in non-polling mode, suitable for sending messages without listening for incoming updates.
     * @throws {Error} If the Telegram bot token or chat ID is missing in the configuration.
     */
    constructor() {
        if (!config.telegram.token) {
            throw new Error('Telegram Bot token is missing in config');
        }
        if (!config.telegram.chatId) {
            throw new Error('Telegram chatId is missing in config');
        }

        this.chatId = config.telegram.chatId;

        // Initialize the Telegram bot with the provided token, disabling polling
        this.bot = new TelegramBot(config.telegram.token, { polling: false });
    }

    /**
     * Sends a text message to the configured Telegram chat.
     * Logs the success or failure of the operation to the console for debugging purposes.
     * @param message - The text message to send to the Telegram chat.
     * @returns {Promise<void>} A promise that resolves when the message is sent successfully.
     * @throws Logs an error to the console if the message fails to send, but does not throw an exception.
     * @example
     * typescript
     * const telegram = new TelegramService();
     * await telegram.sendMessage('Price alert: BTC/USDT reached $50,000!');
     *
     */
    async sendMessage(message: string): Promise<void> {
        try {
            await this.bot.sendMessage(this.chatId, message);
            console.log(`Telegram message sent: ${message}`);
        } catch (error) {
            console.error('Failed to send Telegram message:', error);
        }
    }

    /**
     * Sends a photo to the configured Telegram chat with an optional caption.
     * Logs the success or failure of the operation to the console for debugging purposes.
     * @param photoUrl - The URL of the photo to send.
     * @param caption - An optional caption to accompany the photo.
     * @returns {Promise<void>} A promise that resolves when the photo is sent successfully.
     * @throws Logs an error to the console if the photo fails to send, but does not throw an exception.
     * @example
     * typescript
     * const telegram = new TelegramService();
     * await telegram.sendPhoto('https://example.com/chart.png', 'BTC/USDT price chart');
     *
     */
    async sendPhoto(photoUrl: string, caption?: string): Promise<void> {
        try {
            await this.bot.sendPhoto(this.chatId, photoUrl, { caption });
            console.log(`Telegram photo sent: ${photoUrl}`);
        } catch (error) {
            console.error('Failed to send Telegram photo:', error);
        }
    }

    /**
     * Sends a document (e.g., PDF, text file) to the configured Telegram chat with an optional caption.
     * Logs the success or failure of the operation to the console for debugging purposes.
     * @param filePath - The file path or URL of the document to send.
     * @param caption - An optional caption to accompany the document.
     * @returns {Promise<void>} A promise that resolves when the document is sent successfully.
     * @throws Logs an error to the console if the document fails to send, but does not throw an exception.
     * @example
     * typescript
     * const telegram = new TelegramService();
     * await telegram.sendDocument('/path/to/report.pdf', 'Daily trading report');
     *
     */
    async sendDocument(filePath: string, caption?: string): Promise<void> {
        try {
            await this.bot.sendDocument(this.chatId, filePath, { caption });
            console.log(`Telegram document sent: ${filePath}`);
        } catch (error) {
            console.error('Failed to send Telegram document:', error);
        }
    }
}

