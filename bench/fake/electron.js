// A stand-in for the `electron` module, for the overlay's own main process (overlay/main.js and
// render-sheet.js, run as they are): its windows, menus, clipboard and shell are the bench's page,
// which draws each window as a frame on its desktop and runs the window's page in it.
"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const RUN = process.env.BENCH_RUN;
const ws = new WebSocket(`ws://127.0.0.1:${process.env.BENCH_PORT}/ws?role=proc&run=${encodeURIComponent(RUN)}&kind=electron`);
const outbox = [];
let connected = false;
function toPage(msg) {
    const line = JSON.stringify({ to: "ui", run: RUN, msg: { type: "electron", ...msg } });
    if (connected) { ws.send(line); } else { outbox.push(line); }
}
function toHost(msg) {
    const line = JSON.stringify({ to: "host", run: RUN, msg });
    if (connected) { ws.send(line); } else { outbox.push(line); }
}
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
ws.addEventListener("open", () => { connected = true; for (const l of outbox.splice(0)) { ws.send(l); } toHost({ type: "proc-hello", kind: "electron", pid: process.pid, args: process.argv.slice(1) }); void call("screen").then((s) => { screenInfo = s; readyResolve(); }); });
ws.addEventListener("close", () => process.exit(0));
ws.addEventListener("error", () => { });

let reqSeq = 0;
const pending = new Map();
function call(op, payload = {}, timeout = 20_000) {
    const reqId = `e${++reqSeq}`;
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(reqId); reject(new Error(`the bench's page didn't answer ${op} (is it open?)`)); }, timeout);
        pending.set(reqId, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
        toPage({ op, reqId, ...payload });
    });
}

let screenInfo = { width: 1600, height: 900 };
let cursor = { x: 0, y: 0 };
const windows = new Map();
const menus = new Map();

ws.addEventListener("message", (e) => {
    let env;
    try { env = JSON.parse(String(e.data)); } catch { return; }
    const m = env.msg || {};
    switch (m.type) {
        case "electron-reply": { const p = pending.get(m.reqId); if (p) { pending.delete(m.reqId); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); } break; }
        case "ipc": {
            const w = windows.get(m.win);
            const event = { sender: w?.webContents, returnValue: undefined, reply() { } };
            ipcMain.emit(m.channel, event, ...(m.args || []));
            break;
        }
        case "cursor": cursor = { x: Math.round(m.x), y: Math.round(m.y) }; break;
        case "screen": screenInfo = m.screen; break;
        case "menu-click": {
            const menu = menus.get(m.menu);
            if (!menu) { break; }
            const item = m.index === undefined || m.index === null ? null : menu.items[m.index];
            if (item && item.enabled !== false && typeof item.click === "function") { try { item.click(item, menu.window, {}); } catch (err) { console.error(err); } }
            menus.delete(m.menu);
            menu.callback?.();
            break;
        }
        case "window-event": {
            const w = windows.get(m.win);
            if (!w) { break; }
            if (m.event === "closed") { w._destroy(); }
            else if (m.event === "render-process-gone") { w.webContents.emit("render-process-gone", {}, { reason: m.reason || "crashed", exitCode: 1 }); }
            else if (m.event === "focus") { w._focused = true; }
            else if (m.event === "blur") { w._focused = false; }
            break;
        }
        case "exit": process.exit(m.code ?? 0);
    }
});

// ---------- app ----------
const paths = {
    userData: path.join(process.env.APPDATA || process.env.TEMP || ".", "euterpe-overlay"),
    temp: process.env.TEMP || process.env.TMP || ".",
    home: process.env.USERPROFILE || process.env.HOME || ".",
};
const app = new EventEmitter();
Object.assign(app, {
    commandLine: { appendSwitch() { }, hasSwitch: () => false, getSwitchValue: () => "" },
    whenReady: () => ready,
    isReady: () => connected,
    getPath: (name) => paths[name] || paths.temp,
    setPath: (name, p) => { paths[name] = p; },
    getName: () => "euterpe-overlay",
    getVersion: () => "44.4.5",
    disableHardwareAcceleration() { },
    quit() {
        app.emit("before-quit");
        for (const w of [...windows.values()]) { w.close(); }
        app.emit("will-quit");
        setTimeout(() => process.exit(0), 30);
    },
    exit(code = 0) { setTimeout(() => process.exit(code), 30); },
    focus() { toPage({ op: "app-focus" }); },
    hide() { },
    show() { },
    isActive: () => false,
    isHidden: () => false,
    dock: undefined,
});

// ---------- windows ----------
let winSeq = 0;
class WebContents extends EventEmitter {
    constructor(win) { super(); this._win = win; this.id = win.id; }
    send(channel, ...args) { toPage({ op: "to-page", win: this._win.id, channel, args }); }
    executeJavaScript(code) { return call("eval", { win: this._win.id, code }, 30_000); }
    async capturePage() { const dataUrl = await call("capture", { win: this._win.id }); return { toPNG: () => Buffer.from(String(dataUrl).split(",")[1] || "", "base64") }; }
    setWindowOpenHandler() { }
    reload() { void call("reload", { win: this._win.id }).then(() => this.emit("did-finish-load")); }
    focus() { toPage({ op: "focus", win: this._win.id }); }
    isDestroyed() { return this._win._destroyed; }
    openDevTools() { }
}

class BrowserWindow extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.id = ++winSeq;
        this._opts = opts;
        this._bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width ?? 800, height: opts.height ?? 600 };
        this._destroyed = false;
        this._visible = opts.show !== false;
        this._focusable = opts.focusable !== false;
        this._focused = false;
        this._onTop = !!opts.alwaysOnTop;
        this.webContents = new WebContents(this);
        windows.set(this.id, this);
        const preload = opts.webPreferences?.preload;
        this._preload = preload && fs.existsSync(preload) ? preload : null;
        toPage({ op: "create", win: this.id, bounds: this._bounds, transparent: !!opts.transparent, frame: opts.frame !== false, offscreen: !!opts.webPreferences?.offscreen, show: this._visible, preload: this._preload });
    }
    static getAllWindows() { return [...windows.values()]; }
    async loadFile(file, options = {}) {
        // What the page asks for synchronously (ipcRenderer.sendSync in the preload), answered ahead.
        const sync = {};
        if (this._preload) {
            for (const [, channel] of fs.readFileSync(this._preload, "utf8").matchAll(/sendSync\(\s*["']([^"']+)["']/g)) {
                const event = { sender: this.webContents, returnValue: undefined };
                ipcMain.emit(channel, event);
                sync[channel] = event.returnValue === undefined ? null : event.returnValue;
            }
        }
        await call("load", { win: this.id, file: path.resolve(file), query: options.query || {}, sync: JSON.stringify(sync) }, 30_000);
        this.webContents.emit("did-finish-load");
        this.emit("ready-to-show");
    }
    loadURL(url) { return this.loadFile(url); }
    getBounds() { return { ...this._bounds }; }
    setBounds(b) { this._bounds = { ...this._bounds, ...b }; toPage({ op: "bounds", win: this.id, bounds: this._bounds }); setImmediate(() => this.emit("moved")); }
    getPosition() { return [this._bounds.x, this._bounds.y]; }
    setPosition(x, y) { this.setBounds({ x, y }); }
    getSize() { return [this._bounds.width, this._bounds.height]; }
    setSize(width, height) { this.setBounds({ width, height }); }
    setAlwaysOnTop(on) { this._onTop = !!on; }
    isAlwaysOnTop() { return this._onTop; }
    setVisibleOnAllWorkspaces() { }
    isVisibleOnAllWorkspaces() { return false; }
    showInactive() { this._visible = true; toPage({ op: "show", win: this.id, inactive: true }); }
    show() { this._visible = true; toPage({ op: "show", win: this.id }); }
    hide() { this._visible = false; toPage({ op: "hide", win: this.id }); }
    isVisible() { return this._visible; }
    focus() { if (this._focusable) { this._focused = true; toPage({ op: "focus", win: this.id }); } }
    blur() { this._focused = false; toPage({ op: "blur", win: this.id }); }
    isFocused() { return this._focused; }
    setFocusable(on) { this._focusable = !!on; if (!on) { this._focused = false; } toPage({ op: "focusable", win: this.id, on: !!on }); }
    isFocusable() { return this._focusable; }
    setSkipTaskbar() { }
    setIgnoreMouseEvents(ignore) { toPage({ op: "ignore-mouse", win: this.id, ignore: !!ignore }); }
    hookWindowMessage() { }
    setMenu() { }
    isDestroyed() { return this._destroyed; }
    close() { if (this._destroyed) { return; } toPage({ op: "close", win: this.id }); this._destroy(); }
    destroy() { this.close(); }
    _destroy() {
        if (this._destroyed) { return; }
        this._destroyed = true;
        windows.delete(this.id);
        this.emit("closed");
        if (!windows.size) { app.emit("window-all-closed"); }
    }
}

// ---------- the rest of the main process's API ----------
const ipcMain = new EventEmitter();
ipcMain.handle = () => { };

let menuSeq = 0;
const ROLE_LABELS = { cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select All", undo: "Undo", redo: "Redo", editMenu: "Edit" };
const Menu = {
    buildFromTemplate(template) {
        return {
            items: template,
            popup(opts = {}) {
                const id = `menu-${++menuSeq}`;
                menus.set(id, { items: template, callback: opts.callback, window: opts.window });
                toPage({
                    op: "menu", menu: id, win: opts.window?.id, at: cursor,
                    items: template.map((i) => ({ label: i.label ?? ROLE_LABELS[i.role] ?? i.role, role: i.role, type: i.type || "normal", enabled: i.enabled !== false, roleLabel: !i.label && !!i.role })),
                });
            },
        };
    },
    setApplicationMenu() { },
};

const screen = {
    getPrimaryDisplay: () => display(),
    getDisplayMatching: () => display(),
    getDisplayNearestPoint: () => display(),
    getAllDisplays: () => [display()],
    getCursorScreenPoint: () => ({ ...cursor }),
    on() { },
};
function display() {
    const b = { x: 0, y: 0, width: screenInfo.width, height: screenInfo.height };
    return { id: 1, bounds: b, workArea: { ...b }, size: { width: b.width, height: b.height }, workAreaSize: { width: b.width, height: b.height }, scaleFactor: 1, rotation: 0 };
}

const clipboard = { writeText: (text) => toPage({ op: "clipboard", text: String(text) }), readText: () => "" };
// (through the extension host, which opens the bench's browser, as for vscode.env.openExternal)
const shell = { openExternal: async (url) => { toHost({ type: "electron-external", url: String(url) }); } };

module.exports = { app, BrowserWindow, ipcMain, Menu, screen, clipboard, shell, nativeTheme: { shouldUseDarkColors: true, on() { } }, ready };
