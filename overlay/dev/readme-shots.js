// Dev tool: the README's pictures, drawn offscreen from the real overlay and model sheets.
//   electron overlay/dev/readme-shots.js      (writes docs/overlay.png and docs/mascots.png)
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-shots-"));
const BG = "#1f1b24";

// The overlay mid-session, in the demo: the greeting bubble, then the chat.
function overlayShots() {
    const chat = [
        { type: "mind", expression: "smug", action: null, notes: 0, say: "Finalizers, huh. Brave choice of villain." },
        { type: "user-echo", text: "Is \"as often as not\" the right phrase in what I selected? Give me one alternative, in my voice." },
        { type: "mind", expression: "thinking", action: null, notes: 0, say: "It's grammatically fine as is — \"as often as not\" means \"at least half the time,\" which is a defensible claim for a debugging anecdote. But if you want something with more bite, given your dry, matter-of-fact voice elsewhere:\n\n```\nmore often than it should\n```\n\nShorter, and it implies judgment (\"shouldn't be this common\") rather than just frequency." },
    ];
    const steps = [
        { at: 5, capture: "bubble.png" },
        { at: 5.5, js: `window.__euterpe.openChat(false); ${chat.map((m) => `window.__euterpe.onMessage(${JSON.stringify(m)});`).join(" ")}` },
        { at: 8.5, capture: "chat.png" },
        { at: 9, js: "window.euterpe.quit()" },
    ];
    fs.writeFileSync(path.join(work, "steps.json"), JSON.stringify(steps));
    const env = { ...process.env, EUTERPE_DEV_SCRIPT: path.join(work, "steps.json"), EUTERPE_OVERLAY_OFFSCREEN: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((resolve) => spawn(process.execPath, [path.join(root, "overlay"), "--demo"], { env, stdio: "inherit" }).on("exit", resolve));
}

async function page(html, width, height) {
    const win = new BrowserWindow({ show: false, width, height, webPreferences: { offscreen: true } });
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    win.destroy();
    return img.toPNG();
}

// One mascot, settled in a mood, as a PNG data URL.
async function portrait(pack, mood, scale) {
    const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { offscreen: true } });
    const query = { sheet: `portrait:${mood}`, scale: String(scale) };
    if (pack) query.mascot = fs.readFileSync(path.join(root, "mascots", pack), "utf8");
    await win.loadFile(path.join(root, "overlay", "renderer", "sheet.html"), { query });
    for (let i = 0; i < 100 && (await win.webContents.executeJavaScript("window.sheetState || null")) !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
    const url = await win.webContents.executeJavaScript("document.getElementById('sheet').toDataURL('image/png')");
    win.destroy();
    return url;
}

const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
const pngSize = (file) => { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

app.disableHardwareAcceleration();
app.on("window-all-closed", () => { /* each picture has its own window: stay until done */ });
app.whenReady().then(async () => {
    await overlayShots();
    const shots = ["bubble.png", "chat.png"].map((f) => path.join(work, f));
    const { w, h } = pngSize(shots[0]);
    fs.writeFileSync(path.join(root, "docs", "overlay.png"), await page(
        `<body style="margin:0;background:${BG};display:flex;gap:20px">${shots.map((s) => `<img src="${dataUrl(s)}">`).join("")}</body>`, 2 * w + 20, h));

    const cast = [["Clawd", null, "happy"], ["Boo", "boo.json", "happy"], ["Mochi", "mochi.json", "happy"], ["Inky", "inky.json", "happy"], ["Clippy", "clippy.json", "neutral"]];
    const cells = [];
    for (const [name, pack, mood] of cast) cells.push({ name, url: await portrait(pack, mood, 4) });
    fs.writeFileSync(path.join(root, "docs", "mascots.png"), await page(
        `<body style="margin:0;overflow:hidden;background:${BG};display:flex;justify-content:center;gap:8px;padding:10px 0 14px;font:600 15px 'Segoe UI',system-ui,sans-serif;color:#b9b0c6">` +
        cells.map((c) => `<div style="display:flex;flex-direction:column;align-items:center"><img src="${c.url}" style="image-rendering:pixelated;margin:0 -26px -24px"><span>${c.name}</span></div>`).join("") +
        "</body>", 1060, 262));
    console.log("wrote docs/overlay.png and docs/mascots.png");
    fs.rmSync(work, { recursive: true, force: true });
    app.exit(0);
});
