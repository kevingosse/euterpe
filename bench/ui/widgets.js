// What waits for the writer, drawn as VS Code draws it: notifications (and their center), modal
// dialogs, quick picks, input boxes, progress, and the system's file dialog. Each answers the
// extension host when the writer (or the scenario) chooses.
import { net } from "./net.js";
import { el, esc, icons, linkify, plainIcons } from "./util.js";
import { W, renderStatus } from "./workbench.js";

export const widgets = new Map();   // id -> { id, spec, node }
const history = [];                 // notifications that went to the center
let centerOpen = false;
let modalQueue = [];

window.benchNotifications = { count: () => history.filter((h) => h.open).length };

const answer = (id, event, data = {}) => net.host({ type: "widget", id, event, data });
const ICON = { info: "info", warning: "warning", error: "error" };

net.on("widget", (m) => {
    if (m.op === "open") { open(m.id, m.spec); }
    else if (m.op === "update") { const w = widgets.get(m.id); if (w) { Object.assign(w.spec, m.patch); update(w, m.patch); } }
    else if (m.op === "close") { close(m.id); }
});
// the scenario pressed something: show the press
net.on("widget-act", (m) => {
    const w = widgets.get(m.id);
    if (!w?.node) { return; }
    const target = m.act === "click" ? w.node.querySelectorAll("[data-index]")[m.index] : w.node.querySelector(`.qitem[data-index="${m.index}"]`);
    target?.classList.add("pressed");
});

export function resetWidgets() {
    for (const id of [...widgets.keys()]) { close(id); }
    history.length = 0;
    modalQueue = [];
    renderCenter();
}

function layer() { return W.root?.querySelector("#vsc-layer"); }
function toasts() { return W.root?.querySelector("#vsc-toasts"); }

function open(id, spec) {
    const w = { id, spec, node: null };
    widgets.set(id, w);
    if (spec.widget === "message") { spec.modal ? openModal(w) : openToast(w); }
    else if (spec.widget === "quickpick") { openQuickPick(w); }
    else if (spec.widget === "input") { openInput(w); }
    else if (spec.widget === "progress") { openProgress(w); }
    else if (spec.widget === "open-dialog") { openFileDialog(w); }
    window.dispatchEvent(new CustomEvent("bench:widget", { detail: w }));
}

function close(id) {
    const w = widgets.get(id);
    if (!w) { return; }
    widgets.delete(id);
    if (w.spec.widget === "progress" && w.spec.location === "window") { W.windowProgress = W.windowProgress.filter((p) => p.id !== id); renderStatus(); }
    const h = history.find((x) => x.id === id);
    if (h) { h.open = false; }
    w.node?.remove();
    if (w.spec.modal) { modalQueue = modalQueue.filter((x) => x !== w); showNextModal(); }
    renderCenter();
    renderStatus();
}

function update(w, patch) {
    if (w.spec.widget === "quickpick") { renderQuickPick(w); }
    else if (w.spec.widget === "input") { renderInputState(w, patch); }
    else if (w.spec.widget === "progress") { renderProgress(w, patch); }
}

const src = (spec) => (spec.site && spec.site.length ? JSON.stringify(spec.site) : undefined);

// ---------- notifications ----------
function toastNode(w, inCenter = false) {
    const s = w.spec;
    const node = el("div", { class: "toast", "data-surface": "notification", data: { widget: w.id, site: src(s), severity: s.severity } });
    const msg = el("div", { class: "msg", "data-role": "message", html: linkify(s.message) });
    const tools = el("div", { class: "tools" },
        el("span", { title: "Notification Settings", html: '<i class="codicon codicon-gear"></i>' }),
        el("span", { title: "Clear Notification (Delete)", "data-role": "close", html: '<i class="codicon codicon-close"></i>', onclick: () => { if (W.interactive()) { answer(w.id, "answer", { index: null }); } } }));
    node.append(el("div", { class: "msg-row" }, el("i", { class: `ic codicon codicon-${ICON[s.severity] || "info"} ${s.severity}` }), msg, tools));
    const actRow = el("div", { class: "act-row" }, el("div", { class: "source", "data-role": "source", text: "Source: Euterpe" }));
    s.items.forEach((it, i) => {
        const b = el("button", { class: `vbtn${i ? " secondary" : ""}`, "data-index": i, "data-role": "button", text: it.title });
        b.addEventListener("click", () => { if (W.interactive()) { answer(w.id, "answer", { index: i }); } });
        actRow.append(b);
    });
    node.append(actRow);
    void inCenter;
    return node;
}
function openToast(w) {
    history.unshift({ id: w.id, spec: w.spec, open: true, at: Date.now() });
    w.node = toastNode(w);
    toasts()?.append(w.node);
    renderStatus();
}
window.addEventListener("bench:center", () => { centerOpen = !centerOpen; renderCenter(); });
function renderCenter() {
    layer()?.querySelector(".center-panel")?.remove();
    if (!centerOpen) { return; }
    const panel = el("div", { class: "center-panel", "data-surface": "notification-center" }, el("div", { class: "head" }, el("span", { text: history.length ? "Notifications" : "No new notifications" }), el("span", { html: '<i class="codicon codicon-chevron-down"></i>', onclick: () => { centerOpen = false; renderCenter(); } })));
    const list = el("div", { class: "list" });
    for (const h of history) {
        const live = widgets.get(h.id);
        const node = toastNode(live || { id: h.id, spec: h.spec }, true);
        if (!h.open) { node.style.opacity = ".6"; node.querySelectorAll("button").forEach((b) => { b.disabled = true; }); }
        list.append(node);
    }
    panel.append(list);
    layer()?.append(panel);
}

// ---------- modal dialogs ----------
function openModal(w) {
    modalQueue.push(w);
    if (modalQueue.length === 1) { showNextModal(); }
}
function showNextModal() {
    const w = modalQueue[0];
    if (!w || w.node) { return; }
    const s = w.spec;
    const buttons = el("div", { class: "buttons" });
    s.items.forEach((it, i) => {
        const b = el("button", { class: `vbtn${i ? " secondary" : ""}`, "data-index": i, "data-role": "button", text: it.title });
        b.addEventListener("click", () => { if (W.interactive()) { answer(w.id, "answer", { index: i }); } });
        buttons.append(b);
    });
    // VS Code adds a Cancel button unless one of the items closes the dialog itself
    if (!s.items.some((i) => i.isCloseAffordance)) {
        const c = el("button", { class: "vbtn secondary", "data-role": "cancel", "data-vscode": "1", title: "VS Code's own (it adds Cancel to every modal message)", text: "Cancel" });
        c.addEventListener("click", () => { if (W.interactive()) { answer(w.id, "answer", { index: null }); } });
        buttons.append(c);
    }
    // A dialog of VS Code's own (`vscode`: its consent to the language models, its Copilot setup):
    // VS Code's words, but for the ones of Euterpe's it quotes (its detail, after `detailLabel`).
    const own = s.vscode ? { "data-vscode": "1" } : {};
    const detail = !s.detail ? null
        : s.vscode && s.detailLabel ? el("div", { class: "detail", "data-role": "detail", "data-vscode": "0" }, el("span", { "data-vscode": "1", text: s.detailLabel }), el("span", { text: s.detail }))
            : el("div", { class: "detail", "data-role": "detail", text: s.detail });
    const dlg = el("div", { class: "modal", role: "dialog", "data-surface": s.vscode ? `vscode-dialog:${s.vscode}` : "modal", data: { widget: w.id, site: src(s), severity: s.severity }, ...own },
        el("div", { class: "top" },
            el("i", { class: `codicon codicon-${s.icon || ICON[s.severity] || "info"} ${s.severity}` }),
            el("div", { style: { minWidth: 0, flex: 1 } },
                el("div", { class: "appname", text: "Visual Studio Code", "data-vscode": "1", title: s.vscode ? "VS Code's own dialog, not Euterpe's" : null }),
                el("div", { class: "message", "data-role": "message", text: s.message }),
                detail,
                s.vscode === "copilot-setup" ? el("div", { class: "detail bench-only", style: { fontStyle: "italic", opacity: ".7" }, text: "The bench's stand-in for VS Code's Copilot setup: Continue with GitHub signs in." }) : null)),
        buttons);
    w.node = el("div", { class: "modal-back" }, dlg);
    layer()?.append(w.node);
}

// ---------- quick picks ----------
function filterItems(s, value) {
    const v = (value || "").trim().toLowerCase();
    const items = s.items.map((it, index) => ({ ...it, index }));
    if (!v) { return items; }
    return items.filter((it) => it.kind === -1 ? false : [plainIcons(it.label), s.matchOnDescription ? it.description : "", s.matchOnDetail ? it.detail : ""].some((x) => String(x || "").toLowerCase().includes(v)));
}
function openQuickPick(w) {
    const s = w.spec;
    w.value = s.value || "";
    w.activeIndex = s.active?.[0] ?? s.items.findIndex((i) => i.kind !== -1);
    w.node = el("div", { class: "qi", "data-surface": "quickpick", data: { widget: w.id, site: src(s) } });
    layer()?.append(w.node);
    renderQuickPick(w, true);
}
function renderQuickPick(w, first = false) {
    const s = w.spec, node = w.node;
    if (!node) { return; }
    if (s.value !== undefined && s.value !== w.value && !first) { w.value = s.value; }
    if (s.active && s.active.length && first) { w.activeIndex = s.active[0]; }
    node.innerHTML = "";
    if (s.title) { node.append(el("div", { class: "qtitle", "data-role": "title" }, el("span", { text: s.title }), s.step ? el("span", { class: "step", text: `${s.step}/${s.totalSteps}` }) : null)); }
    const input = el("input", { type: "text", placeholder: s.placeholder || "", "data-role": "placeholder", spellcheck: "false" });
    input.value = w.value;
    node.append(el("div", { class: "qinput" }, input));
    if (s.busy) { node.append(el("div", { class: "busy" })); }
    const list = el("div", { class: "qlist" });
    const shown = filterItems(s, w.value);
    if (!shown.some((x) => x.index === w.activeIndex && x.kind !== -1)) { w.activeIndex = shown.find((x) => x.kind !== -1)?.index ?? -1; }
    let lastSep = false;
    shown.forEach((it, k) => {
        if (it.kind === -1) {
            if (k === 0 || lastSep) { return; }
            lastSep = true;
            list.append(el("div", { class: "qsep", "data-role": "separator" }, it.label ? el("span", { class: "sl", text: it.label }) : null));
            return;
        }
        lastSep = false;
        const row = el("div", { class: `qitem${it.index === w.activeIndex ? " active" : ""}`, "data-index": it.index, "data-role": "item" });
        const l1 = el("div", { class: "l1" }, el("span", { class: "lbl", "data-role": "label", html: icons(it.label) }), it.description ? el("span", { class: "desc", "data-role": "description", text: it.description }) : null);
        row.append(el("div", { class: "main" }, l1, it.detail ? el("div", { class: "det", "data-role": "detail", text: it.detail }) : null));
        if (it.buttons?.length) {
            const bs = el("div", { class: "ibtns" });
            it.buttons.forEach((b, bi) => {
                const bn = el("span", { title: b.tooltip || "", "data-role": "item-button", html: `<i class="codicon codicon-${b.icon || "circle"}"></i>` });
                bn.addEventListener("click", (e) => { e.stopPropagation(); if (W.interactive()) { answer(w.id, "button", { index: it.index, button: bi }); } });
                bs.append(bn);
            });
            row.append(bs);
        }
        row.addEventListener("mousemove", () => { if (w.activeIndex !== it.index) { w.activeIndex = it.index; for (const r of list.querySelectorAll(".qitem")) { r.classList.toggle("active", +r.dataset.index === it.index); } } });
        row.addEventListener("click", () => { if (W.interactive()) { answer(w.id, "accept", { index: it.index }); } });
        list.append(row);
    });
    if (!shown.some((x) => x.kind !== -1)) { list.append(el("div", { class: "qempty", text: "No matching results" })); }
    node.append(list);
    input.addEventListener("input", () => { w.value = input.value; answer(w.id, "value", { value: input.value }); renderQuickPick(w); const i = w.node.querySelector("input"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
    input.addEventListener("keydown", (e) => {
        const pickable = filterItems(s, w.value).filter((x) => x.kind !== -1);
        const at = pickable.findIndex((x) => x.index === w.activeIndex);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = pickable[(at + (e.key === "ArrowDown" ? 1 : -1) + pickable.length) % pickable.length]; if (n) { w.activeIndex = n.index; renderQuickPick(w); w.node.querySelector("input").focus(); } }
        if (e.key === "Enter") { e.preventDefault(); if (W.interactive() && w.activeIndex >= 0) { answer(w.id, "accept", { index: w.activeIndex }); } }
        if (e.key === "Escape") { e.preventDefault(); if (W.interactive()) { answer(w.id, "hide"); } }
    });
    if (W.interactive() && first) { setTimeout(() => input.focus(), 30); }
}

// ---------- input boxes ----------
function openInput(w) {
    const s = w.spec;
    w.node = el("div", { class: "qi", "data-surface": "input", data: { widget: w.id, site: src(s) } });
    if (s.title) { w.node.append(el("div", { class: "qtitle", "data-role": "title", text: s.title })); }
    const input = el("input", { type: s.password ? "password" : "text", placeholder: s.placeHolder || "", "data-role": "placeholder", spellcheck: "false" });
    input.value = s.value || "";
    const box = el("div", { class: "qinput" }, input);
    const msg = el("div", { class: "qmsg", "data-role": "prompt" });
    w.node.append(box, msg);
    layer()?.append(w.node);
    renderInputState(w, {});
    input.addEventListener("input", () => answer(w.id, "value", { value: input.value }));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); if (W.interactive()) { answer(w.id, "accept", { value: input.value }); } }
        if (e.key === "Escape") { e.preventDefault(); if (W.interactive()) { answer(w.id, "hide"); } }
    });
    if (W.interactive()) { setTimeout(() => input.focus(), 30); }
}
function renderInputState(w, patch) {
    const s = w.spec;
    const input = w.node?.querySelector("input");
    if (!input) { return; }
    if (patch.typedByScenario && patch.value !== undefined) { input.value = patch.value; }
    const v = s.validation;
    const box = w.node.querySelector(".qinput"), msg = w.node.querySelector(".qmsg");
    box.classList.toggle("invalid", !!v && v.severity === 3);
    msg.classList.toggle("err", !!v && v.severity === 3);
    if (v) { msg.textContent = v.message; msg.dataset.role = "validation"; }
    else {
        // VS Code's own words around the prompt
        const hint = "Press 'Enter' to confirm your input or 'Escape' to cancel";
        msg.dataset.role = "prompt";
        msg.innerHTML = s.prompt ? `${esc(s.prompt)} <span data-vscode="1" class="vscode-own">(${esc(hint)})</span>` : `<span data-vscode="1">${esc(hint)}</span>`;
    }
}

// ---------- progress ----------
function openProgress(w) {
    const s = w.spec;
    w.done = 0;
    if (s.location === "window") {
        W.windowProgress.push({ id: w.id, title: s.title, site: s.site });
        renderStatus();
        return;
    }
    if (s.location !== "notification") { return; }
    const node = el("div", { class: "toast", "data-surface": "progress", data: { widget: w.id, site: src(s) } });
    node.append(el("div", { class: "progress infinite" }, el("div")));
    node.append(el("div", { class: "msg-row" }, el("i", { class: "ic codicon codicon-info info" }), el("div", { class: "msg", "data-role": "title", text: s.title || "" }), el("div", { class: "tools" }, el("span", { title: "Hide Notification", html: '<i class="codicon codicon-chevron-down"></i>' }))));
    const act = el("div", { class: "act-row" }, el("div", { class: "source", text: "Source: Euterpe" }));
    if (s.cancellable) {
        const c = el("button", { class: "vbtn secondary", "data-role": "cancel", "data-vscode": "1", text: "Cancel" });
        c.addEventListener("click", () => { if (W.interactive()) { answer(w.id, "cancel"); } });
        act.append(c);
    }
    node.append(act);
    w.node = node;
    toasts()?.append(node);
}
function renderProgress(w, patch) {
    const s = w.spec;
    if (!patch.report) { return; }
    if (s.location === "window") { return; }
    const r = patch.report;
    if (r.increment) { w.done = Math.min(100, w.done + r.increment); const bar = w.node?.querySelector(".progress"); if (bar) { bar.classList.remove("infinite"); bar.firstChild.style.left = "0"; bar.firstChild.style.width = `${w.done}%`; } }
    if (r.message !== undefined) {
        const m = w.node?.querySelector(".msg");
        if (m) { m.innerHTML = `${esc(s.title || "")}${s.title && r.message ? ": " : ""}<span data-role="message">${esc(r.message || "")}</span>`; }
    }
}

// ---------- the system's file dialog ----------
function openFileDialog(w) {
    const s = w.spec;
    const filters = Object.entries(s.filters || {}).map(([name, exts]) => `${name} (${exts.map((e) => `*.${e}`).join(", ")})`);
    const win = el("div", { class: "oswin filedlg", "data-surface": "open-dialog", data: { widget: w.id, site: src(s) }, style: { left: "24%", top: "16%", width: "560px", height: "380px" } });
    let picked = null;
    const files = el("div", { class: "files" });
    for (const f of s.offered || []) {
        const row = el("div", { title: f.path }, el("i", { class: `codicon codicon-${s.canSelectFolders ? "folder" : "file"}` }), el("span", { text: f.name }), el("span", { class: "muted", style: { marginLeft: "auto", fontSize: "11px", color: "#8a8a8a" }, text: f.path.replace(/^.*\\Users\\writer/, "~") }));
        row.addEventListener("click", () => { picked = f.path; for (const r of files.children) { r.classList.toggle("on", r === row); } name.textContent = f.name; });
        row.addEventListener("dblclick", () => { if (W.interactive()) { answer(w.id, "answer", { paths: [f.path] }); } });
        files.append(row);
    }
    if (!(s.offered || []).length) { files.append(el("div", { class: "muted", style: { cursor: "default", color: "#8a8a8a" }, text: "(this scenario's world has nothing to pick here)" })); }
    const name = el("div", { class: "grow", text: "" });
    const open = el("button", { class: "go", text: s.openLabel || (s.canSelectFolders ? "Select Folder" : "Open") });
    open.addEventListener("click", () => { if (W.interactive() && picked) { answer(w.id, "answer", { paths: [picked] }); } });
    const cancel = el("button", { text: "Cancel" });
    cancel.addEventListener("click", () => { if (W.interactive()) { answer(w.id, "answer", { paths: null }); } });
    win.append(
        el("div", { class: "ostitle" }, el("i", { class: "codicon codicon-folder-opened" }), el("span", { class: "t", "data-role": "title", text: s.title || "Open" }), el("span", { class: "x", html: "✕", onclick: () => { if (W.interactive()) { answer(w.id, "answer", { paths: null }); } } })),
        el("div", { class: "osbody" },
            el("div", { class: "row" }, el("span", { class: "muted", style: { color: "#9a9a9a", fontSize: "12px" }, text: s.defaultPath ? `Starts in ${s.defaultPath}` : "Windows' Open dialog (the bench's stand-in)" })),
            files,
            el("div", { class: "row" }, el("span", { text: "File name:" }), name, filters.length ? el("div", { class: "grow", style: { flex: "none", minWidth: "160px" }, "data-role": "filter", text: filters.join("; ") }) : null),
            el("div", { class: "row", style: { justifyContent: "flex-end" } }, open, cancel)));
    w.node = win;
    document.getElementById("desktop").append(win);
}
