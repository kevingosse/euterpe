// Chapter 12: Euterpe: Check Setup, on each mind, when all is well and when it isn't.
"use strict";

const LOGIN = "euterpe.chatgpt.login";
const ACCOUNT = { clientId: "app_euterpe_7Hk2Lm9Q", subject: "user-8Qm2fK", email: "writer@example.com" };
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const login = (expires = 3600_000) => JSON.stringify({ ...ACCOUNT, access: "plan-access-0", refresh: "plan-refresh-0", expires: Date.now() + expires, scopes: SCOPES });
const planState = { "chatgpt.hostId": "urn:uuid:5c1f0b1e-bench", "chatgpt.registration": { ...ACCOUNT } };

/**
 * Run Check Setup: its verdict, then (Show Details) its report. `hold`: first, the check while it
 * runs (the bench holds the API's answer about its models).
 */
async function check(t, key, title, notes, { hold = false } = {}) {
    if (hold) { t.world.spec.network = { ...(t.world.spec.network || {}), hold: ["/models"] }; }
    t.run("euterpe.checkSetup");
    if (hold) {
        await t.wait(800);
        await t.screen(`${key}-checking`, `${title}: checking`, "While the check runs (here, while the API lists its models), the status bar says so.");
        t.release("network");
    }
    const n = await t.notification({ text: /Euterpe('s setup| is all set)/, timeout: 40_000 });
    await t.screen(`${key}-verdict`, `${title}: the verdict`, notes);
    n.click("Show Details");
    await t.wait(700);
    await t.screen(`${key}-report`, `${title}: the report`, "The report, in the Euterpe log: one line per thing a session needs, ✓ or ✗.");
    return n;
}

module.exports = {
    id: "check-setup",
    title: "12. Check Setup",
    intro: "Euterpe: Check Setup checks everything a session needs, without starting one: on Claude, on an API, on a ChatGPT plan, when all is well and when it isn't.",
    scenarios: [
        {
            id: "check-claude-ok",
            title: "All good, on Claude",
            summary: "Claude Code installed and signed in (a Claude Max subscription), Electron downloaded, the model set to Opus.",
            world: { settings: { model: "opus" } },
            async run(t) { await check(t, "ok", "All set", "An information message when there's nothing to fix."); },
        },
        {
            id: "check-electron-only",
            title: "All good but the avatar's runtime",
            summary: "Electron isn't downloaded yet: the first session would offer to. Check Setup can download it now.",
            world: { electron: "missing" },
            async run(t) {
                t.run("euterpe.checkSetup");
                const n = await t.notification({ text: /except for its avatar runtime/, timeout: 40_000 });
                await t.screen("verdict", "All set, except for Electron", "With a button to download it now.");
                n.click("Show Details");
                await t.wait(700);
                await t.screen("report", "All set, except for Electron: the report", "");
                t.run("euterpe.checkSetup");
                const again = await t.notification({ text: /except for its avatar runtime/, timeout: 40_000 });
                again.click("Download Now");
                await t.progress({ title: /Downloading/ });
                await t.screen("downloading", "Downloading from Check Setup", "");
            },
        },
        {
            id: "check-claude-problems",
            title: "Problems, on Claude",
            summary: "A remote window, an untrusted folder, a Claude Code that's too old, a persona that isn't there.",
            world: { remote: "ssh-remote", trusted: false, claude: { version: "2.1.150" }, settings: { persona: "ghost" } },
            async run(t) { await check(t, "problems", "Four problems", "A warning when something's wrong: how many, and the first one."); },
        },
        {
            id: "check-claude-signed-out",
            title: "Claude Code isn't signed in",
            summary: "Claude Code is there, but signed out.",
            world: { claude: { auth: { loggedIn: false } } },
            async run(t) { await check(t, "signed-out", "Signed out", ""); },
        },
        {
            id: "check-claude-unknown",
            title: "Claude Code that won't say",
            summary: "Claude Code doesn't answer whether it's signed in (an older or odd build), with a config folder from the environment.",
            world: { claude: { noAuthAnswer: true }, env: { CLAUDE_CONFIG_DIR: "C:\\Users\\writer\\.claude-work" }, files: { "~/.claude-work/settings.json": "{}" } },
            async run(t) { await check(t, "unknown", "Can't tell", ""); },
        },
        {
            id: "check-claude-paths",
            title: "Paths that aren't there",
            summary: "euterpe.claudeConfigDir, euterpe.claudePath and euterpe.electronPath point at nothing.",
            world: { settings: { claudeConfigDir: "~/.claude-work", claudePath: "{home}/tools/claude.exe", electronPath: "{home}/tools/electron.exe" } },
            async run(t) { await check(t, "paths", "Paths", ""); },
        },
        {
            id: "check-claude-npm",
            title: "Claude Code from npm",
            summary: "Claude Code installed with npm (npm install -g), found through PATH.",
            world: { claude: { install: "npm" } },
            async run(t) { await check(t, "npm", "From npm", "Where Claude Code was found, and how it got there."); },
        },
        {
            id: "check-claude-missing",
            title: "No Claude Code at all",
            summary: "Claude Code isn't installed.",
            world: { claude: null },
            async run(t) { await check(t, "missing", "No Claude Code", ""); },
        },
        {
            id: "check-api-ok",
            title: "All good, on OpenAI's API",
            summary: "OpenAI's API, a key, the default model.",
            world: { provider: "openai", settings: { openaiBaseUrl: "https://api.openai.com/v1" }, secrets: { "euterpe.apiKey:https://api.openai.com": "sk-proj-bench" } },
            async run(t) { await check(t, "ok", "All set, on OpenAI's API", "The report says the API answers, and takes the key.", { hold: true }); },
        },
        {
            id: "check-api-problems",
            title: "Problems, on an API",
            summary: "No key yet; then OpenRouter with no model named, then with one it doesn't list; a key OpenAI refuses; an Ollama that isn't running; an address that isn't one.",
            world: { provider: "openai", settings: { openaiBaseUrl: "https://api.openai.com/v1" }, network: { offline: ["localhost:11434"] } },
            async run(t) {
                await check(t, "no-key", "No key", "");
                await t.set("openaiBaseUrl", "https://openrouter.ai/api/v1");
                await t.secret("euterpe.apiKey:https://openrouter.ai", "sk-or-bench");
                await check(t, "no-model", "No model", "");
                await t.set("openaiModel", "anthropic/claude-fable-9");
                await check(t, "unlisted", "A model it doesn't list", "");
                await t.set("openaiBaseUrl", "https://api.openai.com/v1");
                await t.secret("euterpe.apiKey:https://api.openai.com", "sk-proj-revoked");
                t.world.spec.openaiKeyRefused = true;
                await check(t, "refused", "A refused key", "");
                await t.set("openaiBaseUrl", "http://localhost:11434/v1");
                await t.set("openaiModel", "llama3.3:70b");
                await check(t, "unreachable", "A server that isn't running", "");
                await t.set("openaiBaseUrl", "localhost:1234");
                await check(t, "bad-url", "An address that isn't one", "");
            },
        },
        {
            id: "check-plan-ok",
            title: "All good, on a ChatGPT plan",
            summary: "Signed in, the plan's models listed, Euterpe's pick among them.",
            world: () => ({ provider: "openai", globalState: { ...planState }, secrets: { [LOGIN]: login() } }),
            async run(t) { await check(t, "ok", "All set, on the plan", ""); },
        },
        {
            id: "check-plan-problems",
            title: "Problems, on a ChatGPT plan",
            summary: "Not signed in; a sign-in that ended; a plan with no models; a model the plan doesn't offer; models that can't be listed; a sign-in that ends as the check renews it.",
            world: () => ({ provider: "openai", globalState: { ...planState } }),
            async run(t) {
                await check(t, "signed-out", "Not signed in", "");
                await t.secret(LOGIN, JSON.stringify({ ...ACCOUNT, ended: "Euterpe's ChatGPT sign-in has ended: it expired.", at: Date.now() - 3600_000 }));
                await check(t, "ended", "A sign-in that ended", "");
                await t.secret(LOGIN, login());
                t.world.spec.chatgpt = { models: [] };
                await check(t, "no-models", "No models", "");
                t.world.spec.chatgpt = {};
                await t.set("openaiModel", "gpt-9");
                await check(t, "not-offered", "A model the plan doesn't offer", "");
                await t.set("openaiModel", "");
                t.world.spec.chatgpt = { models: { status: 500, body: { detail: "Internal server error" } } };
                await check(t, "unlisted", "Models that can't be listed", "");
                t.world.spec.chatgpt = { refresh: "invalidated" };
                await t.secret(LOGIN, login(60_000));
                await check(t, "ends", "The sign-in ends as it's checked", "Renewing the sign-in, the check finds OpenAI won't renew it.");
            },
        },
    ],
};
