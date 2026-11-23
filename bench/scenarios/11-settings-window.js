// Chapter 11: Euterpe's settings window, in each state it can be in.
"use strict";

const { HELLO, startSession, BROKEN } = require("./lib");

const LOGIN = "euterpe.chatgpt.login";
const ACCOUNT = { clientId: "app_euterpe_7Hk2Lm9Q", subject: "user-8Qm2fK", email: "writer@example.com" };
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const signedIn = () => JSON.stringify({ ...ACCOUNT, access: "plan-access-0", refresh: "plan-refresh-0", expires: Date.now() + 3600_000, scopes: SCOPES });
const planState = { "chatgpt.hostId": "urn:uuid:5c1f0b1e-bench", "chatgpt.registration": { ...ACCOUNT } };

/** Open the settings window (at a section), and wait for it to draw. */
async function open(t, section) {
    t.run("euterpe.openSettings", ...(section ? [section] : []));
    await t.webview.do("wait", "#persona");
    await t.wait(400);
    if (section) { await t.webview.do("scroll", `#${section}`); }
}

module.exports = {
    id: "settings-window",
    title: "11. The settings window",
    intro: "Euterpe: Open Settings: its own window for its settings, section by section, on each mind, in each state a writer can find it in.",
    scenarios: [
        {
            id: "settings-tour",
            title: "The settings window, on Claude",
            summary: "The whole window, top to bottom, before any session, on Claude.",
            world: {},
            async run(t) {
                await open(t);
                await t.screen("top", "The top, and the personas", "Its header and state, the mind's switch (everything below follows it, colours included), the sections, then the personas: the current one framed. Every change saves at once.");
                await t.webview.do("scroll", "#mascot");
                await t.screen("mascot", "The mascot", "The body Euterpe wears, moving at its real size, going through its moods (named below it), then all the mascots. Pointing at one makes it look at you.");
                await t.webview.do("scroll", "#mind");
                await t.screen("mind", "The mind", "The model (Euterpe's picks, and any other by name) and the effort.");
                for (const effort of ["medium", "high", "xhigh"]) {
                    await t.webview.do("click", `[data-set="effort"][data-value="${effort}"]`);
                    await t.wait(500);
                    await t.screen(`effort-${effort}`, `Effort: ${effort}`, "Each effort says what it does, below the buttons.", { settle: 300 });
                }
                await t.webview.do("click", '[data-set="effort"][data-value="low"]');
                await t.webview.do("scroll", "#reading");
                await t.screen("reading", "Reading along", "How closely Euterpe reads, with what each level costs, and whether it follows you to other documents.");
                await t.webview.do("open-setup");
                await t.webview.do("scroll", "#setup");
                await t.wait(1500);
                await t.screen("setup", "Setup", "Folded until opened: the paths (with what's in use when they're empty, and the Claude Code a session would find), the debug console, and the tools for when something's off. Then the footer.");
            },
        },
        {
            id: "settings-personas",
            title: "Each persona, read in full",
            summary: "Read it, on each bundled persona: what it says to Euterpe.",
            world: {},
            async run(t) {
                await open(t);
                for (const id of ["cheeky", "coach", "drill-sergeant", "editor", "fan", "warm"]) {
                    await t.webview.do("click", `[data-read="${id}"]`);
                    await t.webview.do("scroll", `[data-read="${id}"]`, "center");
                    await t.screen(`read-${id}`, `The ${id} persona, read`, "A persona's words, as they'll go into Euterpe's instructions (headings shown as bold lines). Hide folds it again; Copy to edit… starts a persona of your own from it.");
                    await t.webview.do("click", `[data-read="${id}"]`);
                }
            },
        },
        {
            id: "settings-yours",
            title: "Personas and mascots of your own",
            summary: "The writer has a persona of their own (without a description yet), a mascot of their own, and one that doesn't hold up.",
            world: { files: { "~/.euterpe/personas/my-cheeky.md": "---\nname: My Cheeky\ndescription: \n---\nYour name is Euterpe. You tease, gently.\n", "~/.euterpe/mascots/smudge.json": BROKEN } },
            async run(t) {
                await open(t);
                await t.webview.do("scroll", ".grid-personas", "start");
                await t.screen("persona", "A persona of your own", "Marked \"yours\", with Edit rather than Copy to edit, and a line for when it has no description.");
                await t.webview.do("scroll", ".grid-mascots", "start");
                await t.screen("mascot", "A mascot that doesn't hold up", "A mascot file of the writer's that the engine can't draw: shown, with why, and can't be picked.");
            },
        },
        {
            id: "settings-persona-file",
            title: "A persona file in the way",
            summary: "euterpe.personaFile is set: a persona anywhere on disk wins over the ones listed. Then it points at a file that can't be read.",
            world: { files: { "~/Dropbox/euterpe/me.md": "---\nname: Mine\ndescription: The one I sync.\n---\nYou are blunt.\n" }, settings: { personaFile: "{home}/Dropbox/euterpe/me.md" } },
            async run(t) {
                await open(t);
                await t.screen("notice", "euterpe.personaFile wins", "A notice above the personas, with a way to stop using the file; no persona is framed as current.");
                await t.set("personaFile", require("path").join(t.world.home, "Dropbox", "euterpe", "gone.md"));
                await t.wait(800);
                await t.screen("broken", "A persona file that can't be read", "");
            },
        },
        {
            id: "settings-session",
            title: "The settings window during a session",
            summary: "During a session: which changes take effect at once, and which wait for the next session.",
            world: {},
            async run(t) {
                await startSession(t);
                await open(t);
                await t.screen("header", "Writing with you", "The header says a session is on; each field says when a change to it lands.");
                await t.webview.do("scroll", "#mascot");
                await t.screen("chips", "Changes at once, or from the next session", "");
                await t.webview.do("click", '[data-set="provider"][data-value="openai"]');
                await t.webview.do("top");
                await t.wait(800);
                await t.screen("other-mind", "The switch is for the next session", "Switching the mind during a session on Claude: the window shows the next session's settings, and says this one stays on Claude.");
            },
        },
        {
            id: "settings-starting",
            title: "The settings window while Euterpe is on the way",
            summary: "The header while a session starts.",
            world: { electron: "missing", electronDownload: { pauseAt: 0.3 } },
            async run(t) {
                await open(t);
                // (a session starts on the document in front: the draft, then back to the window)
                t.showTab("draft.md");
                t.run("euterpe.startSession");
                const dl = await t.modal({ text: /Electron/ });
                dl.click("Download");
                await t.progress({ title: /Downloading/ });
                t.showTab("Euterpe Settings");
                await t.wait(1000);
                await t.screen("starting", "On the way…", "");
                t.release("download");
            },
        },
        {
            id: "settings-restricted",
            title: "The settings window in Restricted Mode",
            summary: "The folder isn't trusted.",
            world: { trusted: false },
            async run(t) {
                await open(t);
                await t.screen("banner", "Restricted Mode", "The header's state, and a banner: everything works, but a session waits.");
            },
        },
        {
            id: "settings-workspace",
            title: "Settings a workspace sets",
            summary: "The folder's own settings (.vscode/settings.json) set the persona and the attention: a change there goes to the workspace.",
            world: { workspaceSettings: { persona: "editor", attention: "relaxed" } },
            async run(t) {
                await open(t);
                await t.screen("persona", "Set by this workspace", "A chip says so; its tooltip says where a change goes.");
                await t.webview.do("scroll", "#reading");
                await t.screen("attention", "Set by this workspace (attention)", "");
            },
        },
        {
            id: "settings-setup-problems",
            title: "Setup, when the paths are wrong",
            summary: "Every path setting set to something that isn't there (or isn't what it should be).",
            world: {
                files: { "~/euterpe-home": "not a folder" },
                settings: { homeDir: "{home}/euterpe-home", claudeConfigDir: "~/.claude-work", claudePath: "{home}/tools/claude.exe", electronPath: "{home}/tools/electron.exe", personaFile: "{home}/gone.md" },
            },
            async run(t) {
                await open(t);
                await t.webview.do("open-setup");
                await t.webview.do("scroll", "#setup");
                await t.wait(1200);
                await t.screen("problems", "Every path wrong", "What each path says when it's wrong. (Reset puts it back to the default.)");
            },
        },
        {
            id: "settings-setup-hints",
            title: "Setup, before the first session",
            summary: "Nothing downloaded or made yet, and no Claude Code to be found.",
            world: { electron: "missing", claude: null },
            async run(t) {
                await open(t);
                await t.webview.do("open-setup");
                await t.webview.do("scroll", "#setup");
                await t.wait(1500);
                await t.screen("hints", "What's in use, and what isn't there yet", "Euterpe's home made at the first session, Electron not downloaded yet, and why no Claude Code was found.");
            },
        },
        {
            id: "settings-browse",
            title: "Browse… for each path",
            summary: "Each path's Browse… button: the dialog's title.",
            world: {},
            async run(t) {
                await open(t);
                await t.webview.do("open-setup");
                await t.webview.do("scroll", "#setup");
                for (const key of ["homeDir", "claudeConfigDir", "claudePath", "electronPath", "personaFile"]) {
                    await t.webview.do("click", `[data-run="browse"][data-arg="${key}"]`);
                    const d = await t.dialog();
                    await t.screen(`browse-${key}`, `Browse for ${key}`, "The system's dialog (the bench's stand-in), with the title Euterpe gives it.");
                    d.cancel();
                }
            },
        },
        {
            id: "settings-validation",
            title: "Values the window refuses",
            summary: "A model name with a space (then one of the writer's own that holds up), an API address that isn't one.",
            world: {},
            async run(t) {
                await open(t, "mind");
                await t.webview.do("type", "#other-model", "claude sonnet", false);
                await t.webview.do("submit", "form.other-model");
                await t.wait(400);
                await t.screen("model", "A model name is one word", "The field refuses it (the browser's bubble, drawn by the bench).");
                await t.webview.do("type", "#other-model", "claude-sonnet-4-5-20250929", false);
                await t.webview.do("submit", "form.other-model");
                await t.wait(800);
                await t.screen("named", "A model of the writer's own", "One that isn't among the choices: it joins them, chosen.");
                await t.webview.do("click", '[data-set="provider"][data-value="openai"]');
                await t.webview.do("top");
                await t.webview.do("click", '[data-other-url="1"]');
                await t.webview.do("type", "#api-url", "openrouter.ai/api/v1");
                await t.wait(400);
                await t.screen("url", "An address that isn't one", "");
                await t.set("openaiBaseUrl", "openrouter.ai/api/v1");
                await t.wait(800);
                await t.webview.do("scroll", "#mind");
                await t.webview.do("click", '[data-run="listModels"]');
                await t.wait(800);
                await t.webview.do("top");
                await t.screen("url-saved", "An address that isn't one, saved", "Set in settings.json by hand: the window says what's wrong with it.");
                await t.webview.do("scroll", "#mind");
                await t.screen("url-list", "Listing its models can't work", "");
            },
        },
        {
            id: "settings-unknown-setting",
            title: "A setting VS Code doesn't know yet",
            summary: "VS Code still has an older version of Euterpe's settings (it was updated in place): a change can't be written until a reload.",
            world: { unknownSettings: ["avatarScale"] },
            async run(t) {
                await open(t, "mascot");
                await t.webview.do("click", '[data-set="avatarScale"][data-value="5"]');
                const n = await t.notification({ text: /doesn't know the setting/ });
                await t.screen("error", "Reload the window", "");
                n.click("Reload Window");
                await t.wait(6000);
            },
        },
        {
            id: "settings-plan",
            title: "The mind on a ChatGPT plan",
            summary: "OpenAI and others, on the plan (the default): signed out, signing in, signed in.",
            world: () => ({ provider: "openai", globalState: { ...planState } }),
            async run(t) {
                await open(t);
                await t.screen("top", "In blue, signed out", "Off Claude, the window wears Inky's blue (Clawd stays with Claude). Right under the mind's switch, the plan's account: not signed in yet.");
                await t.webview.do("scroll", "#mind");
                await t.screen("signed-out", "No models yet", "Not until the writer signs in.");
                await t.webview.do("top");
                await t.webview.do("click", '[data-run="signIn"]');
                const page = await t.browser.next({ url: /auth\.openai\.com/ });
                await t.wait(800);
                await t.screen("signing-in", "Signing in", "While the browser waits for the writer.");
                page.answer("allow");
                await t.wait(2500);
                page.close();
                await t.webview.do("top");
                await t.screen("signed-in", "Signed in", "Who's signed in, the way to the plan's usage settings and to sign out.");
                await t.webview.do("scroll", "#mind");
                await t.screen("models", "The plan's models", "Euterpe's pick among them, current.");
                await t.webview.do("scroll", "#reading");
                await t.screen("reading", "Reading along, on the plan", "What each look costs, on a plan.");
            },
        },
        {
            id: "settings-plan-problems",
            title: "The plan, when something's off",
            summary: "A sign-in that ended, and the plan's models that can't be listed.",
            world: () => ({ provider: "openai", globalState: { ...planState }, secrets: { [LOGIN]: JSON.stringify({ ...ACCOUNT, ended: "Euterpe's ChatGPT sign-in has ended: OpenAI didn't renew it, and asks you to log in again.", freshLogin: true, at: Date.now() - 3600_000 }) } }),
            async run(t) {
                await open(t);
                await t.screen("ended", "A sign-in that ended", "Why, in place of \"Not signed in yet\".");
                t.world.spec.chatgpt = { models: { status: 502, body: { detail: "Bad gateway" } } };
                await t.secret(LOGIN, signedIn());
                await t.wait(1500);
                await t.webview.do("scroll", "#mind");
                await t.screen("models-problem", "The plan's models can't be listed", "");
            },
        },
        {
            id: "settings-api",
            title: "The mind on an API",
            summary: "OpenAI's API: no key, then a key; OpenRouter, listing its models; a model server on this computer.",
            world: { provider: "openai", settings: { openaiBaseUrl: "https://api.openai.com/v1" } },
            async run(t) {
                await open(t);
                await t.screen("no-key", "OpenAI's API, no key yet", "Right under the mind's switch: the provider's presets, the key's line, and what the key is for.");
                await t.secret("euterpe.apiKey:https://api.openai.com", "sk-proj-bench");
                await t.wait(1200);
                await t.webview.do("top");
                await t.screen("key", "A key", "Change it, or forget it.");
                await t.webview.do("scroll", "#mind");
                await t.screen("models", "OpenAI's models", "Euterpe's picks among them.");
                await t.webview.do("top");
                await t.webview.do("click", '[data-set="openaiBaseUrl"][data-value="https://openrouter.ai/api/v1"]');
                await t.wait(1000);
                await t.webview.do("top");
                await t.screen("openrouter", "OpenRouter, no key yet", "");
                await t.webview.do("scroll", "#mind");
                await t.screen("openrouter-model", "OpenRouter, no model", "Another provider has no default model: the window says so.");
                await t.webview.do("click", '[data-run="listModels"]');
                await t.wait(1200);
                await t.screen("list-no-key", "Listing needs a key", "");
                await t.secret("euterpe.apiKey:https://openrouter.ai", "sk-or-bench");
                await t.wait(1000);
                await t.webview.do("click", '[data-run="listModels"]');
                await t.wait(1500);
                await t.webview.do("scroll", "#mind");
                await t.screen("listed", "Its models, listed", "Type in the field to search them.");
                await t.webview.do("top");
                await t.webview.do("click", '[data-set="openaiBaseUrl"][data-value="http://localhost:11434/v1"]');
                await t.wait(1000);
                await t.webview.do("top");
                await t.screen("ollama", "A model server on this computer", "No key, and the writing stays here.");
                await t.webview.do("scroll", "#reading");
                await t.screen("ollama-reading", "Reading along, on a local server", "");
            },
        },
        {
            id: "settings-api-lists",
            title: "Providers that don't list their models",
            summary: "OpenRouter's model list fails, or comes back empty: the writer names a model by hand.",
            world: { provider: "openai", settings: { openaiBaseUrl: "https://openrouter.ai/api/v1" }, secrets: { "euterpe.apiKey:https://openrouter.ai": "sk-or-bench" }, network: { models: { "openrouter.ai": { status: 503, body: { error: { message: "Service temporarily unavailable" } } } } } },
            async run(t) {
                await open(t, "mind");
                await t.webview.do("click", '[data-run="listModels"]');
                await t.wait(1500);
                await t.screen("failed", "The list fails", "");
                t.world.spec.network.models["openrouter.ai"] = [];
                await t.webview.do("click", '[data-run="listModels"]');
                await t.wait(1500);
                await t.screen("empty", "An empty list", "");
                await t.webview.do("type", "#other-model", "meta-llama/llama-3.3-70b-instruct", false);
                await t.webview.do("submit", "form.other-model");
                await t.wait(800);
                await t.webview.do("scroll", "#mind");
                await t.screen("named", "A model named by hand", "With nothing listed, the writer names the model themselves.");
            },
        },
    ],
};
