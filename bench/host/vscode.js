// A stand-in for the `vscode` module: the parts of VS Code's extension API that Euterpe uses,
// behaving as VS Code does, with everything the writer would see sent to the bench's page
// instead (notifications, dialogs, quick picks, input boxes, progress, the status bar, editors,
// diffs, webviews, the output channel, terminals), and GitHub Copilot's models as VS Code lends them
// (vscode.lm, its consent dialog). The real extension runs against it unchanged.
"use strict";

const fs = require("fs");
const path = require("path");
const T = require("./vscodeTypes");

const { Uri, EventEmitter, Disposable, CancellationTokenSource, Position, Range, Selection, TabInputText, TabInputTextDiff, TabInputWebview } = T;

const LANGUAGES = { ".md": "markdown", ".markdown": "markdown", ".txt": "plaintext", ".json": "json", ".js": "javascript", ".ts": "typescript", ".html": "html", ".css": "css", ".py": "python", ".tex": "latex", ".rst": "restructuredtext", ".adoc": "asciidoc", ".org": "org", ".yml": "yaml", ".yaml": "yaml" };

/**
 * @param bench the host's side of the bench: `ui` (widgets and posts to the page), `world` (the
 * scenario's machine: settings, folders, trust...), `site()` (where in Euterpe's code a call
 * comes from), `log(text)` (the bench's own log), `origin` (the bench server, for webviews).
 */
function createVscode(bench) {
    const { ui, world } = bench;
    const api = { ...T };

    // ---------- events the workbench raises ----------
    const ev = {
        activeEditor: new EventEmitter(), visibleEditors: new EventEmitter(), selection: new EventEmitter(), windowState: new EventEmitter(),
        docChange: new EventEmitter(), docSave: new EventEmitter(), docOpen: new EventEmitter(), docClose: new EventEmitter(),
        config: new EventEmitter(), trust: new EventEmitter(), tabs: new EventEmitter(), tabGroups: new EventEmitter(),
        terminalOpen: new EventEmitter(), terminalClose: new EventEmitter(), lmModels: new EventEmitter(), lmAccess: new EventEmitter(),
    };

    // ---------- documents ----------
    const docs = new Map();   // uri string -> Doc
    let untitledCount = 0;

    class Doc {
        constructor(uri, text, languageId) {
            this.uri = uri;
            this._text = text.replace(/\r\n/g, "\n");
            this.eol = text.includes("\r\n") ? T.EndOfLine.CRLF : T.EndOfLine.LF;
            this.languageId = languageId || LANGUAGES[path.extname(uri.path).toLowerCase()] || "plaintext";
            this.version = 1;
            this.isDirty = false;
            this.isClosed = false;
        }
        get fileName() { return this.uri.scheme === "file" ? this.uri.fsPath : this.uri.path; }
        get isUntitled() { return this.uri.scheme === "untitled"; }
        get lineCount() { return this._text.split("\n").length; }
        getText(range) {
            if (!range) { return this._text; }
            return this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
        }
        lineAt(x) {
            const line = typeof x === "number" ? x : x.line;
            const lines = this._text.split("\n");
            if (line < 0 || line >= lines.length) { throw new Error(`Illegal value for line: ${line}`); }
            const text = lines[line];
            const firstNonWs = text.search(/\S/);
            return {
                lineNumber: line, text,
                range: new Range(line, 0, line, text.length),
                rangeIncludingLineBreak: new Range(line, 0, line + (line < lines.length - 1 ? 1 : 0), line < lines.length - 1 ? 0 : text.length),
                firstNonWhitespaceCharacterIndex: firstNonWs < 0 ? text.length : firstNonWs,
                isEmptyOrWhitespace: firstNonWs < 0,
            };
        }
        offsetAt(p) {
            const lines = this._text.split("\n");
            const line = Math.max(0, Math.min(p.line, lines.length - 1));
            let off = 0;
            for (let i = 0; i < line; i++) { off += lines[i].length + 1; }
            return off + Math.max(0, Math.min(p.character, lines[line].length));
        }
        positionAt(offset) {
            const o = Math.max(0, Math.min(offset, this._text.length));
            const before = this._text.slice(0, o).split("\n");
            return new Position(before.length - 1, before[before.length - 1].length);
        }
        validatePosition(p) { return this.positionAt(this.offsetAt(p)); }
        validateRange(r) { return new Range(this.validatePosition(r.start), this.validatePosition(r.end)); }
        getWordRangeAtPosition(p) {
            const line = this.lineAt(p.line).text;
            let s = p.character, e = p.character;
            while (s > 0 && /\w/.test(line[s - 1])) { s--; }
            while (e < line.length && /\w/.test(line[e])) { e++; }
            return s === e ? undefined : new Range(p.line, s, p.line, e);
        }
        async save() {
            if (this.uri.scheme !== "file") { return false; }
            fs.writeFileSync(this.uri.fsPath, this.eol === T.EndOfLine.CRLF ? this._text.replace(/\n/g, "\r\n") : this._text, "utf8");
            this.isDirty = false;
            ev.docSave.fire(this);
            postDoc(this);
            return true;
        }
        /** Replace [start, end) with text, as typing or an edit does; fires the change. */
        _replace(changes, reason) {
            // changes: [{ start, end, text }] in offsets of the current text, non-overlapping
            const sorted = changes.slice().sort((a, b) => b.start - a.start);
            const contentChanges = [];
            for (const c of sorted) {
                const range = new Range(this.positionAt(c.start), this.positionAt(c.end));
                contentChanges.push({ range, rangeOffset: c.start, rangeLength: c.end - c.start, text: c.text });
                this._text = this._text.slice(0, c.start) + c.text + this._text.slice(c.end);
            }
            this.version++;
            this.isDirty = this.uri.scheme !== bench.proposalScheme;
            ev.docChange.fire({ document: this, contentChanges, reason });
            postDoc(this);
        }
    }

    function postDoc(doc) {
        ui.post({ type: "doc", uri: doc.uri.toString(), fsPath: doc.uri.scheme === "file" ? doc.uri.fsPath : null, name: tabLabel(doc.uri), text: doc._text, languageId: doc.languageId, version: doc.version, dirty: doc.isDirty });
    }

    function uriOf(x) {
        if (x instanceof Uri) { return x; }
        if (x && typeof x === "object" && typeof x.scheme === "string") { return Uri.from(x); }
        if (typeof x === "string") { return /^[a-z][\w+.-]*:/i.test(x) && !/^[a-z]:[\\/]/i.test(x) ? Uri.parse(x) : Uri.file(x); }
        throw new Error(`bench: not a uri: ${x}`);
    }

    async function openTextDocument(arg) {
        if (arg === undefined || (arg && typeof arg === "object" && !(arg instanceof Uri) && !arg.scheme)) {
            const uri = Uri.from({ scheme: "untitled", path: `Untitled-${++untitledCount}` });
            const d = new Doc(uri, arg?.content ?? "", arg?.language);
            docs.set(uri.toString(), d);
            ev.docOpen.fire(d);
            return d;
        }
        const uri = uriOf(arg);
        const known = docs.get(uri.toString());
        if (known) { return known; }
        let text;
        if (uri.scheme === "file") {
            try { text = fs.readFileSync(uri.fsPath, "utf8"); }
            catch (err) { throw new Error(`cannot open ${uri.toString()}. Detail: Unable to read file '${uri.fsPath}' (Error: Unable to resolve nonexistent file '${uri.fsPath}')`); }
        } else if (uri.scheme === "untitled") {
            text = "";
        } else {
            const provider = providers.get(uri.scheme);
            if (!provider) { throw new Error(`cannot open ${uri.toString()}. Detail: No content provider for ${uri.scheme}`); }
            text = (await provider.provideTextDocumentContent(uri, new CancellationTokenSource().token)) ?? "";
        }
        const d = new Doc(uri, text);
        docs.set(uri.toString(), d);
        ev.docOpen.fire(d);
        return d;
    }

    // ---------- content providers (virtual documents) ----------
    const providers = new Map();
    function registerTextDocumentContentProvider(scheme, provider) {
        providers.set(scheme, provider);
        const sub = provider.onDidChange?.(async (uri) => {
            const d = docs.get(uri.toString());
            if (!d) { return; }
            const text = (await provider.provideTextDocumentContent(uri, new CancellationTokenSource().token)) ?? "";
            if (text !== d._text) { d._text = text; d.version++; postDoc(d); }
        });
        return new Disposable(() => { if (providers.get(scheme) === provider) { providers.delete(scheme); } sub?.dispose(); });
    }

    // ---------- tabs and editors ----------
    let tabSeq = 0;
    const groups = [];   // TabGroup
    class TabGroup {
        constructor(viewColumn) { this.viewColumn = viewColumn; this.tabs = []; this._active = null; }
        get activeTab() { return this._active; }
        get isActive() { return activeGroup === this; }
    }
    class Tab {
        constructor(group, label, input, extra = {}) {
            this._id = `tab-${++tabSeq}`;
            this._group = group;
            this.label = label;
            this.input = input;
            this.isPinned = false;
            this.isPreview = !!extra.preview;
            this._kind = extra.kind;      // text, diff, webview, image, markdown, page
            this._extra = extra;
        }
        get group() { return this._group; }
        get isActive() { return this._group._active === this; }
        get isDirty() { return this.input instanceof TabInputText ? !!docs.get(this.input.uri.toString())?.isDirty : false; }
    }
    let activeGroup = null;
    function group(viewColumn) {
        let col = viewColumn === T.ViewColumn.Active || viewColumn === undefined || viewColumn === null ? (activeGroup?.viewColumn ?? 1)
            : viewColumn === T.ViewColumn.Beside ? (activeGroup?.viewColumn ?? 1) + 1 : viewColumn;
        let g = groups.find((x) => x.viewColumn === col);
        if (!g) { g = new TabGroup(col); groups.push(g); groups.sort((a, b) => a.viewColumn - b.viewColumn); }
        if (!activeGroup) { activeGroup = g; }
        return g;
    }

    const editors = new Map();   // doc uri string -> Editor (one per document is enough here)
    class Editor {
        constructor(document, viewColumn) {
            this.document = document;
            this._selections = [new Selection(0, 0, 0, 0)];
            this.viewColumn = viewColumn;
            this.options = { tabSize: 4, insertSpaces: true };
            this.visibleRanges = [new Range(0, 0, Math.min(40, document.lineCount), 0)];
        }
        get selection() { return this._selections[0]; }
        set selection(s) { this._selections = [s]; postSelection(this); }
        get selections() { return this._selections; }
        set selections(s) { this._selections = s.length ? s : [new Selection(0, 0, 0, 0)]; postSelection(this); }
        async edit(cb) {
            const ops = [];
            cb({
                replace: (loc, text) => ops.push({ range: loc instanceof Position ? new Range(loc, loc) : loc, text }),
                insert: (p, text) => ops.push({ range: new Range(p, p), text }),
                delete: (r) => ops.push({ range: r, text: "" }),
                setEndOfLine: () => { /* ignore */ },
            });
            const d = this.document;
            d._replace(ops.map((o) => ({ start: d.offsetAt(o.range.start), end: d.offsetAt(o.range.end), text: o.text })));
            return true;
        }
        revealRange() { /* the page scrolls on its own */ }
        setDecorations() { /* none here */ }
        show() { /* deprecated */ }
        hide() { /* deprecated */ }
    }
    function editorFor(doc, viewColumn) {
        let e = editors.get(doc.uri.toString());
        if (!e) { e = new Editor(doc, viewColumn); editors.set(doc.uri.toString(), e); }
        if (viewColumn) { e.viewColumn = viewColumn; }
        return e;
    }
    function postSelection(e) {
        const d = e.document;
        ui.post({ type: "selection", uri: d.uri.toString(), anchor: d.offsetAt(e.selection.anchor), active: d.offsetAt(e.selection.active) });
    }

    let activeEditor;   // TextEditor | undefined
    function tabLabel(uri) {
        if (uri.scheme === "untitled") { return uri.path; }
        return path.posix.basename(uri.path) || uri.toString();
    }
    function allTabs() { return groups.flatMap((g) => g.tabs); }
    function visibleEditorsNow() {
        const out = [];
        for (const g of groups) {
            const t = g._active;
            if (!t) { continue; }
            if (t.input instanceof TabInputText) { const d = docs.get(t.input.uri.toString()); if (d) { out.push(editorFor(d, g.viewColumn)); } }
            if (t.input instanceof TabInputTextDiff) {
                for (const u of [t.input.original, t.input.modified]) { const d = docs.get(u.toString()); if (d) { out.push(editorFor(d, g.viewColumn)); } }
            }
        }
        return out;
    }
    function computeActiveEditor() {
        const t = activeGroup?._active;
        if (!t) { return undefined; }
        if (t.input instanceof TabInputText) { const d = docs.get(t.input.uri.toString()); return d ? editorFor(d, activeGroup.viewColumn) : undefined; }
        if (t.input instanceof TabInputTextDiff) { const d = docs.get(t.input.modified.toString()); return d ? editorFor(d, activeGroup.viewColumn) : undefined; }
        return undefined;
    }
    function tabsChanged(change) {
        const before = activeEditor;
        activeEditor = computeActiveEditor();
        if (before !== activeEditor) { ev.activeEditor.fire(activeEditor); }
        ev.visibleEditors.fire(visibleEditorsNow());
        ev.tabs.fire({ opened: change.opened || [], closed: change.closed || [], changed: change.changed || [] });
        postTabs();
    }
    function postTabs() {
        ui.post({
            type: "tabs",
            active: activeGroup?.viewColumn ?? 1,
            groups: groups.map((g) => ({
                viewColumn: g.viewColumn,
                active: g._active?._id ?? null,
                tabs: g.tabs.map((t) => ({
                    id: t._id, label: t.label, kind: t._kind, preview: t.isPreview, dirty: t.isDirty,
                    uri: t.input instanceof TabInputText ? t.input.uri.toString() : undefined,
                    original: t.input instanceof TabInputTextDiff ? t.input.original.toString() : undefined,
                    modified: t.input instanceof TabInputTextDiff ? t.input.modified.toString() : undefined,
                    panel: t._extra.panel, page: t._extra.page, icon: t._extra.icon, site: t._extra.site,
                })),
            })),
        });
    }
    /** Open a tab (or bring forward the one already there); returns it. */
    function openTab(g, label, input, extra, same) {
        let t = g.tabs.find(same);
        const opened = [];
        if (!t) {
            if (extra.preview) {
                const old = g.tabs.find((x) => x.isPreview);
                if (old) { g.tabs.splice(g.tabs.indexOf(old), 1); ev.tabs.fire({ opened: [], closed: [old], changed: [] }); }
            }
            t = new Tab(g, label, input, extra);
            const at = g._active ? g.tabs.indexOf(g._active) + 1 : g.tabs.length;
            g.tabs.splice(at, 0, t);
            opened.push(t);
        } else if (!extra.preview && t.isPreview) {
            t.isPreview = false;
        }
        g._active = t;
        activeGroup = g;
        tabsChanged({ opened });
        return t;
    }
    function closeTab(t) {
        const g = t._group;
        const i = g.tabs.indexOf(t);
        if (i < 0) { return false; }
        g.tabs.splice(i, 1);
        if (g._active === t) { g._active = g.tabs[Math.min(i, g.tabs.length - 1)] || null; }
        if (t._extra.panel) { panels.get(t._extra.panel)?._closedByUser(); }
        if (t._extra.terminal) { /* terminals live in the panel */ }
        tabsChanged({ closed: [t] });
        return true;
    }

    async function showTextDocument(arg, columnOrOptions, preserveFocus) {
        const doc = arg instanceof Doc ? arg : await openTextDocument(arg);
        const opts = typeof columnOrOptions === "object" && columnOrOptions ? columnOrOptions : { viewColumn: columnOrOptions, preserveFocus };
        const g = group(opts.viewColumn);
        const preview = opts.preview ?? true;
        const keepActive = opts.preserveFocus ? activeGroup : null;
        openTab(g, tabLabel(doc.uri), new TabInputText(doc.uri), { kind: "text", preview, site: bench.site() }, (t) => t.input instanceof TabInputText && t.input.uri.toString() === doc.uri.toString());
        postDoc(doc);
        if (keepActive && keepActive !== g) { activeGroup = keepActive; tabsChanged({}); }
        const e = editorFor(doc, g.viewColumn);
        if (opts.selection) { e.selection = new Selection(opts.selection.start, opts.selection.end); }
        return e;
    }

    async function openDiff(left, right, title, options = {}) {
        const l = await openTextDocument(left), r = await openTextDocument(right);
        const g = group(options.viewColumn);
        openTab(g, title || `${tabLabel(left)} ↔ ${tabLabel(right)}`, new TabInputTextDiff(left, right), { kind: "diff", preview: options.preview ?? true, site: bench.site() },
            (t) => t.input instanceof TabInputTextDiff && t.input.original.toString() === left.toString() && t.input.modified.toString() === right.toString());
        postDoc(l); postDoc(r);
    }

    /** A page of the workbench's own (the Settings editor, Workspace Trust, settings.json, a picture, a preview...). */
    function openPage(page, label, extra = {}) {
        const g = group(extra.viewColumn);
        return openTab(g, label, { page }, { kind: extra.kind || "page", page, preview: extra.preview ?? false, icon: extra.icon, site: bench.site(), ...extra },
            (t) => t._extra.page && JSON.stringify(t._extra.page) === JSON.stringify(page));
    }

    // ---------- configuration ----------
    const cfgStore = world.config;   // { registry: {key: {default, scope}}, user: {}, workspace: {} }
    function fullKey(section, key) { return section ? `${section}.${key}` : key; }
    function getConfiguration(section) {
        const read = (key) => {
            const k = fullKey(section, key);
            const reg = cfgStore.registry[k];
            const machine = reg && (reg.scope === "machine" || reg.scope === "application" || reg.scope === "machine-overridable" && false);
            const hasWs = Object.prototype.hasOwnProperty.call(cfgStore.workspace, k) && !machine;
            const hasUser = Object.prototype.hasOwnProperty.call(cfgStore.user, k);
            return { k, reg, value: hasWs ? cfgStore.workspace[k] : hasUser ? cfgStore.user[k] : reg ? clone(reg.default) : undefined, defined: hasWs || hasUser || !!reg };
        };
        const conf = {
            get(key, dflt) { const r = read(key); return r.value === undefined ? dflt : r.value; },
            has(key) { return read(key).defined; },
            inspect(key) {
                const k = fullKey(section, key);
                const reg = cfgStore.registry[k];
                return {
                    key: k,
                    defaultValue: reg ? clone(reg.default) : undefined,
                    globalValue: cfgStore.user[k],
                    workspaceValue: cfgStore.workspace[k],
                    workspaceFolderValue: undefined,
                };
            },
            async update(key, value, target) {
                const k = fullKey(section, key);
                const reg = cfgStore.registry[k];
                const t = target === true || target === T.ConfigurationTarget.Global ? "user"
                    : target === false || target === T.ConfigurationTarget.Workspace || target === T.ConfigurationTarget.WorkspaceFolder ? "workspace"
                        : "workspace";
                if (!reg) { throw new Error(`Unable to write to ${t === "user" ? "User Settings" : "Workspace Settings"} because ${k} is not a registered configuration.`); }
                if (t === "workspace" && !world.folders.length) { throw new Error("Unable to write to Workspace Settings because no workspace is opened. Please open a workspace first and try again."); }
                if (t === "workspace" && (reg.scope === "machine" || reg.scope === "application")) { throw new Error(`Unable to write to Workspace Settings because ${k} does not support workspace scope. It can only be written to User Settings.`); }
                const store = t === "user" ? cfgStore.user : cfgStore.workspace;
                if (value === undefined) { delete store[k]; } else { store[k] = clone(value); }
                world.save();
                ui.post({ type: "settings", user: cfgStore.user, workspace: cfgStore.workspace, changed: k, target: t, value: value === undefined ? null : value, site: bench.site() });
                await Promise.resolve();
                ev.config.fire({ affectsConfiguration: (s) => s === k || k.startsWith(`${s}.`) || s.startsWith(`${k}.`) });
            },
        };
        return new Proxy(conf, {
            get(target, prop) {
                if (prop in target || typeof prop !== "string") { return target[prop]; }
                return read(prop).value;
            },
        });
    }
    const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

    // ---------- the workspace ----------
    const folders = () => (world.folders.length ? world.folders.map((f, index) => ({ uri: Uri.file(f.path), name: f.name || path.basename(f.path), index })) : undefined);
    function getWorkspaceFolder(uri) {
        const u = uriOf(uri);
        if (u.scheme !== "file") { return undefined; }
        const p = u.fsPath.toLowerCase();
        return (folders() || []).find((f) => { const fp = f.uri.fsPath.toLowerCase(); return p === fp || p.startsWith(fp + path.sep); });
    }
    function asRelativePath(x, includeWorkspaceFolder) {
        const u = typeof x === "string" ? (/^[a-z][\w+.-]*:\/\//i.test(x) ? Uri.parse(x) : Uri.file(x)) : x;
        const f = getWorkspaceFolder(u);
        if (!f) { return typeof x === "string" ? x : u.scheme === "file" ? u.fsPath : u.toString(); }
        const rel = path.relative(f.uri.fsPath, u.fsPath).replace(/\\/g, "/");
        return (includeWorkspaceFolder ?? (world.folders.length > 1)) ? `${f.name}/${rel}` : rel;
    }

    async function applyEdit(edit) {
        if (world.applyEditFails) { return false; }
        for (const op of edit._ops) {
            if (op.kind === "create") {
                const p = op.uri.fsPath;
                if (fs.existsSync(p) && !op.options.overwrite && !op.options.ignoreIfExists) { return false; }
                if (!fs.existsSync(p) || op.options.overwrite) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ""); }
                const d = docs.get(op.uri.toString()) || await openTextDocument(op.uri);
                d._text = ""; d.version++;
            }
        }
        const byDoc = new Map();
        for (const op of edit._ops) {
            if (op.kind !== "edit") { continue; }
            const d = docs.get(op.uri.toString()) || await openTextDocument(op.uri);
            if (!byDoc.has(d)) { byDoc.set(d, []); }
            byDoc.get(d).push({ start: d.offsetAt(op.range.start), end: d.offsetAt(op.range.end), text: op.text });
        }
        for (const [d, changes] of byDoc) { d._replace(changes); }
        return true;
    }

    const fsApi = {
        async stat(uri) {
            const u = uriOf(uri);
            let s;
            try { s = fs.statSync(u.fsPath); } catch { const e = new Error(`EntryNotFound (FileSystemError): ${u.toString()}`); e.code = "FileNotFound"; e.name = "EntryNotFound (FileSystemError)"; throw e; }
            return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
        },
        async readFile(uri) { return new Uint8Array(fs.readFileSync(uriOf(uri).fsPath)); },
        async writeFile(uri, content) { const p = uriOf(uri).fsPath; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
        async readDirectory(uri) { return fs.readdirSync(uriOf(uri).fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1]); },
        async createDirectory(uri) { fs.mkdirSync(uriOf(uri).fsPath, { recursive: true }); },
        async delete(uri, o) { fs.rmSync(uriOf(uri).fsPath, { recursive: !!o?.recursive, force: true }); },
    };

    api.workspace = {
        getConfiguration,
        onDidChangeConfiguration: ev.config.event,
        get isTrusted() { return world.trusted; },
        onDidGrantWorkspaceTrust: ev.trust.event,
        get workspaceFolders() { return folders(); },
        get workspaceFile() { return world.workspaceFile ? Uri.file(world.workspaceFile) : undefined; },
        get name() { return world.folders[0]?.name; },
        get rootPath() { return world.folders[0]?.path; },
        getWorkspaceFolder,
        asRelativePath,
        get textDocuments() { return [...docs.values()].filter((d) => !d.isClosed); },
        openTextDocument,
        onDidChangeTextDocument: ev.docChange.event,
        onDidSaveTextDocument: ev.docSave.event,
        onDidOpenTextDocument: ev.docOpen.event,
        onDidCloseTextDocument: ev.docClose.event,
        registerTextDocumentContentProvider,
        applyEdit,
        fs: fsApi,
        findFiles: async () => [],
        onDidChangeWorkspaceFolders: new EventEmitter().event,
    };

    // ---------- messages ----------
    function showMessage(severity, message, ...rest) {
        let options = {};
        let items = rest;
        if (rest.length && rest[0] && typeof rest[0] === "object" && !("title" in rest[0])) { options = rest[0]; items = rest.slice(1); }
        items = items.filter((i) => i !== undefined);
        const site = bench.site();
        return new Promise((resolve) => {
            const w = ui.widget({
                widget: "message", severity, message: String(message), detail: options.detail, modal: !!options.modal,
                items: items.map((i) => (typeof i === "string" ? { title: i } : { title: i.title, isCloseAffordance: !!i.isCloseAffordance })),
                site,
            });
            w.on("answer", (e) => {
                w.close();
                resolve(e && Number.isInteger(e.index) && e.index >= 0 ? items[e.index] : undefined);
            });
        });
    }

    // ---------- quick input ----------
    let currentQuickInput = null;
    function takeQuickInput(qi) {
        if (currentQuickInput && currentQuickInput !== qi) { currentQuickInput.hide(); }
        currentQuickInput = qi;
    }
    const iconId = (icon) => (icon && typeof icon === "object" && "id" in icon ? icon.id : icon && icon.dark ? "file" : undefined);
    function itemView(i) {
        return {
            label: i.label, description: i.description, detail: i.detail, kind: i.kind, picked: !!i.picked, alwaysShow: !!i.alwaysShow,
            icon: iconId(i.iconPath),
            buttons: (i.buttons || []).map((b) => ({ icon: iconId(b.iconPath), tooltip: b.tooltip })),
        };
    }

    function createQuickPick(site = bench.site()) {
        const accept = new EventEmitter(), hide = new EventEmitter(), value = new EventEmitter(), active = new EventEmitter(),
            selection = new EventEmitter(), button = new EventEmitter(), itemButton = new EventEmitter();
        let widget = null, visible = false;
        const s = {
            title: undefined, placeholder: undefined, items: [], activeItems: [], selectedItems: [], value: "", busy: false, enabled: true,
            matchOnDescription: false, matchOnDetail: false, canSelectMany: false, ignoreFocusOut: false, buttons: [], step: undefined, totalSteps: undefined,
            keepScrollPosition: false, sortByLabel: true, prompt: undefined,
        };
        const view = () => ({
            title: s.title, placeholder: s.placeholder, prompt: s.prompt, value: s.value, busy: s.busy, matchOnDescription: s.matchOnDescription, matchOnDetail: s.matchOnDetail,
            canSelectMany: s.canSelectMany, step: s.step, totalSteps: s.totalSteps,
            items: s.items.map(itemView),
            active: s.activeItems.map((a) => s.items.indexOf(a)).filter((i) => i >= 0),
            buttons: (s.buttons || []).map((b) => ({ icon: iconId(b.iconPath), tooltip: b.tooltip })),
        });
        let pushQueued = false;
        const push = () => {
            if (!widget || pushQueued) { return; }
            pushQueued = true;
            queueMicrotask(() => { pushQueued = false; widget?.update(view()); });
        };
        const qp = {
            onDidAccept: accept.event, onDidHide: hide.event, onDidChangeValue: value.event, onDidChangeActive: active.event,
            onDidChangeSelection: selection.event, onDidTriggerButton: button.event, onDidTriggerItemButton: itemButton.event,
            show() {
                takeQuickInput(qp);
                if (visible) { push(); return; }
                visible = true;
                widget = ui.widget({ widget: "quickpick", site, ...view() });
                widget.on("accept", (e) => {
                    const picks = Array.isArray(e?.indices) ? e.indices.map((i) => s.items[i]).filter(Boolean) : [s.items[e?.index]].filter(Boolean);
                    if (picks.length) { s.selectedItems = picks; s.activeItems = picks.slice(0, 1); selection.fire(s.selectedItems); }
                    accept.fire();
                });
                widget.on("button", (e) => { const item = s.items[e.index]; if (item) { itemButton.fire({ item, button: item.buttons?.[e.button] }); } });
                widget.on("title-button", (e) => { const b = s.buttons?.[e.button]; if (b) { button.fire(b); } });
                widget.on("value", (e) => { s.value = String(e.value ?? ""); value.fire(s.value); });
                widget.on("active", (e) => { const item = s.items[e.index]; if (item) { s.activeItems = [item]; active.fire(s.activeItems); } });
                widget.on("hide", () => qp.hide());
            },
            hide() {
                if (!visible) { return; }
                visible = false;
                widget?.close();
                widget = null;
                if (currentQuickInput === qp) { currentQuickInput = null; }
                hide.fire();
            },
            dispose() {
                qp.hide();
                for (const e of [accept, hide, value, active, selection, button, itemButton]) { e.dispose(); }
            },
        };
        for (const k of Object.keys(s)) {
            Object.defineProperty(qp, k, {
                get: () => s[k],
                set: (v) => { s[k] = k === "items" || k === "activeItems" || k === "selectedItems" || k === "buttons" ? [...(v || [])] : v; push(); },
                enumerable: true,
            });
        }
        return qp;
    }

    async function showQuickPick(itemsOrPromise, options = {}, token) {
        const site = bench.site();
        const raw = await itemsOrPromise;
        const items = raw.map((i) => (typeof i === "string" ? { label: i } : i));
        const qp = createQuickPick(site);
        qp.title = options.title;
        qp.placeholder = options.placeHolder;
        qp.matchOnDescription = !!options.matchOnDescription;
        qp.matchOnDetail = !!options.matchOnDetail;
        qp.canSelectMany = !!options.canPickMany;
        qp.ignoreFocusOut = !!options.ignoreFocusOut;
        qp.items = items;
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (done) { return; } done = true; resolve(v); qp.dispose(); };
            token?.onCancellationRequested?.(() => finish(undefined));
            qp.onDidAccept(() => {
                const picked = qp.selectedItems.map((i) => raw[items.indexOf(i)]);
                finish(options.canPickMany ? picked : picked[0]);
            });
            qp.onDidHide(() => finish(undefined));
            qp.show();
        });
    }

    function showInputBox(options = {}, token) {
        const site = bench.site();
        return new Promise((resolve) => {
            let done = false;
            const box = { hide: () => finish(undefined) };
            takeQuickInput(box);
            const w = ui.widget({
                widget: "input", title: options.title, prompt: options.prompt, placeHolder: options.placeHolder, value: options.value ?? "",
                password: !!options.password, ignoreFocusOut: !!options.ignoreFocusOut, validating: !!options.validateInput, site,
            });
            const validate = async (v) => {
                if (!options.validateInput) { return null; }
                let r;
                try { r = await options.validateInput(v); } catch (err) { r = String(err?.message || err); }
                if (r && typeof r === "object") { return { message: r.message, severity: r.severity ?? 3 }; }
                return r ? { message: String(r), severity: 3 } : null;
            };
            const finish = (v) => {
                if (done) { return; }
                done = true;
                if (currentQuickInput === box) { currentQuickInput = null; }
                w.close();
                resolve(v);
            };
            token?.onCancellationRequested?.(() => finish(undefined));
            void validate(options.value ?? "").then((m) => w.update({ validation: m, checked: options.value ?? "" }));
            w.on("value", async (e) => { const v = String(e.value ?? ""); const m = await validate(v); w.update({ validation: m, checked: v }); });
            w.on("accept", async (e) => {
                const v = String(e.value ?? "");
                const m = await validate(v);
                if (m && m.severity === 3) { w.update({ validation: m, checked: v, refused: true }); return; }
                finish(v);
            });
            w.on("hide", () => finish(undefined));
        });
    }

    // ---------- progress ----------
    async function withProgress(options, task) {
        const site = bench.site();
        const cts = new CancellationTokenSource();
        const location = typeof options.location === "object" ? "view" : options.location === T.ProgressLocation.Notification ? "notification" : options.location === T.ProgressLocation.Window ? "window" : "scm";
        const w = ui.widget({ widget: "progress", location, title: options.title, cancellable: !!options.cancellable, site });
        w.on("cancel", () => cts.cancel());
        const progress = { report: (v) => w.update({ report: { message: v?.message, increment: v?.increment } }) };
        try {
            return await task(progress, cts.token);
        } finally {
            w.close();
        }
    }

    // ---------- the status bar ----------
    const statusItems = new Set();
    let statusSeq = 0, statusQueued = false;
    function postStatus() {
        if (statusQueued) { return; }
        statusQueued = true;
        queueMicrotask(() => {
            statusQueued = false;
            ui.post({
                type: "statusbar",
                items: [...statusItems].filter((i) => i._visible).map((i) => ({
                    id: i._id, alignment: i.alignment, priority: i.priority, text: i.text, name: i.name,
                    tooltip: i.tooltip instanceof T.MarkdownString ? { markdown: i.tooltip.value, supportThemeIcons: i.tooltip.supportThemeIcons, isTrusted: i.tooltip.isTrusted } : i.tooltip,
                    command: typeof i.command === "string" ? i.command : i.command?.command, args: typeof i.command === "object" ? i.command?.arguments : undefined,
                    backgroundColor: i.backgroundColor?.id, color: typeof i.color === "string" ? i.color : i.color?.id,
                    accessibility: i.accessibilityInformation?.label, site: i._site,
                })),
            });
        });
    }
    function createStatusBarItem(a, b, c) {
        const id = typeof a === "string" ? a : `status-${++statusSeq}`;
        const alignment = typeof a === "string" ? b : a;
        const priority = typeof a === "string" ? c : b;
        const s = { text: "", tooltip: undefined, command: undefined, color: undefined, backgroundColor: undefined, accessibilityInformation: undefined, name: undefined };
        const item = { _id: id, _visible: false, _site: bench.site(), alignment: alignment ?? T.StatusBarAlignment.Left, priority: priority ?? 0, id,
            show() { item._visible = true; statusItems.add(item); postStatus(); },
            hide() { item._visible = false; postStatus(); },
            dispose() { statusItems.delete(item); postStatus(); },
        };
        for (const k of Object.keys(s)) {
            Object.defineProperty(item, k, { get: () => s[k], set: (v) => { s[k] = v; item._site = bench.site(); postStatus(); }, enumerable: true });
        }
        statusItems.add(item);
        return item;
    }

    // ---------- output and terminals ----------
    const channels = new Map();
    function createOutputChannel(name) {
        const ch = {
            name,
            append(text) { ui.post({ type: "output", channel: name, op: "append", text: String(text), site: bench.site() }); },
            appendLine(text) { ui.post({ type: "output", channel: name, op: "append", text: `${text}\n`, site: bench.site() }); },
            replace(text) { ui.post({ type: "output", channel: name, op: "replace", text: String(text) }); },
            clear() { ui.post({ type: "output", channel: name, op: "clear" }); },
            show(a, b) { ui.post({ type: "output", channel: name, op: "show", preserveFocus: typeof a === "boolean" ? a : !!b }); },
            hide() { ui.post({ type: "output", channel: name, op: "hide" }); },
            dispose() { channels.delete(name); },
            info: (m) => ch.appendLine(m), warn: (m) => ch.appendLine(m), error: (m) => ch.appendLine(String(m)), debug: () => { }, trace: () => { },
        };
        channels.set(name, ch);
        ui.post({ type: "output", channel: name, op: "create" });
        return ch;
    }

    let termSeq = 0;
    const terminals = new Map();
    function createTerminal(opts, shellPath) {
        const o = typeof opts === "string" ? { name: opts, shellPath } : opts || {};
        const id = `term-${++termSeq}`;
        const pty = o.pty;
        let opened = false;
        const term = {
            name: o.name || "Terminal", creationOptions: o, processId: Promise.resolve(undefined), exitStatus: undefined, state: { isInteractedWith: false },
            show(preserveFocus) { ui.post({ type: "terminal", op: "show", id, preserveFocus: !!preserveFocus }); open(); },
            hide() { },
            sendText(text) { pty?.handleInput?.(text + "\r"); },
            dispose() { terminals.delete(id); pty?.close?.(); ui.post({ type: "terminal", op: "close", id }); ev.terminalClose.fire(term); },
        };
        const open = () => { if (opened) { return; } opened = true; pty?.open?.({ columns: 120, rows: 30 }); };
        pty?.onDidWrite?.((data) => ui.post({ type: "terminal", op: "data", id, data }));
        pty?.onDidClose?.(() => ui.post({ type: "terminal", op: "close", id }));
        terminals.set(id, { term, pty, open });
        ui.post({ type: "terminal", op: "open", id, name: term.name, site: bench.site() });
        setTimeout(open, 50);
        ev.terminalOpen.fire(term);
        return term;
    }

    // ---------- webviews ----------
    let panelSeq = 0;
    const panels = new Map();
    const serializers = new Map();
    function asWebviewUri(uri) {
        return Uri.parse(`${bench.origin}/fs/${encodeURIComponent(uriOf(uri).fsPath).replace(/%2F/gi, "/").replace(/%5C/gi, "/").replace(/%3A/gi, ":")}`);
    }
    function createWebviewPanel(viewType, title, showOptions, options = {}) {
        const id = `panel-${++panelSeq}`;
        const receive = new EventEmitter(), dispose = new EventEmitter(), viewState = new EventEmitter();
        let html = "", disposed = false, iconPath;
        const site = bench.site();
        const viewColumn = typeof showOptions === "object" ? showOptions.viewColumn : showOptions;
        const g = group(viewColumn);
        const webview = {
            options,
            cspSource: bench.origin,
            asWebviewUri,
            get html() { return html; },
            set html(v) { html = String(v); ui.post({ type: "webview", op: "html", id, html, site: bench.site() }); },
            postMessage(message) { if (disposed) { return Promise.resolve(false); } ui.post({ type: "webview", op: "post", id, message }); return Promise.resolve(true); },
            onDidReceiveMessage: receive.event,
        };
        let tab;
        const panel = {
            viewType, webview, options,
            get title() { return title; },
            set title(v) { title = v; if (tab) { tab.label = v; postTabs(); } },
            get iconPath() { return iconPath; },
            set iconPath(v) { iconPath = v; ui.post({ type: "webview", op: "icon", id, icon: v ? (v.fsPath ?? v.light?.fsPath) : null }); if (tab) { tab._extra.icon = v?.fsPath; postTabs(); } },
            get viewColumn() { return tab?._group.viewColumn; },
            get active() { return !!tab && tab.isActive && activeGroup === tab._group; },
            get visible() { return !!tab && tab.isActive; },
            reveal(col) {
                if (!tab || disposed) { return; }
                const target = col && col !== T.ViewColumn.Active ? group(col) : tab._group;
                if (target !== tab._group) { tab._group.tabs.splice(tab._group.tabs.indexOf(tab), 1); tab._group = target; target.tabs.push(tab); }
                target._active = tab; activeGroup = target;
                tabsChanged({ changed: [tab] });
                viewState.fire({ webviewPanel: panel });
            },
            dispose() {
                if (disposed) { return; }
                disposed = true;
                if (tab) { const t = tab; tab = null; closeTab(t); }
                ui.post({ type: "webview", op: "dispose", id });
                panels.delete(id);
                dispose.fire();
            },
            onDidDispose: dispose.event,
            onDidChangeViewState: viewState.event,
            _receive: (m) => receive.fire(m),
            _closedByUser: () => { if (!disposed) { tab = null; panel.dispose(); } },
            _viewState: () => viewState.fire({ webviewPanel: panel }),
        };
        panels.set(id, panel);
        ui.post({ type: "webview", op: "create", id, viewType, title, site });
        tab = openTab(g, title, new TabInputWebview(viewType), { kind: "webview", panel: id, preview: false, site }, () => false);
        return panel;
    }

    // ---------- dialogs ----------
    function showOpenDialog(options = {}) {
        const site = bench.site();
        return new Promise((resolve) => {
            const w = ui.widget({
                widget: "open-dialog", title: options.title, openLabel: options.openLabel, filters: options.filters, canSelectFiles: options.canSelectFiles !== false,
                canSelectFolders: !!options.canSelectFolders, canSelectMany: !!options.canSelectMany, defaultPath: options.defaultUri?.fsPath,
                offered: world.dialogFiles(options), site,
            });
            w.on("answer", (e) => { w.close(); resolve(Array.isArray(e?.paths) && e.paths.length ? e.paths.map((p) => Uri.file(p)) : undefined); });
        });
    }

    api.window = {
        showInformationMessage: (...a) => showMessage("info", ...a),
        showWarningMessage: (...a) => showMessage("warning", ...a),
        showErrorMessage: (...a) => showMessage("error", ...a),
        showQuickPick,
        createQuickPick: () => createQuickPick(bench.site()),
        showInputBox,
        createInputBox: () => { throw new Error("bench: createInputBox isn't part of the stand-in yet"); },
        withProgress,
        setStatusBarMessage: (text) => { ui.post({ type: "status-message", text: String(text) }); return new Disposable(() => ui.post({ type: "status-message", text: "" })); },
        createStatusBarItem,
        createOutputChannel,
        createTerminal,
        get terminals() { return [...terminals.values()].map((t) => t.term); },
        onDidOpenTerminal: ev.terminalOpen.event,
        onDidCloseTerminal: ev.terminalClose.event,
        createWebviewPanel,
        registerWebviewPanelSerializer: (viewType, s) => { serializers.set(viewType, s); return new Disposable(() => serializers.delete(viewType)); },
        registerWebviewViewProvider: () => new Disposable(() => { }),
        showTextDocument,
        showOpenDialog,
        showSaveDialog: async () => undefined,
        get activeTextEditor() { return activeEditor; },
        get visibleTextEditors() { return visibleEditorsNow(); },
        onDidChangeActiveTextEditor: ev.activeEditor.event,
        onDidChangeVisibleTextEditors: ev.visibleEditors.event,
        onDidChangeTextEditorSelection: ev.selection.event,
        onDidChangeWindowState: ev.windowState.event,
        get state() { return { focused: world.focused, active: world.focused }; },
        activeColorTheme: { kind: T.ColorThemeKind.Dark },
        onDidChangeActiveColorTheme: new EventEmitter().event,
        tabGroups: {
            get all() { return groups.slice(); },
            get activeTabGroup() { return activeGroup || group(1); },
            onDidChangeTabs: ev.tabs.event,
            onDidChangeTabGroups: ev.tabGroups.event,
            async close(x, preserveFocus) {
                const list = Array.isArray(x) ? x : [x];
                let ok = true;
                for (const t of list) { ok = (t instanceof TabGroup ? t.tabs.slice().every((tt) => closeTab(tt)) : closeTab(t)) && ok; }
                return ok;
            },
        },
    };

    // ---------- commands ----------
    const commands = new Map();
    const contextKeys = {};
    const builtins = {
        setContext: (key, value) => { contextKeys[key] = value; ui.post({ type: "context", keys: { ...contextKeys } }); },
        "vscode.open": async (uri, options) => {
            const u = uriOf(uri);
            if (/\.(png|jpe?g|gif|webp|svg)$/i.test(u.path)) {
                openPage({ kind: "image", path: u.fsPath }, tabLabel(u), { kind: "image", preview: options?.preview ?? true, viewColumn: options?.viewColumn });
                return;
            }
            await showTextDocument(u, options);
        },
        "vscode.diff": (left, right, title, options) => openDiff(uriOf(left), uriOf(right), title, options),
        "markdown.showPreview": (uri) => {
            const u = uriOf(uri);
            openPage({ kind: "markdown", path: u.fsPath }, `Preview ${tabLabel(u)}`, { kind: "markdown" });
        },
        "workbench.trust.manage": () => openPage({ kind: "trust" }, "Workspace Trust", { kind: "page" }),
        "workbench.action.openSettingsJson": () => openPage({ kind: "settings-json" }, "settings.json", { kind: "page" }),
        "workbench.action.openSettings": (query) => openPage({ kind: "settings-ui", query: typeof query === "string" ? query : (query?.query ?? "") }, "Settings", { kind: "page" }),
        "workbench.action.reloadWindow": () => bench.reload(),
        "workbench.action.openWalkthrough": () => { },
        "workbench.action.chat.triggerSetup": () => copilotSetup(),
        "revealFileInOS": (uri) => ui.post({ type: "external", url: uriOf(uri).toString(), site: bench.site() }),
    };
    api.commands = {
        registerCommand(id, fn, thisArg) {
            if (commands.has(id)) { throw new Error(`command '${id}' already exists`); }
            commands.set(id, thisArg ? fn.bind(thisArg) : fn);
            return new Disposable(() => commands.delete(id));
        },
        registerTextEditorCommand(id, fn) { return api.commands.registerCommand(id, (...a) => activeEditor && fn(activeEditor, null, ...a)); },
        async executeCommand(id, ...args) {
            const fn = commands.get(id) || builtins[id];
            if (!fn) { bench.log(`(VS Code would run its command ${id}${args.length ? ` with ${JSON.stringify(args).slice(0, 200)}` : ""})`); return undefined; }
            return fn(...args);
        },
        async getCommands() { return [...commands.keys(), ...Object.keys(builtins)]; },
    };

    // ---------- the Language Model API: GitHub Copilot's models, lent to extensions ----------
    // The world's (world.copilot), each a LanguageModelChat whose requests the network answers in Chat
    // Completions, as it answers an API's (the turn router: the scenario, or the reviewer). An
    // extension's first request asks the writer, in VS Code's own dialog, whether it may use them.
    const COPILOT_VENDOR = "copilot", COPILOT_PROVIDER = "GitHub Copilot Chat";
    const copilot = () => world.copilot;
    const offers = (id) => (copilot().models || []).some((m) => m.id === id);

    function chatModel(m) {
        return {
            id: m.id, name: m.name, vendor: COPILOT_VENDOR, family: m.family ?? m.id, version: m.version ?? m.id, maxInputTokens: m.maxInputTokens ?? 128000,
            countTokens: async (x) => Math.ceil(String(typeof x === "string" ? x : (x?.content || []).map((p) => p?.value ?? "").join("")).length / 4),
            sendRequest: (messages, options, token) => sendChatRequest(m, messages, options || {}, token),
        };
    }

    function selectChatModels(selector = {}) {
        const fits = (m) => (!selector.vendor || selector.vendor === COPILOT_VENDOR) && (!selector.id || selector.id === m.id)
            && (!selector.family || selector.family === (m.family ?? m.id)) && (!selector.version || selector.version === (m.version ?? m.id));
        return Promise.resolve((copilot().models || []).filter(fits).map(chatModel));
    }

    /** Whether VS Code lets the extension use a model: true, false (declined), or undefined (it hasn't asked yet). */
    const languageModelAccess = {
        onDidChange: ev.lmAccess.event,
        canSendRequest: (chat) => (offers(chat?.id) ? copilot().access : undefined),
    };

    /** VS Code asks the writer, once, whether Euterpe may use the models (its own dialog, with Euterpe's reason). */
    let consent = null;
    function askConsent(justification, site) {
        consent = consent || new Promise((resolve) => {
            const w = ui.widget({
                widget: "message", modal: true, vscode: "consent", severity: "info",
                message: `The extension '${world.packageJSON.displayName}' wants to access the language models provided by ${COPILOT_PROVIDER}.`,
                detailLabel: justification ? "Justification: " : undefined, detail: justification || undefined,
                items: [{ title: "Allow" }], site,
            });
            w.on("answer", (e) => { w.close(); resolve(!!e && e.index === 0); });
        }).then((allowed) => { consent = null; setCopilot({ access: allowed }); return allowed; });
        return consent;
    }

    /** A failure as VS Code passes it on: a LanguageModelError with its code, else the provider's own error (Copilot's words). */
    function lmError(e) {
        const err = typeof e === "string" ? { message: e } : e || {};
        const cause = err.cause ? new Error(err.cause) : undefined;
        if (err.code) { return new T.LanguageModelError(err.message || "", err.code, cause); }
        const plain = new Error(err.message || "Something went wrong.", cause ? { cause } : undefined);
        if (err.name) { plain.name = err.name; }
        return plain;
    }

    async function sendChatRequest(m, messages, options, token) {
        const site = bench.site();
        if (!offers(m.id)) { throw T.LanguageModelError.NotFound(`Language model '${m.id}' is unknown.`); }
        if (copilot().access !== true && !(await askConsent(options.justification, site))) {
            throw T.LanguageModelError.NoPermissions(`Language model '${m.id}' cannot be used by '${world.extId}'.`);
        }
        if (copilot().error) { throw lmError(copilot().error); }
        if (token?.isCancellationRequested) { throw new T.CancellationError(); }
        // Auto chooses its model by the words of the writer's side's last message, and refuses a request with none (Copilot 0.75).
        if (m.id === "auto") {
            const last = [...(messages || [])].reverse().find((x) => x?.role === T.LanguageModelChatMessageRole.User);
            const words = (Array.isArray(last?.content) ? last.content : []).map((p) => (p instanceof T.LanguageModelTextPart ? p.value : "")).join("").trim();
            if (!words) { throw new Error("Auto mode needs a prompt or a command to route a request."); }
        }
        const tools = (options.tools || []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
        const body = { model: m.id, messages: asChat(messages), ...(tools.length ? { tools } : {}) };
        const r = await new Promise((resolve, reject) => {
            const sub = token?.onCancellationRequested?.(() => reject(new T.CancellationError()));
            bench.network.chatTurn(body, JSON.stringify(body), "copilot").then((v) => { sub?.dispose(); resolve(v); }, (err) => { sub?.dispose(); reject(err); });
        });
        // VS Code's own refusals come before any answer; the model's failures, as it streams.
        if (r.failed?.error?.code) { throw lmError(r.failed.error); }
        const fails = r.failed ? lmError(r.failed.error ?? { message: r.failed.network }) : null;
        const parts = [];
        if (r.message?.content) { parts.push(new T.LanguageModelTextPart(r.message.content)); }
        for (const c of r.message?.tool_calls || []) { parts.push(new T.LanguageModelToolCallPart(c.id, c.function.name, JSON.parse(c.function.arguments || "{}"))); }
        async function* stream() { for (const p of parts) { yield p; } if (fails) { throw fails; } }
        async function* text() { for await (const p of stream()) { if (p instanceof T.LanguageModelTextPart) { yield p.value; } } }
        return { stream: stream(), text: text() };
    }

    /**
     * VS Code's messages in Chat Completions' terms, as the network reads a turn: the writer's side's
     * words and the results of tools, the model's words and calls. VS Code's API has no system role:
     * the instructions open the conversation, from the writer's side (copilot.ts); here they're the system's.
     */
    function asChat(messages) {
        const out = [];
        for (const [i, msg] of (messages || []).entries()) {
            const parts = Array.isArray(msg?.content) ? msg.content : [new T.LanguageModelTextPart(String(msg?.content ?? ""))];
            if (msg?.role === T.LanguageModelChatMessageRole.Assistant) {
                const words = parts.filter((p) => p instanceof T.LanguageModelTextPart).map((p) => p.value).join("");
                const calls = parts.filter((p) => p instanceof T.LanguageModelToolCallPart).map((c) => ({ id: c.callId, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
                out.push({ role: "assistant", content: words || null, ...(calls.length ? { tool_calls: calls } : {}) });
                continue;
            }
            parts.forEach((p, k) => {
                if (p instanceof T.LanguageModelToolResultPart) { out.push({ role: "tool", tool_call_id: p.callId, content: (p.content || []).map((c) => c?.value ?? "").join("") }); }
                else if (p instanceof T.LanguageModelTextPart) { out.push({ role: i === 0 && k === 0 ? "system" : "user", content: p.value }); }
                else if (p instanceof T.LanguageModelDataPart) { out.push({ role: "user", content: `[a picture, ${p.mimeType}]` }); }
            });
        }
        return out;
    }

    /** The world's Copilot changes (a sign-in, a plan, a policy; VS Code's answer to the writer): as VS Code says it. */
    function setCopilot(patch) {
        Object.assign(world.copilot, patch);
        if ("models" in patch) { ev.lmModels.fire(); }
        if ("access" in patch) { ev.lmAccess.fire(); }
    }

    /** VS Code's Copilot setup (the bench's stand-in for it): signing in brings Copilot's models. */
    function copilotSetup() {
        const site = bench.site();
        return new Promise((resolve) => {
            const w = ui.widget({
                widget: "message", modal: true, vscode: "copilot-setup", icon: "copilot", severity: "info",
                message: "Sign in to use AI Features", detail: "By continuing, you agree to GitHub's Terms and Privacy Statement.",
                items: [{ title: "Continue with GitHub" }, { title: "Skip for now", isCloseAffordance: true }], site,
            });
            w.on("answer", (e) => {
                w.close();
                if (e && e.index === 0) { setCopilot({ models: copilot().setUp || [] }); }
                resolve();
            });
        });
    }

    api.lm = {
        selectChatModels,
        onDidChangeChatModels: ev.lmModels.event,
        tools: [],
    };

    // VS Code's GitHub sign-in: the account Copilot uses, while Copilot offers models (world.copilot.account).
    api.authentication = {
        getAccounts: async (providerId) => (providerId === "github" && (copilot().models || []).length
            ? [{ id: "github-1", label: copilot().account || "writer" }] : []),
        onDidChangeSessions: ev.lmModels.event,
    };

    // ---------- the environment ----------
    api.env = {
        appName: "Visual Studio Code",
        appRoot: "c:\\Program Files\\Microsoft VS Code\\resources\\app",
        appHost: "desktop",
        language: "en",
        machineId: "bench-machine",
        sessionId: "bench-session",
        uriScheme: "vscode",
        uiKind: T.UIKind.Desktop,
        shell: "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        get remoteName() { return world.remoteName || undefined; },
        isTelemetryEnabled: false,
        clipboard: {
            async readText() { return bench.clipboard || ""; },
            async writeText(t) { bench.clipboard = String(t); ui.post({ type: "clipboard", text: String(t), site: bench.site() }); },
        },
        async openExternal(uri) {
            const u = uriOf(uri);
            // a browser that won't open shows nothing
            if (world.openExternalFails) { return false; }
            ui.post({ type: "external", url: u.scheme === "file" ? u.fsPath : u.toString(), file: u.scheme === "file", site: bench.site() });
            bench.external(u);
            return true;
        },
        asExternalUri: async (u) => u,
    };

    api.extensions = {
        getExtension(id) {
            const e = world.extensions[id];
            return e ? { id, extensionPath: e.path, extensionUri: Uri.file(e.path), isActive: true, packageJSON: e.packageJSON || {}, exports: undefined, activate: async () => undefined } : undefined;
        },
        get all() { return Object.keys(world.extensions).map((id) => api.extensions.getExtension(id)); },
        onDidChange: new EventEmitter().event,
    };
    api.version = "1.105.1";
    api.l10n = { t: (s, ...a) => (typeof s === "string" ? s.replace(/\{(\d+)\}/g, (_, i) => String(a[i])) : s.message) };
    api.languages = { createDiagnosticCollection: () => ({ set() { }, delete() { }, clear() { }, dispose() { } }) };

    // ---------- what the page (and the scenario) do to the workbench ----------
    const control = {
        api,
        docs,
        panels,
        terminals,
        commands,
        contextKeys,
        /** Open a document as the writer would: in an editor tab, with the keyboard. */
        async openDocument(file, opts = {}) {
            const e = await showTextDocument(uriOf(file), { preview: false, ...opts });
            return e;
        },
        /** The writer types or deletes in a document (offsets into its text). */
        edit(uri, start, end, text) {
            const d = docs.get(uriOf(uri).toString());
            if (!d) { return; }
            d._replace([{ start, end, text }]);
            const e = editors.get(d.uri.toString());
            if (e) {
                const p = d.positionAt(start + text.length);
                e._selections = [new Selection(p, p)];
                ev.selection.fire({ textEditor: e, selections: e.selections, kind: T.TextEditorSelectionChangeKind.Keyboard });
            }
        },
        select(uri, anchor, active) {
            const d = docs.get(uriOf(uri).toString());
            const e = d && editors.get(d.uri.toString());
            if (!e) { return; }
            e._selections = [new Selection(d.positionAt(anchor), d.positionAt(active))];
            ev.selection.fire({ textEditor: e, selections: e.selections, kind: T.TextEditorSelectionChangeKind.Mouse });
        },
        async save(uri) { const d = docs.get(uriOf(uri).toString()); if (d) { await d.save(); } },
        activateTab(id) {
            for (const g of groups) {
                const t = g.tabs.find((x) => x._id === id);
                if (t) {
                    g._active = t; activeGroup = g; tabsChanged({ changed: [t] });
                    if (t._extra.panel) { panels.get(t._extra.panel)?._viewState(); }
                    return;
                }
            }
        },
        closeTab(id) { const t = allTabs().find((x) => x._id === id); if (t) { closeTab(t); } },
        tabs: allTabs,
        webviewMessage(id, message) { panels.get(id)?._receive(message); },
        terminalInput(id, data) { terminals.get(id)?.pty?.handleInput?.(data); },
        terminalReady(id) { terminals.get(id)?.open(); },
        grantTrust() {
            if (world.trusted) { return; }
            world.trusted = true;
            world.save();
            ev.trust.fire();
            ui.post({ type: "trust", trusted: true });
        },
        setFocused(focused) { if (world.focused === focused) { return; } world.focused = focused; ev.windowState.fire({ focused, active: focused }); },
        /** The extension's context.languageModelAccessInformation. */
        languageModelAccess,
        /** GitHub Copilot changes (its models, VS Code's access answer, a failure for every request). */
        setCopilot,
        runCommand: (id, ...args) => api.commands.executeCommand(id, ...args),
        /** A page of VS Code's own (the extension's page in the Extensions view, the Settings editor…), or a document the bench shows. */
        openPage: (page, label, extra) => openPage(page, label, extra),
        /** Everything the page needs to draw the workbench as it is (after a reload of the page). */
        resync() {
            postTabs();
            postStatus();
            for (const d of docs.values()) { postDoc(d); }
            ui.post({ type: "context", keys: { ...contextKeys } });
            ui.post({ type: "settings", user: cfgStore.user, workspace: cfgStore.workspace });
            ui.post({ type: "trust", trusted: world.trusted });
            for (const [id, p] of panels) { ui.post({ type: "webview", op: "create", id, viewType: p.viewType, title: p.title }); ui.post({ type: "webview", op: "html", id, html: p.webview.html }); }
        },
    };
    return control;
}

module.exports = { createVscode };
