// src/lib/services/telegram/state/userStateManager.ts
// Encapsulates userStates Map, updateUserState, and stale-state cleanup timer

import type TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '../../../logger';
import { type AlertState, STATE_TIMEOUT_MS } from '../types';

const logger = createLogger('TelegramBot:state');

/**
 * Owns the multi-step workflow state Map and the periodic cleanup interval.
 * Instantiated once by TelegramBotController.
 */
export class UserStateManager {
    private readonly userStates: Map<number, AlertState> = new Map();
    private cleanupInterval: NodeJS.Timeout | null = null;

    get map(): Map<number, AlertState> {
        return this.userStates;
    }

    /**
     * Merges partial state updates for a chat and refreshes lastActivity.
     * Copied verbatim from the original TelegramBotController.updateUserState.
     */
    updateUserState(chatId: number, newState: Partial<AlertState>): void {
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
     * Starts periodic cleanup of stale user states.
     * - Removes states inactive for longer than STATE_TIMEOUT_MS.
     * - Sends the exact original timeout message to the user.
     * Interval: every 5 minutes (same as original).
     */
    startCleanup(bot: TelegramBot): void {
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            let cleanedCount = 0;

            this.userStates.forEach((state, chatId) => {
                if (now - state.lastActivity > STATE_TIMEOUT_MS) {
                    this.userStates.delete(chatId);
                    cleanedCount++;
                    bot.sendMessage(chatId, '⌛ Your previous command session timed out due to inactivity. Please start a new command.');
                }
            });

            if (cleanedCount > 0) {
                logger.info(`State cleanup completed. Removed ${cleanedCount} expired states.`);
            }
        }, 5 * 60 * 1000);
    }

    stopCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            logger.info('State cleanup interval cleared.');
        }
    }

    clear(): number {
        const size = this.userStates.size;
        this.userStates.clear();
        return size;
    }
}
