// VS Code's own pages, as far as Euterpe shows in them: the Settings editor (drawn from Euterpe's
// package.json, the way VS Code draws contributed settings), settings.json, Workspace Trust, the
// extension's page in the Extensions view, Markdown previews; and documents the bench shows (the
// mind's instructions as a session writes them).
import { el, esc, md, mdBlocks } from "./util.js";
import { net } from "./net.js";

let pkg = null;
let readme = null;
const fileCache = new Map();
fetch("/repo/package.json").then((r) => r.json()).then((p) => { pkg = p; });

function fetchText(url, done) {
    if (fileCache.has(url)) { return fileCache.get(url); }
    fileCache.set(url, null);
    fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText)))).then((t) => { fileCache.set(url, t); done(); }, () => { fileCache.set(url, "(couldn't read it)"); done(); });
    return null;
}
export function forgetFiles() { fileCache.clear(); }

/** VS Code's label for a setting: euterpe.followActiveEditor → "Euterpe: Follow Active Editor". */
export function settingLabel(key) {
    const [cat, ...rest] = key.split(".");
    const name = rest.join(".").replace(/\.([a-z0-9])/g, (_, c) => ` › ${c.toUpperCase()}`).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^[a-z]/, (c) => c.toUpperCase());
    return { category: cat.charAt(0).toUpperCase() + cat.slice(1), name };
}

function rel(path) {
    const m = /[\\/]euterpe[\\/](.*)$/i.exec(path || "");
    return m ? m[1].replace(/\\/g, "/") : path;
}

export function renderPage(tab, W) {
    const p = tab.page || {};
    const rerender = () => window.dispatchEvent(new CustomEvent("bench:rerender"));
    if (p.kind === "settings-ui") { return settingsEditor(p, W); }
    if (p.kind === "settings-json") { return settingsJson(W); }
    if (p.kind === "trust") { return trustPage(W); }
    if (p.kind === "extension") { return extensionPage(p, rerender); }
    if (p.kind === "plain") {
        // text as the mind reads it (a perception, a tool's answer): line by line, each one commentable
        const view = el("div", { class: "md-view", "data-surface": `mind:${p.title || "text"}` });
        if (p.title) { view.append(el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "8px" }, text: p.title })); }
        const box = el("div", { style: { font: "13px/19px var(--vsc-mono)", whiteSpace: "pre-wrap" } });
        for (const [i, line] of String(p.text ?? "").split("\n").entries()) { box.append(el("div", { class: "blk", "data-doc": p.file || "", "data-line": i + 1, text: line || " " })); }
        view.append(box);
        return view;
    }
    if (p.kind === "markdown" || p.kind === "doc") {
        const text = p.text ?? fetchText(`/fs/${String(p.path).replace(/\\/g, "/")}`, rerender);
        const view = el("div", { class: "md-view", "data-surface": `doc:${p.file || rel(p.path)}` });
        view.append(docBlocks(text, p.file || rel(p.path), p.title));
        return view;
    }
    return el("div", { class: "page", text: `(${p.kind})` });
}

/** A document, block by block, each block knowing its file and line (for comments, and coverage). */
export function docBlocks(text, file, title) {
    const box = el("div", { class: "md" });
    if (title) { box.append(el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "6px" }, text: title })); }
    if (text === null) { box.append(el("p", { class: "muted", text: "Loading…" })); return box; }
    let body = text, offset = 0;
    const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
    if (front) {
        offset = (front[0].match(/\n/g) || []).length;
        body = text.slice(front[0].length);
        box.append(el("pre", { class: "front", "data-doc": file, "data-line": 1, text: front[0].trim() }));
    }
    const dir = file && file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
    for (const b of mdBlocks(body)) {
        const d = el("div", { class: "blk", "data-doc": file, "data-line": b.line + offset, html: b.html });
        // pictures the document names relative to itself
        for (const img of d.querySelectorAll("img")) {
            const src = img.getAttribute("src") || "";
            if (src && !/^(https?:|data:|\/)/.test(src)) { img.src = `/repo/${dir}${src}`; }
        }
        box.append(d);
    }
    return box;
}

// ---------- the Settings editor ----------
function settingsEditor(p, W) {
    const page = el("div", { class: "page set-page", "data-surface": "settings-editor" });
    if (!pkg) { page.append(el("p", { text: "Loading…" })); setTimeout(() => window.dispatchEvent(new CustomEvent("bench:rerender")), 300); return page; }
    const query = p.query || "@ext:kevingosse.euterpe";
    page.append(el("input", { class: "search", value: query, "data-vscode": "1", readonly: true }));
    page.append(el("div", { class: "tabs", "data-vscode": "1" }, el("span", { class: "on", text: "User" }), el("span", { text: "Workspace" })));
    const cols = el("div", { class: "set-cols" });
    const toc = el("div", { class: "set-toc", "data-vscode": "1" });
    const list = el("div", { class: "set-list" });
    for (const section of pkg.contributes.configuration) {
        toc.append(el("div", { class: "on", text: section.title }));
        list.append(el("div", { class: "set-group", "data-manifest": `configuration ${section.id}`, text: section.title }));
        const props = Object.entries(section.properties).sort((a, b) => (a[1].order ?? 99) - (b[1].order ?? 99));
        for (const [key, s] of props) {
            const { category, name } = settingLabel(key);
            const user = W.settings.user[key], ws = W.settings.workspace[key];
            const value = ws !== undefined && s.scope !== "machine" ? ws : user !== undefined ? user : s.default;
            const item = el("div", { class: `set-item${user !== undefined || ws !== undefined ? " modified" : ""}`, "data-manifest": key });
            item.append(el("div", { class: "label", title: key }, el("span", { class: "cat", "data-vscode": "1", text: `${category}: ` }), el("span", { "data-vscode-label": key, text: name }),
                s.scope === "machine" ? el("span", { class: "ws-note", "data-vscode": "1", text: "(Machine)" }) : null,
                ws !== undefined ? el("span", { class: "ws-note", "data-vscode": "1", text: "Also modified in: Workspace" }) : null));
            const descMd = (s.markdownDescription || s.description || "")
                .replace(/`?#(euterpe\.[a-zA-Z]+)#`?/g, (_, k) => { const l = settingLabel(k); return `[${l.category}: ${l.name}](#${k})`; });
            const desc = el("div", { class: "desc", "data-manifest": key, html: s.markdownDescription ? md(descMd) : esc(descMd) });
            if (s.type === "boolean") {
                item.append(el("div", { class: "chk" }, el("span", { class: "box", html: value ? '<i class="codicon codicon-check"></i>' : "" }), desc));
            } else {
                item.append(desc);
                if (s.enum) {
                    const labels = s.enumItemLabels || s.enum.map(String);
                    const sel = el("select", { disabled: true });
                    s.enum.forEach((v, i) => sel.append(el("option", { value: String(v), text: labels[i], selected: v === value })));
                    item.append(sel);
                    // the open dropdown: each choice with its description, as VS Code shows it on hover
                    const lst = el("div", { class: "enum-list" });
                    s.enum.forEach((v, i) => {
                        lst.append(el("div", { class: v === value ? "on" : "", "data-manifest": `${key} label`, text: labels[i] }));
                        if (s.enumDescriptions?.[i]) { lst.append(el("div", { class: "ed2", "data-manifest": `${key} enum`, text: s.enumDescriptions[i] })); }
                    });
                    item.append(lst);
                } else {
                    item.append(el("input", { type: s.type === "integer" || s.type === "number" ? "number" : "text", value: value ?? "", readonly: true }));
                }
            }
            list.append(item);
        }
    }
    cols.append(toc, list);
    page.append(cols);
    page.addEventListener("click", (e) => {
        const a = e.target.closest("a[data-href]");
        if (!a) { return; }
        e.preventDefault();
        const m = /^command:([\w.]+)(\?(.*))?$/.exec(a.dataset.href);
        if (m && W.interactive()) { let args = []; try { args = m[3] ? JSON.parse(decodeURIComponent(m[3])) : []; } catch { /* none */ } net.host({ type: "command", command: m[1], args: Array.isArray(args) ? args : [args] }); }
    });
    return page;
}

function settingsJson(W) {
    const page = el("div", { class: "json-page", "data-surface": "settings-json" });
    const text = JSON.stringify(W.settings.user, null, 4);
    const lines = (text === "{}" ? "{\n}" : text).split("\n");
    lines.forEach((l) => {
        const html = esc(l).replace(/^(\s*)(&quot;[^&]*&quot;)(:)/, '$1<span class="key">$2</span>$3').replace(/: (&quot;.*&quot;)(,?)$/, ': <span class="str">$1</span>$2').replace(/: (-?\d+)(,?)$/, ': <span class="num">$1</span>$2').replace(/: (true|false|null)(,?)$/, ': <span class="kw">$1</span>$2');
        page.append(el("div", { class: "l", html }));
    });
    return page;
}

function trustPage(W) {
    const page = el("div", { class: "page trust-page", "data-surface": "workspace-trust", "data-vscode": "1" });
    const trusted = W.trusted;
    page.append(el("div", { class: "shield", html: `<i class="codicon codicon-${trusted ? "workspace-trusted" : "shield"}" style="font-size:34px"></i>` }));
    page.append(el("h1", { text: trusted ? "Trusting this folder" : "In Restricted Mode" }));
    page.append(el("p", { text: trusted ? "All features are enabled because trust has been granted to the workspace." : "Some features are disabled because this workspace is not trusted." }));
    const box = el("div", { class: "box" });
    box.append(el("b", { text: "In Restricted Mode" }), el("ul", {}, el("li", { text: "Tasks are not allowed to run" }), el("li", { text: "Debugging is disabled" }), el("li", { text: "Workspace settings are not applied" }), el("li", { html: "1 extension is disabled or has limited functionality — <b>Euterpe</b>" })));
    page.append(box);
    if (!trusted) {
        const b = el("button", { class: "vbtn", text: "Trust" });
        b.addEventListener("click", () => { if (W.interactive()) { net.host({ type: "trust-grant" }); } });
        page.append(b);
    }
    const ext = el("div", { class: "box", "data-vscode": "0" }, el("b", { text: "Euterpe" }), el("div", { class: "muted", style: { marginTop: "4px" }, "data-manifest": "capabilities.untrustedWorkspaces.description", text: pkg?.capabilities?.untrustedWorkspaces?.description || "" }));
    ext.querySelector("b").dataset.vscode = "1";
    page.append(el("p", { class: "muted", style: { marginTop: "18px" }, "data-vscode": "1", text: "What VS Code shows of Euterpe in its list of extensions that Restricted Mode limits:" }), ext);
    return page;
}

// ---------- the extension's page (Extensions view) ----------
function extensionPage(p, rerender) {
    const page = el("div", { class: "page", "data-surface": "extension-page" });
    if (!pkg) { page.append(el("p", { text: "Loading…" })); setTimeout(rerender, 300); return page; }
    const tab = p.tab || "details";
    const head = el("div", { style: { display: "flex", gap: "18px", alignItems: "flex-start", marginBottom: "16px" } },
        el("img", { src: "/repo/media/icon.png", width: 128, height: 128, alt: "", style: { imageRendering: "auto", borderRadius: "6px" } }),
        el("div", {},
            el("div", { style: { fontSize: "26px", fontWeight: "600" }, "data-manifest": "displayName", text: pkg.displayName }),
            el("div", { class: "muted", style: { margin: "4px 0" } }, el("span", { "data-vscode": "1", text: "Kevin Gosse" }), " | ", el("span", { "data-vscode": "1", text: `v${pkg.version}` }), " | ", el("span", { "data-vscode": "1", text: "Preview" })),
            el("div", { style: { margin: "6px 0 10px" }, "data-manifest": "description", text: pkg.description }),
            el("div", { style: { display: "flex", gap: "8px" } }, el("button", { class: "vbtn", "data-vscode": "1", text: "Disable" }), el("button", { class: "vbtn secondary", "data-vscode": "1", text: "Uninstall" }))));
    page.append(head);
    const tabs = el("div", { class: "tabs", style: { display: "flex", gap: "18px", borderBottom: "1px solid var(--vsc-border)", marginBottom: "14px" }, "data-vscode": "1" });
    for (const [id, label] of [["details", "Details"], ["features", "Features"]]) {
        tabs.append(el("span", { style: { padding: "6px 0", cursor: "pointer", borderBottom: id === tab ? "1px solid var(--vsc-focus)" : "0", textTransform: "uppercase", fontSize: "11px" }, text: label, onclick: () => { p.tab = id; rerender(); } }));
    }
    page.append(tabs);
    const side = el("div", { style: { display: "flex", gap: "30px" } });
    const main = el("div", { style: { flex: 1, minWidth: 0 } });
    if (tab === "details") {
        readme = readme ?? fetchText("/repo/README.md", rerender);
        main.append(docBlocks(readme, "README.md"));
    } else {
        const f = el("div", { class: "md" });
        f.append(el("h3", { "data-vscode": "1", text: "Commands" }));
        const t = el("table");
        t.append(el("tr", { "data-vscode": "1" }, el("th", { text: "ID" }), el("th", { text: "Title" }), el("th", { text: "Keyboard Shortcuts" }), el("th", { text: "Menu Contexts" })));
        for (const c of pkg.contributes.commands) {
            const kb = (pkg.contributes.keybindings || []).find((k) => k.command === c.command);
            const menus = Object.entries(pkg.contributes.menus || {}).filter(([, items]) => items.some((i) => i.command === c.command && i.when !== "false")).map(([m]) => m);
            t.append(el("tr", {}, el("td", { class: "mono", text: c.command }), el("td", { "data-manifest": `command ${c.command}`, text: `${c.category}: ${c.title}` }), el("td", { text: kb ? kb.key.replace(/ctrl/g, "Ctrl").replace(/\+(\w)\b/g, (_, k) => `+${k.toUpperCase()}`) : "" }), el("td", { text: menus.join(", ") })));
        }
        f.append(t);
        f.append(el("h3", { "data-vscode": "1", text: "Settings" }));
        const s = el("table");
        s.append(el("tr", { "data-vscode": "1" }, el("th", { text: "ID" }), el("th", { text: "Description" }), el("th", { text: "Default" })));
        for (const section of pkg.contributes.configuration) {
            for (const [key, prop] of Object.entries(section.properties)) {
                s.append(el("tr", {}, el("td", { class: "mono", text: key }), el("td", { "data-manifest": key, html: md(prop.markdownDescription || prop.description || "") }), el("td", { class: "mono", text: JSON.stringify(prop.default) })));
            }
        }
        f.append(s);
        f.append(el("h3", { "data-vscode": "1", text: "Icons" }));
        for (const [id, icon] of Object.entries(pkg.contributes.icons || {})) {
            f.append(el("p", {}, el("span", { class: "eicon", style: { fontSize: "18px", marginRight: "8px" }, text: icon.default.fontCharacter === "\\E001" ? "" : "" }), el("code", { text: id }), " ", el("span", { "data-manifest": `icons.${id}`, text: icon.description })));
        }
        main.append(f);
    }
    side.append(main);
    side.append(el("div", { style: { width: "230px", flex: "none" }, "data-vscode": "1" },
        el("div", { style: { fontWeight: 600, marginBottom: "6px" }, text: "Categories" }),
        el("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } }, ...pkg.categories.map((c) => el("span", { style: { border: "1px solid var(--vsc-border)", padding: "1px 8px", borderRadius: "2px", fontSize: "12px" }, text: c }))),
        el("div", { style: { fontWeight: 600, margin: "14px 0 6px" }, text: "Resources" }),
        el("div", { class: "muted", text: "Repository · Kevin Gosse · License" })));
    page.append(side);
    return page;
}
