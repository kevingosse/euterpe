// Renders a model sheet (renderer/sheet.html) offscreen to a PNG: for reviewing the art, and for
// previewing a mascot (Euterpe: Preview Mascot, and the mind's preview_mascot tool).
//   electron overlay/render-sheet.js --sheet=<name>[:<arg>] --out=<file.png> [--scale=4] [--mascot=<mascot.json>]
// or, as the extension runs it, electron overlay --euterpe-sheet=<name> … (main.js hands over).
// Sheets are defined in renderer/sheet.js; --mascot draws a mascot pack instead of Clawd
// (--sheet=mascot is a pack's full model sheet). A pack that doesn't hold up prints
// "invalid: <problems>" and exits with 2.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

function arg(name, dflt) {
    const a = process.argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : dflt;
}

// Its own profile, so it can run beside a live overlay.
app.setPath("userData", path.join(app.getPath("temp"), "euterpe-sheets"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const sheet = arg("euterpe-sheet", arg("sheet", "views"));
    const out = path.resolve(arg("out", "sheet.png"));
    const scale = arg("scale", "4");
    const query = { sheet, scale };
    if (arg("bg")) query.bg = arg("bg");
    try {
        if (arg("mascot")) query.mascot = fs.readFileSync(arg("mascot"), "utf8");
    } catch (err) {
        console.error(`invalid: can't read ${arg("mascot")}: ${err.message}`);
        app.exit(2);
        return;
    }
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true } });
    await win.loadFile(path.join(__dirname, "renderer", "sheet.html"), { query });
    for (let i = 0; i < 200; i++) {
        const state = await win.webContents.executeJavaScript("window.sheetState || null");
        if (state === "ready") break;
        if (state && state.startsWith("invalid")) { console.error(state); app.exit(2); return; }
        if (state && state.startsWith("error")) { console.error(state); app.exit(1); return; }
        await new Promise((r) => setTimeout(r, 50));
    }
    const url = await win.webContents.executeJavaScript("document.getElementById('sheet').toDataURL('image/png')");
    fs.writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
    console.log(`wrote ${out}`);
    app.exit(0);
});
