// Chapter 2: the very first session, on Claude.
"use strict";

const { HELLO } = require("./lib");

module.exports = {
    id: "first-session",
    title: "2. The first session",
    intro: "A writer who just installed Euterpe, with Claude Code installed and signed in, starts a session for the first time.",
    scenarios: [
        {
            id: "first-session",
            title: "The very first session",
            summary: "The avatar's window downloading, and Euterpe arriving.",
            world: { electron: "missing", electronDownload: { pauseAt: 0.45 } },
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const dl = await t.modal({ text: /Electron/ });
                await t.screen("download", "Euterpe's window needs Electron", "Asked once, then kept across updates. Modal on purpose: a notification would hide itself, and the session would wait unseen. VS Code adds the Cancel button to every modal message; the rest is Euterpe's.");
                dl.click("Download");
                await t.progress({ title: /Downloading/ });
                await t.wait(2200);
                await t.screen("downloading", "Downloading", "A progress notification, with how much has come (the bench's download is smaller than the real 150 MB), and a Cancel button.");
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
    ],
};
