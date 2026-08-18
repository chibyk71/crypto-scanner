// src/lib/services/telegram/context.ts
// Shared dependency bag passed to every extracted handler / menu function

import type TelegramBot from 'node-telegram-bot-api';
import type { ExchangeService } from '../exchange';
import type { MLService } from '../mlService';
import type { AlertState } from './types';

/**
 * Explicit dependency context for Telegram handlers and menus.
 * Mirrors the `db: Db` pattern used by the database repositories:
 * every extracted function takes `ctx: TelegramContext` as its first parameter
 * and never uses `this`.
 */
export interface TelegramContext {
    bot: TelegramBot;
    exchange: ExchangeService;
    mlService: MLService;
    authorizedChatId: string;
    userStates: Map<number, AlertState>;
    isAuthorized(chatId: number): boolean;
    sendMessage(message: string, options?: TelegramBot.SendMessageOptions): Promise<void>;
    updateUserState(chatId: number, newState: Partial<AlertState>): void;
}
