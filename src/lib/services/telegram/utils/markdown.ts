// src/lib/services/telegram/utils/markdown.ts
// Canonical MarkdownV2 helpers — ONE copy for the entire telegram package.
// Do not duplicate these elsewhere. See project notes on the double-escaping footgun:
// any variable interpolated into a string later passed to escape() must remain raw.

/**
 * Escapes a value for Telegram MarkdownV2.
 * Characters escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escape(value: string | number | undefined): string {
    if (value === undefined || value === null) return '';
    const str = String(value);
    return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

/**
 * Formats a number as a percentage string and escapes it for MarkdownV2.
 */
export function formatPercent(value: number, decimals = 1): string {
    return escape(value.toFixed(decimals) + '%');
}

/**
 * Formats a number as an R-multiple string and escapes it for MarkdownV2.
 */
export function formatR(value: number): string {
    return escape(value.toFixed(2) + 'R');
}
