// Chapter 2: the very first session: on Claude, before any document, and without Claude Code.
"use strict";

const { HELLO } = require("./lib");

const CONSENT = /wants to access the language models/;

module.exports = {
    id: "first-session",
    title: "2. The first session",
    intro: "A writer who just installed Euterpe starts a session for the first time: with Claude Code installed and signed in, before opening any document, and without Claude Code.",
    scenarios: [
        {
            id: "first-session",
            title: "The very first session",
            summary: "The avatar's window downloading, and Euterpe arriving.",
            world: { electron: "missing", electronDownload: { pauseAt: 0.45 } },
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                await t.progress({ title: /Getting Euterpe's avatar ready/ });
                await t.wait(2200);
                await t.screen("downloading", "Getting Euterpe's avatar ready", "Euterpe's window runs on Electron, downloaded once (and kept across updates) from the first click, with no question asked: a progress notification while the session waits for it, with how much has come (the bench's download is smaller than the real 150 MB), and a Cancel button.");
                await t.screen("on-the-way", "Euterpe is on the way", "Meanwhile, the status bar item spins, and says so on hover.", { focus: "status-tooltip", settle: 200 });
                t.release("download");
                const turn = await first;
                await t.overlay.ready();
                await t.wait(1500);
                await t.screen("arriving", "Euterpe arrives", "The overlay's window comes up in the corner of the screen and Euterpe walks in. Its first turn reads its memory and the draft, so it reads for a while before it speaks.");
                const answered = t.session.response();
                turn.reply(HELLO);
                await answered;
                await t.overlay.bubble();
                await t.screen("hello", "Hello", "Euterpe's first words, in its bubble (written by the mind: the bench's stand-in here). The status bar item shows it's with you.", { focus: "status-tooltip" });
            },
        },
        {
            id: "no-document",
            title: "No document open yet",
            summary: "The writer invites Euterpe in before opening anything: Euterpe comes, and reads the first document they open.",
            world: { open: [] },
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const turn = await first;
                if (!/document: none/.test(turn.text || "")) { throw new t.ScenarioError("the first perception should say there's no document"); }
                await t.overlay.ready();
                const answered = t.session.response();
                turn.reply({ expression: "happy", action: "wave", say: "Hey you. Nothing open yet? Open a draft whenever you're ready, I'll read along. Or just talk to me.", notes: 0 });
                await answered;
                await t.overlay.bubble();
                await t.screen("hello", "Hello, with nothing to read", "No document open: Euterpe comes all the same. Its first look says there's none, and it can talk meanwhile.");
                const look = t.mind.turn({ kind: "doc_switch" });
                await t.open("ws/draft.md");
                const seen = await look;
                if (!/<document>/.test(seen.text || "")) { throw new t.ScenarioError("the first document should be seen in full"); }
                const read = t.session.response();
                seen.reply({ expression: "curious", action: "peek", say: null, notes: 0 });
                await read;
                await t.screen("first-document", "The first document", "The first document the writer opens is the session's (even when Euterpe doesn't follow them to other documents): Euterpe reads it in full a couple of seconds later.");
            },
        },
        {
            id: "no-claude",
            title: "Without Claude Code",
            summary: "A fresh install, without Claude Code (Euterpe's default mind): the first click opens Euterpe's settings at the choice of mind while the avatar's runtime downloads, and the first session runs on GitHub Copilot.",
            world: { claude: null, electron: "missing", electronDownload: { pauseAt: 0.4 } },
            async run(t) {
                t.run("euterpe.startSession");
                await t.webview.do("wait", '[data-run="installClaude"]');
                await t.webview.do("wait", "#runtime progress");
                await t.wait(800);
                await t.screen("choose", "The minds, and the download", "Claude is only one of Euterpe's minds: with Claude Code missing, the status bar's click opens Euterpe's settings at the choice of mind. Claude says what's missing, with the way to install it; the other minds are one click away. Meanwhile, at the top, the avatar's runtime downloads (held here by the bench).");
                await t.webview.do("click", '[data-set="provider"][data-value="copilot"]');
                await t.wait(1000);
                await t.webview.do("top");
                await t.screen("copilot", "GitHub Copilot", "The writer is signed in to GitHub Copilot in VS Code: nothing more to set up.");
                t.release("download");
                for (let i = 0; await t.webview.do("exists", "#runtime"); i++) {
                    if (i > 100) { throw new t.ScenarioError("the download banner should go once the runtime is there"); }
                    await t.wait(300);
                }
                await t.wait(500);
                await t.screen("ready", "Ready", "Downloaded while the writer chose a mind: the banner goes.");
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const consent = await t.modal({ text: CONSENT });
                consent.click("Allow");
                const turn = await first;
                // (started from the settings window, in front of the draft: the draft is the one read)
                if (!/file: draft\.md[\s\S]*<document>/.test(turn.text || "")) { throw new t.ScenarioError("the session should start on the draft the writer was on"); }
                await t.overlay.ready();
                const answered = t.session.response();
                turn.reply({ ...HELLO, say: "Hey you. Inky here, thinking on your GitHub Copilot plan. A benchmark post that admits the benchmark lied? I'm hooked." });
                await answered;
                await t.overlay.bubble();
                await t.screen("hello", "Hello, on Copilot", "The session, on the mind the writer just chose, on the draft they were on before Euterpe's settings came up.");
            },
        },
    ],
};
