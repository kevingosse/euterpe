// Chapter 4: during a session, on Claude.
"use strict";

const { startSession, chat } = require("./lib");

module.exports = {
    id: "session",
    title: "4. Writing with Euterpe",
    intro: "A session on Claude: the status bar, talking to Euterpe, its chat, notes and menus, what it says when its mind trips, and how a session ends.",
    scenarios: [
        {
            id: "session-status",
            title: "The status bar and the session's menu",
            summary: "Euterpe is with the writer: its status bar item, and the menu it opens.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.screen("status", "Euterpe is with you", "During a session, the item's tooltip says so, and how to talk to Euterpe.", { focus: "status-tooltip" });
                t.run("euterpe.sessionMenu");
                const qp = await t.quickPick({ text: "Euterpe" });
                await t.screen("menu", "The session's menu", "A click on the status bar item during a session opens this. (Accept and Reject join it while an edit waits: see Euterpe's edits.)");
                qp.hide();
            },
        },
        {
            id: "talk-box",
            title: "Talk to Euterpe, from the editor",
            summary: "Ctrl+K Ctrl+E (Talk to Euterpe): a question without leaving the editor.",
            world: {},
            async run(t) {
                await startSession(t);
                const turn = t.mind.turn({ kind: "chat" });
                t.run("euterpe.talk");
                const box = await t.input({ title: "Talk to Euterpe" });
                await t.screen("box", "Talk to Euterpe", "An input box over the editor: the keyboard stays in VS Code.");
                await box.type("Is the intro too long?");
                box.accept();
                const tt = await turn;
                await t.wait(800);
                await t.screen("thinking", "Euterpe thinks", "While the answer comes, Euterpe looks thoughtful. (The question goes to the chat's log, which isn't open.)");
                const answered = t.session.response();
                tt.reply({ expression: "thinking", say: "Not too long: too *slow*. The second paragraph is the hook. What if it came first?", notes: 0, action: null });
                await answered;
                await t.overlay.bubble();
                await t.screen("answer", "The answer", "In the bubble, since the chat is closed.");
            },
        },
        {
            id: "overlay-chat",
            title: "The chat",
            summary: "A click on Euterpe opens its chat: for longer exchanges, with what Euterpe says written out in Markdown.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.overlay.do("openChat");
                await t.screen("open", "The chat, open", "Its title, hints and buttons; the chat's log keeps what Euterpe said in its bubble. Its top and left edges resize it.");
                const turn = t.mind.turn({ kind: "chat" });
                await t.overlay.do("type", "Give me three ways to open the post.");
                const tt = await turn;
                await t.overlay.do("wait-thinking");
                await t.screen("thinking", "Euterpe thinks", "The writer's message, then the thinking dots.");
                const answered = t.session.response();
                tt.reply({
                    expression: "idea", action: null, notes: 0,
                    say: "Three ways in:\n\n1. **The number first**: \"The benchmark said 40% slower.\"\n2. *The confession*: \"I spent three days chasing a ghost.\"\n3. The question: what if your profiler is the one telling the truth?\n\nIf you want the first one as a sentence to start from:\n\n```\nThe benchmark said my new allocator was 40% slower. It was lying.\n```\n\nBenchmarkDotNet's docs on this: https://benchmarkdotnet.org/articles/guides/good-practices.html",
                });
                await answered;
                await t.wait(1500);
                await t.screen("answer", "An answer, in Markdown", "Lists, emphasis, a code block with its copy button (that's how a suggestion travels to the writer), and a link.");
                await t.overlay.do("copy-code");
                await t.screen("copied", "Copied", "The code block's button says so for a moment.", { settle: 150 });
                await t.overlay.do("click-link");
                await t.browser.next();
                await t.screen("link", "A link, followed", "A link in what Euterpe says opens in the browser.");
            },
        },
        {
            id: "notes-badge",
            title: "Notes Euterpe holds",
            summary: "Euterpe keeps its remarks for later, and says how many it holds: a badge by its head. A click asks for them.",
            world: {},
            async run(t) {
                await startSession(t);
                t.mind.reply({ expression: "smug", say: null, notes: 2, action: null }, { when: (x) => x.kind !== "chat" });
                await t.type(" Actually, I was wrong about that too.", { at: "end" });
                await t.wait(4000);
                await t.screen("badge", "Two notes", "The badge by Euterpe's head counts the notes it's holding back (its tooltip says what it's for).");
                const turn = t.mind.turn({ kind: "chat" });
                await t.overlay.do("badge");
                const tt = await turn;
                const answered = t.session.response();
                tt.reply({ expression: "smug", action: "shrug", notes: 0, say: "Two things. You wrote *actually* three times so far, and the heading promises a setup the paragraph never describes." });
                await answered;
                await t.wait(3000);
                await t.screen("notes", "The notes", "The chat opens, says the writer asked, and Euterpe's mind gets the request as a chat turn (see what it reads in the mind's panel).");
            },
        },
        {
            id: "overlay-menus",
            title: "Euterpe's menus",
            summary: "Right-clicks on Euterpe, on its words, and in its chat's input.",
            world: { files: { "~/AppData/Roaming/euterpe-overlay/window-state.json": { x: 380, y: 90, width: 560, height: 800 } } },
            async run(t) {
                await startSession(t);
                await t.overlay.do("menu");
                await t.screen("body", "Right-click on Euterpe", "Its menu. \"Default chat size\" shows because the chat was made bigger in an earlier session (the window remembers its place and size).");
                await t.overlay.do("pick", null);
                await t.overlay.do("text-menu", "#bubble-content");
                await t.screen("text", "Right-click on its words", "Copy what's selected (Euterpe's window usually doesn't have the keyboard, so the page's own copy can't).");
                await t.overlay.do("pick", null);
                await t.overlay.do("openChat");
                await t.overlay.do("selectAll", "a few words");
                await t.overlay.do("text-menu", "#chat-input", false);
                await t.screen("input", "Right-click in the chat's input", "Cut, Copy, Paste and Select All are Electron's own labels for its menu roles.");
                await t.overlay.do("pick", null);
            },
        },
        {
            id: "turn-errors",
            title: "When a turn fails",
            summary: "What Euterpe says, in its chat, when an answer doesn't come: an overloaded API, a usage limit, a turn that ran out of steps.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.overlay.do("openChat");
                await chat(t, "What do you think of the title?", { error: "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}" }, { open: false });
                await t.overlay.chat("Overloaded");
                await t.screen("api-error", "Claude Code's own error", "What Claude Code says goes to the chat as it is (cut at 300 characters), and Euterpe looks dizzy.");
                const at = Math.floor(Date.now() / 1000) + 2 * 3600;
                await chat(t, "Hello?", { error: `Claude AI usage limit reached|${at}` }, { open: false });
                await t.overlay.chat("usage limit");
                await t.screen("limit", "A usage limit", "Euterpe says when it'll be back. A look (not a chat) that hits the limit says so too, since it's something the writer needs to know.");
                await chat(t, "Still there?", { fail: { subtype: "error_max_turns", errors: ["Reached the maximum number of turns (40)"] } }, { open: false });
                await t.overlay.chat("max_turns");
                await t.screen("max-turns", "A turn that couldn't finish", "When Claude Code gives no words of its own: the kind of failure.");
            },
        },
        {
            id: "mind-crashes",
            title: "When the mind crashes",
            summary: "Claude Code crashes mid-answer: Euterpe resumes the conversation. After four crashes, it gives up.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.overlay.do("openChat");
                const ok = (n) => ({ expression: "happy", say: `Still here (${n}).`, notes: 0, action: null });
                await chat(t, "Can you hear me?", ok(1), { open: false });
                await chat(t, "And now?", { crash: 3221225477, stderr: ["thread 'main' panicked at 'index out of bounds'"] }, { open: false });
                await t.overlay.chat("hiccuped");
                await t.wait(1500);
                await t.screen("restarted", "Euterpe lost the thread", "The answer that was coming is lost (Euterpe asks to say it again), and the mind restarts on the same conversation.");
                for (let n = 2; n <= 4; n++) {
                    await t.wait(1500);
                    await chat(t, `Try ${n}?`, ok(n), { open: false });
                    await chat(t, `Crash ${n}?`, { crash: 1 }, { open: false });
                }
                await t.notification({ text: /crashed 4 times/, timeout: 30_000 });
                await t.wait(1500);
                await t.screen("gave-up", "Four crashes", "The session ends with the last thing Claude Code printed.");
            },
        },
        {
            id: "stuck-turn",
            title: "A turn that never ends",
            summary: "An answer that takes minutes: Euterpe lets it go, so the next ones aren't stuck behind it.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.overlay.do("openChat");
                const tt = await chat(t, "Rewrite the whole post as a sonnet.", undefined, { open: false });
                await t.overlay.do("wait-thinking");
                await t.screen("waiting", "Euterpe thinks… for a long time", "The bench holds this answer back.");
                t.warp(250_000);
                await t.overlay.chat("stuck", 30_000);
                await t.screen("let-go", "Euterpe lets it go", "After four minutes (the bench skips ahead), the turn is interrupted.");
                void tt;
            },
        },
        {
            id: "goodbye",
            title: "The end of a session",
            summary: "End Writing Session: Euterpe gets a last look, says goodbye, and walks off.",
            world: {},
            async run(t) {
                await startSession(t);
                const last = t.mind.turn({ kind: "session_end" });
                t.run("euterpe.endSession");
                const turn = await last;
                await t.screen("leaving", "Euterpe is leaving", "While its last turn runs, the status bar item says so.", { focus: "status-tooltip" });
                turn.reply({ expression: "happy", action: "wave", say: "Good session. The setup paragraph is the one to come back to. See you tomorrow?", notes: 0 });
                await t.overlay.bubble();
                await t.screen("goodbye", "Goodbye", "Euterpe's last words stay up long enough to read, then it walks off.");
                await t.session.ended();
                await t.wait(800);
                await t.screen("ended", "Gone", "The status bar item is back to inviting Euterpe in.", { focus: "status-tooltip" });
            },
        },
        {
            id: "vscode-gone",
            title: "When VS Code goes away",
            summary: "VS Code (its extension host) goes away during a session: Euterpe's window loses its line to it.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.overlay.do("openChat");
                await t.overlay.do("cut");
                await t.overlay.do("type", "Are you still there?");
                await t.overlay.chat("Not connected");
                await t.screen("not-connected", "Not connected", "What the writer types now can't reach Euterpe's mind; after a few tries, the window leaves on its own.", { settle: 200 });
            },
        },
        {
            id: "end-from-overlay",
            title: "Ending from Euterpe's menu",
            summary: "The writer ends the session from Euterpe's own menu.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.overlay.do("menu");
                await t.overlay.do("pick", "End writing session");
                await t.session.ended();
                await t.screen("ended", "Ended from the overlay", "The same goodbye as from VS Code.");
            },
        },
        {
            id: "end-none",
            title: "Ending a session that isn't there",
            summary: "End Writing Session with no session (from a keybinding: the palette hides it).",
            world: {},
            async run(t) {
                t.run("euterpe.endSession");
                await t.notification({ text: /No Euterpe session/ });
                await t.screen("info", "No session", "");
            },
        },
        {
            id: "memory",
            title: "Euterpe's memory",
            summary: "Open Euterpe's Memory: the plain Markdown file Euterpe keeps about the writer (made empty if there's none yet).",
            world: {},
            async run(t) {
                t.run("euterpe.openMemory");
                await t.until(() => t.tabs().some((x) => x.label === "memory.md"), { what: "memory.md" });
                await t.screen("memory", "The memory file", "What Euterpe starts it with. From the first session on, Euterpe writes what it learns of the writer here, in its own words.");
            },
        },
        {
            id: "log",
            title: "The log",
            summary: "Show Log after a short session: what Euterpe writes in its output channel.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.overlay.do("openChat");
                await chat(t, "Quick one: is 'BenchmarkDotNet' one word?", { expression: "neutral", say: "One word, camel-cased: BenchmarkDotNet.", notes: 0, action: null }, { open: false });
                t.run("euterpe.showLog");
                await t.wait(800);
                await t.screen("log", "The Euterpe log", "Everything a session does, for when something's off: what it runs, where it looks, what it found. Its lines are text too.");
            },
        },
        {
            id: "debug-console-api",
            title: "The mind's debug console, on an API",
            summary: "The same console when the mind runs on an API (here a model server on this computer): it shows the requests and answers the extension makes itself.",
            world: { provider: "openai", settings: { openaiBaseUrl: "http://localhost:11434/v1", openaiModel: "llama3.3:70b", debugMind: true } },
            async run(t) {
                await startSession(t, { hello: { expression: "happy", say: "Hi, from your own machine.", notes: 0, action: null } });
                await t.overlay.do("openChat");
                await chat(t, "Say something wrong on purpose?", { error: { status: 500, message: "model runner has unexpectedly stopped" } }, { open: false });
                await t.overlay.chat("had trouble answering", 30_000);
                await t.wait(800);
                await t.screen("console", "The console, on an API", "The model and where it runs, each perception sent, what Euterpe said, and each turn's cost, or why it failed.");
            },
        },
        {
            id: "debug-console",
            title: "The mind's debug console",
            summary: "With euterpe.debugMind on: a terminal that shows what the mind reads and says, turn by turn, where the writer can talk to it too.",
            world: { settings: { debugMind: true } },
            async run(t) {
                await startSession(t);
                await t.wait(1200);
                await t.screen("console", "The Euterpe Mind terminal", "Its first line, the session's start, Euterpe's first perception and its answer, with each turn's token use.");
                const turn = t.mind.turn({ kind: "chat" });
                await t.terminalType("Can you hear me from here?");
                const tt = await turn;
                const answered = t.session.response();
                tt.reply({ expression: "happy", say: "Loud and clear, from the back room.", notes: 0, action: null });
                await answered;
                await t.wait(1200);
                await t.screen("typed", "Talking from the console", "What's typed here goes to Euterpe as a chat message.");
                // a turn that fails, with a long reason; a new model mid-session; the end
                const failing = t.mind.turn({ kind: "chat" });
                await t.terminalType("Still with me?");
                (await failing).reply({ error: `API Error: 500 ${JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal server error. The upstream model service returned an unexpected response while generating this turn; no part of the turn was billed. Retry the request, and if the problem persists, check the status page." } })}` });
                await t.overlay.chat("Internal server error", 30_000);
                t.run("euterpe.chooseModel");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                qp.pick(/Opus/);
                await t.notification({ text: /from now on/ });
                await t.wait(1200);
                await t.screen("failed", "A failed turn, then another model", "Why a turn failed (cut short when it's long), and the request that switches the model mid-session.");
                const last = t.mind.turn({ kind: "session_end" });
                t.run("euterpe.endSession");
                (await last).reply({ expression: "happy", action: "wave", say: "Off I go.", notes: 0 });
                await t.session.ended();
                await t.wait(1000);
                await t.screen("ended", "After the session", "The terminal stays open, to read back.");
                t.run("euterpe.showLog");
                await t.wait(600);
                await t.screen("raw", "The raw traffic", "With debugMind on, the log has every line the mind's process exchanges (stream-json).");
            },
        },
    ],
};
