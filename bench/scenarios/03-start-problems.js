// Chapter 3: what can stand between the writer and a session.
"use strict";

const { HELLO, startSession, settingsInstead } = require("./lib");

module.exports = {
    id: "start-problems",
    title: "3. When a session can't start",
    intro: "Everything that can stop a session from starting, or end it right away, and what Euterpe says each time.",
    scenarios: [
        {
            id: "remote-window",
            title: "A remote window",
            summary: "VS Code is connected to WSL (or SSH, a container): the files are on another machine.",
            world: { remote: "wsl" },
            async run(t) {
                t.run("euterpe.startSession");
                await t.notification({ text: /remote window/ });
                await t.screen("warning", "Local folders only", "The status bar's remote indicator (bottom left) says where VS Code is. Euterpe runs on this computer, for its window.");
            },
        },
        {
            id: "restricted-folder",
            title: "Restricted Mode",
            summary: "The folder isn't trusted: Euterpe explains why it waits, and joins once the writer trusts the folder.",
            world: { trusted: false },
            async run(t) {
                await t.until(() => t.status(), { what: "Euterpe's status bar item" });
                await t.screen("status", "The status bar in Restricted Mode", "Before a session, the tooltip says why Euterpe would wait.", { focus: "status-tooltip" });
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const m = await t.modal({ text: /trust this folder/ });
                await t.screen("ask", "Euterpe waits for trust", "Euterpe's mind reads the folder's files with its permission prompts off: in Restricted Mode, it explains why it waits, and offers to manage trust.");
                m.click(0);
                await t.until(() => t.tabs().some((x) => x.label === "Workspace Trust"), { what: "the Workspace Trust editor" });
                await t.screen("trust-editor", "VS Code's Workspace Trust", "VS Code's own page (the bench's rendering of it): the one line about Euterpe is the description from Euterpe's package.json, which VS Code shows for extensions Restricted Mode limits.");
                t.trust();
                const turn = await first;
                await t.overlay.ready();
                const answered = t.session.response();
                turn.reply(HELLO);
                await answered;
                await t.overlay.bubble();
                await t.screen("joined", "Euterpe joins", "Once the folder is trusted (within five minutes of asking), the session starts on its own, on the document the writer asked for.");
            },
        },
        {
            id: "restricted-workspace",
            title: "Restricted Mode, in a workspace",
            summary: "The same, when VS Code has a .code-workspace open rather than a folder.",
            world: { trusted: false, workspaceFile: "~/Documents/blog.code-workspace", files: { "~/Documents/blog.code-workspace": { folders: [{ path: "my-blog" }] } } },
            async run(t) {
                t.run("euterpe.startSession");
                const m = await t.modal({ text: /workspace/ });
                await t.screen("ask", "Euterpe waits for trust (a workspace)", "The words follow what VS Code has open: a workspace here.");
                m.close();
            },
        },
        {
            id: "start-twice",
            title: "Starting twice",
            summary: "The writer clicks again while Euterpe is on the way, and again once it's there.",
            world: { electron: "missing", electronDownload: { pauseAt: 0.3 } },
            async run(t) {
                t.run("euterpe.startSession");
                await t.progress({ title: /Getting Euterpe's avatar ready/ });
                t.run("euterpe.startSession");
                await t.notification({ text: /on the way/ });
                await t.screen("on-the-way", "Euterpe is on the way", "A second start while the first is under way.");
                const first = t.mind.turn({ kind: "session_start" });
                t.release("download");
                const turn = await first;
                await t.overlay.ready();
                turn.reply(HELLO);
                await t.overlay.bubble();
                t.run("euterpe.startSession");
                await t.notification({ text: /already running/ });
                await t.screen("running", "A session is already running", "Start Writing Session during a session. (The status bar item opens the session's menu instead: see the next chapter.)");
            },
        },
        {
            id: "claude-missing",
            title: "Claude Code isn't installed",
            summary: "The writer chose Claude, but Claude Code is nowhere Euterpe looks: not on PATH, not where its installers put it, not inside the Claude Code extension.",
            world: { claude: null, provider: "claude" },
            async run(t) {
                t.run("euterpe.startSession");
                await t.webview.do("wait", '[data-run="installClaude"]');
                await t.wait(600);
                await t.screen("minds", "Claude Code isn't installed", "Euterpe's settings open at the choice of mind, as on a first run: Claude says what's missing, the other minds are one click away.");
                await t.webview.do("click", '[data-run="installClaude"]');
                await t.browser.next();
                await t.screen("install-page", "Install Claude Code", "The button opens Claude Code's setup page in the browser.");
            },
        },
        {
            id: "claude-too-old",
            title: "Claude Code is too old",
            summary: "Claude Code is there, but older than the version Euterpe needs.",
            world: { claude: { version: "2.1.204" } },
            async run(t) {
                await settingsInstead(t);
                await t.screen("settings", "Claude Code is too old", "Euterpe needs a Claude Code that takes --permission-prompts: its settings open at the choice of mind, which says what to do.");
            },
        },
        {
            id: "claude-path-wrong",
            title: "euterpe.claudePath points nowhere",
            summary: "The writer set euterpe.claudePath to a program that isn't there.",
            world: { settings: { claudePath: "{home}/tools/claude/claude.exe" } },
            async run(t) {
                await settingsInstead(t);
                await t.screen("settings", "euterpe.claudePath isn't a working Claude Code", "An explicit path isn't second-guessed: Euterpe doesn't look elsewhere. Its settings open at the choice of mind, with a way to choose the program.");
            },
        },
        {
            id: "claude-config-missing",
            title: "euterpe.claudeConfigDir points nowhere",
            summary: "The writer set euterpe.claudeConfigDir to a folder that doesn't exist (a typo, a folder not synced yet).",
            world: { settings: { claudeConfigDir: "~/.claude-work" } },
            async run(t) {
                await settingsInstead(t);
                await t.screen("settings", "A config folder that isn't there", "A session would refuse it (Claude Code would quietly start a signed-out one): Euterpe's settings open at the choice of mind, with a way to choose the folder.");
            },
        },
        {
            id: "electron-path-wrong",
            title: "euterpe.electronPath points nowhere",
            summary: "The writer set euterpe.electronPath to an Electron that isn't there.",
            world: { settings: { electronPath: "{home}/tools/electron/electron.exe" } },
            async run(t) {
                t.run("euterpe.startSession");
                await t.notification({ text: /electronPath/ });
                await t.screen("error", "euterpe.electronPath doesn't exist", "");
            },
        },
        {
            id: "electron-no-build",
            title: "No Electron for this computer",
            summary: "A computer Electron has no build for (here a 32-bit Windows).",
            world: { arch: "ia32", electron: "missing" },
            async run(t) {
                t.run("euterpe.startSession");
                await t.notification({ text: /no build/ });
                await t.screen("error", "Electron has no build for this computer", "");
            },
        },
        {
            id: "electron-download-fails",
            title: "The avatar's download fails",
            summary: "Every way Electron's download can go wrong: the server says no, the file is corrupt, it's cut short, it stalls, the writer cancels it.",
            world: { electron: "missing", electronDownload: { status: 404 } },
            async run(t) {
                // (each click on Euterpe tries the download again)
                const attempt = async (spec, key, title, notes, expect) => {
                    t.world.spec.electronDownload = spec;
                    t.run("euterpe.startSession");
                    await t.notification({ text: expect, timeout: 30_000 });
                    await t.screen(key, title, notes);
                };
                await attempt({ status: 404 }, "http", "The server refuses", "Each error ends with a way around a download: euterpe.electronPath.", /HTTP 404/);
                await attempt({ status: 200, corrupt: true }, "corrupt", "The download is corrupt", "Its checksum doesn't match the one Euterpe pins.", /corrupt/);
                await attempt({ status: 200, cutShort: true }, "cut-short", "The download is cut short", "", /cut short/);
                await attempt({ status: 200, stall: true }, "stalled", "The download stalls", "Nothing comes for a minute (the bench shortens the wait).", /stalled/);
                await attempt({ status: 200, redirectLoop: true }, "redirects", "Too many redirects", "", /Too many redirects/);
                t.world.spec.electronDownload = { status: 200, slow: true };
                t.run("euterpe.startSession");
                const p = await t.progress({ title: /Getting Euterpe's avatar ready/ });
                await t.wait(1500);
                p.cancel();
                await p.done;
                await t.wait(800);
                await t.screen("cancelled", "Cancelled", "The writer cancels the download: nothing more is said, and the session doesn't start.");
            },
        },
        {
            id: "mind-exits",
            title: "Claude Code exits before answering",
            summary: "Claude Code starts, then exits before its first answer (a broken install, a login it can't read).",
            world: {},
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const turn = await first;
                await t.overlay.ready();
                turn.reply({ crash: 1, stderr: ["Error: EPERM: operation not permitted, open 'C:\\Users\\writer\\.claude\\.credentials.json'"] });
                await t.notification({ text: /before answering/ });
                await t.wait(1500);
                await t.screen("error", "Euterpe's mind exited", "The session ends; the error quotes what Claude Code last printed.");
            },
        },
        {
            id: "mind-not-signed-in",
            title: "Claude Code isn't signed in",
            summary: "Claude Code runs, but isn't signed in: its first turn fails.",
            world: {},
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const turn = await first;
                await t.overlay.ready();
                turn.reply({ error: "Not logged in · Please run /login" });
                await t.notification({ text: /couldn't sign in/ });
                await t.wait(1200);
                await t.screen("error", "Euterpe's mind couldn't sign in", "The session ends, with what Claude Code said and what to do.");
            },
        },
        {
            id: "mind-spawn-error",
            title: "Claude Code won't run",
            summary: "The program was found, but can't be run (it vanished, or something blocks it).",
            world: { claude: { spawnError: true } },
            async run(t) {
                t.run("euterpe.startSession");
                await t.notification({ text: /Could not run/ });
                await t.wait(800);
                await t.screen("error", "Euterpe couldn't run Claude Code", "");
            },
        },
        {
            id: "mind-model-refused",
            title: "A model Claude Code can't run",
            summary: "euterpe.model names a model this account doesn't have (or that doesn't exist): the first turn fails.",
            world: { settings: { model: "claude-opus-9" } },
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const turn = await first;
                await t.overlay.ready();
                turn.reply({ error: "There's an issue with the selected model (claude-opus-9). It may not exist or you may not have access to it. Run --model to pick a different model." });
                await t.notification({ text: /can't run Euterpe's mind/ });
                await t.wait(1200);
                await t.screen("error", "The model can't run", "Every turn would fail the same way: the session ends, and says how to pick another model.");
            },
        },
        {
            id: "permission-restricted",
            title: "Permission prompts can't be skipped",
            summary: "Claude Code runs under a policy (an organization's) that forbids skipping permission prompts.",
            world: { claude: { permissionMode: "default" } },
            async run(t) {
                await startSession(t);
                await t.notification({ text: /permission prompts/ });
                await t.screen("warning", "Euterpe's tools will be refused", "The session goes on, but nobody is there to answer the prompts: Euterpe can read along and talk, not use its tools.");
            },
        },
        {
            id: "overlay-closes",
            title: "Euterpe's window closes",
            summary: "The overlay's window goes away during a session (it crashed, or something closed it).",
            world: {},
            async run(t) {
                await startSession(t);
                t.kill("electron", 1);
                await t.notification({ text: /window closed/ });
                await t.wait(1000);
                await t.screen("info", "Euterpe's window closed", "The session ends with it.");
            },
        },
    ],
};
