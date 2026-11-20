// CI check: the overlay's window keeps its promises about the keyboard. It opens and closes the
// chat and, on macOS, makes the app active on purpose (as a click does on macOS 27), probing the
// window and the app after each step. Pops a real window: for CI or a spare machine, not a desktop
// someone is working on.
//   node overlay/dev/check-focus.js [--download]
// --download runs it on the Electron that Euterpe downloads for writers (src/electronRuntime.ts,
// compiled to out/ by `npm test`) instead of the development one in node_modules.
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const overlayDir = path.join(__dirname, "..");
const isMac = process.platform === "darwin";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-focus-"));

async function electronPath() {
    if (!process.argv.includes("--download")) return require("electron");
    const { downloadElectron } = require(path.join(__dirname, "..", "..", "out", "electronRuntime.js"));
    const exe = await downloadElectron(path.join(work, "storage"), { log: (m) => console.log(m) });
    console.log(execFileSync(exe, ["--version"], { encoding: "utf8" }).trim(), "runs");
    return exe;
}

const steps = [
    { at: 3, probe: "start.json" },
    { at: 3.5, js: "window.__euterpe.openChat(true)" },
    { at: 5, probe: "chat.json" },
    { at: 5.5, js: "window.__euterpe.closeChat()" },
    { at: 7, probe: "closed.json" },
    ...(isMac ? [
        { at: 7.5, activate: true },
        { at: 7.6, probe: "activating.json" },
        { at: 9, probe: "activated.json" },
        { at: 9.5, js: "window.__euterpe.openChat(true)" },
        { at: 11, probe: "chat-again.json" },
        { at: 11.5, js: "window.__euterpe.closeChat()" },
        { at: 13, probe: "closed-again.json" },
    ] : []),
    { at: isMac ? 13.5 : 7.5, js: "window.euterpe.quit()" },
];

// On macOS the app should never stay the active one unless the chat is open: the chat gets the
// keyboard, and gives it back when it closes. A CI runner's Windows or Linux desktop has no editor to
// take the keyboard from; there the steps only have to run.
const expectations = {
    darwin: {
        "start.json": { visible: true, focused: false, appActive: false },
        "chat.json": { focused: true, pageFocused: true },
        "closed.json": { visible: true, focused: false, focusable: false, appActive: false },
        "activated.json": { visible: true, appActive: false },
        "chat-again.json": { focused: true, pageFocused: true },
        "closed-again.json": { visible: true, focused: false, appActive: false },
    },
}[process.platform] || { "start.json": { visible: true }, "closed.json": { visible: true, focusable: false } };

async function main() {
    const exe = await electronPath();
    const script = path.join(work, "steps.json");
    fs.writeFileSync(script, JSON.stringify(steps));
    const env = { ...process.env, EUTERPE_DEV_SCRIPT: script };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [overlayDir, "--demo", ...(process.platform === "linux" ? ["--ozone-platform=x11"] : [])];
    const child = spawn(exe, args, { env, stdio: "inherit" });
    const killer = setTimeout(() => child.kill(), 40_000);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    clearTimeout(killer);

    let failed = code !== 0;
    if (failed) console.error(`the overlay exited with ${code}`);
    for (const s of steps.filter((x) => x.probe)) {
        const file = path.join(work, s.probe);
        if (!fs.existsSync(file)) { console.error(`✗ ${s.probe}: no probe (did the step throw?)`); failed = true; continue; }
        const state = JSON.parse(fs.readFileSync(file, "utf8"));
        const wrong = Object.entries(expectations[s.probe] || {}).filter(([k, v]) => state[k] !== v);
        console.log(`${wrong.length ? "✗" : "✓"} ${s.probe} ${JSON.stringify(state)}`);
        for (const [k, v] of wrong) console.log(`    expected ${k} = ${v}`);
        failed ||= wrong.length > 0;
    }
    // Worth knowing, not failures.
    const probe = (name) => {
        try { return JSON.parse(fs.readFileSync(path.join(work, name), "utf8")); } catch { return null; }
    };
    if (isMac && probe("chat.json")?.appActive) {
        console.log("note: the chat took the keyboard by making the app active, not as a non-activating panel");
    }
    if (isMac && probe("activating.json") && !probe("activating.json").appActive) {
        console.log("note: macOS refused to make the app active, so giving activation back went untested");
    }
    process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ } });
