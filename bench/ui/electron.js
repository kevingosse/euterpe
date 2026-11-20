// Electron, as the overlay's main process (overlay/main.js, run by fake/electron-host.js) sees it:
// its windows are frames on the bench's desktop running the overlay's real page, its menus are
// drawn here, and its IPC goes through the page. A window that lets clicks through (the overlay's
// empty space) still hears the pointer, as Electron's { forward: true } does.
import { net } from "./net.js";
import { el, toastMini } from "./util.js";
import { openBrowser } from "./browser.js";

export const wins = new Map();   // id (proc:win) -> window
let cursor = { x: 0, y: 0 };
let dragging = null;             // window id holding a drag or a resize
let openMenu = null;

const desktop = () => document.getElementById("desktop");
/** The room left below Euterpe's window, for VS Code's notifications and status bar. */
const SPARE = 170;
const key = (proc, win) => `${proc}:${win}`;
const reply = (m, result, error) => net.send("proc", { type: "electron-reply", reqId: m.reqId, result, error }, { proc: m.from });
const toProc = (w, msg) => net.send("proc", msg, { proc: w.proc });

window.benchElectron = {
    sync(id, channel) { const w = wins.get(id); return JSON.stringify(w?.sync?.[channel] ?? null); },
    send(id, channel, argsJson) {
        const w = wins.get(id);
        if (!w) { return; }
        const args = JSON.parse(argsJson || "[]");
        if (channel === "drag-start" || channel === "resize-start") { dragging = id; sendCursor(w); }
        if (channel === "drag-end" || channel === "resize-end") { dragging = null; }
        if (channel === "show-context-menu" || channel === "show-text-menu") { sendCursor(w); }
        toProc(w, { type: "ipc", win: w.win, channel, args });
    },
    on(id, channel, cb) { const w = wins.get(id); if (!w) { return; } if (!w.listeners.has(channel)) { w.listeners.set(channel, []); } w.listeners.get(channel).push(cb); },
};

function sendCursor(w) { toProc(w, { type: "cursor", x: cursor.x, y: cursor.y }); }
function deskPoint(e, frameOffset) {
    const r = desktop().getBoundingClientRect();
    return { x: (frameOffset ? frameOffset.left + e.clientX : e.clientX) - r.left, y: (frameOffset ? frameOffset.top + e.clientY : e.clientY) - r.top };
}

// the pointer, wherever it is on the desktop
document.addEventListener("pointermove", (e) => {
    const p = deskPoint(e);
    cursor = p;
    if (dragging) { const w = wins.get(dragging); if (w) { sendCursor(w); } }
    forwardMove(e, p);
}, true);

/** Over a window that lets clicks through: the page under it still sees the pointer move (and leave). */
function forwardMove(e, p) {
    for (const w of wins.values()) {
        if (!w.ignore || !w.frame?.contentDocument || w.offscreen || !w.visible) { continue; }
        const b = w.bounds;
        const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
        const doc = w.frame.contentDocument, win = w.frame.contentWindow;
        if (inside) {
            w.pointerInside = true;
            doc.dispatchEvent(new win.MouseEvent("mousemove", { clientX: p.x - b.x, clientY: p.y - b.y, screenX: e.screenX, screenY: e.screenY, bubbles: true }));
        } else if (w.pointerInside) {
            w.pointerInside = false;
            doc.dispatchEvent(new win.MouseEvent("mouseleave", { bubbles: false }));
        }
    }
}

function place(w) {
    if (!w.el) { return; }
    const b = w.bounds;
    Object.assign(w.el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px` });
}

function wireFrame(w) {
    const doc = w.frame.contentDocument, fwin = w.frame.contentWindow;
    if (!doc || !fwin) { return; }
    const offset = () => ({ left: w.el.getBoundingClientRect().left, top: w.el.getBoundingClientRect().top });
    const track = (e) => {
        cursor = deskPoint(e, offset());
        if (dragging === w.id) { sendCursor(w); }
    };
    fwin.addEventListener("pointermove", track, true);
    fwin.addEventListener("mousemove", (e) => { if (e.isTrusted) { track(e); } }, true);
    fwin.addEventListener("pointerdown", track, true);
    fwin.addEventListener("contextmenu", (e) => { cursor = deskPoint(e, offset()); sendCursor(w); }, true);
    fwin.addEventListener("focus", () => toProc(w, { type: "window-event", win: w.win, event: "focus" }));
    fwin.addEventListener("blur", () => toProc(w, { type: "window-event", win: w.win, event: "blur" }));
    window.dispatchEvent(new CustomEvent("bench:frame", { detail: { frame: w.frame, kind: w.offscreen ? "sheet" : "overlay", id: w.id } }));
}

net.on("electron", async (m) => {
    const id = key(m.from, m.win);
    switch (m.op) {
        case "screen": {
            // The screen Euterpe's window sees. Its work area stops short of the desktop's bottom:
            // there, VS Code's notifications, the status bar and its tooltips would hide under
            // Euterpe (as they do on a real screen, where it floats above everything).
            const r = desktop().getBoundingClientRect();
            reply(m, { width: Math.round(r.width), height: Math.round(r.height) - SPARE });
            break;
        }
        case "create": {
            const w = { id, proc: m.from, win: m.win, bounds: m.bounds, offscreen: m.offscreen, visible: !!m.show && !m.offscreen, ignore: false, listeners: new Map(), sync: {}, preload: m.preload };
            const frame = el("iframe", { allowtransparency: "true", title: m.offscreen ? "offscreen window" : "Euterpe's window", "data-win": id });
            if (m.offscreen) {
                w.el = el("div", { "data-win": id }, frame);
                document.getElementById("sheet-frames").append(w.el);
            } else {
                w.el = el("div", { class: `ewin${w.visible ? "" : " hidden-win"}`, "data-surface": "overlay", "data-win": id }, frame);
                desktop().append(w.el);
                place(w);
            }
            w.frame = frame;
            frame.addEventListener("load", () => wireFrame(w));
            wins.set(id, w);
            break;
        }
        case "load": {
            const w = wins.get(id);
            if (!w) { reply(m, null, "no such window"); break; }
            w.sync = JSON.parse(m.sync || "{}");
            const q = new URLSearchParams(m.query || {});
            q.set("bench-win", id);
            if (w.preload) { q.set("bench-preload", w.preload); }
            const done = () => { w.frame.removeEventListener("load", done); reply(m, true); };
            w.frame.addEventListener("load", done);
            w.frame.src = `/fs/${m.file.replace(/\\/g, "/")}?${q.toString()}`;
            break;
        }
        case "bounds": { const w = wins.get(id); if (w) { w.bounds = m.bounds; place(w); } break; }
        case "show": { const w = wins.get(id); if (w && !w.offscreen) { w.visible = true; w.el.classList.remove("hidden-win"); } break; }
        case "hide": { const w = wins.get(id); if (w && !w.offscreen) { w.visible = false; w.el.classList.add("hidden-win"); } break; }
        case "ignore-mouse": { const w = wins.get(id); if (w && !w.offscreen) { w.ignore = m.ignore; w.el.classList.toggle("ignore", m.ignore); } break; }
        case "focus": { const w = wins.get(id); try { w?.frame.contentWindow.focus(); } catch { /* fine */ } break; }
        case "blur": {
            const ta = document.querySelector(".vsc textarea");
            if (ta) { ta.focus({ preventScroll: true }); } else { window.focus(); }
            break;
        }
        case "focusable": break;
        case "to-page": {
            const w = wins.get(id);
            for (const cb of w?.listeners.get(m.channel) || []) {
                try { cb({ sender: null }, ...JSON.parse(JSON.stringify(m.args || []))); } catch (err) { console.error(err); }
            }
            break;
        }
        case "eval": {
            // as Electron's executeJavaScript: past the page's own Content Security Policy (the page
            // may forbid eval), so run from here, with the page's window and document at hand
            const w = wins.get(id);
            try {
                const fw = w.frame.contentWindow;
                let fn;
                try { fn = new Function("window", "document", "globalThis", `return (${m.code}\n);`); }
                catch { fn = new Function("window", "document", "globalThis", m.code); }
                let r = fn.call(fw, fw, fw.document, fw);
                if (r && typeof r.then === "function") { r = await r; }
                reply(m, r === undefined ? null : JSON.parse(JSON.stringify(r)));
            } catch (err) { reply(m, null, String(err.message || err)); }
            break;
        }
        case "reload": {
            const w = wins.get(id);
            if (!w) { reply(m, null, "no such window"); break; }
            const done = () => { w.frame.removeEventListener("load", done); reply(m, true); };
            w.frame.addEventListener("load", done);
            w.frame.contentWindow.location.reload();
            break;
        }
        case "capture": reply(m, null, "the bench doesn't capture windows"); break;
        case "close": { const w = wins.get(id); w?.el.remove(); wins.delete(id); break; }
        case "menu": showMenu(m); break;
        case "clipboard": toastMini("Copied to the clipboard"); try { await navigator.clipboard.writeText(m.text); } catch { /* not focused */ } break;
        case "open-external": openBrowser({ id: `ext-${Date.now()}`, url: m.url, kind: "page", from: "overlay" }); break;
        case "app-focus": break;
    }
});

function closeMenu(index = null) {
    if (!openMenu) { return; }
    const m = openMenu;
    openMenu = null;
    m.node.remove();
    net.send("proc", { type: "menu-click", menu: m.menu, index }, { proc: m.from });
}
function showMenu(m) {
    closeMenu();
    const node = el("div", { class: "emenu", "data-surface": "overlay-menu", "data-source": "overlay/main.js" });
    m.items.forEach((it, i) => {
        if (it.type === "separator") { node.append(el("div", { class: "sep" })); return; }
        const row = el("div", { class: it.enabled ? "" : "dis", "data-role": "menu-item", "data-menu-label": it.label, ...(it.roleLabel ? { "data-vscode": "1", title: "Electron's own label for this menu role" } : {}) }, it.label);
        row.addEventListener("click", (e) => { e.stopPropagation(); if (it.enabled) { closeMenu(i); } });
        node.append(row);
    });
    const at = m.at || cursor;
    node.style.left = `${Math.max(4, Math.min(at.x, desktop().clientWidth - 240))}px`;
    node.style.top = `${Math.max(4, Math.min(at.y, desktop().clientHeight - 30 * m.items.length - 10))}px`;
    desktop().append(node);
    openMenu = { node, menu: m.menu, from: m.from };
}
document.addEventListener("pointerdown", (e) => { if (openMenu && !openMenu.node.contains(e.target) && !document.body.classList.contains("comment-on")) { closeMenu(null); } }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openMenu) { closeMenu(null); } });
/** The scenario picks a menu item (by label), or dismisses the menu. */
export function pickMenu(label) {
    if (!openMenu) { return false; }
    if (label === null) { closeMenu(null); return true; }
    const rows = [...openMenu.node.querySelectorAll("[data-role=menu-item]")];
    const row = rows.find((r) => r.dataset.menuLabel === label || r.textContent.trim() === label);
    if (!row) { return false; }
    row.click();
    return true;
}
export const menuShown = () => !!openMenu;

export function resetElectron() {
    for (const w of wins.values()) { w.el?.remove(); }
    wins.clear();
    dragging = null;
    closeMenu();
}

/** The overlay's window (the first one that isn't offscreen). */
export function overlayWindow() { return [...wins.values()].find((w) => !w.offscreen && w.frame?.contentWindow); }
