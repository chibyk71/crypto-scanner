// src/lib/services/telegram/types.ts
// Shared types and constants for the Telegram bot controller

import type { Condition } from '../../../types';

/**
 * State interface for managing multi-step alert creation and editing workflows.
 * - Tracks the mode, step, and data for alert configuration.
 * - Includes pagination for symbol, alert, position, and trade selection.
 */
export interface AlertState {
    mode: 'create' | 'edit' | 'delete' | 'alerts' | 'positions' | 'trades';
    step:
        | 'select_symbol'
        | 'select_timeframe'
        | 'conditions_menu'
        | 'select_indicator'
        | 'enter_period'
        | 'select_operator'
        | 'select_target'
        | 'edit_menu'
        | 'select_alert'
        | 'delete_alert'
        | 'view_alerts'
        | 'view_positions'
        | 'view_trades'
        | '';
    data: {
        symbol: string;
        timeframe: string;
        conditions: Condition[];
    };
    temp?: Partial<Condition>;
    alertId?: string;
    page?: number;
    lastActivity: number;
}

/** Timeout for clearing stale user states (30 minutes). */
export const STATE_TIMEOUT_MS = 30 * 60 * 1000;

/** Page size for pagination (alerts, positions, trades). */
export const PAGE_SIZE = 5;
