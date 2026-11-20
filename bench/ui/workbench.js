// The VS Code window: its title bar, editors (text, diffs, webviews, pictures, previews, VS Code's
// own pages), the panel (output, terminals) and the status bar, kept as the extension host says
// they are. The writer's typing in an editor goes back to the host as edits.
import { net } from "./net.js";
import { el, esc, icons, md, diffRows, markChange, plainIcons } from "./util.js";
import { renderPage } from "./pages.js";

export const W = {
    root: null,
    tabs: { groups: [], active: 1 },
    docs: new Map(),         // uri -> { uri, fsPath, name, text, languageId, version, dirty }
    selections: new Map(),
    status: [],
    windowProgress: [],
    context: {},
    settings: { user: {}, workspace: {} },
    world: null,
    trusted: true,
    output: { channels: new Map(), active: null },
    terminals: new Map(),
    panel: { visible: false, view: "output" },
    tooltip: null,           // status item id with its tooltip shown
    webviews: null,          // set by webviews.js: id -> { frame }
    interactive: () => true,
    light: false,
};

const pkg = { menus: null };

export function mountWorkbench(desktop) {
    const root = el("div", { class: "vsc", id: "vsc" });
    root.innerHTML = `
        <div class="vsc-title" data-surface="titlebar">
            <div class="menus"><span>File</span><span>Edit</span><span>Selection</span><span>View</span><span>Go</span><span>Run</span><span>…</span></div>
            <div class="search" id="vsc-search" data-surface="command-center" title="Search (Ctrl+P), or the command palette (Ctrl+Shift+P)"><i class="codicon codicon-search"></i><span id="vsc-title-text">my-blog</span></div>
            <div class="wc"><span><i class="codicon codicon-chrome-minimize"></i></span><span><i class="codicon codicon-chrome-maximize"></i></span><span><i class="codicon codicon-chrome-close"></i></span></div>
        </div>
        <div class="vsc-body">
            <div class="vsc-activity"><span class="on"><i class="codicon codicon-files"></i></span><span><i class="codicon codicon-search"></i></span><span><i class="codicon codicon-source-control"></i></span><span><i class="codicon codicon-debug-alt"></i></span><span><i class="codicon codicon-extensions"></i></span></div>
            <div class="vsc-sidebar" id="vsc-sidebar"></div>
            <div class="vsc-main">
                <div class="vsc-editors" id="vsc-editors"></div>
                <div class="vsc-panel hidden" id="vsc-panel" data-surface="panel"></div>
            </div>
        </div>
        <div class="vsc-status" id="vsc-status" data-surface="statusbar"><div class="left" id="sb-left"></div><div class="right" id="sb-right"></div></div>
        <div id="webview-layer"></div>
        <div class="toasts" id="vsc-toasts"></div>
        <div id="vsc-layer"></div>`;
    desktop.append(root);
    W.root = root;
    root.querySelector("#vsc-search").addEventListener("click", () => { if (W.interactive()) { window.dispatchEvent(new CustomEvent("bench:palette")); } });
    fetch("/repo/package.json").then((r) => r.json()).then((p) => { pkg.menus = p.contributes.menus; pkg.commands = p.contributes.commands; pkg.json = p; render(); });
    render();
}

export function setLight(on) { W.light = on; W.root?.classList.toggle("light", on); for (const f of document.querySelectorAll(".webview-frame")) { f.dispatchEvent(new CustomEvent("bench:theme")); } }

// ---------- the host's news ----------
net.on("tabs", (m) => { W.tabs = m; render(); });
net.on("doc", (m) => {
    const old = W.docs.get(m.uri);
    W.docs.set(m.uri, { ...m });
    const ta = W.root?.querySelector(`textarea[data-uri="${CSS.escape(m.uri)}"]`);
    if (ta && ta.value !== m.text) {
        const pos = ta.selectionStart;
        ta.value = m.text;
        ta.selectionStart = ta.selectionEnd = Math.min(pos, m.text.length);
        sizeEditor(ta);
    }
    if (!old || old.dirty !== m.dirty) { renderTabs(); }
    if (!ta) { renderEditors(); }
});
net.on("selection", (m) => { W.selections.set(m.uri, m); });
net.on("statusbar", (m) => { W.status = m.items; renderStatus(); });
net.on("context", (m) => { W.context = m.keys; renderEditors(); });
net.on("settings", (m) => { W.settings = { user: m.user, workspace: m.workspace }; refreshPages(); });
net.on("trust", (m) => { W.trusted = m.trusted; if (W.world) { W.world.trusted = m.trusted; } renderStatus(); refreshPages(); });
net.on("world", (m) => { W.world = m; W.trusted = m.trusted; W.settings = { user: m.user, workspace: m.workspace }; renderSidebar(); renderStatus(); });
net.on("output", (m) => {
    const ch = W.output.channels.get(m.channel) || { name: m.channel, lines: [] };
    W.output.channels.set(m.channel, ch);
    if (m.op === "append") {
        const parts = m.text.split("\n");
        if (ch.partial !== undefined) { parts[0] = ch.partial + parts[0]; }
        ch.partial = parts.pop();
        for (const p of parts) { ch.lines.push({ text: p, site: m.site }); }
        if (ch.partial === "") { ch.partial = undefined; }
        if (W.panel.visible && W.panel.view === "output" && W.output.active === m.channel) { appendOutput(parts, m.site); }
    } else if (m.op === "clear") { ch.lines = []; ch.partial = undefined; renderPanel(); }
    else if (m.op === "replace") { ch.lines = m.text.split("\n").map((t) => ({ text: t })); renderPanel(); }
    else if (m.op === "show") { W.output.active = m.channel; W.panel.visible = true; W.panel.view = "output"; renderPanel(); }
    else if (m.op === "hide") { /* stays */ }
    else if (m.op === "create" && !W.output.active) { W.output.active = m.channel; }
});
net.on("terminal", (m) => {
    if (m.op === "open") { W.terminals.set(m.id, { id: m.id, name: m.name, data: "", site: m.site }); }
    const t = W.terminals.get(m.id);
    if (!t) { return; }
    if (m.op === "data") { t.data += m.data; if (W.panel.visible && W.panel.view === `term:${m.id}`) { renderTerminalBody(); } }
    if (m.op === "show") { W.panel.visible = true; W.panel.view = `term:${m.id}`; renderPanel(); net.host({ type: "terminal-ready", id: m.id }); }
    if (m.op === "close") { t.closed = true; }
});

export function resetWorkbench() {
    W.tabs = { groups: [], active: 1 };
    W.docs.clear(); W.selections.clear();
    W.status = []; W.windowProgress = []; W.context = {};
    W.output = { channels: new Map(), active: null };
    W.terminals.clear();
    W.panel = { visible: false, view: "output" };
    W.tooltip = null;
    W.world = null;
    render();
}

export function render() { if (!W.root) { return; } renderSidebar(); renderEditors(); renderPanel(); renderStatus(); }

// ---------- the explorer ----------
function renderSidebar() {
    const sb = W.root?.querySelector("#vsc-sidebar");
    if (!sb) { return; }
    const folder = W.world?.folders?.[0];
    const files = [...W.docs.values()].filter((d) => d.fsPath && folder && d.fsPath.toLowerCase().startsWith(folder.path.toLowerCase()));
    const active = activeTab();
    sb.innerHTML = `<div class="head">Explorer</div>${folder ? `<div class="folder"><i class="codicon codicon-chevron-down"></i> ${esc(folder.name)}</div>` : `<div class="file muted">No folder opened</div>`}`;
    for (const d of files) {
        const rel = d.fsPath.slice(folder.path.length + 1).replace(/\\/g, "/");
        const on = active?.uri === d.uri;
        const f = el("div", { class: `file${on ? " on" : ""}`, title: d.fsPath }, el("i", { class: "codicon codicon-markdown" }), " ", rel);
        f.addEventListener("click", () => { if (!W.interactive()) { return; } const t = findTab((x) => x.uri === d.uri); if (t) { net.host({ type: "tab-activate", id: t.id }); } else { net.host({ type: "open-document", path: d.fsPath }); } });
        sb.append(f);
    }
    const title = W.root.querySelector("#vsc-title-text");
    if (title) { title.textContent = folder ? folder.name : "Visual Studio Code"; }
}

// ---------- editors ----------
const allTabs = () => W.tabs.groups.flatMap((g) => g.tabs.map((t) => ({ ...t, group: g.viewColumn, active: g.active === t.id })));
const findTab = (f) => allTabs().find(f);
export function activeTab() {
    const g = W.tabs.groups.find((x) => x.viewColumn === W.tabs.active) || W.tabs.groups[0];
    return g ? g.tabs.find((t) => t.id === g.active) : undefined;
}

function renderTabs() { renderEditors(); }

function whenTrue(expr, tab) {
    if (!expr) { return true; }
    const scheme = tab ? (tab.kind === "diff" ? (tab.modified || "").split(":")[0] : (tab.uri || "").split(":")[0]) : "";
    return expr.split("||").some((alt) => alt.split("&&").every((term) => {
        const t = term.trim();
        let m = /^resourceScheme\s*==\s*([\w-]+)$/.exec(t);
        if (m) { return scheme === m[1]; }
        m = /^(!)?([\w.]+)$/.exec(t);
        if (m) { const v = t === "false" ? false : t === "true" ? true : !!W.context[m[2]]; return m[1] ? !v : v; }
        return false;
    }));
}

function renderEditors() {
    const host = W.root?.querySelector("#vsc-editors");
    if (!host) { return; }
    host.innerHTML = "";
    const groups = W.tabs.groups.length ? W.tabs.groups : [{ viewColumn: 1, tabs: [], active: null }];
    for (const g of groups) {
        const gEl = el("div", { class: "vsc-group" });
        const tabsEl = el("div", { class: "vsc-tabs", "data-surface": "tabs" });
        for (const t of g.tabs) {
            const on = g.active === t.id;
            const icon = t.kind === "webview" ? (t.icon ? el("img", { src: `/fs/${String(t.icon).replace(/\\/g, "/")}`, alt: "" }) : el("i", { class: "codicon codicon-preview" }))
                : t.kind === "diff" ? el("i", { class: "codicon codicon-diff" }) : t.kind === "image" ? el("i", { class: "codicon codicon-file-media" })
                    : t.kind === "markdown" ? el("i", { class: "codicon codicon-open-preview" }) : t.kind === "page" ? el("i", { class: "codicon codicon-settings" }) : el("i", { class: "codicon codicon-markdown" });
            const dirty = t.uri && W.docs.get(t.uri)?.dirty;
            const x = el("span", { class: "x", title: "Close (Ctrl+F4)" }, dirty && !on ? el("span", { class: "dot" }) : el("i", { class: "codicon codicon-close" }));
            const tabEl = el("div", { class: `vsc-tab${on ? " active" : ""}${t.preview ? " preview" : ""}`, data: { tab: t.id, site: t.site }, title: t.uri ? decodeURIComponent(t.uri) : t.label }, icon, el("span", { class: "lbl", text: t.label }), x);
            tabEl.addEventListener("mousedown", (e) => { if (!W.interactive() || e.button !== 0) { return; } if (!e.target.closest(".x")) { net.host({ type: "tab-activate", id: t.id }); } });
            x.addEventListener("click", (e) => { e.stopPropagation(); if (W.interactive()) { net.host({ type: "tab-close", id: t.id }); } });
            tabsEl.append(tabEl);
        }
        const active = g.tabs.find((t) => t.id === g.active);
        // editor/title actions the extension contributes (Accept / Reject on its diff)
        const actions = el("div", { class: "title-actions" });
        if (active && pkg.menus) {
            for (const item of pkg.menus["editor/title"] || []) {
                if (!whenTrue(item.when, active)) { continue; }
                const cmd = (pkg.commands || []).find((c) => c.command === item.command);
                const icon = /\$\(([\w-]+)\)/.exec(cmd?.icon || "")?.[1] || "circle";
                const b = el("span", { title: cmd?.title || item.command, data: { command: item.command, manifest: "editor/title" } }, el("i", { class: `codicon codicon-${icon}` }));
                b.addEventListener("click", () => { if (W.interactive()) { net.host({ type: "command", command: item.command, args: [{ $uri: active.modified || active.uri }] }); } });
                actions.append(b);
            }
            actions.append(el("span", { title: "More Actions..." }, el("i", { class: "codicon codicon-ellipsis" })));
        }
        tabsEl.append(actions);
        gEl.append(tabsEl);
        if (active && (active.kind === "text" || active.kind === "diff")) {
            const d = W.docs.get(active.uri || active.modified);
            gEl.append(el("div", { class: "vsc-crumbs" }, ...(d?.fsPath ? crumbs(d.fsPath) : [active.label])));
        }
        const content = el("div", { class: "vsc-content" });
        if (!active) {
            content.append(el("div", { class: "vsc-empty" }, el("div", { class: "big", html: '<i class="codicon codicon-vscode" style="font-size:120px"></i>' }), el("div", { text: "Show All Commands  Ctrl+Shift+P" })));
        } else if (active.kind === "text") {
            content.append(textEditor(active));
        } else if (active.kind === "diff") {
            content.append(diffEditor(active));
        } else if (active.kind === "webview") {
            // the webview itself stays where it is (moving a frame reloads it): it's laid over this slot
            content.append(el("div", { class: "webview-slot", "data-panel": active.panel }));
        } else if (active.kind === "image") {
            content.append(el("div", { class: "img-view", "data-surface": "image" }, el("img", { src: `/fs/${String(active.page.path).replace(/\\/g, "/")}?t=${active.id}`, alt: active.label, title: active.label })));
        } else {
            content.append(renderPage(active, W));
        }
        gEl.append(content);
        host.append(gEl);
    }
    renderSidebar();
    placeWebviews();
}

/** Each webview over its editor's slot, or out of sight when its tab isn't the one shown. */
export function placeWebviews() {
    const layer = W.root?.querySelector("#webview-layer");
    if (!layer) { return; }
    const base = W.root.getBoundingClientRect();
    for (const holder of layer.querySelectorAll(".webview-holder")) {
        const slot = W.root.querySelector(`.webview-slot[data-panel="${CSS.escape(holder.dataset.panel)}"]`);
        if (!slot) { holder.style.visibility = "hidden"; holder.style.pointerEvents = "none"; continue; }
        const r = slot.getBoundingClientRect();
        Object.assign(holder.style, { left: `${r.left - base.left}px`, top: `${r.top - base.top}px`, width: `${r.width}px`, height: `${r.height}px`, visibility: "visible", pointerEvents: "auto" });
    }
}
window.addEventListener("resize", () => placeWebviews());
window.addEventListener("bench:place-webviews", () => placeWebviews());

function crumbs(fsPath) {
    const folder = W.world?.folders?.[0];
    const rel = folder && fsPath.toLowerCase().startsWith(folder.path.toLowerCase()) ? fsPath.slice(folder.path.length + 1) : fsPath;
    const parts = rel.split(/[\\/]/);
    const out = [];
    parts.forEach((p, i) => { if (i) { out.push(el("i", { class: "codicon codicon-chevron-right" })); } out.push(el("span", { text: p })); });
    return out;
}

/** The editor as tall as its text, and a line number beside each line (a wrapped line takes the room it wraps to). */
let mirror = null;
function sizeEditor(ta) {
    const lines = ta.value.split("\n");
    const gutter = ta.parentElement?.querySelector(".gutter");
    if (gutter && ta.clientWidth) {
        mirror ??= document.body.appendChild(el("div", { style: { position: "absolute", left: "-10000px", top: "0", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word" } }));
        const cs = getComputedStyle(ta);
        Object.assign(mirror.style, { font: cs.font, lineHeight: cs.lineHeight, tabSize: cs.tabSize, width: `${ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px` });
        mirror.innerHTML = lines.map((l) => `<div>${esc(l) || " "}</div>`).join("");
        gutter.innerHTML = [...mirror.children].map((c, i) => `<div style="height:${c.offsetHeight}px">${i + 1}</div>`).join("");
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.max(ta.scrollHeight, ta.parentElement?.parentElement?.clientHeight || 0)}px`;
}

function textEditor(tab) {
    const d = W.docs.get(tab.uri);
    const wrap = el("div", { class: "ed", "data-surface": "editor" });
    const gutter = el("div", { class: "gutter" });
    const ta = el("textarea", { spellcheck: "false", "data-uri": tab.uri, wrap: "soft" });
    ta.value = d ? d.text : "";
    const editable = !!d && (d.uri.startsWith("file:") || d.uri.startsWith("untitled:"));
    if (!editable) { ta.readOnly = true; }
    let last = ta.value;
    ta.addEventListener("input", () => {
        if (!W.interactive()) { ta.value = last; return; }
        const now = ta.value;
        let s = 0;
        while (s < last.length && s < now.length && last[s] === now[s]) { s++; }
        let e = 0;
        while (e < last.length - s && e < now.length - s && last[last.length - 1 - e] === now[now.length - 1 - e]) { e++; }
        net.host({ type: "doc-edit", uri: tab.uri, start: s, end: last.length - e, text: now.slice(s, now.length - e) });
        last = now;
        sizeEditor(ta);
    });
    const sel = () => net.host({ type: "doc-select", uri: tab.uri, anchor: ta.selectionDirection === "backward" ? ta.selectionEnd : ta.selectionStart, active: ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd });
    // (the writer's own moves only: a selection the page sets as the text comes in isn't theirs to echo)
    ta.addEventListener("mouseup", sel);
    ta.addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.shiftKey) { sel(); } });
    ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); net.host({ type: "doc-save", uri: tab.uri }); }
    });
    const inner = el("div", { class: "ed-wrap" }, gutter, ta);
    wrap.append(inner);
    requestAnimationFrame(() => {
        sizeEditor(ta);
        const s = W.selections.get(tab.uri);
        if (s && document.activeElement !== ta) { ta.selectionStart = Math.min(s.anchor, s.active); ta.selectionEnd = Math.max(s.anchor, s.active); }
    });
    // what changes the text from the host keeps `last` in step
    const observer = new MutationObserver(() => { last = ta.value; });
    observer.observe(ta, { attributes: true });
    ta.addEventListener("focus", () => { last = ta.value; });
    const watchValue = () => { if (!ta.isConnected) { return; } if (document.activeElement !== ta) { last = ta.value; } requestAnimationFrame(watchValue); };
    watchValue();
    return wrap;
}

function diffEditor(tab) {
    const L = W.docs.get(tab.original), R = W.docs.get(tab.modified);
    const { rows, A, B } = diffRows(L?.text ?? "", R?.text ?? "");
    const wrap = el("div", { class: "diff", "data-surface": "diff", data: { site: tab.site } });
    const left = el("div", { class: "side" }), right = el("div", { class: "side" });
    for (const r of rows) {
        const lt = r.l === null ? null : A[r.l], rt = r.r === null ? null : B[r.r];
        const lcls = r.kind === "del" || r.kind === "mod" ? "del" : r.l === null ? "pad" : "";
        const rcls = r.kind === "ins" || r.kind === "mod" ? "ins" : r.r === null ? "pad" : "";
        left.append(el("div", { class: `line ${lcls}` }, el("span", { class: "n", text: r.l === null ? "" : r.l + 1 }), el("span", { class: "s", html: lt === null ? "" : r.kind === "mod" ? markChange(lt, rt, "del") : esc(lt) })));
        right.append(el("div", { class: `line ${rcls}` }, el("span", { class: "n", text: r.r === null ? "" : r.r + 1 }), el("span", { class: "s", html: rt === null ? "" : r.kind === "mod" ? markChange(rt, lt, "ins") : esc(rt) })));
    }
    wrap.append(left, right);
    return wrap;
}

export function refreshPages() {
    const t = activeTab();
    if (t && (t.kind === "page" || t.kind === "markdown")) { renderEditors(); }
}

// ---------- the panel ----------
function renderPanel() {
    const p = W.root?.querySelector("#vsc-panel");
    if (!p) { return; }
    p.classList.toggle("hidden", !W.panel.visible);
    requestAnimationFrame(placeWebviews);
    if (!W.panel.visible) { return; }
    const terms = [...W.terminals.values()];
    const termView = W.panel.view.startsWith("term:");
    p.innerHTML = "";
    const row = el("div", { class: "tabsrow" },
        el("span", { text: "Problems" }), el("span", { class: !termView ? "on" : "", text: "Output", onclick: () => { W.panel.view = "output"; renderPanel(); } }),
        el("span", { text: "Debug Console" }), el("span", { class: termView ? "on" : "", text: "Terminal", onclick: () => { if (terms[0]) { W.panel.view = `term:${terms[terms.length - 1].id}`; renderPanel(); } } }));
    const right = el("div", { class: "right" });
    if (!termView) {
        const sel = el("select", { title: "Output channel" });
        for (const name of W.output.channels.keys()) { sel.append(el("option", { value: name, text: name, selected: name === W.output.active })); }
        sel.addEventListener("change", () => { W.output.active = sel.value; renderPanel(); });
        right.append(sel);
    } else {
        const t = W.terminals.get(W.panel.view.slice(5));
        if (t) { right.append(el("span", { class: "muted", html: `<i class="codicon codicon-terminal"></i> ${esc(t.name)}` })); }
    }
    right.append(el("span", { title: "Close Panel", style: { cursor: "pointer" }, html: '<i class="codicon codicon-close"></i>', onclick: () => { W.panel.visible = false; renderPanel(); } }));
    row.append(right);
    p.append(row);
    const body = el("div", { class: "body", id: "vsc-panel-body", "data-surface": termView ? "terminal" : "output" });
    p.append(body);
    if (termView) { renderTerminalBody(); }
    else {
        const ch = W.output.channels.get(W.output.active);
        for (const l of ch?.lines || []) { body.append(el("div", { class: "out-line", text: l.text, data: { site: l.site } })); }
        body.scrollTop = body.scrollHeight;
    }
}
function appendOutput(lines, site) {
    const body = W.root?.querySelector("#vsc-panel-body");
    if (!body || body.dataset.surface !== "output") { renderPanel(); return; }
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
    for (const t of lines) { body.append(el("div", { class: "out-line", text: t, data: { site } })); }
    if (atEnd) { body.scrollTop = body.scrollHeight; }
}

/** A terminal's text, with the colours its escape codes ask for. */
function ansiHtml(data) {
    let out = "", cls = [];
    const text = data.replace(/\r\n/g, "\n").replace(/[^\n\x1b]*\r(?!\n)/g, "");
    let lines = [];
    for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
        const m = /^\x1b\[([0-9;]*)m$/.exec(part);
        if (m) {
            for (const c of m[1].split(";").map(Number)) { if (c === 0) { cls = []; } else { cls.push(`ansi-${c}`); } }
            continue;
        }
        let p = part;
        // backspaces as the console echoes them ("\x08 \x08" rubs a character out)
        while (/[^\x08]\x08 \x08/.test(p)) { p = p.replace(/[^\x08]\x08 \x08/, ""); }
        out += cls.length ? `<span class="${cls.join(" ")}">${esc(p)}</span>` : esc(p);
    }
    void lines;
    return out;
}
function renderTerminalBody() {
    const body = W.root?.querySelector("#vsc-panel-body");
    const t = W.terminals.get(W.panel.view.slice(5));
    if (!body || !t) { return; }
    body.innerHTML = `<div class="term" tabindex="0">${ansiHtml(t.data)}<span class="cursor"> </span></div>`;
    const term = body.firstChild;
    term.addEventListener("keydown", (e) => {
        if (!W.interactive()) { return; }
        let data = null;
        if (e.key === "Enter") { data = "\r"; } else if (e.key === "Backspace") { data = "\x7f"; } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { data = e.key; }
        if (data !== null) { e.preventDefault(); net.host({ type: "terminal-input", id: t.id, data }); }
    });
    body.scrollTop = body.scrollHeight;
}

// ---------- the status bar ----------
export function renderStatus() {
    const left = W.root?.querySelector("#sb-left"), right = W.root?.querySelector("#sb-right");
    if (!left || !right) { return; }
    left.innerHTML = "";
    right.innerHTML = "";
    const remote = W.world?.remote;
    left.append(el("div", { class: "sb-item remote", title: remote ? `Remote: ${remote}` : "Open a Remote Window", html: remote ? `<i class="codicon codicon-remote"></i> ${esc(remote === "wsl" ? "WSL: Ubuntu" : remote)}` : '<i class="codicon codicon-remote"></i>' }));
    if (W.world && !W.trusted) { left.append(el("div", { class: "sb-item", title: "Restricted Mode is intended for safe code browsing. Trust this window to enable all features.", html: '<i class="codicon codicon-shield"></i> Restricted Mode' })); }
    left.append(el("div", { class: "sb-item", html: '<i class="codicon codicon-source-control"></i> main' }));
    left.append(el("div", { class: "sb-item", html: '<i class="codicon codicon-error"></i> 0 <i class="codicon codicon-warning"></i> 0' }));
    for (const p of W.windowProgress) { left.append(el("div", { class: "sb-item", title: p.title, data: { site: p.site, surface: "window-progress" }, html: `<i class="codicon codicon-loading codicon-modifier-spin"></i> ${esc(p.title || "")}` })); }
    const items = W.status.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const mk = (i) => {
        const cls = ["sb-item", "euterpe"];
        if (i.command) { cls.push("cmd"); }
        if (i.backgroundColor === "statusBarItem.warningBackground") { cls.push("warn"); }
        const item = el("div", { class: cls.join(" "), data: { site: i.site, surface: "statusbar-item", status: i.id }, "aria-label": i.accessibility || "", html: icons(i.text || "") });
        if (i.tooltip) {
            item.addEventListener("mouseenter", () => showTooltip(i, item));
            item.addEventListener("mouseleave", () => { setTimeout(() => { if (!document.querySelector(".sb-tooltip:hover") && W.tooltip === i.id && !W.tooltipPinned) { hideTooltip(); } }, 250); });
        }
        item.addEventListener("click", () => { if (W.interactive() && i.command) { net.host({ type: "command", command: i.command, args: i.args || [] }); } });
        if (W.tooltip === i.id) { item.append(tooltipEl(i)); }
        return item;
    };
    for (const i of items.filter((x) => x.alignment === 1)) { left.append(mk(i)); }
    const known = ["Ln 9, Col 74", "Spaces: 4", "UTF-8", "LF", "Markdown"];
    const editor = activeTab();
    if (editor?.kind === "text") { for (const k of known) { right.append(el("div", { class: "sb-item", text: k })); } }
    for (const i of items.filter((x) => x.alignment !== 1)) { right.append(mk(i)); }
    const bell = el("div", { class: "sb-item", title: "Notifications", "data-surface": "bell", html: `<i class="codicon codicon-${window.benchNotifications?.count?.() ? "bell-dot" : "bell"}"></i>` });
    bell.addEventListener("click", () => window.dispatchEvent(new CustomEvent("bench:center")));
    right.append(bell);
}
function tooltipEl(i) {
    const t = i.tooltip;
    const html = typeof t === "string" ? esc(t).replace(/\n/g, "<br>") : md(t.markdown, { icons: t.supportThemeIcons });
    const tip = el("div", { class: "sb-tooltip", "data-surface": "tooltip", data: { site: i.site }, html });
    tip.addEventListener("click", (e) => {
        const a = e.target.closest("a[data-href]");
        if (!a) { return; }
        e.preventDefault();
        const href = a.dataset.href;
        const m = /^command:([\w.]+)(\?(.*))?$/.exec(href);
        if (m && W.interactive()) { let args = []; try { args = m[3] ? JSON.parse(decodeURIComponent(m[3])) : []; } catch { /* none */ } net.host({ type: "command", command: m[1], args: Array.isArray(args) ? args : [args] }); hideTooltip(); }
    });
    tip.addEventListener("mouseleave", () => { if (!W.tooltipPinned) { hideTooltip(); } });
    return tip;
}
/** A status bar item's tooltip, with the notifications moved up above it (as they make room in VS Code). */
export function showTooltip(i, _item, pinned = false) {
    W.tooltip = i.id; W.tooltipPinned = pinned; renderStatus();
    const tip = W.root?.querySelector(".sb-tooltip"), toasts = W.root?.querySelector("#vsc-toasts");
    if (tip && toasts) { toasts.style.bottom = `${tip.offsetHeight + 40}px`; }
}
export function hideTooltip() {
    W.tooltip = null; W.tooltipPinned = false; renderStatus();
    const toasts = W.root?.querySelector("#vsc-toasts");
    if (toasts) { toasts.style.bottom = ""; }
}
export function showEuterpeTooltip() {
    const i = W.status.find((x) => /Euterpe/.test(plainIcons(x.text)) || /euterpe/.test(x.text));
    if (i) { showTooltip(i, null, true); }
    return !!i;
}
