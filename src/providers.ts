// Who Euterpe's mind runs on (euterpe.provider): Claude, through Claude Code and the writer's own
// Claude login; an OpenAI-compatible API: the writer's ChatGPT plan (Sign in with ChatGPT,
// chatgpt.ts), OpenAI's API, or another provider's, with the writer's own key; or the models the
// writer's GitHub Copilot plan offers in VS Code (copilot.ts). Claude Code is how a Claude
// subscription may be used at all; OpenAI lets open-source apps use a ChatGPT plan through its public
// API, an API needs no program in between, and VS Code lends Copilot's models to extensions, so
// those minds run in the extension (openaiMind.ts). vscode-free, for the tests.

export const PROVIDERS = ["claude", "openai", "copilot"] as const;
export type Provider = typeof PROVIDERS[number];

/** The setting's provider; anything else is Claude, the default. */
export function providerFor(setting: unknown): Provider {
    return setting === "openai" || setting === "copilot" ? setting : "claude";
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** An OpenAI-compatible API, as euterpe.openaiBaseUrl names it. */
export interface Endpoint {
    /** The API's base URL, as the SDK takes it. */
    baseURL: string;
    /** scheme://host[:port]: what an API key belongs to (a key is only ever sent where it was given for). */
    origin: string;
    /** OpenAI's own API, with an API key: Euterpe's picks among its models. */
    openai: boolean;
    /** The writer's ChatGPT plan: OpenAI's API too, signed in with ChatGPT rather than a key, on the models the plan offers. */
    chatgpt: boolean;
    /** A server on this computer, which needs no key. */
    local: boolean;
    /** How the writer knows it: "ChatGPT", "OpenAI API", "OpenRouter", "Ollama", or the host. */
    name: string;
}

/**
 * Providers the settings window offers in one click; any other OpenAI-compatible address works too.
 * The plan is the setting's default (""): it has no address of its own, being OpenAI's API too.
 */
export const PRESETS = [
    { id: "chatgpt", name: "ChatGPT", url: "", detail: "Your ChatGPT plan (Plus or Pro): sign in, no API key" },
    { id: "openai", name: "OpenAI API", url: OPENAI_BASE_URL, detail: "GPT models, billed to your OpenAI API key" },
    { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1", detail: "Hundreds of models from many labs, with one key" },
    { id: "ollama", name: "Ollama", url: "http://localhost:11434/v1", detail: "Models on this computer, no key needed" },
    { id: "lmstudio", name: "LM Studio", url: "http://localhost:1234/v1", detail: "Models on this computer, no key needed" },
] as const;

/** euterpe.openaiBaseUrl, understood ("" = the ChatGPT plan). Throws when it isn't an http(s) URL. */
export function endpointFor(setting: string | undefined): Endpoint {
    const raw = (setting ?? "").trim();
    if (!raw) {
        return { baseURL: OPENAI_BASE_URL, origin: new URL(OPENAI_BASE_URL).origin, openai: false, chatgpt: true, local: false, name: "ChatGPT" };
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`euterpe.openaiBaseUrl is "${raw}", which isn't a web address (it should look like ${OPENAI_BASE_URL}).`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`euterpe.openaiBaseUrl is "${raw}": an http or https address, please.`);
    }
    const baseURL = url.href.replace(/\/+$/, "");
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(url.hostname);
    const openai = url.origin === "https://api.openai.com";
    const preset = PRESETS.find((p) => p.url && new URL(p.url).origin === url.origin);
    return { baseURL, origin: url.origin, openai, chatgpt: false, local, name: preset?.name ?? url.host };
}

/** Where an endpoint's key is kept, in VS Code's secret storage: one key per origin. */
export function secretName(origin: string): string {
    return `euterpe.apiKey:${origin}`;
}

/** Where the ChatGPT sign-in is kept, in VS Code's secret storage. */
export const CHATGPT_SECRET = "euterpe.chatgpt.login";
