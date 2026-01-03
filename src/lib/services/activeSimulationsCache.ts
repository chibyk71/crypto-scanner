// src/lib/services/activeSimulationsCache.ts
import { createLogger } from '../logger';

const logger = createLogger('activeSimCache');

/**
 * In-memory store for currently running simulations' live excursion data
 * Key: signalId
 * Value: current interim state
 */
interface ActiveSimulationState {
    symbol: string;
    direction: 'long' | 'short';
    currentMfePct: number;     // positive
    currentMaePct: number;     // negative or zero
    startedAt: number;
    lastUpdated: number;
}

class ActiveSimulationsCache {
    private cache = new Map<string, ActiveSimulationState>();

    // Add or update a running simulation's interim state
    set(signalId: string, state: ActiveSimulationState): void {
        this.cache.set(signalId, { ...state, lastUpdated: Date.now() });
        logger.debug('Active sim cache updated', { signalId, symbol: state.symbol });
    }

    // Remove when simulation closes
    delete(signalId: string): void {
        this.cache.delete(signalId);
        logger.debug('Active sim removed from cache', { signalId });
    }

    // Get all active for a specific symbol
    getBySymbol(symbol: string): ActiveSimulationState[] {
        return Array.from(this.cache.values()).filter(s => s.symbol === symbol);
    }

    // Get one by signalId (for updates)
    get(signalId: string): ActiveSimulationState | undefined {
        return this.cache.get(signalId);
    }

    // Optional: cleanup very old entries (safety)
    cleanup(maxAgeMs = 60 * 60 * 1000 * 2): void { // 2 hours
        const now = Date.now();
        for (const [id, state] of this.cache.entries()) {
            if (now - state.lastUpdated > maxAgeMs) {
                this.cache.delete(id);
                logger.warn('Stale active sim removed from cache', { signalId: id, symbol: state.symbol });
            }
        }
    }
}

export const activeSimulationsCache = new ActiveSimulationsCache();
