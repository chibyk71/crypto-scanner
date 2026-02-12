// src/lib/services/cooldownService.ts
// =============================================================================
// COOLDOWN SERVICE – Centralized per-symbol cooldown management
//
// Purpose:
//   • Prevent signal/alert spam by enforcing minimum time between actions
//   • Support memory (fast, in-process) or database (persistent across restarts)
//   • Reusable across MarketScanner, Strategy, custom alerts, etc.
//
// Usage example:
//   if (await cooldownService.isActive(symbol)) return;
//   // ... process signal ...
//   await cooldownService.setCooldown(symbol);
// =============================================================================

import { createLogger } from '../logger';
import { config } from '../config/settings';
import { dbService } from '../db'; // only used if backend === 'database'

const logger = createLogger('CooldownService');

type CooldownBackend = 'memory' | 'database';

export interface CooldownEntry {
    symbol: string;
    expiry: number; // timestamp when cooldown ends
}

export class CooldownService {
    private readonly backend: CooldownBackend;
    private readonly defaultDurationMs: number;

    // Memory backend storage
    private memoryStore: Map<string, number> = new Map();

    constructor(
        backend: CooldownBackend = 'memory',
        defaultDurationMs: number = config.scanner?.signalCooldownMs ?? 8 * 60 * 1000
    ) {
        this.backend = backend;
        this.defaultDurationMs = defaultDurationMs;

        logger.info('CooldownService initialized', {
            backend: this.backend,
            defaultDurationMs: this.defaultDurationMs / 1000 / 60,
            unit: 'minutes',
        });

        // Optional: warm up from DB if using database backend
        if (this.backend === 'database') {
            this._warmupFromDb().catch(err => {
                logger.error('Failed to warmup cooldowns from DB', { error: err });
            });
        }
    }

    /**
     * Check if a symbol is currently under cooldown.
     * @param symbol Trading pair (e.g. 'BTC/USDT')
     * @returns true if cooldown is active (should skip), false otherwise
     */
    public async isActive(symbol: string): Promise<boolean> {
        const normalized = this._normalizeSymbol(symbol);

        if (this.backend === 'memory') {
            const expiry = this.memoryStore.get(normalized);
            if (!expiry) return false;
            const active = Date.now() < expiry;
            if (!active) this.memoryStore.delete(normalized); // clean up expired
            return active;
        }

        // Database backend
        try {
            const entry = await dbService.getCoolDown(normalized);
            if (!entry?.lastTradeAt) return false;

            const expiry = entry.lastTradeAt + this.defaultDurationMs;
            const active = Date.now() < expiry;

            if (!active) {
                // Optional: clean up expired entry
                await dbService.upsertCoolDown(normalized); // or delete if supported
            }

            return active;
        } catch (err) {
            logger.error('Failed to check cooldown in DB', { symbol: normalized, error: err });
            return false; // fail-open: better to allow than block everything
        }
    }

    /**
     * Activate cooldown for a symbol.
     * @param symbol Trading pair
     * @param durationMs Optional override duration (defaults to config value)
     */
    public async setCooldown(symbol: string, durationMs?: number): Promise<void> {
        const normalized = this._normalizeSymbol(symbol);
        const ms = durationMs ?? this.defaultDurationMs;
        const expiry = Date.now() + ms;

        if (this.backend === 'memory') {
            this.memoryStore.set(normalized, expiry);
            logger.debug(`Cooldown set (memory) for ${normalized} until ${new Date(expiry).toISOString()}`);
            return;
        }

        // Database backend
        try {
            await dbService.upsertCoolDown(normalized, Date.now()); // we store start time
            // Note: expiry is computed on read using defaultDurationMs
            // If you want variable durations per entry, extend the DB schema
            logger.debug(`Cooldown set (DB) for ${normalized} for ${ms / 1000 / 60} min`);
        } catch (err) {
            logger.error('Failed to set cooldown in DB', { symbol: normalized, error: err });
            // fail-open: log but don't throw
        }
    }

    /**
     * Clear cooldown for a symbol (or all if symbol omitted).
     * Useful for manual reset or testing.
     */
    public async clear(symbol?: string): Promise<void> {
        if (symbol) {
            const normalized = this._normalizeSymbol(symbol);

            if (this.backend === 'memory') {
                this.memoryStore.delete(normalized);
            } else {
                try {
                    await dbService.upsertCoolDown(normalized);
                } catch (err) {
                    logger.error('Failed to clear cooldown in DB', { symbol: normalized, error: err });
                }
            }
            logger.debug(`Cooldown cleared for ${normalized}`);
        } else {
            // Clear all – mostly useful in tests/dev
            if (this.backend === 'memory') {
                this.memoryStore.clear();
            } else {
                logger.warn('Clearing ALL cooldowns in database is not implemented for safety');
                // If really needed → add dbService.clearAllCoolDowns() later
            }
            logger.debug('All in-memory cooldowns cleared');
        }
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ──────────────────────────────────────────────────────────────────────────────

    private _normalizeSymbol(symbol: string): string {
        return symbol.trim().toUpperCase();
    }

    /**
     * Optional: Load active cooldowns from DB on startup (for database backend)
     * Currently just logs count – can be extended to populate memory cache
     */
    private async _warmupFromDb(): Promise<void> {
        if (this.backend !== 'database') return;

        try {
            // Assuming dbService has a method to get all active cooldowns
            // If not implemented yet, skip or add later
            logger.debug('Cooldown DB warmup skipped (method not implemented yet)');
            // Example future implementation:
            // const active = await dbService.getActiveCoolDowns();
            // logger.info(`Loaded ${active.length} active cooldowns from DB on startup`);
        } catch (err) {
            logger.warn('Cooldown DB warmup failed', { error: err });
        }
    }
}

// Singleton export – preferred usage pattern
export const cooldownService = new CooldownService(
    // You can make this configurable later, e.g. config.cooldown.backend ?? 'memory'
    'memory' // start with memory for simplicity & speed
);
