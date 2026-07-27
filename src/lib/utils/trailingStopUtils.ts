// src/lib/utils/trailingStopUtils.ts
// =============================================================================
// TRAILING STOP UTILITIES — LIVE/MANUAL EXECUTION ONLY
//
// Purpose:
//   • Compute trailing-stop activation price + giveback distance for a signal
//   • Used by: AutoTradeService (live order placement + Telegram alert display)
//              and simulateTrade.ts (counterfactual tracking only — never
//              triggers a simulated exit)
//
// Design notes:
//   • trailingStop is an ABSOLUTE PRICE DISTANCE, not a percentage — this is
//     the format Bybit's /v5/position/trading-stop endpoint requires for its
//     `trailingStop` param.
//   • There is deliberately NO hard-cap price here. The ceiling for a live
//     trailing trade is the signal's own ATR-derived `takeProfit` — dynamic
//     per-signal, not a fixed global percentage.
//   • activePrice is the exchange's `activePrice` param — trailing does
//     nothing until price reaches this level.
// =============================================================================

import { config } from '../config/settings';

export interface TrailingLevels {
    /** Price at which the trailing stop arms (Bybit's `activePrice` param) */
    activePrice: number;
    /** Giveback distance behind peak, as an ABSOLUTE PRICE VALUE (Bybit's `trailingStop` param) */
    trailingStop: number;
    /** Same giveback distance, as a % — for display/logging only */
    trailingStopPct: number;
}

/**
 * Computes trailing-stop activation price and giveback distance anchored to
 * a given price (typically entry price, or actual fill price for live orders).
 *
 * @param anchorPrice - Price to anchor the calculation to (entry or fill price)
 * @param side - 'buy' (long) or 'sell' (short) — determines direction of activePrice
 * @param opts - Optional overrides; defaults to config.strategy.trail* values
 */
export function computeTrailingLevels(
    anchorPrice: number,
    side: 'buy' | 'sell',
    opts: { activationPct?: number; givebackPct?: number } = {}
): TrailingLevels {
    const activationPct = opts.activationPct ?? config.strategy.trailActivationPct;
    const givebackPct = opts.givebackPct ?? config.strategy.trailGivebackPct;
    const isLong = side === 'buy';

    const activePrice = isLong
        ? anchorPrice * (1 + activationPct / 100)
        : anchorPrice * (1 - activationPct / 100);

    const trailingStop = anchorPrice * (givebackPct / 100);

    return {
        activePrice: Number(activePrice.toFixed(8)),
        trailingStop: Number(trailingStop.toFixed(8)),
        trailingStopPct: givebackPct,
    };
}
