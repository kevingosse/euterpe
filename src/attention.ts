// How closely Euterpe reads along (euterpe.attention). These are cost throttles, not behaviour:
// how often the mind gets a look, and how much of the session it keeps verbatim. Each look is a
// turn on the writer's Claude login, re-reading the whole conversation from the prompt cache, so
// fewer looks and a shorter conversation cost less; what a look *means* stays the mind's call.

export type AttentionLevel = "close" | "relaxed" | "light";

export interface Attention {
    /** Quiet this long after typing: a look. */
    pauseMs: number;
    /** During sustained typing, a look at least this often. */
    heartbeatMs: number;
    /** Never two looks closer than this. */
    minGapMs: number;
    /**
     * Claude Code's auto-compact window for the mind (it summarizes about 33k tokens short of it,
     * capped by the model's own window): every look re-reads the conversation, so its size is
     * the price of each one.
     */
    compactWindow: number;
    /** The system prompt's account of the cadence ("While they write, you look …"). */
    cadence: string;
}

export const ATTENTION: Record<AttentionLevel, Attention> = {
    close: {
        pauseMs: 1_500,
        heartbeatMs: 15_000,
        minGapMs: 5_000,
        compactWindow: 300_000,
        cadence: "every few seconds: at each breath they take, and at least every quarter of a minute when they type straight through. That keeps you right behind them, so a typo can go to your notes while it's still fresh.",
    },
    relaxed: {
        pauseMs: 4_000,
        heartbeatMs: 60_000,
        minGapMs: 15_000,
        compactWindow: 200_000,
        cadence: "when they stop for a few seconds, and at least every minute when they type straight through. That keeps you a sentence or two behind them.",
    },
    light: {
        pauseMs: 12_000,
        heartbeatMs: 240_000,
        minGapMs: 45_000,
        compactWindow: 120_000,
        cadence: "when they stop for a while, and every few minutes when they type straight through. You're often a paragraph behind them: catch up when you look.",
    },
};

/** The setting's level; anything unknown reads as the default, close. */
export function attentionFor(setting: string | undefined): Attention {
    return setting && Object.prototype.hasOwnProperty.call(ATTENTION, setting) ? ATTENTION[setting as AttentionLevel] : ATTENTION.close;
}
