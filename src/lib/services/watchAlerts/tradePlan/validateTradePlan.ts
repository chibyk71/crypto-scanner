// src/lib/watchAlerts/tradePlan/validateTradePlan.ts
// Sanity gate at paste-in time using a snapshot ATR / price.

import { MAX_SL_DISTANCE_PCT, MIN_RR } from '../constants';
import type { TradePlanSpec } from '../types';

export interface TradePlanValidationResult {
    ok: boolean;
    reason?: string;
    /** Computed RR at validation time (when ok) */
    riskReward?: number;
    /** SL distance as fraction of price */
    slDistancePct?: number;
}

/**
 * Validate a declarative trade plan against a snapshot price + ATR.
 *
 * Rejects when:
 *   • SL / TP value is non-positive (already enforced by zod, double-check)
 *   • SL distance as % of price exceeds the 10% absolute cap (riskParams)
 *   • Computed RR < 1
 */
export function validateTradePlan(
    plan: TradePlanSpec,
    price: number,
    atr: number
): TradePlanValidationResult {
    if (!Number.isFinite(price) || price <= 0) {
        return { ok: false, reason: 'Invalid snapshot price for trade-plan validation' };
    }
    if (!Number.isFinite(atr) || atr <= 0) {
        return { ok: false, reason: 'Invalid snapshot ATR for trade-plan validation' };
    }

    if (plan.stopLoss.value <= 0) {
        return { ok: false, reason: 'stopLoss.value must be > 0' };
    }
    if (plan.takeProfit.value <= 0) {
        return { ok: false, reason: 'takeProfit.value must be > 0' };
    }

    // SL distance in price units
    let slDistance: number;
    if (plan.stopLoss.type === 'atr_multiple') {
        slDistance = atr * plan.stopLoss.value;
    } else {
        // percent
        slDistance = price * (plan.stopLoss.value / 100);
    }

    if (!Number.isFinite(slDistance) || slDistance <= 0) {
        return { ok: false, reason: `Computed SL distance is invalid: ${slDistance}` };
    }

    const slDistancePct = slDistance / price;
    if (slDistancePct > MAX_SL_DISTANCE_PCT) {
        return {
            ok: false,
            reason: `SL distance ${(slDistancePct * 100).toFixed(2)}% exceeds ${(MAX_SL_DISTANCE_PCT * 100).toFixed(0)}% absolute cap`,
            slDistancePct,
        };
    }

    // TP distance in price units
    let tpDistance: number;
    if (plan.takeProfit.type === 'percent') {
        tpDistance = price * (plan.takeProfit.value / 100);
    } else {
        // rr
        tpDistance = slDistance * plan.takeProfit.value;
    }

    if (!Number.isFinite(tpDistance) || tpDistance <= 0) {
        return { ok: false, reason: `Computed TP distance is invalid: ${tpDistance}` };
    }

    const riskReward = tpDistance / slDistance;
    if (riskReward < MIN_RR) {
        return {
            ok: false,
            reason: `Computed RR ${riskReward.toFixed(2)} is below minimum ${MIN_RR}`,
            riskReward,
            slDistancePct,
        };
    }

    return {
        ok: true,
        riskReward,
        slDistancePct,
    };
}
