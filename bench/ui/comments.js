// Comments: point at anything on the desktop (the VS Code window, the overlay, the settings
// window, a browser page), click, and say what should change. Each comment keeps the element's
// text, where that text lives in Euterpe's sources, and the screen it was on.
import { net } from "./net.js";
import { el, esc } from "./util.js";
import { sourcesOf } from "./coverage.js";

const S = { on: false, frames: new Set(), hover: null, ctx: () => ({}), review: { comments: [] } };
const TAGS = ["Wording", "Remove", "Add", "Bug", "Behaviour", "Look", "Question"];

const PICK = "[data-role], [data-doc], [data-manifest], [data-menu-label], button, a, label, summary, h1, h2, h3, h4, h5, p, li, td, th, dt, dd, pre, code, img, canvas, input, textarea, select, .card-title, .card-desc, .lbl, .desc, .det, .msg, .detail, .message, .sb-item, .vsc-tab, .qitem, .out-line, .blk, .chip, .badge, .eyebrow, .lede, .notice, .banner, .key-line, .field-label, .switch-label, .stage-mood, .proposal-title, #chat-title, #chat-hint, #notes-badge, #bubble-content, .msg.system, .small";

export function mountComments({ context, onSaved }) {
    S.ctx = context;
    S.onSaved = onSaved;
    const btn = document.getElementById("btn-comment");
    btn.addEventListener("click", () => setMode(!S.on));
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { closePopover(); hilite(null); }
        if ((e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e)) { setMode(!S.on); }
    });
    hook(window, null);
    window.addEventListener("bench:frame", (e) => { const f = e.detail.frame; if (f?.contentWindow) { hook(f.contentWindow, f, e.detail); } });
}
const typing = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.tagName === "SELECT"); };

export function setMode(on) {
    S.on = on;
    document.body.classList.toggle("comment-on", on);
    document.body.classList.toggle("comment-off", !on);
    document.getElementById("btn-comment").classList.toggle("on", on);
    if (!on) { hilite(null); }
}
export const commentMode = () => S.on;
export function setReview(r) { S.review = r; }

/** Listen in a window (the page itself, or a frame's): hover shows what a click would comment on. */
function hook(win, frame, info) {
    if (S.frames.has(win)) { return; }
    S.frames.add(win);
    const doc = win.document;
    const active = (e) => (S.on || e.altKey) && !e.target.closest?.("#popover, #bar, #side, #tour, .view, #hilite");
    doc.addEventListener("mousemove", (e) => {
        if (!e.isTrusted) { return; }
        if (!active(e)) { if (S.hover) { hilite(null); } return; }
        const r = resolve(e, frame);
        if (r) { hilite(r.el, r.frame); }
    }, true);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "contextmenu"]) {
        doc.addEventListener(type, (e) => {
            if (!e.isTrusted || !active(e)) { return; }
            if (frame === null && !document.getElementById("desktop").contains(e.target)) { return; }
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (type === "click") { const r = resolve(e, frame); if (r) { openPopover(r.el, r.frame, info); } }
        }, true);
    }
    win.addEventListener("unload", () => S.frames.delete(win));
}

/**
 * What a point means: the element under it, looking into the overlay's window (whose empty space
 * lets clicks through to what's below, as on a real desktop) and out of it again.
 */
function resolve(e, frame) {
    if (frame) {
        const inner = innerAt(frame, e.clientX, e.clientY);
        if (inner) { return { el: pick(inner, frame), frame }; }
        const f = frame.getBoundingClientRect();
        return below(f.left + e.clientX, f.top + e.clientY);
    }
    const ewin = e.target.closest?.(".ewin");
    if (ewin) {
        const fr = ewin.querySelector("iframe");
        const f = fr.getBoundingClientRect();
        const inner = innerAt(fr, e.clientX - f.left, e.clientY - f.top);
        if (inner) { return { el: pick(inner, fr), frame: fr }; }
        return below(e.clientX, e.clientY);
    }
    const t = pick(e.target, null);
    return t ? { el: t, frame: null } : null;
}
/** Something of the frame's own at a point (frame coordinates): an element, or the body it draws; null where it's see-through. */
function innerAt(frame, x, y) {
    let d, w;
    try { d = frame.contentDocument; w = frame.contentWindow; } catch { return null; }
    if (!d) { return null; }
    const e = d.elementFromPoint(x, y);
    if (!frame.closest(".ewin")) { return e; }   // a webview or a page: all of it is there
    if (e && e !== d.body && e !== d.documentElement && e.id !== "stage") { return e; }
    const st = w.__euterpe?.stage;
    if (st && st.hit(x, y, 2)) { return d.getElementById("stage"); }
    return null;
}
/** The desktop's element under a point (page coordinates), the overlay's windows aside. */
function below(x, y) {
    const under = document.elementsFromPoint(x, y).find((n) => !n.closest(".ewin") && n.id !== "hilite" && !n.closest("#popover"));
    if (!under) { return null; }
    if (under.tagName === "IFRAME") {
        const f = under.getBoundingClientRect();
        const inner = innerAt(under, x - f.left, y - f.top);
        return inner ? { el: pick(inner, under), frame: under } : { el: under, frame: null };
    }
    const t = pick(under, null);
    return t ? { el: t, frame: null } : null;
}

function pick(target, frame) {
    let e = target?.nodeType === 3 ? target.parentElement : target;
    if (!e || !e.closest) { return null; }
    if (frame === null && !e.closest("#desktop")) { return null; }
    const hit = e.closest(PICK);
    // a big container isn't what anyone means: the element itself, if it holds text of its own
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim());
    return own ? e : hit || e;
}

function rectOf(e, frame) {
    const r = e.getBoundingClientRect();
    if (!frame) { return r; }
    const f = frame.getBoundingClientRect();
    return { left: f.left + r.left, top: f.top + r.top, width: r.width, height: r.height, right: f.left + r.right, bottom: f.top + r.bottom };
}

function hilite(e, frame) {
    const h = document.getElementById("hilite");
    S.hover = e;
    if (!e) { h.classList.add("hidden"); return; }
    const r = rectOf(e, frame);
    Object.assign(h.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    h.dataset.label = labelOf(e, frame);
    h.classList.remove("hidden");
}

function surfaceOf(e, frame) {
    const inner = e.closest("[data-surface]")?.dataset.surface;
    if (frame) {
        const outer = frame.closest("[data-surface]")?.dataset.surface || frame.dataset.surface;
        return inner && inner !== outer ? `${outer} › ${inner}` : outer || "frame";
    }
    return inner || "desktop";
}
function labelOf(e, frame) {
    const s = surfaceOf(e, frame);
    const role = e.closest("[data-role]")?.dataset.role;
    const tag = e.id ? `#${e.id}` : e.className && typeof e.className === "string" ? `.${e.className.split(" ")[0]}` : e.tagName.toLowerCase();
    return `${s}${role ? ` · ${role}` : ""} · ${tag}`;
}
function textOf(e) {
    if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") { return e.getAttribute("placeholder") ? `[placeholder] ${e.getAttribute("placeholder")}` : e.value; }
    if (e.tagName === "IMG") { return `[picture] ${e.getAttribute("alt") || e.getAttribute("title") || e.getAttribute("src") || ""}`; }
    if (e.tagName === "CANVAS") { return e.id === "stage" ? "[Euterpe's body, drawn on the overlay's canvas]" : "[a drawing]"; }
    const t = (e.innerText || e.textContent || "").trim();
    const title = e.getAttribute("title") || e.getAttribute("aria-label");
    return t ? (t.length > 2000 ? `${t.slice(0, 2000)}…` : t) : title ? `[tooltip] ${title}` : "";
}
function cssPath(e) {
    const parts = [];
    for (let x = e; x && x.nodeType === 1 && parts.length < 6; x = x.parentElement) {
        let p = x.tagName.toLowerCase();
        if (x.id) { p += `#${x.id}`; parts.unshift(p); break; }
        if (x.className && typeof x.className === "string") { p += `.${x.className.trim().split(/\s+/).slice(0, 2).join(".")}`; }
        parts.unshift(p);
    }
    return parts.join(" > ");
}
function json(attr) { try { return attr ? JSON.parse(attr) : undefined; } catch { return undefined; } }

function describe(e, frame) {
    const text = textOf(e);
    const own = json(e.closest("[data-site]")?.dataset.site);
    // a page in a frame (the settings window) was opened by a call: that's where it is, not where its words are
    const windowSite = !own && frame ? json(frame.closest("[data-site]")?.dataset.site) : undefined;
    const site = own;
    const docEl = e.closest("[data-doc]");
    const doc = docEl ? { file: docEl.dataset.doc, line: +docEl.dataset.line } : undefined;
    const manifest = e.closest("[data-manifest]")?.dataset.manifest;
    const vscodeOwn = e.closest("[data-vscode]")?.dataset.vscode === "1";
    const surface = surfaceOf(e, frame);
    const files = site ? site.map((s) => s.file) : surface.includes("settings-window") ? ["settings/settings.js", "src/settingsPanel.ts", "src/settingsModel.ts"] : surface.includes("overlay") ? ["overlay/renderer/app.js", "overlay/renderer/index.html", "overlay/main.js", "src/session.ts"] : [];
    const title = e.getAttribute?.("title");
    let sources = text ? sourcesOf(text.replace(/^\[(placeholder|tooltip|picture)\]\s*/, ""), { files, doc, manifest }) : [];
    if (title && !sources.length) { sources = sourcesOf(title, { files }); }
    if (doc && !sources.some((s) => s.file === doc.file)) { sources.unshift({ file: doc.file, line: doc.line, kind: "doc", text: text.slice(0, 120), score: 99 }); }
    return {
        surface, role: e.closest("[data-role]")?.dataset.role, text, tooltip: title || undefined, selector: cssPath(e),
        frame: frame ? (frame.dataset.win || frame.dataset.panel || frame.title) : undefined,
        sources, site, windowSite, doc, manifest, vscodeOwn,
    };
}

// ---------- the popover ----------
let pop = null;
function closePopover() { document.getElementById("popover").classList.add("hidden"); pop = null; }

/** A comment on a text of Euterpe's sources, from the Coverage view: for the texts no screen shows. */
export function openTextPopover(s, anchor) {
    const target = { surface: "Euterpe's sources", role: s.kind, text: s.text, selector: "", sources: [{ file: s.file, line: s.line, kind: s.kind, text: s.text }], fromCoverage: true };
    const ctx = { scenario: null, scenarioTitle: null, screen: "coverage", screenTitle: "From the Coverage view", world: null };
    openPopover(null, null, null, false, { target, ctx, anchor });
}

export function openPopover(e, frame, _info, whole = false, preset = null) {
    const p = document.getElementById("popover");
    const target = preset ? preset.target : whole ? { surface: "screen", text: "", selector: "", sources: [] } : describe(e, frame);
    const ctx = preset ? preset.ctx : S.ctx();
    pop = { target, tags: new Set() };
    p.innerHTML = "";
    p.append(el("h4", { text: whole ? `A comment on the whole screen: ${ctx.screenTitle || ctx.scenarioTitle || ""}` : `On: ${target.surface}${target.role ? ` · ${target.role}` : ""}` }));
    if (!whole) {
        p.append(el("div", { class: "quote", text: target.text || "(no text)" }));
        if (target.tooltip && target.tooltip !== target.text) { p.append(el("div", { class: "small muted", style: { marginTop: "4px" }, text: `Tooltip: ${target.tooltip}` })); }
        if (target.vscodeOwn) { p.append(el("div", { class: "small", style: { color: "#e0b04f", marginTop: "6px" }, text: "This is VS Code's own text, not Euterpe's: Euterpe can't change it, but say so if it reads badly next to Euterpe's." })); }
        const srcs = el("div", { class: "sources" });
        const site = target.site?.[0];
        if (site) { srcs.append(srcRow(`${site.file}:${site.line}`, `the call that shows it${site.fn ? ` (${site.fn})` : ""}`, site.file, site.line)); }
        for (const s of target.sources.slice(0, 4)) { srcs.append(srcRow(`${s.file}:${s.line}`, `${s.kind} · ${s.text.slice(0, 90)}`, s.file, s.line)); }
        if (!site && !target.sources.length) { srcs.append(el("div", { text: "No source found for this text (it may come from the mind, VS Code, or the world)." })); }
        const ws = target.windowSite?.[0];
        if (ws) { srcs.append(srcRow(`${ws.file}:${ws.line}`, "the call that opens the window it's in", ws.file, ws.line)); }
        p.append(srcs);
    }
    const tags = el("div", { class: "kinds" });
    for (const t of TAGS) {
        const b = el("button", { text: t });
        b.addEventListener("click", () => { pop.tags.has(t) ? pop.tags.delete(t) : pop.tags.add(t); b.classList.toggle("on"); });
        tags.append(b);
    }
    p.append(tags);
    const ta = el("textarea", { placeholder: whole ? "What should change on this screen?" : "What should change? (\"Say it shorter\", \"Remove this\", \"Wrong after a sign-out\"…)" });
    p.append(ta);
    const save = () => {
        const text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        net.server({ type: "review", op: "add-comment", comment: { scenario: ctx.scenario, scenarioTitle: ctx.scenarioTitle, screen: ctx.screen, screenTitle: ctx.screenTitle, tags: [...pop.tags], comment: text, target, context: ctx.world } });
        closePopover();
        S.onSaved?.();
    };
    ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); } if (ev.key === "Escape") { closePopover(); } });
    p.append(el("div", { class: "row" },
        whole || preset ? null : el("button", { class: "btn", text: "About the whole screen instead", onclick: () => openPopover(null, null, null, true) }),
        el("div", { style: { flex: 1 } }),
        el("button", { class: "btn", text: "Cancel", onclick: closePopover }),
        el("button", { class: "btn primary", text: "Save (Ctrl+Enter)", onclick: save })));
    p.classList.remove("hidden");
    const r = preset ? preset.anchor.getBoundingClientRect() : whole ? { left: innerWidth / 2 - 220, bottom: 120, top: 100 } : rectOf(e, frame);
    const below = r.bottom + 12 + 360 < innerHeight;
    p.style.left = `${Math.max(8, Math.min(innerWidth - 452, r.left))}px`;
    p.style.top = `${Math.max(54, below ? r.bottom + 10 : r.top - p.offsetHeight - 10)}px`;
    setTimeout(() => ta.focus(), 20);
}
function srcRow(label, detail, file, line) {
    const a = el("span", { class: "src", text: label });
    const row = el("div", {}, a, el("span", { text: detail }));
    a.addEventListener("click", () => peek(file, line, row));
    return row;
}

export async function peek(file, line, after) {
    const old = after.nextElementSibling;
    if (old?.classList.contains("code-peek")) { old.remove(); return; }
    const r = await fetch(`/api/source?file=${encodeURIComponent(file)}&line=${line}`);
    if (!r.ok) { return; }
    const j = await r.json();
    const box = el("div", { class: "code-peek" });
    j.lines.forEach((l, i) => { const n = j.from + i; box.append(el("span", { class: n === line ? "hit" : "", html: `<span class="ln">${n}</span>${esc(l)}\n` })); });
    after.after(box);
}

// ---------- comments, listed ----------
const STATUS = { open: "open", done: "done", wontfix: "won't do", question: "question" };
export function commentNode(c, { onEdit } = {}) {
    const n = el("div", { class: "cm" });
    if (c.target?.text) { n.append(el("div", { class: "cm-target", title: c.target.text, text: c.target.text })); }
    else if (c.target?.surface === "screen") { n.append(el("div", { class: "cm-target", text: "(the whole screen)" })); }
    n.append(el("div", { class: "cm-text", text: c.comment }));
    const meta = el("div", { class: "cm-meta" }, el("span", { class: `cm-status ${c.status}`, text: STATUS[c.status] || c.status }));
    for (const t of c.tags || []) { meta.append(el("span", { text: `#${t}` })); }
    const src = c.target?.site?.[0] || c.target?.sources?.[0];
    if (src) { const s = el("span", { class: "src", text: `${src.file}:${src.line}` }); s.addEventListener("click", () => peek(src.file, src.line, meta)); meta.append(s); }
    meta.append(el("span", { style: { flex: 1 } }));
    meta.append(el("button", { class: "btn tiny", text: "Edit", onclick: () => onEdit?.(c) }));
    meta.append(el("button", { class: "btn tiny danger", text: "Delete", onclick: () => { net.server({ type: "review", op: "delete-comment", id: c.id }); } }));
    n.append(meta);
    if (c.reply) { n.append(el("div", { class: "cm-reply", text: `Claude: ${c.reply}` })); }
    return n;
}

/** Edit a comment in place: its text and status. */
export function editInPlace(node, c) {
    const ta = el("textarea", { style: { width: "100%", minHeight: "60px", background: "#141217", color: "inherit", border: "1px solid #37313f", borderRadius: "6px", padding: "6px" } });
    ta.value = c.comment;
    const status = el("select", {}, ...Object.entries(STATUS).map(([k, v]) => el("option", { value: k, text: v, selected: k === c.status })));
    const done = el("button", { class: "btn primary tiny", text: "Save", onclick: () => net.server({ type: "review", op: "update-comment", id: c.id, patch: { comment: ta.value.trim() || c.comment, status: status.value } }) });
    node.replaceChildren(ta, el("div", { class: "cm-meta" }, status, done, el("button", { class: "btn tiny", text: "Cancel", onclick: () => window.dispatchEvent(new CustomEvent("bench:review")) })));
}

export function renderAllComments(view, review, { jump }) {
    view.innerHTML = "";
    const state = view._state || (view._state = { status: "open" });
    view.append(el("h2", { text: "All comments" }));
    view.append(el("p", { class: "muted", html: `Kept in <code>bench/review.json</code>. Claude reads them from there, makes the changes, and marks each one done (with a word on what it did).` }));
    const sel = el("select", {}, el("option", { value: "all", text: "All" }), ...Object.entries(STATUS).map(([k, v]) => el("option", { value: k, text: v })));
    sel.value = state.status;
    sel.onchange = () => { state.status = sel.value; renderAllComments(view, review, { jump }); };
    view.append(el("div", { class: "toolbar" }, sel, el("button", { class: "btn", text: "Close", onclick: () => view.classList.add("hidden") })));
    const list = review.comments.filter((c) => state.status === "all" || c.status === state.status);
    const by = new Map();
    for (const c of list) { const k = c.screen || c.scenario || "?"; if (!by.has(k)) { by.set(k, []); } by.get(k).push(c); }
    const box = el("div", { class: "all-cm" });
    for (const [k, cs] of by) {
        const head = el("div", { style: { display: "flex", gap: "10px", alignItems: "baseline", marginTop: "10px" } }, el("b", { text: cs[0].screenTitle || cs[0].scenarioTitle || k }), el("span", { class: "muted mono small", text: k }));
        if (cs[0].scenario) { head.append(el("button", { class: "btn tiny", text: "Show this scenario", onclick: () => jump(cs[0].scenario) })); }
        box.append(head);
        for (const c of cs) {
            const n = commentNode(c, { onEdit: () => editInPlace(n, c) });
            n.classList.add("card");
            box.append(n);
        }
    }
    if (!list.length) { box.append(el("p", { class: "muted", text: "None." })); }
    view.append(box);
}
