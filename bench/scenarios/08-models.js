// Chapter 8: the model Euterpe's mind thinks with.
"use strict";

const { startSession, chat } = require("./lib");

module.exports = {
    id: "models",
    title: "8. Models",
    intro: "Choose Model, on each mind, before and during a session, and what happens when a model can't run.",
    scenarios: [
        {
            id: "choose-model-claude",
            title: "Choose Model, on Claude",
            summary: "Euterpe: Choose Model, with the setting empty (Euterpe's default).",
            world: {},
            async run(t) {
                t.run("euterpe.chooseModel");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                await t.screen("chooser", "The model chooser", "Claude Code's aliases for each family's latest model, the current one marked, and a way to name any other.");
                qp.pick(/Another Model/);
                const box = await t.input({ title: "Euterpe's Model" });
                await t.screen("another", "Another model", "A model name as `claude --model` takes it.");
                const v = await box.type("claude opus");
                await t.screen("invalid", "One word, please", `Its validation: "${v}".`);
                await box.type("claude-opus-5");
                box.accept();
                await t.wait(600);
                t.run("euterpe.chooseModel");
                await t.quickPick({ title: "Euterpe's Model" });
                await t.screen("named", "A model of the writer's own", "The model named is in the list now, as the current one.");
            },
        },
        {
            id: "switch-model",
            title: "Another model, mid-session",
            summary: "Choose Model during a session: the next turn runs on it.",
            world: {},
            async run(t) {
                await startSession(t);
                t.run("euterpe.chooseModel");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                qp.pick("Opus");
                await t.notification({ text: /from now on/ });
                await t.screen("switched", "Euterpe thinks with Opus from now on", "Claude Code takes the switch (the conversation carries over), and the setting follows.");
            },
        },
        {
            id: "switch-model-refused",
            title: "A model Claude Code refuses",
            summary: "The writer picks a model this account can't choose: Claude Code refuses the switch.",
            world: { claude: { refuseModels: ["fable"], refusal: "Model 'fable' isn't available on your plan." } },
            async run(t) {
                await startSession(t);
                t.run("euterpe.chooseModel");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                qp.pick("Fable");
                await t.notification({ text: /can't think with/ });
                await t.screen("refused", "Euterpe can't think with Fable", "With Claude Code's reason. The session stays on the model it had, and so does the setting.");
            },
        },
        {
            id: "switch-model-fails",
            title: "A model that takes the switch but can't run",
            summary: "Claude Code takes the switch, and the next turn fails on the model: Euterpe goes back.",
            world: {},
            async run(t) {
                await startSession(t);
                t.run("euterpe.chooseModel");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                qp.pick(/Another Model/);
                const box = await t.input({ title: "Euterpe's Model" });
                await box.type("claude-opus-9");
                box.accept();
                await t.notification({ text: /from now on/ });
                await t.overlay.do("openChat");
                await chat(t, "Ready?", { error: "There's an issue with the selected model (claude-opus-9). It may not exist or you may not have access to it. Run --model to pick a different model." }, { open: false });
                await t.notification({ text: /back on/ });
                await t.screen("back", "Back on Sonnet", "The turn runs again on the model before, and the setting goes back too.");
            },
        },
        {
            id: "choose-model-openai",
            title: "Choose Model, on OpenAI's API",
            summary: "On OpenAI's API (with a key): Euterpe's picks among OpenAI's models.",
            world: { provider: "openai", settings: { openaiBaseUrl: "https://api.openai.com/v1" }, secrets: { "euterpe.apiKey:https://api.openai.com": "sk-bench-1234" } },
            async run(t) {
                t.run("euterpe.chooseModel");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                await t.screen("chooser", "OpenAI's models", "Euterpe's three picks on OpenAI's API.");
                qp.pick(/Another Model/);
                await t.input({ title: "Euterpe's Model" });
                await t.screen("another", "Another model OpenAI's API knows", "");
            },
        },
        {
            id: "choose-model-other",
            title: "Choose Model, on another provider",
            summary: "On OpenRouter (any OpenAI-compatible API): its models are its own business, so there's nothing to pick from.",
            world: { provider: "openai", settings: { openaiBaseUrl: "https://openrouter.ai/api/v1" }, secrets: { "euterpe.apiKey:https://openrouter.ai": "sk-or-bench" } },
            async run(t) {
                t.run("euterpe.chooseModel");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                await t.screen("chooser", "Nothing to pick from", "Only the way to name one.");
                qp.pick(/Another Model/);
                await t.input({ title: "Euterpe's Model" });
                await t.screen("another", "The model, as the provider names it", "");
            },
        },
    ],
};
