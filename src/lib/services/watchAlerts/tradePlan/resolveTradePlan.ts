// src/lib/watchAlerts/tradePlan/resolveTradePlan.ts
// Declarative trade plan → real SL / TP / trailing prices at trigger time.

import { computeTrailingLevels } from '../../../utils/trailingStopUtils';
import type { ResolvedTradePlan, TradePlanSpec } from '../types';

/**
 * Resolve a TradePlanSpec into concrete prices using the live price + ATR.
 *
 * Side (buy/sell) determines placement, matching riskParams convention:
 *   buy  → SL below price, TP above
 *   sell → SL above price, TP below
 *
 * Trailing levels reuse computeTrailingLevels() — never reimplemented here.
 */
export function resolveTradePlan(
    plan: TradePlanSpec,
    price: number,
    atr: number
): ResolvedTradePlan {
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`resolveTradePlan: invalid price ${price}`);
    }
    if (!Number.isFinite(atr) || atr < 0) {
        throw new Error(`resolveTradePlan: invalid atr ${atr}`);
    }

    const isLong = plan.direction === 'buy';

    // --- Stop-loss distance ---
    let slDistance: number;
    if (plan.stopLoss.type === 'atr_multiple') {
        slDistance = atr * plan.stopLoss.value;
    } else {
        slDistance = price * (plan.stopLoss.value / 100);
    }

    // --- Take-profit distance ---
    let tpDistance: number;
    if (plan.takeProfit.type === 'percent') {
        tpDistance = price * (plan.takeProfit.value / 100);
    } else {
        // rr — multiple of the SL distance
        tpDistance = slDistance * plan.takeProfit.value;
    }

    const stopLoss = isLong ? price - slDistance : price + slDistance;
    const takeProfit = isLong ? price + tpDistance : price - tpDistance;

    let trailingStop: number | null = null;
    let trailingActivePrice: number | null = null;
    let trailingStopPct: number | null = null;

    if (plan.trailing) {
        const levels = computeTrailingLevels(price, plan.direction, {
            activationPct: plan.trailing.activationPct,
            givebackPct: plan.trailing.givebackPct,
        });
        trailingStop = levels.trailingStop;
        trailingActivePrice = levels.activePrice;
        trailingStopPct = levels.trailingStopPct;
    }

    const riskReward = slDistance > 0 ? tpDistance / slDistance : 0;

    return {
        direction: plan.direction,
        entryPrice: Number(price.toFixed(8)),
        stopLoss: Number(stopLoss.toFixed(8)),
        takeProfit: Number(takeProfit.toFixed(8)),
        trailingStop,
        trailingActivePrice,
        trailingStopPct,
        slDistance: Number(slDistance.toFixed(8)),
        tpDistance: Number(tpDistance.toFixed(8)),
        riskReward: Number(riskReward.toFixed(4)),
    };
}
