// The settings window's model: what it shows of Euterpe's settings (settingsPanel.ts gathers it,
// settings/settings.js draws it), and what it takes back. Every value from the window is checked
// here before it becomes a setting. vscode-free, for the tests.

import { ATTENTION } from "./attention";
import type { RuntimeStatus } from "./avatarRuntime";
import { isMascotId, Mascot } from "./mascots";
import { defaultModel, modelName, modelsFor, sameModel } from "./models";
import { isPersonaId, Persona } from "./personas";
import { Endpoint, PROVIDERS, Provider } from "./providers";
import type { StartedWith } from "./session";

/** The efforts Euterpe offers, of those claude --effort and the APIs take, as package.json lists them. */
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
/** Avatar sizes: screen pixels per art pixel. */
export const AVATAR_SCALES = [2, 3, 4, 5, 6] as const;
/** The settings that are paths on this computer (machine-scoped: the writer's own settings only). */
export const PATH_SETTINGS = ["homeDir", "claudeConfigDir", "claudePath"] as const;
export type PathSetting = typeof PATH_SETTINGS[number];
/** Settings the window leaves to VS Code's settings page: an Electron for a computer that can't download it. */
export const OUTSIDE_WINDOW = ["electronPath"] as const;
/** Settings only the writer's own settings hold: the paths, and where the API key and the writing go. */
export const MACHINE_SETTINGS = [...PATH_SETTINGS, "openaiBaseUrl"] as const;

const oneOf = <T>(list: readonly T[]) => (v: unknown): T | null => (list.includes(v as T) ? v as T : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
/** A path as typed: trimmed, one line, not absurdly long ("" = the default). */
const pathValue = (v: unknown): string | null => {
    if (typeof v !== "string") { return null; }
    const s = v.trim();
    return s.length <= 1024 && !/[\u0000-\u001f]/.test(s) ? s : null;
};

/** A model name: one word, no spaces (claude-sonnet-5-5, a Bedrock ARN, gpt-6.1-sol, meta-llama/llama-3.3-70b:free…). */
const modelValue = (v: unknown): string | null => {
    if (typeof v !== "string") { return null; }
    const s = v.trim();
    return s.length <= 200 && !/[\s\u0000-\u001f]/.test(s) ? s : null;
};
/** An API's base URL: http(s), one line ("" = OpenAI's). */
const urlValue = (v: unknown): string | null => {
    const s = pathValue(v);
    if (s === null || s === "") { return s; }
    try { return /^https?:$/.test(new URL(s).protocol) && s.length <= 500 ? s : null; } catch { return null; }
};

/** What each setting (euterpe.<key>) takes from the window: the value to store, or null when it isn't one. */
export const SETTINGS = {
    persona: (v: unknown) => (typeof v === "string" && isPersonaId(v) ? v : null),
    mascot: (v: unknown) => (typeof v === "string" && isMascotId(v) ? v : null),
    avatarScale: oneOf(AVATAR_SCALES as readonly number[]),
    provider: oneOf(PROVIDERS as readonly string[]),
    model: modelValue,
    openaiModel: modelValue,
    openaiBaseUrl: urlValue,
    copilotModel: modelValue,
    effort: oneOf(EFFORTS as readonly string[]),
    attention: oneOf(Object.keys(ATTENTION)),
    followActiveEditor: bool,
    debugMind: bool,
    homeDir: pathValue,
    claudeConfigDir: pathValue,
    claudePath: pathValue,
} satisfies Record<string, (v: unknown) => string | number | boolean | null>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue = string | number | boolean;

export function isSettingKey(key: unknown): key is SettingKey {
    return typeof key === "string" && Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

/** The value to store for `key`, or null if the window sent something that isn't one. */
export function checkSetting(key: unknown, value: unknown): { key: SettingKey; value: SettingValue } | null {
    if (!isSettingKey(key)) { return null; }
    const v = SETTINGS[key](value);
    return v === null ? null : { key, value: v };
}

// ---------- what the window shows ----------

export interface PersonaView {
    id: string;
    name: string;
    description: string;
    /** The persona's own words, as the mind reads them. */
    text: string;
    bundled: boolean;
}

export interface MascotView {
    id: string;
    name: string;
    description: string;
    /** The body as the mind hears it described. */
    body: string;
    bundled: boolean;
    /** The pack the window draws (null: Clawd, whom the engine draws by hand). */
    pack: Record<string, unknown> | null;
}

export interface ModelView {
    /** What euterpe.model (or openaiModel) holds ("" = the default). */
    id: string;
    name: string;
    detail: string;
}

/** The OpenAI-compatible API a mind on "openai" uses, as the window shows it. */
export interface ApiView {
    /** euterpe.openaiBaseUrl as written ("" = the ChatGPT plan). */
    value: string;
    /** What it comes to; null when it isn't a web address (`problem` says why). */
    endpoint: Endpoint | null;
    problem?: string;
    /** Its key, in VS Code's secret storage: set, missing, or not needed (a server on this computer). */
    key: "set" | "missing" | "local";
    /** On the ChatGPT plan: who's signed in (null: nobody yet). */
    account?: { email?: string } | null;
    /** Why the last ChatGPT sign-in ended, when it did (OpenAI wouldn't renew it) and nobody signed in since. */
    ended?: string;
    /** A ChatGPT sign-in is waiting for the writer in their browser. */
    signingIn?: boolean;
    /** Why the plan's models couldn't be listed. */
    modelsProblem?: string;
}

/** Claude Code as a session would find it: for the choice of mind, and Setup. */
export interface ClaudeFound {
    ok: boolean;
    /** Its version, when it's there. */
    version?: string;
    /** Nowhere Euterpe looks (rather than too old, or not what euterpe.claudePath names). */
    missing?: boolean;
    /** What Setup says: the one in use, or what's wrong. */
    text: string;
}

/** A path setting, as the window shows it. */
export interface PathView {
    value: string;
    /** What an empty value means, or what the value comes to (~ expanded). */
    hint: string;
    /** Something's off with it: it isn't there, or isn't what it should be. */
    problem?: string;
}

export interface SettingsState {
    /** Workspace Trust: without it, no session starts. */
    trusted: boolean;
    session: "none" | "starting" | "active";
    /** The avatar's runtime (Electron): the banner says how its download is going, until it's there. */
    runtime: RuntimeStatus;
    /** What the mind runs on, from the next session: the window wears its colours. */
    provider: Provider;
    /** What the running session's mind runs on, during one. */
    liveProvider?: Provider;
    api: ApiView;
    /** On GitHub Copilot: why it offers no models, when it doesn't (no Copilot here, or signed out of it); else the GitHub account, when VS Code is signed in to just one. */
    copilot?: { problem?: string; account?: string };
    values: Record<SettingKey, SettingValue>;
    /** Settings this workspace's own settings set: the window changes them there. */
    workspace: SettingKey[];
    personas: PersonaView[];
    /** The persona the next session gets (a missing one falls back). */
    persona: string;
    /** During a session: what it started with of the settings only the next one takes on. */
    live?: StartedWith;
    mascots: MascotView[];
    /** The body Euterpe wears now, or will at the next session. */
    mascot: string;
    /** The provider's default body: what a pack that doesn't hold up leaves on stage. */
    defaultMascot: string;
    models: ModelView[];
    /** What an empty model setting means: Euterpe's default on Claude and on OpenAI's API, its pick on a ChatGPT plan or GitHub Copilot, none elsewhere. */
    modelDefault: string;
    /** Why no session could start on the model as set: none named where there's no default, one GitHub Copilot doesn't offer, a plan that offers none. */
    modelProblem?: string;
    /** The model the mind runs on now, during a session. */
    liveModel?: string;
    paths: Record<PathSetting, PathView>;
    /** Euterpe's home: where the writer's own personas and mascots live. */
    home: string;
}

export const personaView = (p: Persona): PersonaView =>
    ({ id: p.id, name: p.name, description: p.description, text: p.body, bundled: p.bundled });

export const mascotView = (m: Mascot): MascotView =>
    ({ id: m.id, name: m.name, description: m.description, body: m.body, bundled: m.bundled, pack: m.pack });

/**
 * Why no session could start on the model as set (`chosen`: the provider's model setting), given
 * the models a plan or GitHub Copilot offers (`listed`); undefined when nothing's in the way. What the
 * mind itself needs (Claude Code, a key, a sign-in) is the provider's business, not the model's.
 */
export function modelProblem(provider: Provider, chosen: string, api: ApiView, listed?: readonly ModelView[]): string | undefined {
    const model = chosen.trim();
    if (provider === "copilot") {
        return listed?.length && model && !listed.some((m) => sameModel(m.id, model)) ? `GitHub Copilot doesn't offer the model ${model} here: choose another.` : undefined;
    }
    if (provider !== "openai" || !api.endpoint) { return undefined; }
    if (api.endpoint.chatgpt) {
        // (signed in, and the plan answered: a list that failed says so itself)
        return api.account && listed && !listed.length && !api.modelsProblem ? "Your ChatGPT plan offers Euterpe no models." : undefined;
    }
    return model || defaultModel("openai", api.endpoint.openai) ? undefined : `Name the model Euterpe should think with: ${api.endpoint.name} has no default.`;
}

/**
 * The models to choose from: Euterpe's picks (Claude's; OpenAI's on OpenAI's own API), or the
 * ones a ChatGPT plan or GitHub Copilot offers (`listed`), and the current one if it's none of them.
 * Another provider's models are its own business: there, only the one named.
 */
export function modelViews(current: string, provider: Provider = "claude", openaiApi = true, listed?: readonly ModelView[]): ModelView[] {
    const views: ModelView[] = provider === "claude"
        ? modelsFor("claude").map((m) => ({ id: m.id, name: m.name, detail: m.detail }))
        : listed ? [...listed]
        : provider === "openai" && openaiApi ? modelsFor("openai").map((m) => ({ id: m.id, name: m.name, detail: m.detail })) : [];
    if (current.trim() && !views.some((v) => sameModel(v.id, current))) {
        views.push({ id: current.trim(), name: modelName(current, provider), detail: provider === "copilot" ? "GitHub Copilot doesn't offer it here" : openaiApi ? "A model you named" : "The model you named" });
    }
    return views;
}
