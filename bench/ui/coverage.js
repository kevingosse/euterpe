// Coverage: every text Euterpe's sources hold (bench/server/extract.js), and which of them the
// reviewer has had on screen. What's on screen is read from the page itself (the VS Code window,
// the overlay, the settings window, the browser), so it's what was really shown.
import { net } from "./net.js";
import { el, esc } from "./util.js";

export const C = { strings: [], byId: new Map(), screen: new Set(), loaded: false };
const norm = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/ /g, " ").replace(/\s+/g, " ").trim();

export async function loadStrings() {
    const r = await fetch("/api/strings");
    C.strings = await r.json();
    C.byId = new Map(C.strings.map((s) => [s.id, s]));
    for (const s of C.strings) {
        s.nfrags = s.fragments.map(norm).filter(Boolean);
        s.nraw = s.rawFragments ? s.rawFragments.map(norm).filter(Boolean) : null;   // as written (where Markdown isn't rendered)
        // a whole one-word text (a label): it has to be one on screen
        s.single = !s.text.includes("{…}") && s.nfrags.length === 1 && !/\s/.test(s.nfrags[0]);
        // a text built around too little fixed text ("Model: {…}") can't be told apart on screen
        s.matchable = s.nfrags.length > 0 && (!s.text.includes("{…}") || s.nfrags.join("").length >= 8);
    }
    C.loaded = true;
    window.dispatchEvent(new CustomEvent("bench:strings"));
}
net.on("strings-changed", () => void loadStrings());

/** VS Code's own text (its buttons, its Settings editor's headings), not Euterpe's: the nearest mark says. */
export const vscodeOwn = (e) => e.closest("[data-vscode]")?.dataset.vscode === "1";

/** What's visibly on screen: text runs and the attributes a writer meets (titles, placeholders). */
export function capture(roots) {
    const texts = [], units = new Set();
    const seenNode = (node, win) => {
        const e = node.nodeType === 1 ? node : node.parentElement;
        if (!e) { return false; }
        if (vscodeOwn(e) || e.closest(".bench-only, script, style, noscript")) { return false; }
        const r = e.getClientRects();
        if (!r.length) { return false; }
        const cs = win.getComputedStyle(e);
        if (cs.visibility === "hidden" || cs.opacity === "0") { return false; }
        return true;
    };
    const walk = (root, win) => {
        if (!root) { return; }
        // Text runs through inline elements (a link, a bit of code, bold) as one text, the way it reads:
        // "Who Euterpe is: <code>cheeky</code>, …" is one.
        let block = null, buf = "";
        const flush = () => { const t = norm(buf); if (t) { texts.push(t); } buf = ""; };
        const blockOf = (e) => { while (e !== root && e.parentElement && win.getComputedStyle(e).display === "inline") { e = e.parentElement; } return e; };
        const tw = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        for (let n = tw.currentNode; n; n = tw.nextNode()) {
            if (n.nodeType === 3) {
                // (white space between two elements: a space, if the text goes on)
                if (!n.data.trim()) { if (buf) { buf += " "; } continue; }
                if (n.parentElement && seenNode(n, win)) {
                    const b = blockOf(n.parentElement);
                    if (b !== block) { flush(); block = b; }
                    buf += n.data;
                }
            } else {
                for (const a of ["title", "placeholder", "aria-label", "alt"]) {
                    const v = n.getAttribute?.(a);
                    if (v && seenNode(n, win)) { texts.push(norm(v)); units.add(norm(v)); }
                }
                // what's typed in a field, and a document in the editor (Euterpe writes some: a persona to edit, its memory)
                if (n.tagName === "INPUT" || n.tagName === "TEXTAREA") { if (n.value && n.type !== "password" && seenNode(n, win)) { texts.push(norm(n.value)); } }
                if (n.children?.length === 0 || n.matches?.("button, [data-role], .lbl, .card-title, label, h1, h2, h3, a")) {
                    const t = norm(n.textContent || "");
                    if (t && t.length < 200 && seenNode(n, win)) { units.add(t); }
                }
            }
        }
        flush();
    };
    for (const { root, win } of roots) { walk(root, win); }
    return { blob: texts.join("\n"), units };
}

/** The texts of Euterpe's a capture shows. */
export function covered(cap) {
    const out = new Set();
    for (const s of C.strings) {
        if (!s.matchable) { continue; }
        if (s.single) { if (cap.units.has(s.nfrags[0]) || cap.units.has(s.nfrags[0].replace(/[.…]$/, ""))) { out.add(s.id); } continue; }
        if (s.nfrags.every((f) => cap.blob.includes(f)) || (s.nraw?.length && s.nraw.every((f) => cap.blob.includes(f)))) { out.add(s.id); }
    }
    return out;
}

/** Where a text on screen comes from: the strings it matches, best first. */
export function sourcesOf(text, hints = {}) {
    const t = norm(text);
    if (!t) { return []; }
    const scored = [];
    for (const s of C.strings) {
        if (!s.nfrags.length) { continue; }
        let score = 0;
        const all = s.nfrags.join(" ");
        if (norm(all) === t) { score = 100; }
        else if (s.single) { if (s.nfrags[0] === t) { score = 90; } else { continue; } }
        else {
            const inside = s.nfrags.filter((f) => t.includes(f));
            if (inside.length === s.nfrags.length) { score = 60 + Math.min(30, Math.round(30 * all.length / Math.max(t.length, 1))); }
            else if (s.nfrags.some((f) => f.length > 12 && f.includes(t) && t.length > 12)) { score = 45; }
            else if (inside.length && inside.join("").length > 20) { score = 20 + inside.length; }
            else { continue; }
        }
        if (hints.files && hints.files.includes(s.file)) { score += 15; }
        if (hints.doc && s.file === hints.doc.file && Math.abs(s.line - hints.doc.line) <= 2) { score += 40; }
        if (hints.manifest && s.file === "package.json" && s.where && (s.where === hints.manifest || s.where.startsWith(hints.manifest))) { score += 30; }
        scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 6).map(({ s, score }) => ({ file: s.file, line: s.line, kind: s.kind, text: s.text, score }));
}

// ---------- the coverage view ----------
const USER_KINDS = ["ui", "error", "manifest", "other"];
export function coverageStats(review) {
    const reviewed = new Set(), seen = new Set();
    for (const s of Object.values(review.screens || {})) {
        for (const id of s.seenIds || []) { seen.add(id); if (s.reviewed) { reviewed.add(id); } }
    }
    const pool = C.strings.filter((s) => USER_KINDS.includes(s.kind) && s.matchable);
    const done = pool.filter((s) => reviewed.has(s.id)).length;
    return { reviewed, seen, pool, done, pct: pool.length ? Math.round((100 * done) / pool.length) : 0 };
}

export function renderCoverage(view, review, { onPeek, onComment }) {
    const { reviewed, seen } = coverageStats(review);
    const kinds = ["ui", "error", "other", "manifest", "log", "mind", "doc", "persona"];
    const label = { ui: "UI", error: "Errors", other: "Other text", manifest: "package.json", log: "Log", mind: "For the mind", doc: "Documents", persona: "Personas" };
    const state = view._state || (view._state = { kind: "user", q: "", show: "unreviewed" });
    view.innerHTML = "";
    view.append(el("h2", { text: "Coverage: every text in Euterpe's sources" }));
    view.append(el("p", { class: "muted", text: "Found by reading the sources (bench/server/extract.js). A text counts as seen when a screen showed it, and as reviewed once you passed that screen with Next. Texts built at run time show their fixed parts; ones with too little (like \"{…}: {…}\" or \"Model: {…}\") can't be matched on screen. The comment button on a row comments on that text directly: for the ones no screen shows." }));
    const sum = el("div", { class: "cov-sum" });
    for (const k of kinds) {
        const pool = C.strings.filter((s) => s.kind === k && s.matchable);
        const ok = pool.filter((s) => reviewed.has(s.id)).length;
        sum.append(el("div", {}, el("div", { class: "muted small", text: label[k] }), el("b", { text: `${ok}` }), el("span", { class: "muted", text: ` / ${pool.length}` })));
    }
    view.append(sum);
    const kindSel = el("select", {}, el("option", { value: "user", text: "What a writer may see (UI, errors, package.json, other)" }), ...kinds.map((k) => el("option", { value: k, text: label[k] })), el("option", { value: "all", text: "Everything" }));
    kindSel.value = state.kind;
    const showSel = el("select", {}, el("option", { value: "unreviewed", text: "Not reviewed yet" }), el("option", { value: "never", text: "Never on screen" }), el("option", { value: "all", text: "All" }));
    showSel.value = state.show;
    const q = el("input", { type: "search", placeholder: "Search the texts or files…", value: state.q });
    const redraw = () => { state.kind = kindSel.value; state.show = showSel.value; state.q = q.value; renderCoverage(view, review, { onPeek, onComment }); };
    kindSel.onchange = redraw; showSel.onchange = redraw; q.onchange = redraw;
    view.append(el("div", { class: "toolbar" }, kindSel, showSel, q, el("button", { class: "btn", text: "Close", onclick: () => view.classList.add("hidden") })));
    const ql = state.q.toLowerCase();
    const pick = C.strings.filter((s) => (state.kind === "all" || (state.kind === "user" ? USER_KINDS.includes(s.kind) : s.kind === state.kind))
        && (state.show === "all" || (state.show === "never" ? !seen.has(s.id) : !reviewed.has(s.id)))
        && (!ql || s.text.toLowerCase().includes(ql) || s.file.toLowerCase().includes(ql)));
    view.append(el("p", { class: "muted", text: `${pick.length} texts` }));
    let file = null;
    for (const s of pick.slice(0, 3000)) {
        if (s.file !== file) { file = s.file; view.append(el("div", { class: "cov-file", text: file })); }
        const st = reviewed.has(s.id) ? el("span", { class: "ok", title: "Reviewed", html: '<i class="codicon codicon-pass-filled"></i>' })
            : seen.has(s.id) ? el("span", { class: "seen", title: "Shown, not marked reviewed", html: '<i class="codicon codicon-eye"></i>' })
                : el("span", { class: "no", title: s.matchable ? "Never on screen" : "Built at run time around too little fixed text: can't be matched on screen", html: `<i class="codicon codicon-${s.matchable ? "circle-large-outline" : "question"}"></i>` });
        const where = el("span", { class: "where src", text: `${s.file}:${s.line}${s.fn ? ` · ${s.fn}` : ""}` });
        where.addEventListener("click", () => onPeek(s.file, s.line, where));
        const talk = el("button", { class: "btn tiny cov-talk", title: "Comment on this text", html: '<i class="codicon codicon-comment"></i>' });
        talk.addEventListener("click", () => onComment?.(s, talk));
        view.append(el("div", { class: "cov-row" }, st, el("span", { class: "k", text: label[s.kind] || s.kind }), el("span", { class: "t", html: esc(s.text) }), where, talk));
    }
}
