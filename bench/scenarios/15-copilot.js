// Chapter 15: Euterpe's mind on the models the writer's GitHub Copilot plan offers in VS Code.
"use strict";

const { HELLO, startSession, chat } = require("./lib");

/** On Copilot, signed in to it; `access`: VS Code's answer to Euterpe (undefined: it hasn't asked yet). */
const copilot = (extra = {}) => ({ provider: "copilot", ...extra });
const allowed = (extra = {}) => copilot({ copilot: { access: true }, ...extra });
const COPILOT_HELLO = { ...HELLO, say: "Hey you. Inky here, on your GitHub Copilot plan today. A benchmark post that admits the benchmark lied? I'm hooked." };
const CONSENT = /wants to access the language models/;

/** Open the settings window (at a section), and wait for it to draw. */
async function open(t, section) {
    t.run("euterpe.openSettings", ...(section ? [section] : []));
    await t.webview.do("wait", "#persona");
    await t.wait(400);
    if (section) { await t.webview.do("scroll", `#${section}`); }
}

/** Run Check Setup: its verdict (unless `report` only), then (Show Details) its report. */
async function check(t, key, title, notes, { verdict = true } = {}) {
    t.run("euterpe.checkSetup");
    const n = await t.notification({ text: /Euterpe('s setup| is all set)/, timeout: 40_000 });
    if (verdict) { await t.screen(`${key}-verdict`, `${title}: the verdict`, notes); }
    n.click("Show Details");
    await t.wait(700);
    await t.screen(`${key}-report`, `${title}: the report`, verdict ? "" : notes);
}

module.exports = {
    id: "copilot",
    title: "15. On GitHub Copilot",
    intro: "Euterpe's mind on the models the writer's GitHub Copilot plan offers in VS Code: no key, no sign-in of Euterpe's own. VS Code asks whether Euterpe may use them.",
    scenarios: [
        {
            id: "copilot-settings",
            title: "The settings window, on GitHub Copilot",
            summary: "The writer switches the mind to GitHub Copilot, not signed in to it yet; then signs in (Set Up Copilot…).",
            world: { copilot: null },
            async run(t) {
                await open(t);
                await t.webview.do("click", '[data-set="provider"][data-value="copilot"]');
                await t.wait(1000);
                await t.webview.do("top");
                await t.screen("switch", "GitHub Copilot", "The mind's third choice, in GitHub's purple. Right under it, Copilot as VS Code has it: not signed in yet, and the way to VS Code's Copilot setup.");
                await t.webview.do("scroll", "#mind");
                await t.screen("no-models", "No models yet", "Not until Copilot offers them.");
                await t.webview.do("top");
                await t.webview.do("click", '[data-run="setUpCopilot"]');
                const setup = await t.modal({ text: /Sign in to use AI Features/ });
                setup.click("Continue with GitHub");
                await t.wait(1500);
                await t.webview.do("top");
                await t.screen("signed-in", "Signed in", "As soon as VS Code has Copilot's models, with the GitHub account when VS Code has just one.");
                await t.webview.do("scroll", "#mind");
                await t.screen("models", "Copilot's models", "By Copilot's names; Euterpe's pick is Auto, where Copilot chooses the model. Effort, as on the other minds, with what happens when a model doesn't take it.");
            },
        },
        {
            id: "copilot-first-session",
            title: "The first session on GitHub Copilot",
            summary: "VS Code asks whether Euterpe may use Copilot's models; allowed, the session runs.",
            world: copilot(),
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const ask = await t.modal({ text: CONSENT });
                await t.screen("consent", "VS Code asks", "VS Code's own dialog at Euterpe's first request, with Euterpe's reason. Once allowed, it doesn't ask again.");
                ask.click("Allow");
                const turn = await first;
                await t.overlay.ready();
                const answered = t.session.response();
                turn.reply(COPILOT_HELLO);
                await answered;
                await t.overlay.bubble();
                await t.screen("session", "A session on Copilot", "In GitHub's purple, in Inky.");
                await chat(t, "Is the opening too long?", {
                    tools: [{ name: "propose_edit", args: { edits: [{ old_text: "Actually, it existed, but not where I thought, and not for the reason I thought.", new_text: "It existed, just not where I thought, or for the reason I thought." }] } }],
                    expression: "proud", say: "One sentence could go faster. In the diff.", notes: 0, action: null,
                });
                await t.until(() => t.tabs().some((x) => /Euterpe's edit/.test(x.label)), { what: "the diff" });
                await t.overlay.chat("In the diff");
                await t.screen("chat", "A chat, and an edit", "Euterpe's tools work on Copilot as elsewhere.");
            },
        },
        {
            id: "copilot-declined",
            title: "VS Code's question, declined",
            summary: "The writer cancels VS Code's dialog: Euterpe may not use the models, and the session ends.",
            world: copilot(),
            async run(t) {
                t.run("euterpe.startSession");
                const ask = await t.modal({ text: CONSENT });
                const ended = t.session.ended();
                ask.close();
                await t.notification({ text: /may not use GitHub Copilot's models/ });
                await ended;
                await t.screen("declined", "Declined", "Every turn would be refused: the session ends, and says how to go on.");
            },
        },
        {
            id: "copilot-no-models",
            title: "No Copilot here",
            summary: "Copilot offers no models (the writer isn't signed in to it): starting a session, then Choose Model.",
            world: copilot({ copilot: null }),
            async run(t) {
                t.run("euterpe.startSession");
                const n = await t.notification({ text: /offers Euterpe no models/ });
                await t.screen("start", "No models", "With the way to VS Code's Copilot setup.");
                n.click("Set Up Copilot");
                const setup = await t.modal({ text: /Sign in to use AI Features/ });
                await t.screen("setup", "VS Code's Copilot setup", "What Set Up Copilot opens: VS Code's own sign-in (the bench's stand-in).");
                setup.click("Skip for now");
                await setup.closed;
                t.run("euterpe.chooseModel");
                await t.notification({ text: /offers Euterpe no models/ });
                await t.screen("choose-model", "Choose Model, with no models", "The same, from Choose Model.");
            },
        },
        {
            id: "copilot-model-not-offered",
            title: "A model Copilot doesn't offer",
            summary: "euterpe.copilotModel names a model Copilot doesn't offer here (one the writer's plan doesn't include).",
            world: copilot({ settings: { copilotModel: "claude-opus-4.5" } }),
            async run(t) {
                t.run("euterpe.startSession");
                const n = await t.notification({ text: /doesn't offer the model/ });
                await t.screen("error", "Not offered", "With a way to Euterpe's settings.");
                n.click("Open Settings");
                await t.webview.do("wait", "#mind");
                await t.wait(800);
                await t.screen("settings", "Euterpe's settings, at the Mind", "The model named, among the ones Copilot offers.");
            },
        },
        {
            id: "copilot-choose-model",
            title: "Choose Model, on GitHub Copilot",
            summary: "Copilot's models, and no way to name another: Copilot runs only these.",
            world: copilot(),
            async run(t) {
                t.run("euterpe.chooseModel");
                await t.quickPick({ title: "Euterpe's Model" });
                await t.screen("chooser", "Copilot's models", "By Copilot's names, Euterpe's pick (Auto) current. No way to name another.");
            },
        },
        {
            id: "copilot-switch-model",
            title: "Another model, mid-session",
            summary: "Choose Model during a session on Copilot; the next turn fails on the new model: Euterpe goes back.",
            world: allowed(),
            async run(t) {
                await startSession(t, { hello: COPILOT_HELLO });
                t.run("euterpe.chooseModel");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                qp.pick("Gemini 3 Pro");
                await t.notification({ text: /from now on/ });
                await t.screen("switched", "Gemini 3 Pro from now on", "");
                await t.overlay.do("openChat");
                await chat(t, "Ready?", { error: { message: "The requested model is not supported." } }, { open: false });
                await t.notification({ text: /back on/ });
                await t.screen("back", "Back on the model before", "The turn runs again on it, and the setting goes back too.");
            },
        },
        {
            id: "copilot-errors",
            title: "When GitHub Copilot says no",
            summary: "Every way Copilot can refuse a turn, as Euterpe says it in its chat.",
            world: allowed(),
            async run(t) {
                await startSession(t, { hello: COPILOT_HELLO });
                await t.overlay.do("openChat");
                const cases = [
                    ["blocked", { code: "Blocked", message: "Sorry, you have been rate-limited. Please wait a moment before trying again." }, "limiting Euterpe", "Rate-limited", "VS Code's own refusal (Blocked). Euterpe tries again at its next look."],
                    ["quota", { message: "You've reached your monthly chat messages quota. Upgrade to Copilot Pro (30-day free trial) or wait for your allowance to renew." }, "usage limit", "Out of requests", "The plan's allowance is spent."],
                    ["off-topic", { message: "Response got filtered. Reason: off_topic" }, "off-topic", "Off-topic", "Copilot turns down what it doesn't take for programming."],
                    ["overflow", { message: "Request Failed: 400 prompt token count of 141235 exceeds the limit of 128000" }, "can't read that much", "Too much to read", "The conversation is summarized and the turn tried again; if even that can't fit, Euterpe says so."],
                    ["other", { message: "Sorry, your request failed. Please try again. Reason: Server error: 503" }, "couldn't answer", "Anything else", "With Copilot's own words."],
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
            },
        },
        {
            id: "copilot-check-ok",
            title: "Check Setup, all good",
            summary: "Copilot's models listed, Euterpe's pick among them, VS Code letting Euterpe use them.",
            world: allowed(),
            async run(t) { await check(t, "ok", "All set, on Copilot", "Copilot's models, and the one Euterpe would use.", { verdict: false }); },
        },
        {
            id: "copilot-check-declined",
            title: "Check Setup, access declined",
            summary: "The writer declined when VS Code asked whether Euterpe may use Copilot's models.",
            world: copilot({ copilot: { access: false } }),
            async run(t) { await check(t, "declined", "Access declined", ""); },
        },
    ],
};
