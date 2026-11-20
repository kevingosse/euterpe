// Small helpers for drawing: escaping, codicons as VS Code draws them, Markdown, line diffs.
import { marked } from "/repo/node_modules/marked/lib/marked.esm.js";

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) { continue; }
        if (k === "class") { e.className = v; }
        else if (k === "html") { e.innerHTML = v; }
        else if (k === "text") { e.textContent = v; }
        else if (k.startsWith("on") && typeof v === "function") { e.addEventListener(k.slice(2), v); }
        else if (k === "style" && typeof v === "object") { Object.assign(e.style, v); }
        else if (k === "data" && typeof v === "object") { for (const [dk, dv] of Object.entries(v)) { if (dv !== undefined) { e.dataset[dk] = typeof dv === "string" ? dv : JSON.stringify(dv); } } }
        else { e.setAttribute(k, v === true ? "" : v); }
    }
    for (const c of children.flat()) { if (c !== null && c !== undefined && c !== false) { e.append(c instanceof Node ? c : document.createTextNode(String(c))); } }
    return e;
}

/** Euterpe's own status bar icons (media/euterpe-icons.ttf). */
const EUTERPE_ICONS = { "euterpe-idle": "", "euterpe-active": "" };

/** Text with $(icon) codicons, as VS Code draws it (HTML). */
export function icons(text) {
    return esc(text).replace(/\$\(([a-z0-9-]+)(~spin)?\)/gi, (_, name, spin) => {
        if (EUTERPE_ICONS[name]) { return `<span class="eicon" data-icon="${name}">${EUTERPE_ICONS[name]}</span>`; }
        return `<i class="codicon codicon-${name}${spin ? " codicon-modifier-spin" : ""}" data-icon="${name}"></i>`;
    });
}
export const plainIcons = (text) => String(text ?? "").replace(/\$\([a-z0-9~-]+\)\s*/gi, "").trim();

marked.setOptions({ gfm: true, breaks: false });
/** Markdown as VS Code renders it in a hover or a description (links kept, as data-href). */
export function md(text, { icons: withIcons = false, inline = false } = {}) {
    let src = String(text ?? "");
    const html = inline ? marked.parseInline(src) : marked.parse(src);
    let out = html.replace(/<a href="([^"]*)"/g, (_, href) => `<a data-href="${href}" href="javascript:void 0"`);
    if (withIcons) { out = out.replace(/\$\(([a-z0-9-]+)(~spin)?\)/gi, (m) => icons(m)); }
    return out;
}

/** A notification's message, as VS Code draws it: plain text, but [text](link) becomes a link. */
export function linkify(text) {
    return esc(text).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a data-href="${href}" href="javascript:void 0">${label}</a>`);
}

/** Markdown for documents (README and the like): blocks with their source lines, for comments. */
export function mdBlocks(text) {
    const tokens = marked.lexer(String(text ?? ""));
    let line = 1;
    const out = [];
    for (const t of tokens) {
        const lines = (t.raw.match(/\n/g) || []).length;
        if (t.type !== "space") { out.push({ html: marked.parser([t]), line, raw: t.raw, type: t.type }); }
        line += lines;
    }
    return out;
}

/** Line diff (LCS), as rows for two sides: { l, r, kind: "same" | "del" | "ins" | "mod" }. */
export function diffRows(a, b) {
    const A = a.split("\n"), B = b.split("\n");
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) { for (let j = m - 1; j >= 0; j--) { dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]); } }
    const rows = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && A[i] === B[j]) { rows.push({ l: i, r: j, kind: "same" }); i++; j++; }
        // deletions before insertions, so a changed line pairs up with what replaces it
        else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { rows.push({ l: i, r: null, kind: "del" }); i++; }
        else { rows.push({ l: null, r: j, kind: "ins" }); j++; }
    }
    // pair a deletion with the insertion right after it: a changed line
    const out = [];
    for (let k = 0; k < rows.length; k++) {
        const r = rows[k];
        if (r.kind === "del") {
            let d = k; const dels = [];
            while (d < rows.length && rows[d].kind === "del") { dels.push(rows[d]); d++; }
            const ins = [];
            while (d < rows.length && rows[d].kind === "ins") { ins.push(rows[d]); d++; }
            const len = Math.max(dels.length, ins.length);
            for (let x = 0; x < len; x++) { out.push({ l: dels[x]?.l ?? null, r: ins[x]?.r ?? null, kind: dels[x] && ins[x] ? "mod" : dels[x] ? "del" : "ins" }); }
            k = d - 1;
        } else { out.push(r); }
    }
    return { rows: out, A, B };
}

/** The characters two lines don't share, marked (a word-level highlight inside a changed line). */
export function markChange(a, b, cls) {
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) { s++; }
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) { e++; }
    return esc(a.slice(0, s)) + (a.length - e > s ? `<mark class="${cls}">${esc(a.slice(s, a.length - e))}</mark>` : "") + esc(a.slice(a.length - e));
}

export function debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toastMini(text) {
    const d = el("div", { class: "toast-mini", text });
    document.getElementById("desktop").append(d);
    setTimeout(() => d.remove(), 2200);
}

/** Where a piece of UI came from in Euterpe's sources, as the extension host saw it. */
export function siteAttr(site) {
    return site && site.length ? JSON.stringify(site) : undefined;
}
