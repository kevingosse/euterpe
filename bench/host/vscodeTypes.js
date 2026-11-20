// The value types of the vscode API, as the extension uses them: Uri (with VS Code's own
// spelling of file paths), events, positions and ranges, edits, icons, Markdown strings, tab
// inputs and the enums. Behaviour lives in vscode.js.
"use strict";

const path = require("path");

// ---------- Uri ----------

const WIN = process.platform === "win32";

/** VS Code's percent-encoding of a URI component: unreserved characters stay, the rest is %XX. */
function encode(s, keepSlash) {
    let out = "";
    for (const ch of s) {
        if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === "/")) { out += ch; }
        else { out += encodeURIComponent(ch).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()); }
    }
    return out;
}

class Uri {
    constructor(scheme, authority, path_, query, fragment) {
        this.scheme = scheme || "file";
        this.authority = authority || "";
        this.path = path_ || "";
        this.query = query || "";
        this.fragment = fragment || "";
        if (this.scheme === "file" && !this.path.startsWith("/") && this.path) { this.path = "/" + this.path; }
    }

    static file(fsPath) {
        let p = String(fsPath);
        if (WIN) { p = p.replace(/\\/g, "/"); }
        let authority = "";
        if (p.startsWith("//")) {
            const i = p.indexOf("/", 2);
            authority = i < 0 ? p.slice(2) : p.slice(2, i);
            p = i < 0 ? "/" : p.slice(i);
        }
        if (!p.startsWith("/")) { p = "/" + p; }
        return new Uri("file", authority, p, "", "");
    }

    static parse(value) {
        const m = /^([a-zA-Z][\w+.-]*):(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/.exec(String(value));
        if (!m) { return new Uri("file", "", String(value), "", ""); }
        const dec = (s) => { try { return decodeURIComponent(s || ""); } catch { return s || ""; } };
        return new Uri(m[1].toLowerCase(), dec(m[3]), dec(m[4]), dec(m[6]), dec(m[8]));
    }

    static from(c) {
        return new Uri(c.scheme, c.authority, c.path, c.query, c.fragment);
    }

    static joinPath(base, ...segments) {
        return base.with({ path: path.posix.join(base.path || "/", ...segments) });
    }

    with(change) {
        return new Uri(
            change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path,
            change.query ?? this.query, change.fragment ?? this.fragment);
    }

    /** As VS Code writes it: a drive letter lower case, backslashes on Windows. */
    get fsPath() {
        let value;
        if (this.authority && this.path.length > 1 && this.scheme === "file") { value = `//${this.authority}${this.path}`; }
        else if (/^\/[a-zA-Z]:/.test(this.path)) { value = this.path[1].toLowerCase() + this.path.slice(2); }
        else { value = this.path; }
        return WIN ? value.replace(/\//g, "\\") : value;
    }

    toString(skipEncoding = false) {
        let p = this.path;
        let pathOut;
        const drive = /^\/([a-zA-Z]):(.*)$/.exec(p);
        if (skipEncoding) { pathOut = p; }
        else if (drive) { pathOut = `/${drive[1].toLowerCase()}%3A${encode(drive[2], true)}`; }
        else { pathOut = encode(p, true); }
        // an authority keeps its port's colon (and an IPv6 host's brackets), as VS Code writes it
        const auth = this.authority || this.scheme === "file" ? `//${skipEncoding ? this.authority : this.authority.replace(/[^A-Za-z0-9\-._~:@[\]]/g, (c) => encodeURIComponent(c))}` : "";
        const q = this.query ? `?${skipEncoding ? this.query : this.query.split("&").map((kv) => kv.split("=").map((x) => encode(x, false)).join("=")).join("&")}` : "";
        const f = this.fragment ? `#${skipEncoding ? this.fragment : encode(this.fragment, false)}` : "";
        return `${this.scheme}:${auth}${pathOut}${q}${f}`;
    }

    toJSON() {
        return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath, external: this.toString() };
    }
}

// ---------- events ----------

class Disposable {
    constructor(fn) { this._fn = fn; }
    static from(...items) { return new Disposable(() => { for (const d of items) { try { d?.dispose?.(); } catch { /* ignore */ } } }); }
    dispose() { const f = this._fn; this._fn = null; if (f) { f(); } }
}

class EventEmitter {
    constructor() {
        this._listeners = [];
        this.event = (listener, thisArgs, disposables) => {
            const entry = { fn: thisArgs ? listener.bind(thisArgs) : listener };
            this._listeners.push(entry);
            const d = new Disposable(() => { this._listeners = this._listeners.filter((e) => e !== entry); });
            if (Array.isArray(disposables)) { disposables.push(d); }
            return d;
        };
    }
    fire(data) {
        for (const e of this._listeners.slice()) {
            try { e.fn(data); } catch (err) { console.error("[bench] listener failed:", err); }
        }
    }
    dispose() { this._listeners = []; }
}

class CancellationTokenSource {
    constructor() {
        const emitter = new EventEmitter();
        let cancelled = false;
        this.token = {
            get isCancellationRequested() { return cancelled; },
            onCancellationRequested: emitter.event,
        };
        this.cancel = () => { if (!cancelled) { cancelled = true; emitter.fire(); } };
        this.dispose = () => emitter.dispose();
    }
}

// ---------- positions ----------

class Position {
    constructor(line, character) { this.line = line; this.character = character; }
    isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
    isBeforeOrEqual(o) { return this.isBefore(o) || this.isEqual(o); }
    isAfter(o) { return !this.isBeforeOrEqual(o); }
    isAfterOrEqual(o) { return !this.isBefore(o); }
    isEqual(o) { return this.line === o.line && this.character === o.character; }
    compareTo(o) { return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1; }
    translate(a, b) {
        const dl = typeof a === "object" ? a.lineDelta ?? 0 : a ?? 0;
        const dc = typeof a === "object" ? a.characterDelta ?? 0 : b ?? 0;
        return new Position(this.line + dl, this.character + dc);
    }
    with(a, b) {
        const line = typeof a === "object" ? a.line ?? this.line : a ?? this.line;
        const character = typeof a === "object" ? a.character ?? this.character : b ?? this.character;
        return new Position(line, character);
    }
}

class Range {
    constructor(a, b, c, d) {
        let start, end;
        if (typeof a === "number") { start = new Position(a, b); end = new Position(c, d); }
        else { start = a; end = b; }
        if (end.isBefore(start)) { [start, end] = [end, start]; }
        this.start = start;
        this.end = end;
    }
    get isEmpty() { return this.start.isEqual(this.end); }
    get isSingleLine() { return this.start.line === this.end.line; }
    contains(p) {
        if (p instanceof Range) { return this.contains(p.start) && this.contains(p.end); }
        return !p.isBefore(this.start) && !this.end.isBefore(p);
    }
    isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end); }
    with(a, b) {
        const start = a && a.start !== undefined && !(a instanceof Position) ? a.start : a ?? this.start;
        const end = a && a.end !== undefined && !(a instanceof Position) ? a.end : b ?? this.end;
        return new Range(start, end);
    }
}

class Selection extends Range {
    constructor(a, b, c, d) {
        let anchor, active;
        if (typeof a === "number") { anchor = new Position(a, b); active = new Position(c, d); }
        else { anchor = a; active = b; }
        super(anchor, active);
        this.anchor = anchor;
        this.active = active;
    }
    get isReversed() { return this.active.isBefore(this.anchor); }
}

// ---------- edits ----------

class TextEdit {
    constructor(range, newText) { this.range = range; this.newText = newText; }
    static replace(range, text) { return new TextEdit(range, text); }
    static insert(pos, text) { return new TextEdit(new Range(pos, pos), text); }
    static delete(range) { return new TextEdit(range, ""); }
}

class WorkspaceEdit {
    constructor() { this._ops = []; }
    replace(uri, range, newText) { this._ops.push({ kind: "edit", uri, range, text: newText }); }
    insert(uri, position, newText) { this._ops.push({ kind: "edit", uri, range: new Range(position, position), text: newText }); }
    delete(uri, range) { this._ops.push({ kind: "edit", uri, range, text: "" }); }
    createFile(uri, options) { this._ops.push({ kind: "create", uri, options: options || {} }); }
    deleteFile(uri, options) { this._ops.push({ kind: "delete", uri, options: options || {} }); }
    renameFile(oldUri, newUri, options) { this._ops.push({ kind: "rename", uri: oldUri, newUri, options: options || {} }); }
    set(uri, edits) { for (const e of edits || []) { this.replace(uri, e.range, e.newText); } }
    has(uri) { return this._ops.some((o) => o.uri.toString() === uri.toString()); }
    get size() { return new Set(this._ops.map((o) => o.uri.toString())).size; }
    entries() {
        const m = new Map();
        for (const o of this._ops) { if (o.kind === "edit") { const k = o.uri.toString(); if (!m.has(k)) { m.set(k, [o.uri, []]); } m.get(k)[1].push(new TextEdit(o.range, o.text)); } }
        return [...m.values()];
    }
}

// ---------- looks ----------

class ThemeColor { constructor(id) { this.id = id; } }
class ThemeIcon {
    constructor(id, color) { this.id = id; this.color = color; }
}
ThemeIcon.File = new ThemeIcon("file");
ThemeIcon.Folder = new ThemeIcon("folder");

class MarkdownString {
    constructor(value = "", supportThemeIcons = false) {
        this.value = value;
        this.supportThemeIcons = supportThemeIcons;
        this.isTrusted = undefined;
        this.supportHtml = false;
        this.baseUri = undefined;
    }
    appendText(t) { this.value += String(t).replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&"); return this; }
    appendMarkdown(t) { this.value += t; return this; }
    appendCodeblock(code, lang = "") { this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`; return this; }
}

// ---------- tabs ----------

class TabInputText { constructor(uri) { this.uri = uri; } }
class TabInputTextDiff { constructor(original, modified) { this.original = original; this.modified = modified; } }
class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
class TabInputTerminal { constructor() { } }

// ---------- enums ----------

const enums = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    EndOfLine: { LF: 1, CRLF: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    UIKind: { Desktop: 1, Web: 2 },
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
    InputBoxValidationSeverity: { Info: 1, Warning: 2, Error: 3 },
};

module.exports = {
    Uri, Disposable, EventEmitter, CancellationTokenSource, Position, Range, Selection, TextEdit, WorkspaceEdit,
    ThemeColor, ThemeIcon, MarkdownString, TabInputText, TabInputTextDiff, TabInputWebview, TabInputCustom, TabInputTerminal,
    ...enums,
};
