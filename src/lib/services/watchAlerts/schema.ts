// src/lib/watchAlerts/schema.ts
// Zod validation for pasted Watch Alert JSON — field-level errors only.

import { z } from 'zod';

import { config } from '../../config/settings';

import {
    ALLOWED_INDICATORS,
    ALLOWED_OPERATORS,
    ALLOWED_TIMEFRAMES,
    DEFAULT_EXPIRY_HOURS,
    MAX_CONDITION_TREE_DEPTH,
    MAX_EXPIRY_HOURS,
    MIN_EXPIRY_HOURS,
} from './constants';
import type { ConditionNode } from './types';

const indicatorEnum = z.enum(
    ALLOWED_INDICATORS as unknown as [string, ...string[]]
);
const timeframeEnum = z.enum(
    ALLOWED_TIMEFRAMES as unknown as [string, ...string[]]
);
const operatorEnum = z.enum(
    ALLOWED_OPERATORS as unknown as [string, ...string[]]
);

const targetSchema = z.union([
    z.number().finite(),
    z.string().min(1),
    z
        .tuple([z.number().finite(), z.number().finite()])
        .refine(([a, b]) => a < b, {
            message: 'range target must be [min, max] with min < max',
        }),
]);

/**
 * Leaf schema — indicator / timeframe / operator constrained to allow-lists.
 */
const leafSchema = z
    .object({
        indicator: indicatorEnum,
        period: z.number().int().positive().max(500).optional(),
        timeframe: timeframeEnum,
        operator: operatorEnum,
        target: targetSchema,
    })
    .strict();

/**
 * Recursive group schema with depth + non-empty refinements applied after parse.
 * Zod 4 supports z.lazy for recursive types.
 */
type ConditionInput =
    | z.infer<typeof leafSchema>
    | { op: 'AND' | 'OR'; conditions: ConditionInput[] };

const conditionNodeSchema: z.ZodType<ConditionInput> = z.lazy(() =>
    z.union([
        leafSchema,
        z
            .object({
                op: z.enum(['AND', 'OR']),
                conditions: z.array(conditionNodeSchema),
            })
            .strict(),
    ])
);

const stopLossSchema = z
    .object({
        type: z.enum(['atr_multiple', 'percent']),
        value: z.number().positive(),
    })
    .strict();

const takeProfitSchema = z
    .object({
        type: z.enum(['percent', 'rr']),
        value: z.number().positive(),
    })
    .strict();

const trailingSchema = z
    .object({
        activationPct: z.number().positive(),
        givebackPct: z.number().positive(),
    })
    .strict()
    .nullable();

const tradePlanSchema = z
    .object({
        direction: z.enum(['buy', 'sell']),
        stopLoss: stopLossSchema,
        takeProfit: takeProfitSchema,
        trailing: trailingSchema,
    })
    .strict();

/**
 * Top-level pasted JSON schema.
 * Symbol membership and tree-depth checks are applied as refinements so
 * callers receive specific field paths rather than a generic failure.
 */
export const watchAlertJsonSchema = z
    .object({
        symbol: z.string().min(1),
        thesis: z.string().min(1).max(300),
        confidence: z.enum(['low', 'medium', 'high']),
        expiryHours: z.number().positive().optional(),
        entry: conditionNodeSchema,
        invalidate: conditionNodeSchema.nullable(),
        tradePlan: tradePlanSchema,
    })
    .strict()
    .superRefine((data, ctx) => {
        // Symbol must be in the configured universe
        const symbols = config.symbols ?? [];
        if (!symbols.includes(data.symbol)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['symbol'],
                message: `symbol must be one of: ${symbols.join(', ')}`,
            });
        }

        // Clamp guidance — we still accept out-of-range and clamp later,
        // but reject non-finite / absurd values early
        if (data.expiryHours !== undefined) {
            if (
                data.expiryHours < MIN_EXPIRY_HOURS ||
                data.expiryHours > MAX_EXPIRY_HOURS
            ) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['expiryHours'],
                    message: `expiryHours must be between ${MIN_EXPIRY_HOURS} and ${MAX_EXPIRY_HOURS}`,
                });
            }
        }

        validateTree(data.entry, ['entry'], ctx);
        if (data.invalidate !== null) {
            validateTree(data.invalidate, ['invalidate'], ctx);
        }
    });

/**
 * Walk a condition tree collecting empty-group and depth violations.
 */
function validateTree(
    node: ConditionInput,
    path: (string | number)[],
    ctx: z.RefinementCtx,
    depth = 1
): void {
    if (depth > MAX_CONDITION_TREE_DEPTH) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `condition tree exceeds max depth of ${MAX_CONDITION_TREE_DEPTH}`,
        });
        return;
    }

    if ('op' in node && Array.isArray(node.conditions)) {
        if (node.conditions.length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, 'conditions'],
                message: 'group.conditions must not be empty',
            });
            return;
        }
        node.conditions.forEach((child, i) => {
            validateTree(child, [...path, 'conditions', i], ctx, depth + 1);
        });
    }
}

export type ParsedWatchAlertJson = z.infer<typeof watchAlertJsonSchema>;

/**
 * Parse and validate a raw JSON string.
 * Returns either the typed payload or a list of { field, message } errors.
 */
export function parseWatchAlertJson(raw: string):
    | { ok: true; data: ParsedWatchAlertJson }
    | { ok: false; errors: Array<{ field: string; message: string }> } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {
            ok: false,
            errors: [{ field: '', message: 'Body is not valid JSON' }],
        };
    }

    const result = watchAlertJsonSchema.safeParse(parsed);
    if (result.success) {
        return { ok: true, data: result.data };
    }

    const errors = result.error.issues.map((issue) => ({
        field: issue.path.length ? issue.path.join('.') : '',
        message: issue.message,
    }));
    return { ok: false, errors };
}

/** Clamp expiry hours to the allowed window; default when omitted */
export function clampExpiryHours(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
        return DEFAULT_EXPIRY_HOURS;
    }
    return Math.min(MAX_EXPIRY_HOURS, Math.max(MIN_EXPIRY_HOURS, Math.round(value)));
}

/** Narrow parsed condition nodes to the runtime ConditionNode type */
export function asConditionNode(node: ParsedWatchAlertJson['entry']): ConditionNode {
    return node as ConditionNode;
}
