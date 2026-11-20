// A headless Chrome for testing the bench itself, driven over the DevTools protocol:
//   node bench/dev/chrome.js launch            start it (its own profile, in the scratch folder)
//   node bench/dev/chrome.js open <url>        load a page
//   node bench/dev/chrome.js eval "<js>"       run an expression in the page (awaited), print the result
//   node bench/dev/chrome.js shot <file.png>   screenshot the page
//   node bench/dev/chrome.js click <x> <y>     click at a point; key <key>; move <x> <y>
//   node bench/dev/chrome.js quit
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.BENCH_CHROME_PORT) || 9333;
const CHROME = process.env.BENCH_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = process.env.BENCH_CHROME_PROFILE || path.join(os.tmpdir(), "euterpe-bench-chrome");

async function targets() {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    return r.json();
}

async function session() {
    let list = await targets();
    let page = list.find((t) => t.type === "page");
    if (!page) {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
        page = await r.json();
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; waiting.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
    return { send, close: () => ws.close() };
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    if (cmd === "launch") {
        fs.mkdirSync(PROFILE, { recursive: true });
        const p = spawn(CHROME, [
            "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--window-size=1720,1000",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "--mute-audio", "about:blank",
        ], { detached: true, stdio: "ignore" });
        p.unref();
        for (let i = 0; i < 50; i++) { try { await targets(); console.log(`chrome up on ${PORT}`); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
        throw new Error("chrome didn't come up");
    }
    if (cmd === "quit") {
        const s = await session();
        try { await s.send("Browser.close"); } catch { /* gone */ }
        return;
    }
    const s = await session();
    try {
        if (cmd === "open") {
            await s.send("Page.enable");
            await s.send("Emulation.setDeviceMetricsOverride", { width: Number(args[1]) || 1720, height: Number(args[2]) || 1000, deviceScaleFactor: 1, mobile: false });
            await s.send("Page.navigate", { url: args[0] });
            await new Promise((r) => setTimeout(r, Number(args[3]) || 1500));
            console.log("ok");
        } else if (cmd === "eval") {
            const r = await s.send("Runtime.evaluate", { expression: args.join(" "), awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) { console.log("EXCEPTION", JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); }
            else { console.log(typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value, null, 2)); }
        } else if (cmd === "shot") {
            const clip = args[1] ? args[1].split(",").map(Number) : null;
            const r = await s.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: clip[4] || 1 } } : {}) });
            fs.writeFileSync(args[0], Buffer.from(r.data, "base64"));
            console.log(args[0]);
        } else if (cmd === "click" || cmd === "move" || cmd === "rclick") {
            const x = Number(args[0]), y = Number(args[1]);
            await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
            if (cmd !== "move") {
                const button = cmd === "rclick" ? "right" : "left";
                const mods = args[2] === "alt" ? 1 : 0;
                await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1, modifiers: mods });
                await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1, modifiers: mods });
            }
            console.log("ok");
        } else if (cmd === "key") {
            const key = args[0];
            await s.send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key.length === 1 ? key : undefined });
            await s.send("Input.dispatchKeyEvent", { type: "keyUp", key });
            console.log("ok");
        } else if (cmd === "type") {
            await s.send("Input.insertText", { text: args.join(" ") });
            console.log("ok");
        } else {
            console.log("commands: launch, open, eval, shot, click, rclick, move, key, type, quit");
        }
    } finally {
        s.close();
    }
}

if (require.main === module) { main().catch((err) => { console.error(err.message); process.exit(1); }); }
module.exports = { session, PORT };
