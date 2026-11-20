// The models Euterpe offers to think with (Choose Model, the settings window), and how the writer
// knows them.

import { Provider } from "./providers";

export interface ModelChoice {
    /** What claude --model, or the API, gets. */
    id: string;
    name: string;
    detail: string;
}

/**
 * Euterpe's picks on Claude; any other model Claude Code knows works too (euterpe.model). Aliases,
 * which Claude Code resolves to the family's latest model: no version to keep up to date. No [1m]
 * suffix, which Claude Code refuses for an account without the 1M-token window.
 */
export const MODELS: readonly ModelChoice[] = [
    { id: "haiku", name: "Haiku", detail: "The quickest and cheapest: light company" },
    { id: "sonnet", name: "Sonnet", detail: "Quick, and thoughtful enough for most writing. Euterpe's default" },
    { id: "opus", name: "Opus", detail: "A more thoughtful reader and writer, slower and pricier" },
    { id: "fable", name: "Fable", detail: "The most thoughtful of all, and by far the most expensive" },
];
export const CLAUDE_DEFAULT_MODEL = "sonnet";

/**
 * Euterpe's picks on OpenAI's API (euterpe.openaiModel); any other model the API knows works too.
 * Another provider's models are its own: the writer names one. As OpenAI puts it (October 2026):
 * Astra for the best writing, 6.1 Sol to balance it with cost, Luna for many cheap requests.
 * Reading along is many requests, mostly cache reads, which are cheapest on 6.1 Sol: it's the
 * default.
 */
export const OPENAI_MODELS: readonly ModelChoice[] = [
    { id: "gpt-6-astra", name: "GPT-6 Astra", detail: "OpenAI's most thoughtful reader and writer, at five times the price" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", detail: "Nearly as thoughtful, quicker, and much cheaper. Euterpe's default" },
    { id: "gpt-6-luna", name: "GPT-6 Luna", detail: "The quickest and cheapest: light company" },
];
export const OPENAI_DEFAULT_MODEL = "gpt-6.1-sol";

/** The picks for a provider (OpenAI's are for its own API). */
export function modelsFor(provider: Provider): readonly ModelChoice[] {
    return provider === "claude" ? MODELS : OPENAI_MODELS;
}

/**
 * The model a session starts on when the setting is empty: Euterpe's default on Claude, or on
 * OpenAI's API. Another provider's: none, the writer names one.
 */
export function defaultModel(provider: Provider, openaiApi: boolean): string {
    return provider === "claude" ? CLAUDE_DEFAULT_MODEL : openaiApi ? OPENAI_DEFAULT_MODEL : "";
}

/** The same model, whatever the case, and with or without the [1m] suffix. */
export function sameModel(a: string, b: string): boolean {
    const base = (m: string) => m.trim().toLowerCase().replace(/\[1m\]$/, "");
    return base(a) === base(b);
}

/** A model as the writer knows it: "Sonnet", Euterpe's default for "" on Claude, else its name for the API. */
export function modelName(id: string, provider: Provider = "claude"): string {
    if (!id.trim()) { return provider === "claude" ? modelName(CLAUDE_DEFAULT_MODEL) : "no model yet"; }
    return modelsFor(provider).find((m) => sameModel(m.id, id))?.name ?? id.trim();
}
