// Chapter 10: Euterpe's mind on an OpenAI-compatible API, with the writer's own key.
"use strict";

const { HELLO, startSession, settingsInstead, chat } = require("./lib");

const OPENAI = "https://api.openai.com/v1";
const KEY = (origin, key) => ({ [`euterpe.apiKey:${origin}`]: key });
const api = (url, extra = {}) => ({ provider: "openai", settings: { openaiBaseUrl: url, ...(extra.settings || {}) }, secrets: extra.secrets ?? {}, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "settings" && k !== "secrets")) });

module.exports = {
    id: "api",
    title: "10. On an API, with a key",
    intro: "Euterpe's mind on OpenAI's API, OpenRouter, a model server on the writer's computer: keys, addresses, and what Euterpe says when the API says no.",
    scenarios: [
        {
            id: "api-first-session",
            title: "The first session on an API",
            summary: "OpenAI's API, no key yet: Euterpe's settings open where the key goes; then the session.",
            world: api(OPENAI),
            async run(t) {
                await settingsInstead(t, { selector: '[data-run="setApiKey"]' });
                await t.screen("no-key", "No key yet", "Euterpe's settings open at the choice of mind, where the key goes.");
                await t.webview.do("click", '[data-run="setApiKey"]');
                const box = await t.input({ title: /API Key/ });
                await t.screen("key", "The API key", "Hidden as it's typed, kept in VS Code's secret storage, sent only to the address it's for.");
                const v = await box.type("sk-proj abc");
                await t.screen("invalid", "One word, please", `Its validation: "${v}".`);
                await box.type("sk-proj-bench1234");
                box.accept();
                await t.webview.do("wait", ".key-set");
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const turn = await first;
                await t.overlay.ready();
                const answered = t.session.response();
                turn.reply({ ...HELLO, say: "Hey you. Inky, on OpenAI's API today. A benchmark post that admits the benchmark lied? I'm hooked." });
                await answered;
                await t.overlay.bubble();
                await t.screen("session", "A session on OpenAI's API", "In blue, in Inky.");
            },
        },
        {
            id: "api-local-session",
            title: "A model server on this computer",
            summary: "Ollama, on this computer: no key, and the writing stays here.",
            world: api("http://localhost:11434/v1", { settings: { openaiModel: "llama3.3:70b" } }),
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const turn = await first;
                await t.overlay.ready();
                turn.reply({ ...HELLO, say: "Hi! Running right here on your machine today." });
                await t.overlay.bubble();
                await t.screen("session", "A session on Ollama", "No key asked for.");
            },
        },
        {
            id: "api-address-problems",
            title: "An address that isn't one",
            summary: "euterpe.openaiBaseUrl isn't a web address, or isn't http(s).",
            world: api("api.openai.com/v1"),
            async run(t) {
                await settingsInstead(t);
                await t.screen("not-url", "Not a web address", "Euterpe's settings open at the choice of mind: the address, and what's wrong with it.");
                await t.set("openaiBaseUrl", "ftp://models.example.com/v1");
                await settingsInstead(t);
                await t.screen("not-http", "Not http or https", "");
            },
        },
        {
            id: "api-no-model",
            title: "Another provider, no model named",
            summary: "OpenRouter, with no model named: another provider has no default.",
            world: api("https://openrouter.ai/api/v1", { secrets: KEY("https://openrouter.ai", "sk-or-bench") }),
            async run(t) {
                await settingsInstead(t);
                await t.screen("settings", "Which model?", "Euterpe's settings open at the model, which asks for one.");
            },
        },
        {
            id: "set-api-key",
            title: "Set API Key",
            summary: "Euterpe: Set API Key… with no key yet, then with one: replace it, or forget it.",
            world: api("https://openrouter.ai/api/v1"),
            async run(t) {
                t.run("euterpe.setApiKey");
                const box = await t.input({ title: /API Key for OpenRouter/ });
                await t.screen("ask", "A key for OpenRouter", "Named for the provider, for its address only.");
                await box.type("sk-or-v1-bench");
                box.accept();
                await t.notification({ text: /has your key/ });
                await t.screen("kept", "Kept", "");
                t.run("euterpe.setApiKey");
                const qp = await t.quickPick({ title: /API Key/ });
                await t.screen("menu", "A key already there", "Replace it, or forget it.");
                qp.pick(/Forget/);
                const m = await t.modal({ text: /Forget your API key/ });
                await t.screen("forget", "Forget it?", "");
                m.click("Forget It");
            },
        },
        {
            id: "api-errors",
            title: "When the API says no",
            summary: "Every answer an API can refuse a turn with, as Euterpe says it in its chat.",
            world: api(OPENAI, { secrets: KEY("https://api.openai.com", "sk-proj-bench1234") }),
            async run(t) {
                await startSession(t, { hello: { ...HELLO, say: "Hey. On OpenAI's API today." } });
                await t.overlay.do("openChat");
                const cases = [
                    ["rate", { status: 429, type: "requests", code: "rate_limit_exceeded", message: "Rate limit reached for gpt-6.1-sol in organization org-bench on requests per min (RPM): Limit 500, Used 500." }, "rate-limiting", "Rate-limited", "Passing: Euterpe tries again at its next look."],
                    ["credit", { status: 429, type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." }, "out of credit", "Out of credit", ""],
                    ["denied", { status: 403, code: "unsupported_country_region_territory", message: "Country, region, or territory not supported." }, "turned the request down", "Turned down", ""],
                    ["no-api", { status: 404, message: "Invalid URL (POST /v1/responsess)" }, "no API there", "No API at that address", "A 404 that isn't about a model: the address is wrong."],
                    ["overflow", { status: 400, code: "context_length_exceeded", message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 141235 tokens." }, "can't read that much", "Too much to read", "The conversation is summarized and the turn tried again; if even that can't fit, Euterpe says so."],
                    ["server", { status: 500, message: "The server had an error while processing your request." }, "had trouble answering", "The API had trouble", ""],
                    ["other", { status: 400, code: "invalid_value", message: "Invalid value for 'temperature'." }, "refused Euterpe's request", "A request refused", "Anything else, with the API's own words."],
                ];
                for (const [key, error, expect, title, notes] of cases) {
                    if (key === "overflow") {
                        // too long for the model: Euterpe summarizes, then tries the turn again; here neither fits
                        const tt = await chat(t, "Read it all again?", undefined, { open: false });
                        t.mind.reply({ error }, { when: "summary" });
                        t.mind.reply({ error }, { when: "chat" });
                        tt.reply({ error });
                    } else {
                        await chat(t, `Try ${key}?`, { error }, { open: false });
                    }
                    await t.overlay.chat(expect, 30_000);
                    await t.screen(key, title, notes);
                }
                await chat(t, "And offline?", { network: "getaddrinfo ENOTFOUND api.openai.com" }, { open: false });
                await t.overlay.chat("couldn't reach", 30_000);
                await t.screen("offline", "Out of reach", "No answer at all (no network, a wrong host).");
            },
        },
        {
            id: "api-key-refused",
            title: "A key the API refuses",
            summary: "The key is wrong (or was revoked): every turn would fail, so the session ends.",
            world: api(OPENAI, { secrets: KEY("https://api.openai.com", "sk-proj-revoked") }),
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const turn = await first;
                await t.overlay.ready();
                const ended = t.session.ended();
                turn.reply({ error: { status: 401, code: "invalid_api_key", message: "Incorrect API key provided: sk-proj-****oked." } });
                await t.notification({ text: /refused Euterpe's API key/ });
                await ended;
                await t.screen("error", "The key is refused", "");
            },
        },
        {
            id: "api-model-unknown",
            title: "A model the API doesn't know",
            summary: "The first turn names a model the API doesn't have: the session ends; mid-session, Euterpe goes back to the model before.",
            world: api(OPENAI, { secrets: KEY("https://api.openai.com", "sk-proj-bench1234"), settings: { openaiModel: "gpt-9" } }),
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const turn = await first;
                await t.overlay.ready();
                const ended = t.session.ended();
                turn.reply({ error: { status: 404, code: "model_not_found", message: "The model `gpt-9` does not exist or you do not have access to it." } });
                await t.notification({ text: /doesn't know the model/ });
                await ended;
                await t.screen("at-start", "Unknown model, at the start", "");
                await t.set("openaiModel", "gpt-6.1-sol");
                await startSession(t, { hello: { ...HELLO, say: "Back on a model I know." } });
                t.run("euterpe.chooseModel");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                qp.pick(/Another Model/);
                const box = await t.input({ title: "Euterpe's Model" });
                await box.type("gpt-9-mini");
                box.accept();
                await t.notification({ text: /from now on/ });
                await t.overlay.do("openChat");
                await chat(t, "Ready?", { error: { status: 404, code: "model_not_found", message: "The model `gpt-9-mini` does not exist or you do not have access to it." } }, { open: false });
                await t.notification({ text: /back on/ });
                await t.screen("mid-session", "Unknown model, mid-session", "Euterpe goes back to the model before, and says so.");
            },
        },
        {
            id: "api-model-refused",
            title: "A model the key can't use",
            summary: "The API knows the model, but won't run it for this key (a project without access to it): the session ends.",
            world: api(OPENAI, { secrets: KEY("https://api.openai.com", "sk-proj-bench1234"), settings: { openaiModel: "gpt-6.1-sol-pro" } }),
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const turn = await first;
                await t.overlay.ready();
                const ended = t.session.ended();
                turn.reply({ error: { status: 403, code: "model_not_allowed", message: "Project `proj_8Hk2Lm` does not have access to model `gpt-6.1-sol-pro`." } });
                await t.notification({ text: /won't run Euterpe's mind/ });
                await ended;
                await t.screen("refused", "Refused for this key", "");
            },
        },
    ],
};
