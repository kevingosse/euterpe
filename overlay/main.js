// Euterpe's body: a frameless, transparent, always-on-top window with Clawd in it.
// Spawned by the VS Code extension with --euterpe-port/--euterpe-scale, and the connection's token
// in EUTERPE_OVERLAY_TOKEN (the environment, since other users can read a command line);
// `npm run demo` runs a scripted tour without VS Code.
const { app, BrowserWindow, Menu, clipboard, ipcMain, screen, shell } = require("electron");
const fs = require("fs");
const path = require("path");

// The extension also runs this app to draw a model sheet (a mascot's preview): no window then.
if (process.argv.some((a) => a.startsWith("--euterpe-sheet="))) {
    require("./render-sheet.js");
    return;
}

function argValue(name) {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split("=").slice(1).join("=") : null;
}

// A mascot pack file: { id, pack } for the page, or null (Clawd) if there's none or it can't be read.
function readMascot(file) {
    if (!file) return null;
    try {
        if (fs.statSync(file).size > 128 * 1024) throw new Error("bigger than 128 KB");
        return { id: path.basename(file).replace(/\.json$/i, ""), pack: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (err) {
        console.error(`mascot ${file}: ${err.message}; wearing Clawd`);
        return null;
    }
}

const port = argValue("euterpe-port");
const token = process.env.EUTERPE_OVERLAY_TOKEN || "";
const scale = Math.max(2, Math.min(6, Math.round(Number(argValue("euterpe-scale")) || 4)));
// The body to wear, if not Clawd: a mascot pack (renderer/clawd/pack.js checks and draws it). The
// fallback is what a pack that doesn't hold up leaves on stage (none: Clawd; a mind that isn't on
// Claude never wears Clawd).
const initialMascot = readMascot(argValue("euterpe-mascot"));
const fallbackMascot = readMascot(argValue("euterpe-fallback-mascot"));
// The chat's colours: Claude's clay, or "openai" (blue) for a mind on another provider.
const theme = argValue("euterpe-theme") === "openai" ? "openai" : "";
const screenshotPath = argValue("screenshot");
const screenshotDelay = Number(argValue("screenshot-delay")) || 7000;
const demo = process.argv.includes("--demo") || !!screenshotPath;
// Screenshots and tests render offscreen: nothing appears on (or takes focus from) the desktop.
const offscreen = !!screenshotPath || process.env.EUTERPE_OVERLAY_OFFSCREEN === "1";
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
// How high the window floats. On Windows, the highest level, to stay above other always-on-top
// windows (see keepOnTop). On macOS that level would also cover menus, the Dock and other apps'
// popups; a floating panel is already above every ordinary window, full-screen apps included.
const TOP_LEVEL = isMac ? "floating" : "screen-saver";

// No native occlusion tracking. Chromium marks a window occluded when other windows cover it, and
// every window while the screen is locked or the display is off. For this window that hides the
// child HWND that receives its clicks, and with backgroundThrottling off nothing ever shows it
// again (see reshowInputWindow). An always-on-top overlay that keeps rendering anyway gains
// nothing from occlusion tracking.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// The canvas is 80×64 art pixels; the chat panel and speech bubble live above it. The default
// height is clamped to the screen once it's known (small laptop screens), see fitHeight().
// The writer can give the chat more room by dragging its top or left edge: the window grows
// up and to the left, so its bottom-right corner — where Clawd stands — never moves. The
// default size is also the smallest.
const DEFAULT_W = Math.max(400, 80 * scale + 40);
let DEFAULT_H = 64 * scale + 350;
function fitHeight() {
    const minH = 64 * scale + 200;   // room for Clawd, a bubble and a (short) chat panel
    DEFAULT_H = Math.max(minH, Math.min(64 * scale + 350, screen.getPrimaryDisplay().workArea.height));
    size = { width: DEFAULT_W, height: DEFAULT_H };
}
let size = { width: DEFAULT_W, height: DEFAULT_H };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let win = null;
const alive = () => !!win && !win.isDestroyed();

// ---------- remembered position and size ----------
const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
function loadState() {
    try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return null; }
}
function saveState() {
    if (!alive() || demo) return;
    try {
        const [x, y] = win.getPosition();
        fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
        fs.writeFileSync(stateFile(), JSON.stringify({ x, y, ...size }));
    } catch { /* not worth failing over */ }
}
function place(bounds) {
    size = { width: bounds.width, height: bounds.height };
    win.setBounds(bounds);
}
// A new size (never below the default), with the bottom-right corner (Clawd) where it was.
function resizeTo(width, height) {
    const b = win.getBounds();
    width = Math.max(DEFAULT_W, width);
    height = Math.max(DEFAULT_H, height);
    place({ x: b.x + size.width - width, y: b.y + size.height - height, width, height });
}
function cornerBounds() {
    const { workArea } = screen.getPrimaryDisplay();
    const width = Math.min(size.width, workArea.width), height = Math.min(size.height, workArea.height);
    return { x: workArea.x + workArea.width - width - 8, y: workArea.y + workArea.height - height, width, height };
}
function initialBounds() {
    const s = offscreen ? null : loadState();   // offscreen renders are the same everywhere
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
        const right = s.x + (Number.isFinite(s.width) ? s.width : DEFAULT_W);
        const bottom = s.y + (Number.isFinite(s.height) ? s.height : DEFAULT_H);
        // Clawd's corner, at the default size: still (mostly) on a screen?
        const home = { x: right - DEFAULT_W, y: bottom - DEFAULT_H, width: DEFAULT_W, height: DEFAULT_H };
        const d = screen.getDisplayMatching(home).workArea;
        const w = Math.min(right, d.x + d.width) - Math.max(home.x, d.x);
        const h = Math.min(bottom, d.y + d.height) - Math.max(home.y, d.y);
        if (w > DEFAULT_W * 0.5 && h > DEFAULT_H * 0.5) {
            // a bigger chat still has to fit on that screen, header included
            const width = clamp(Number.isFinite(s.width) ? s.width : DEFAULT_W, DEFAULT_W, right - d.x);
            const height = clamp(Number.isFinite(s.height) ? s.height : DEFAULT_H, DEFAULT_H, bottom - d.y);
            size = { width, height };
            return { x: right - width, y: bottom - height, width, height };
        }
    }
    return cornerBounds();
}

// Clawd looks toward the middle of the screen, where the writer's text usually is.
function sendGaze() {
    if (!alive()) return;
    const b = win.getBounds(), d = screen.getDisplayMatching(b).workArea;
    const clawdX = b.x + b.width - 40 * scale - 20;
    win.webContents.send("gaze", clawdX > d.x + d.width / 2 ? -1 : 1);
}

// The window never takes the keyboard from the writer's editor — dragging or booping Clawd,
// or dismissing a bubble, leaves VS Code focused. It only becomes focusable while the chat is
// open (the renderer asks), and hands focus back when the chat closes.
let chatWantsKeys = false;
function setFocusable(on) {
    if (!alive() || offscreen) return;
    chatWantsKeys = on;
    win.setFocusable(on);
    win.setSkipTaskbar(true);   // on Windows, setFocusable(true) would also give it a taskbar button
}

// macOS: a click on the panel shouldn't make this the active app, but macOS 27 activates it anyway
// (electron#53889), and so does a click made in software. An active app without a key window
// swallows the writer's typing, so give activation back: hiding the app activates the one the writer
// was in, and the window stays on screen (hiding the Dock icon made it one that doesn't hide). Not
// while the chat is open (the writer is typing to Euterpe) or a menu is (hiding would close it).
function handBackActivation() {
    if (isMac && alive() && !offscreen && !chatWantsKeys && !menuOpen && app.isActive()) app.hide();
}
function resetInput() {
    if (!alive() || offscreen) return;
    win.setIgnoreMouseEvents(true, { forward: true });   // click-through; the renderer opts back in
    setFocusable(false);
}

// On Windows, clicks on the non-focusable window go to Chromium's hidden child window, the
// "Chrome Legacy Window", which declines activation but keeps the click. If that child is hidden,
// clicks land on the window itself, and Chromium eats the press of every click on a
// non-activatable window: Clawd would only answer right-clicks, which fire on release. Chromium
// hides the child when it thinks the window is occluded, and with backgroundThrottling off it
// never shows it again. The switch above should prevent that. If WM_MOUSEACTIVATE still reaches
// the window itself, the child is gone, and any resize makes Chromium show it again.
const WM_MOUSEACTIVATE = 0x0021;
let reshowing = false;
function reshowInputWindow() {
    if (!alive() || reshowing) return;
    reshowing = true;
    console.error("overlay: a click reached the window itself (Chromium's input window was hidden); resizing to restore it");
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width: size.width + 1, height: size.height });
    setTimeout(() => {
        reshowing = false;
        if (!alive()) return;
        const [nx, ny] = win.getPosition();
        win.setBounds({ x: nx, y: ny, ...size });
    }, 50);
}

// Stay on top. Windows can leave this window below ordinary windows with its always-on-top flag
// still set (seen after switching between apps on different screens), and nothing raises it again
// unless asked, so ask every second. That also lifts it above other always-on-top windows, which
// is harmless for a mostly transparent window. Not while one of its menus is open: the menu is its
// own always-on-top window, which the overlay would then cover and take clicks from.
let menuOpen = false;
function keepOnTop() {
    if (alive() && !offscreen && !menuOpen) win.setAlwaysOnTop(true, TOP_LEVEL);
}
function popupMenu(template) {
    menuOpen = true;
    Menu.buildFromTemplate(template).popup({
        window: win,
        callback: () => {
            menuOpen = false;
            // a menu item that opens the chat has run by now; any other leaves the keyboard to the editor
            setTimeout(handBackActivation, 100);
        },
    });
}

// macOS and Linux may not pass the page the pointer's moves while the window lets clicks through
// (Linux never does; macOS doesn't promise it to an app in the background, which this one always
// is), and without them the page can't notice the pointer arriving over Clawd. So tell it from
// here, while the pointer is over the window.
let pointerSeen = null;
function trackPointer() {
    if (!alive()) return;
    const p = screen.getCursorScreenPoint(), b = win.getBounds();
    const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
    const at = inside ? { x: p.x - b.x, y: p.y - b.y } : null;
    if (at ? pointerSeen && at.x === pointerSeen.x && at.y === pointerSeen.y : !pointerSeen) return;
    pointerSeen = at;
    win.webContents.send("pointer", at);
}

function createWindow() {
    fitHeight();
    win = new BrowserWindow({
        ...initialBounds(),
        show: false,
        transparent: true,
        frame: false,
        resizable: false,
        minimizable: false,     // no taskbar entry: a minimized overlay could never come back
        maximizable: false,
        fullscreenable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        backgroundColor: "#00000000",
        ...(isMac ? {
            // A non-activating panel: a click on Clawd doesn't bring this app forward, so the editor
            // keeps the keyboard. Panels also float over full-screen apps, on every Space.
            type: "panel",
            // The window is never the key one, so without this every click would only focus it.
            acceptFirstMouse: true,
            roundedCorners: false,
            hiddenInMissionControl: true,
        } : {}),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            backgroundThrottling: false,
            offscreen,
        },
    });
    win.setAlwaysOnTop(true, TOP_LEVEL);
    if (isMac && !offscreen) {
        // No Dock icon: an accessory, like a menu bar app. That also keeps this window on screen
        // when the app is hidden, which is how it gives activation back (handBackActivation).
        app.dock?.hide();
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    if (!offscreen) {
        win.once("ready-to-show", () => {
            if (!alive()) return;
            win.showInactive();
            setTimeout(handBackActivation, 250);   // in case launching made this the active app
        });
    }
    // Windows can drop the window below ordinary ones (see keepOnTop); elsewhere, where the page
    // may not hear about the pointer, trackPointer.
    const timer = offscreen ? null : isWindows ? setInterval(keepOnTop, 1000) : setInterval(trackPointer, 16);
    win.on("closed", () => { clearInterval(timer); win = null; });

    const query = { scale: String(scale) };
    if (theme) query.theme = theme;
    if (port) query.port = port;
    if (token) query.token = token;
    if (demo) query.demo = "1";
    win.loadFile(path.join(__dirname, "renderer", "index.html"), { query });
    win.webContents.on("did-finish-load", sendGaze);

    // This window only ever shows its own page: no navigation (a file dropped on it), no popups.
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    // If the page crashes, bring Clawd back rather than leave an empty window; give up after a few.
    let crashes = 0;
    win.webContents.on("render-process-gone", (_e, details) => {
        console.error(`overlay renderer gone: ${details.reason}`);
        if (!alive() || details.reason === "clean-exit") return;
        if (++crashes > 3) { app.quit(); return; }
        resetInput();
        win.webContents.reload();
    });

    resetInput();
    if (process.platform === "win32" && !offscreen) win.hookWindowMessage(WM_MOUSEACTIVATE, reshowInputWindow);

    let saveTimer = null;
    win.on("moved", () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveState(); sendGaze(); }, 400);
    });

    if (screenshotPath) {
        // A capture that fails, or never comes (the compositor can fail on a headless runner),
        // must end the run with an error, not keep CI waiting for hours.
        const fail = (why) => { console.error(`screenshot: ${why}`); app.exit(1); };
        const deadline = setTimeout(() => fail("no capture after 60 s more"), screenshotDelay + 60_000);
        setTimeout(async () => {
            if (!alive()) return;
            try {
                const image = await win.webContents.capturePage();
                fs.writeFileSync(screenshotPath, image.toPNG());
                clearTimeout(deadline);
                app.quit();
            } catch (err) { fail(err.message); }
        }, screenshotDelay);
    }
    runDevScript();
}

// End-to-end test hook, inert unless EUTERPE_DEV_SCRIPT points at a JSON list of steps:
// { "at": seconds, "js": "code run in the page", "write": "result.txt" (optional) },
// { "at": seconds, "size": { "width": w, "height": h } } (as if the writer resized the chat),
// { "at": seconds, "capture": "file.png" }, { "at": seconds, "probe": "state.json" } (the window's
// and the app's focus state, see overlay/dev/check-focus.js) or { "at": seconds, "activate": true }
// (make this the active app, as a click does on macOS 27). Captures are of this window's page only
// (transparent background), never the desktop.
function runDevScript() {
    const file = process.env.EUTERPE_DEV_SCRIPT;
    if (!file) return;
    let steps = [];
    try { steps = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { console.error(`dev script: ${err.message}`); return; }
    const dir = path.dirname(file);
    for (const s of steps) {
        setTimeout(async () => {
            if (!alive()) return;
            try {
                if (s.size) resizeTo(s.size.width, s.size.height);
                if (s.js) {
                    const result = await win.webContents.executeJavaScript(s.js);
                    if (s.write) fs.writeFileSync(path.join(dir, s.write), JSON.stringify({ result, focused: win.isFocused() }));
                }
                if (s.capture) fs.writeFileSync(path.join(dir, s.capture), (await win.webContents.capturePage()).toPNG());
                if (s.activate) app.focus({ steal: true });
                if (s.probe) {
                    const state = {
                        visible: win.isVisible(), focused: win.isFocused(), focusable: win.isFocusable(),
                        onTop: win.isAlwaysOnTop(), pageFocused: await win.webContents.executeJavaScript("document.hasFocus()"),
                        ...(isMac ? { appActive: app.isActive(), appHidden: app.isHidden(), allSpaces: win.isVisibleOnAllWorkspaces() } : {}),
                    };
                    fs.writeFileSync(path.join(dir, s.probe), JSON.stringify(state));
                }
            } catch (err) { console.error(`dev script step at ${s.at}s: ${err.message}`); }
        }, s.at * 1000);
    }
}

ipcMain.on("initial-mascot", (ev) => { ev.returnValue = initialMascot; });
ipcMain.on("fallback-mascot", (ev) => { ev.returnValue = fallbackMascot; });

ipcMain.on("set-ignore-mouse", (_ev, ignore) => {
    if (alive() && !offscreen) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

// Manual window drag: CSS app-region doesn't work on transparent click-through windows on
// Windows, so the window follows the cursor while the renderer holds a drag. The velocity
// goes back to the renderer: Clawd dangles and swings with it.
let drag = null;
function endDrag() {
    if (!drag) return;
    clearInterval(drag.timer);
    drag = null;
    saveState();
    sendGaze();
}
ipcMain.on("drag-start", () => {
    if (!alive() || drag || resize) return;
    const c = screen.getCursorScreenPoint(), [wx, wy] = win.getPosition();
    drag = { ox: c.x - wx, oy: c.y - wy, x: wx, y: wy, t: Date.now(), timer: null };
    drag.timer = setInterval(() => {
        if (!alive() || !drag) { endDrag(); return; }
        const p = screen.getCursorScreenPoint(), nx = Math.round(p.x - drag.ox), ny = Math.round(p.y - drag.oy);
        const now = Date.now(), dt = Math.max(1, now - drag.t);
        const vx = ((nx - drag.x) * 1000) / dt, vy = ((ny - drag.y) * 1000) / dt;
        if (nx !== drag.x || ny !== drag.y) win.setBounds({ x: nx, y: ny, ...size });
        drag.x = nx; drag.y = ny; drag.t = now;
        win.webContents.send("drag-move", { vx, vy });
    }, 16);
});
ipcMain.on("drag-end", endDrag);

// Resizing the chat, the same way: while the renderer holds an edge ("n", "w" or "nw"), the
// window's top and/or left side follow the cursor, within the screen Clawd is on.
let resize = null;
function endResize() {
    if (!resize) return;
    clearInterval(resize.timer);
    resize = null;
    saveState();
}
ipcMain.on("resize-start", (_ev, edge) => {
    if (!alive() || drag || resize || !["n", "w", "nw"].includes(edge)) return;
    const b = win.getBounds(), c = screen.getCursorScreenPoint();
    const right = b.x + size.width, bottom = b.y + size.height, start = { ...size };
    const d = screen.getDisplayMatching(b).workArea;
    resize = { timer: null };
    resize.timer = setInterval(() => {
        if (!alive() || !resize) { endResize(); return; }
        const p = screen.getCursorScreenPoint();
        const width = edge.includes("w") ? clamp(start.width - (p.x - c.x), DEFAULT_W, Math.max(DEFAULT_W, right - d.x)) : start.width;
        const height = edge.includes("n") ? clamp(start.height - (p.y - c.y), DEFAULT_H, Math.max(DEFAULT_H, bottom - d.y)) : start.height;
        if (width !== size.width || height !== size.height) place({ x: right - width, y: bottom - height, width, height });
    }, 16);
});
ipcMain.on("resize-end", endResize);

ipcMain.on("show-context-menu", () => {
    if (!alive()) return;
    const send = (cmd) => alive() && win.webContents.send("menu", cmd);
    const resized = size.width !== DEFAULT_W || size.height !== DEFAULT_H;
    popupMenu([
        { label: "Talk to Euterpe", click: () => send("talk") },
        { label: "Back to the corner", click: () => { if (!alive()) return; place(cornerBounds()); saveState(); sendGaze(); } },
        ...(resized ? [{ label: "Default chat size", click: () => { if (!alive()) return; resizeTo(DEFAULT_W, DEFAULT_H); saveState(); } }] : []),
        { type: "separator" },
        { label: "End writing session", click: () => send("close") },
    ]);
});

// Right-click on text in the bubble or the chat: copy what's selected, paste into the input.
ipcMain.on("show-text-menu", (_ev, o) => {
    if (!alive()) return;
    const selection = typeof o?.selection === "string" ? o.selection : "";
    popupMenu([
        { label: "Copy", enabled: !!selection, click: () => clipboard.writeText(selection) },
        ...(o?.editable ? [{ role: "cut" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" }] : []),
    ]);
});

// The page's clipboard API needs a focused document; the overlay usually isn't focused.
ipcMain.on("copy", (_ev, text) => { if (typeof text === "string") clipboard.writeText(text); });

ipcMain.on("open-external", (_ev, url) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.on("focus-window", () => {
    if (!alive()) return;
    setFocusable(true);
    win.setAlwaysOnTop(true, TOP_LEVEL);
    // A panel takes the keyboard without activating the app, unless the app is hidden.
    if (isMac && app.isHidden()) app.show();
    win.focus();
    win.webContents.focus();
});
ipcMain.on("set-focusable", (_ev, on) => setFocusable(!!on));
// Hand the keyboard back to the window the writer came from.
ipcMain.on("blur-window", () => {
    if (!alive()) return;
    if (isWindows && win.isFocused()) {
        // Deactivating a window activates the next visible one below it, which for an always-on-top
        // window is the taskbar or another always-on-top window, not the editor. Out of the topmost
        // band for a moment, the window sits right above the one that was active before it: that one
        // gets the keyboard. (setFocusable(false) deactivates.)
        win.setAlwaysOnTop(false);
        setFocusable(false);
        win.setAlwaysOnTop(true, TOP_LEVEL);
        return;
    }
    if (win.isFocused()) win.blur();
    setFocusable(false);
    handBackActivation();
});

ipcMain.on("quit", () => app.quit());

app.whenReady().then(() => {
    // No application menu: its default accelerators (Ctrl+W, Ctrl+R, Ctrl+M, F11...) would
    // otherwise close, reload or minimize the overlay whenever it has focus. Except on macOS, where
    // ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z in the chat come from the Edit menu (unseen: an app without a Dock
    // icon has no menu bar).
    Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([{ role: "editMenu" }]) : null);
    createWindow();
});
app.on("window-all-closed", () => app.quit());
// Wait for the click's release: if it opened the chat, the app keeps the keyboard.
app.on("did-become-active", () => setTimeout(handBackActivation, 250));
