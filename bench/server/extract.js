// Every piece of text Euterpe has, found in its sources: what its windows, notifications and
// pages say, its errors, its log, what it tells its mind, its manifest and its documents. Each
// with where it is (file and line) and the fixed parts of it (a message built around a name or a
// path has several), so text seen on screen can be traced back to its source, and text never seen
// on screen can be found. TypeScript's own parser reads the code.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const ts = require(require.resolve("typescript", { paths: [REPO] }));

const UI_CALL = /(^|\.)(show(Information|Warning|Error)Message|showInputBox|showQuickPick|withProgress|createWebviewPanel|createOutputChannel|createTerminal|showOpenDialog|createStatusBarItem|offerSettings|confirm|appendSystem|appendChat|showBubble|say|popupMenu|buildFromTemplate|setStatusBarMessage)$/;
const LOG_CALL = /(^|\.)(log|appendLine|append|console\.(log|error|warn|info))$/;
const ERROR_CALL = /(^|\.)(Error|TypeError|RangeError|SignInNeeded|ScenarioError|die|failTurn|fail|reject|bad|streamError)$/;
const CODE_CALL = /(^|\.)(on|once|off|emit|addEventListener|removeEventListener|registerCommand|executeCommand|getConfiguration|get|has|inspect|update|getElementById|querySelector|querySelectorAll|closest|setAttribute|getAttribute|removeAttribute|createElement|createTreeWalker|startsWith|endsWith|includes|indexOf|split|join|replace|replaceAll|match|test|setContext|toggle|contains|add|remove|setProperty|getPropertyValue|send|sendSync|handle|appendSwitch|getPath|setPath|require|resolve|readFileSync|writeFileSync|existsSync|join|basename|extname|dirname|mkdirSync|rmSync|statSync|encode|decode|from|toString|createHash|digest|randomBytes|ipcRenderer\.on|onMenu|exposeInMainWorld|matchMedia|postMessage|setState|getState|defineProperty|hasOwnProperty|find|filter|findIndex|some|every|sort|localeCompare|padStart|slice|at|charAt|toFixed|parse|stringify|fetch|headers|URL|URLSearchParams|Headers|Response|Symbol|Uri\.parse|Uri\.file|Uri\.from|ThemeColor|ThemeIcon|asWebviewUri|joinPath|secretName|setTimeout)$/;
/** Calls whose string arguments are code for the page (selectors, tag names), whatever they hold. */
const DOM_CALL = /(^|\.)(querySelector|querySelectorAll|closest|matches|getElementById|matchMedia|createElement|createTreeWalker|classList\.(add|remove|toggle|contains|replace))$/;
/** Texts unlike the rest of their file (for the mind, for the log, a demo): by the function or constant they're in. */
const PLACES = {
    "src/session.ts": [[/^(assemblePrompt|DECISIONS)$/, "mind"]],
    "src/openaiMind.ts": [[/^(runTool|compact|addResults|SUMMARY_REQUEST)$/, "mind"], [/^auth$/, "log"]],
    "src/mascots.ts": [[/^body$/, "mind"]],
    "overlay/renderer/app.js": [[/^(demoReply|runDemo)$/, "dev"]],
};
/** A page (or a piece of one) built in TypeScript: the sign-in's answer, the webview's shell. */
const HTML_IN_TS = /<\/?(!DOCTYPE|html|head|body|title|meta|link|script|style|div|p|span|button|h[1-6])\b[^<>]*>/i;
const UI_PROPS = new Set(["label", "description", "detail", "title", "placeholder", "placeHolder", "prompt", "tooltip", "message", "openLabel", "name", "text", "notes", "ended", "hint", "problem", "why", "say"]);

const kebabish = /^[a-z0-9]+([._:/-][a-z0-9]+)*$/i;

function lineOf(text, index) {
    let n = 1;
    for (let i = 0; i < index && i < text.length; i++) { if (text.charCodeAt(i) === 10) { n++; } }
    return n;
}

/** The fixed parts of a text worth matching on screen: three characters or more, Markdown and codicons aside. */
function fragmentsOf(parts, { raw = false } = {}) {
    const out = [];
    for (const p of parts) {
        const clean = normalizeSource(p, { raw });
        for (const piece of clean.split(/\u0001/)) {
            const t = piece.replace(/\s+/g, " ").trim();
            if (t.replace(/[^A-Za-z0-9À-ÿ]/g, "").length >= 3) { out.push(t); }
        }
    }
    return out;
}

/**
 * How source text looks once shown: codicons drawn, Markdown links and emphasis rendered, entities
 * decoded. `raw`: where Markdown isn't rendered (a plain notification, the log), it stays.
 */
function normalizeSource(s, { raw = false } = {}) {
    const t = String(s).replace(/\$\([a-z0-9~-]+\)/gi, "\u0001");
    return (raw ? t : t
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/#euterpe\.[a-zA-Z]+#/g, "\u0001")
        .replace(/\*\*|__|`/g, ""))
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/\\n/g, " ");
}

function looksLikeText(joined, ui) {
    const t = joined.replace(/\u0001/g, " ").trim();
    const bare = joined.replace(/\u0001/g, "").trim();
    if (!/[A-Za-z]{2}/.test(t)) { return false; }
    if (t === "use strict") { return false; }
    if (/^(https?:|file:|data:|ws:|vscode:|command:)\S*$/.test(bare)) { return false; }   // addresses, built or not
    if (/^[\w-]+\/[\w+.-]+(;\s*[\w-]+=[\w-]+)*$/.test(bare)) { return false; }         // mime types
    if (/[#.:]/.test(bare) && /^([#.]?[\w-]+(:[\w-]+(\([^)]*\))?)*\s*,\s*)+[#.]?[\w-]+(:[\w-]+(\([^)]*\))?)*$/.test(bare)) { return false; }   // a list of selectors
    const attrs = joined.replace(/\u0001/g, "x");
    if (/^\s*([\w-]+="[^"]*"\s*)+$/.test(attrs) && !/\b(title|placeholder|aria-label|alt)="/.test(attrs)) { return false; }    // attributes for a tag
    if (/^(json|md|png|txt|js|ts|html|css|exe|zip|auto|responses|chat|bash|sh|low|high|none|null|true|false)$/i.test(t)) { return false; }
    if (/^(https?:|file:|data:|ws:|vscode:|command:)/.test(t) && !/\s/.test(t)) { return false; }
    if (/^[.#[][\w-]/.test(t) && !/\s/.test(t)) { return false; }   // selectors
    if (/^\w+\/[\w+.-]+$/.test(t)) { return false; }                // mime types, paths
    if (/^[\w.-]+\.(md|json|js|ts|png|html|css|exe|cmd|zip|asar|txt|ttf)$/i.test(t)) { return false; }
    if (/\s/.test(t)) { return true; }
    // one word: a label (capitalized), a hint that trails off ("sk-…"), or one of the few lowercase ones
    if (ui) { return /^[A-Z]/.test(t) || /…$/.test(t) || /^(current|yours|copy|euterpe\.[A-Za-z]+)$/.test(t); }
    return false;
}

// ---------- TypeScript and JavaScript ----------

function scanScript(rel, text) {
    const out = [];
    const kindOfFile = fileKind(rel);
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);

    function contextOf(node) {
        let call = null, prop = null, fn = null, holder = null, isError = false, isThrow = false, compared = false, html = false, caseLabel = false, objectKeys = [];
        let before = null;   // in a template's ${…}: the template's text before it
        let n = node, child = node;
        while (n.parent) {
            const p = n.parent;
            if (!prop && ts.isPropertyAssignment(p) && p.initializer === n) { prop = p.name.getText(sf).replace(/["']/g, ""); }
            if (ts.isPropertyAssignment(p) && p.name === n) { return { skip: true }; }
            if (ts.isObjectLiteralExpression(p) && objectKeys.length === 0) { objectKeys = p.properties.map((x) => x.name ? x.name.getText(sf) : "").filter(Boolean); }
            if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword].includes(p.operatorToken.kind)) { compared = true; }
            if (ts.isCaseClause(p) && p.expression === n) { caseLabel = true; }
            if (ts.isElementAccessExpression(p) && p.argumentExpression === n) { return { skip: true }; }
            // a class name, an id, a style: the page's code
            if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n && /(\.(className|id|type|name|src|href|rel|role|htmlFor|lang|dir))$|\.dataset\.|\.style\./.test(p.left.getText(sf))) { return { skip: true }; }
            if (before === null && ts.isTemplateSpan(p) && p.expression === n) {
                const tpl = p.parent, i = tpl.templateSpans.indexOf(p);
                before = [tpl.head.text, ...tpl.templateSpans.slice(0, i).map((x) => x.literal.text)].join("\u0001");
            }
            if (!holder && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) { holder = p.name.getText(sf); }
            if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p)) { return { skip: true }; }
            if (ts.isTaggedTemplateExpression(p) && p.template === n) { html = /^(h|html|raw)$/.test(p.tag.getText(sf)); }
            if (!call && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== n) {
                call = p.expression.getText(sf);
                if (ts.isNewExpression(p) && /Error$|^SignInNeeded$|^ScenarioError$/.test(call)) { isError = true; }
            }
            if (ts.isThrowStatement(p)) { isThrow = true; }
            if (!fn && (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) { fn = p.name.getText(sf); }
            if (!fn && ts.isVariableDeclaration(p) && p.name && ts.isIdentifier(p.name) && (p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)))) { fn = p.name.getText(sf); }
            if (ts.isCallExpression(p) && /(^|\.)super$/.test(p.expression.getText(sf))) { isError = true; }
            child = n;
            n = p;
            if (ts.isBlock(n) || ts.isSourceFile(n)) { if (!fn && n.parent && (ts.isConstructorDeclaration(n.parent))) { fn = "constructor"; } }
        }
        void child;
        return { call, prop, fn, holder, isError: isError || isThrow, compared, html, caseLabel, objectKeys, before };
    }

    function classify(c, textValue) {
        if (c.call && CODE_CALL.test(c.call) && !UI_CALL.test(c.call) && !/\s/.test(textValue)) { return null; }
        for (const [re, k] of PLACES[rel] || []) {
            // (what's thrown or logged there is still an error, or the log)
            if (k === "mind" && (c.isError || (c.call && LOG_CALL.test(c.call)))) { continue; }
            if ([c.fn, c.holder, c.prop, c.call].some((x) => x && re.test(x))) { return k; }
        }
        let kind = null;
        if (c.call && LOG_CALL.test(c.call)) { kind = rel === "src/setupCheck.ts" ? "ui" : "log"; }
        if (c.call && UI_CALL.test(c.call)) { kind = "ui"; }
        if (c.isError || (c.call && ERROR_CALL.test(c.call))) { kind = kind === "ui" ? "ui" : "error"; }
        if (!kind && c.prop && UI_PROPS.has(c.prop)) { kind = c.objectKeys.includes("inputSchema") || c.objectKeys.includes("type") && c.prop === "description" ? "mind" : "ui"; }
        if (!kind && c.prop === "why") { kind = "error"; }
        if (c.call && /(^|\.)add$/.test(c.call) && rel === "src/setupCheck.ts") { kind = "ui"; }
        if (c.call && /events\.push$/.test(c.call)) { kind = "mind"; }
        // the mind's own files: what they say is the mind's, unless VS Code shows it to the writer
        const shownByVsCode = c.call && /show(Information|Warning|Error)Message|vscode\.diff|executeCommand/.test(c.call);
        if ((kindOfFile === "mind" || MIND_TOOLS.test(rel)) && kind !== "log" && !shownByVsCode) { kind = "mind"; }
        if (kindOfFile === "dev") { kind = "dev"; }
        return kind || (kindOfFile === "ui" ? "ui" : "other");
    }

    function emit(node, parts, opts = {}) {
        const c = contextOf(node);
        if (c.skip || c.caseLabel) { return; }
        const joined = parts.join("\u0001");
        const shown = parts.join("{…}");
        if (c.compared && !/\s/.test(shown)) { return; }
        if (c.call && DOM_CALL.test(c.call)) { return; }
        // A value inside a template's ${…}, in a tag: an attribute, which is text only in a title, a
        // placeholder, a label for screen readers (not a class, an id, a data-…).
        const tag = c.before !== null ? /<[a-z][\w-]*(\s[^<>]*)?$/i.exec(c.before) : null;
        if (tag) {
            const attr = /([\w-]+)="[^"]*$/.exec(tag[0]);
            if (attr && /^(title|placeholder|aria-label|alt)$/.test(attr[1])) {
                if (/[A-Za-z]{2}/.test(joined.replace(/\u0001/g, ""))) {
                    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                    out.push(entry(rel, line + 1, character + 1, "ui", shown.replace(/\s+/g, " ").trim(), parts, { attr: attr[1], fn: c.fn }));
                }
                return;
            }
            emitHtml(node, parts, c, { attrsOnly: true });
            return;
        }
        if (c.html || (rel.endsWith(".js") && /<\/?[a-z][^>]*>/i.test(joined)) || HTML_IN_TS.test(joined)) {
            emitHtml(node, parts, c);
            return;
        }
        const kind = classify(c, joined);
        if (!kind) { return; }
        const ui = kind === "ui" || kind === "error" || (c.prop && UI_PROPS.has(c.prop));
        if (!looksLikeText(joined, ui)) { return; }
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push(entry(rel, line + 1, character + 1, kind, shown, parts, { call: c.call, prop: c.prop, fn: c.fn, ...opts }));
    }

    // A template that builds HTML (the settings page, the overlay's chat): its text runs and the
    // attributes a writer sees (titles, placeholders, labels for screen readers).
    function emitHtml(node, parts, c, { attrsOnly = false } = {}) {
        const joined = parts.join("\u0001");
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const startOffset = node.getStart(sf);
        const raw = node.getText(sf);
        const at = (needle) => { const i = raw.indexOf(needle.slice(0, 40)); return i < 0 ? line + 1 : lineOf(text, startOffset + i); };
        for (const m of joined.matchAll(/\b(title|placeholder|aria-label|alt)="([^"]*)"/g)) {
            const v = m[2];
            if (!v.replace(/\u0001/g, "").trim() || !/[A-Za-z]{2}/.test(v.replace(/\u0001/g, ""))) { continue; }
            const ps = v.split("\u0001");
            out.push(entry(rel, at(ps.find((x) => x.trim()) || v), 1, "ui", ps.join("{…}"), ps, { attr: m[1], fn: c.fn }));
        }
        if (attrsOnly) { return; }
        // (a page's title, scripts and styles aren't text on it)
        const textOnly = joined.replace(/<(title|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "\u0002").replace(/<[^>]*>/g, "\u0002");
        for (const run of textOnly.split("\u0002")) {
            if (!run.replace(/\u0001/g, "").trim()) { continue; }
            const ps = run.split("\u0001");
            const shown = ps.join("{…}").replace(/\s+/g, " ").trim();
            if (!/[A-Za-z]{2}/.test(shown.replace(/\{…\}/g, ""))) { continue; }
            // one word: a label, not a key handed to a helper (ws("provider")) or a bit of a sentence ("as")
            if (!/\s/.test(shown.replace(/\{…\}/g, "").trim()) && !looksLikeText(run, true)) { continue; }
            out.push(entry(rel, at(ps.find((x) => x.trim()) || run), 1, "ui", shown, ps, { html: true, fn: c.fn }));
        }
    }

    function visit(node) {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { emit(node, [node.text]); }
        else if (ts.isTemplateExpression(node)) { emit(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)]); }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return out;
}

/** Files of the mind's tools: what they answer goes to the mind (the writer sees what VS Code shows). */
const MIND_TOOLS = /^src\/(proposals|mascotTools|agentTools|mcpServer)\.ts$/;

function fileKind(rel) {
    if (/^src\/(agentTools|mascotTools|perception|prompt|lineDiff|edits|protocol|mcpServer|attention)\.ts$/.test(rel)) { return "mind"; }
    if (/^overlay\/(dev\/|render-sheet\.js)|^overlay\/renderer\/sheet\.js|^media\//.test(rel)) { return "dev"; }
    if (/^overlay\/renderer\/clawd\//.test(rel)) { return "engine"; }
    if (/^(settings\/|overlay\/renderer\/(app|markdown)\.js|overlay\/main\.js)/.test(rel)) { return "ui"; }
    return "src";
}

function entry(file, line, col, kind, text, parts, extra = {}) {
    const fragments = fragmentsOf(parts);
    // the same text with its Markdown as written, for where it's shown as is
    const raw = fragmentsOf(parts, { raw: true });
    const rawFragments = raw.join("\u0001") !== fragments.join("\u0001") ? raw : undefined;
    return { file, line, col, kind, text, fragments, ...(rawFragments ? { rawFragments } : {}), dynamic: fragments.length === 0, ...extra };
}

// ---------- the overlay's page ----------

function scanHtml(rel, text) {
    const out = [];
    const body = text.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<head>[\s\S]*?<\/head>/, (h) => h.replace(/<title>[\s\S]*?<\/title>/, ""));
    for (const m of body.matchAll(/\b(title|placeholder|aria-label|alt)="([^"]+)"/g)) {
        out.push(entry(rel, lineOf(text, text.indexOf(m[0])), 1, "ui", m[2], [m[2]], { attr: m[1] }));
    }
    for (const m of body.matchAll(/>([^<>]+)</g)) {
        const t = m[1].trim();
        if (!/[A-Za-z]{2}/.test(t)) { continue; }
        out.push(entry(rel, lineOf(text, text.indexOf(m[0])), 1, "ui", t, [t], { html: true }));
    }
    return out;
}

// ---------- package.json: what VS Code shows of the extension ----------

function scanManifest() {
    const rel = "package.json";
    const text = fs.readFileSync(path.join(REPO, rel), "utf8");
    const pkg = JSON.parse(text);
    const out = [];
    const at = (value, from = 0) => { const i = text.indexOf(JSON.stringify(value).slice(1, 60), from); return i < 0 ? 1 : lineOf(text, i); };
    const add = (value, where) => { if (typeof value === "string" && /[A-Za-z]{2}/.test(value)) { out.push(entry(rel, at(value), 1, "manifest", value, [value], { where })); } };
    add(pkg.displayName, "displayName");
    add(pkg.description, "description");
    add(pkg.capabilities?.untrustedWorkspaces?.description, "capabilities.untrustedWorkspaces.description");
    for (const [id, icon] of Object.entries(pkg.contributes.icons || {})) { add(icon.description, `icons.${id}`); }
    for (const c of pkg.contributes.commands || []) { add(c.title, `command ${c.command}`); add(c.category, `command ${c.command} category`); }
    for (const section of pkg.contributes.configuration || []) {
        add(section.title, `configuration ${section.id}`);
        for (const [key, p] of Object.entries(section.properties)) {
            add(p.markdownDescription || p.description, `${key}`);
            for (const l of p.enumItemLabels || []) { add(l, `${key} label`); }
            for (const d of p.enumDescriptions || []) { add(d, `${key} enum`); }
        }
    }
    return out;
}

// ---------- documents ----------

function scanMarkdown(rel, kind) {
    const text = fs.readFileSync(path.join(REPO, rel), "utf8");
    const lines = text.split(/\r?\n/);
    const out = [];
    let block = [], start = 0, fence = false;
    const flush = () => {
        const t = block.join(" ").trim();
        if (t && /[A-Za-z]{2}/.test(t)) {
            const shown = t.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").replace(/^>\s*/, "");
            out.push(entry(rel, start + 1, 1, kind, shown, [shown], { block: true }));
        }
        block = [];
    };
    lines.forEach((l, i) => {
        if (/^\s*```/.test(l)) { flush(); fence = !fence; return; }
        if (fence) { return; }
        if (/^---\s*$/.test(l) && i === 0) { return; }
        if (!l.trim() || /^#{1,6}\s/.test(l) || /^\s*([-*]|\d+\.)\s+/.test(l) || /^\s*\|/.test(l) || /^<!--/.test(l)) {
            flush();
            if (l.trim() && !/^<!--/.test(l) && !/^\s*\|[-:| ]+\|\s*$/.test(l)) { block = [l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()).join(" · ")]; start = i; if (/^#{1,6}\s/.test(l) || /^\s*\|/.test(l)) { flush(); } }
            return;
        }
        if (!block.length) { start = i; }
        block.push(l.trim());
    });
    flush();
    return out;
}

function scanMascots() {
    const out = [];
    for (const f of fs.readdirSync(path.join(REPO, "mascots")).filter((x) => x.endsWith(".json"))) {
        const rel = `mascots/${f}`;
        const text = fs.readFileSync(path.join(REPO, rel), "utf8");
        const p = JSON.parse(text);
        for (const [k, kind] of [["name", "ui"], ["description", "ui"], ["body", "mind"]]) {
            if (typeof p[k] === "string") { out.push(entry(rel, lineOf(text, text.indexOf(`"${k}"`)), 1, kind, p[k], [p[k]], { prop: k })); }
        }
    }
    return out;
}

// ---------- all of it ----------

function listFiles(dir, re) {
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(path.join(REPO, d), { withFileTypes: true })) {
            const rel = `${d}/${e.name}`;
            if (e.isDirectory()) { if (!/node_modules|\.cache|dev$/.test(rel)) { walk(rel); } }
            else if (re.test(e.name)) { out.push(rel); }
        }
    };
    walk(dir);
    return out;
}

function extractAll() {
    const strings = [];
    for (const rel of listFiles("src", /\.ts$/).filter((f) => !f.startsWith("src/test/"))) { strings.push(...scanScript(rel, fs.readFileSync(path.join(REPO, rel), "utf8"))); }
    for (const rel of ["overlay/main.js", "overlay/renderer/app.js", "overlay/renderer/markdown.js", "settings/settings.js", ...listFiles("overlay/renderer/clawd", /\.js$/)]) {
        strings.push(...scanScript(rel, fs.readFileSync(path.join(REPO, rel), "utf8")));
    }
    strings.push(...scanHtml("overlay/renderer/index.html", fs.readFileSync(path.join(REPO, "overlay/renderer/index.html"), "utf8")));
    strings.push(...scanManifest());
    for (const [rel, kind] of [["README.md", "doc"],["docs/mascots.md", "doc"], ["mind/system-prompt.md", "mind"]]) { strings.push(...scanMarkdown(rel, kind)); }
    for (const f of fs.readdirSync(path.join(REPO, "mind", "personas"))) { if (f.endsWith(".md")) { strings.push(...scanMarkdown(`mind/personas/${f}`, "persona")); } }
    strings.push(...scanMascots());
    // engine strings are only text when they explain a broken pack
    const kept = strings.filter((s) => !(s.kind === "other" && fileKind(s.file) === "engine" && !/\s/.test(s.text))).map((s) => (fileKind(s.file) === "engine" && s.kind === "other" ? { ...s, kind: "error" } : s));
    // the same text at the same place once
    const seen = new Set();
    const unique = kept.filter((s) => { const k = `${s.file}:${s.line}:${s.text}`; if (seen.has(k)) { return false; } seen.add(k); return true; });
    // An id from the file and the text: it survives the code moving around, and a text that changes
    // becomes a new one (not reviewed yet).
    const count = new Map();
    for (const s of unique) {
        const base = `${s.file}#${crypto.createHash("sha1").update(s.text).digest("hex").slice(0, 10)}`;
        const n = (count.get(base) || 0) + 1;
        count.set(base, n);
        s.id = n > 1 ? `${base}~${n}` : base;
    }
    return unique;
}

module.exports = { extractAll, normalizeSource, fragmentsOf };

if (require.main === module) {
    const all = extractAll();
    const by = {};
    for (const s of all) { by[s.kind] = (by[s.kind] || 0) + 1; }
    console.log(JSON.stringify(by));
    const kind = process.argv[2];
    for (const s of all.filter((x) => !kind || x.kind === kind)) { console.log(`${s.kind.padEnd(8)} ${s.file}:${s.line}  ${s.text.slice(0, 140)}`); }
}
