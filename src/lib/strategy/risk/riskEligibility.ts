// src/lib/strategy/risk/riskEligibility.ts
// =============================================================================
// RISK ELIGIBILITY
//
// Mechanical extraction from Strategy._isRiskEligible().
//
// This function performs a basic volatility sanity check using ATR as a
// percentage of the current price.
//
// IMPORTANT:
// The calculation and boundary conditions are preserved exactly from the
// original strategy.ts implementation.
// =============================================================================

import {
    MIN_ATR_PCT,
    MAX_ATR_PCT,
} from '../constants';

// =============================================================================
// RISK ELIGIBILITY: Basic volatility sanity check
// =============================================================================

/**
 * Quick filter to reject symbols with unrealistic ATR volatility.
 *
 * Called from:
 *   • determineSignal() – before final signal decision
 *
 * Purpose:
 *   • Avoid trades in dead-flat or hyper-volatile markets
 *   • Tighter bounds than general strategies (optimized for crypto scalping)
 *
 * @param price - Current market price
 * @param lastAtr - Latest ATR value
 * @returns true if volatility is in acceptable range
 */
export function isRiskEligible(
    price: number,
    lastAtr: number
): boolean {
    const atrPct = (lastAtr / price) * 100;

    return atrPct > MIN_ATR_PCT && atrPct < MAX_ATR_PCT;
}
