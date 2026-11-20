// The bench's extension host: one per scenario run, as VS Code runs one per window. It builds the
// scenario's world, puts the stand-ins in place (vscode, child_process, the network), activates the
// real extension from its bundle, and plays the scenario. What the writer would see goes to the
// bench's page through the server; what they do comes back the same way.
"use strict";

process.setSourceMapsEnabled?.(true);
Error.stackTraceLimit = 60;

const fs = require("fs");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");
const { buildWorld } = require("./world");
const { createVscode } = require("./vscode");
const { createChildProcess } = require("./childProcess");
const { createNetwork } = require("./network");
const { createDriver } = require("./driver");
const T = require("./vscodeTypes");

// Time, as the extension reads it, can jump ahead (a turn stuck for minutes, in a moment).
const realNow = Date.now;
let warp = 0;
Date.now = () => realNow() + warp;

const RUN = process.env.BENCH_RUN;
const PORT = process.env.BENCH_PORT;
const REPO = path.resolve(__dirname, "..", "..");
const SRC = path.join(REPO, "src").toLowerCase();

// ---------- the line to the server ----------
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=host&run=${encodeURIComponent(RUN)}`);
const outbox = [];
let opened = false;
function send(to, msg, extra = {}) {
    const line = JSON.stringify({ to, run: RUN, msg, ...extra });
    if (opened) { ws.send(line); } else { outbox.push(line); }
}
/** The last of what the page was told, by kind (the scenario reads the status bar, the tabs…). */
const last = {};
let outputText = "";
const state = { overlayUp: false };
function post(msg) {
    if (msg.type === "statusbar" || msg.type === "tabs" || msg.type === "context") { last[msg.type] = msg; }
    if (msg.type === "output" && msg.op === "append") {
        outputText += msg.text;
        if (/\] overlay connected$/m.test(msg.text)) { state.overlayUp = true; }
        if (/\] overlay exited/m.test(msg.text)) { state.overlayUp = false; }
    }
    send("ui", msg);
}
ws.addEventListener("open", () => { opened = true; for (const l of outbox.splice(0)) { ws.send(l); } });
ws.addEventListener("close", () => shutdown(0));
ws.addEventListener("error", () => { /* close follows */ });

const inbox = new EventEmitter();
ws.addEventListener("message", (e) => {
    let env;
    try { env = JSON.parse(String(e.data)); } catch { return; }
    inbox.emit(env.msg?.type || "?", env.msg, env);
});

function log(text) { post({ type: "bench-log", text: String(text) }); }

// ---------- where a call comes from, in Euterpe's sources ----------
function site() {
    const frames = [];
    for (const line of String(new Error().stack).split("\n").slice(2)) {
        const m = /\(?((?:[A-Za-z]:)?[^():]+\.(?:ts|js)):(\d+):(\d+)\)?\s*$/.exec(line.trim());
        if (!m) { continue; }
        const file = path.resolve(m[1]);
        if (!file.toLowerCase().startsWith(SRC)) { continue; }
        const fn = /^\s*at\s+(?:async\s+)?([^\s(]+)\s+\(/.exec(line);
        frames.push({ file: path.relative(REPO, file).replace(/\\/g, "/"), line: +m[2], col: +m[3], fn: fn ? fn[1] : undefined });
        if (frames.length >= 4) { break; }
    }
    return frames;
}

// ---------- widgets: what waits for the writer ----------
const widgets = new Map();
const widgetEvents = new EventEmitter();
let widgetSeq = 0;
function widget(spec) {
    const w = new EventEmitter();
    w.id = `w${++widgetSeq}`;
    w.spec = spec;
    w.open = true;
    w.openedAt = Date.now();
    w.update = (patch) => { if (!w.open) { return; } Object.assign(w.spec, patch); post({ type: "widget", op: "update", id: w.id, patch }); widgetEvents.emit("update", w, patch); };
    w.close = () => { if (!w.open) { return; } w.open = false; widgets.delete(w.id); post({ type: "widget", op: "close", id: w.id }); widgetEvents.emit("close", w); };
    widgets.set(w.id, w);
    post({ type: "widget", op: "open", id: w.id, spec });
    widgetEvents.emit("open", w);
    return w;
}
inbox.on("widget", (m) => { const w = widgets.get(m.id); if (w) { w.emit(m.event, m.data || {}); } });

// ---------- the mind's turns ----------
let turnSeq = 0;
const SILENCE = { expression: "reading", say: null, notes: 0, action: null };
const router = {
    scripted: [],
    handler: null,
    /** Turns nobody scripted or waits for: Euterpe reads on in silence (a scenario can change it). */
    auto: { reply: SILENCE, ms: 900 },
    waiting: new Map(),
    events: new EventEmitter(),
    /** A turn from a mind (the fake Claude Code, or an API request): its reply, when someone gives one. */
    turn(info) {
        const id = `turn-${++turnSeq}`;
        const reason = /<euterpe:perception reason="([\w-]+)">/.exec(info.text || "")?.[1];
        const chat = /<euterpe:chat>\n?([\s\S]*?)\n?<\/euterpe:chat>/.exec(info.text || "")?.[1];
        const turn = { id, ...info, reason, chat, kind: chat !== undefined ? "chat" : reason || (/summarized to keep you quick/.test(info.text || "") ? "summary" : "other"), claimed: false };
        post({ type: "mind", op: "turn", turn: { ...turn, claimed: undefined } });
        return new Promise((resolve) => {
            this.waiting.set(id, resolve);
            const i = this.scripted.findIndex((s) => matches(s.when, turn));
            if (i >= 0) {
                const s = this.scripted.splice(i, 1)[0];
                turn.claimed = true;
                setTimeout(() => this.answer(id, typeof s.reply === "function" ? s.reply(turn) : s.reply), s.delay ?? 700);
            }
            // a scenario waiting for this turn takes it (and answers it when it likes)
            this.events.emit("turn", turn);
            if (turn.claimed) { return; }
            if (this.handler) {
                Promise.resolve(this.handler(turn)).then((r) => { if (r !== undefined) { setTimeout(() => this.answer(id, r), 600); } });
            } else if (this.auto && !this.auto.skip?.(turn)) {
                const a = this.auto;
                setTimeout(() => { if (!turn.claimed) { this.answer(id, typeof a.reply === "function" ? a.reply(turn) : a.reply); } }, a.ms ?? 900);
            }
        });
    },
    answer(id, reply) {
        const r = this.waiting.get(id);
        if (!r || reply === undefined) { return false; }
        this.waiting.delete(id);
        post({ type: "mind", op: "reply", id, reply });
        r(reply);
        return true;
    },
};
function matches(when, turn) {
    if (!when) { return true; }
    if (typeof when === "function") { return when(turn); }
    if (when instanceof RegExp) { return when.test(turn.text || ""); }
    return when === turn.kind || when === turn.reason;
}
inbox.on("mind-reply", (m) => router.answer(m.id, m.reply));
/**
 * Who answers the turns nobody scripted: the bench (silently, after a moment), or the reviewer at
 * the mind's panel. In free play the writer's chats and Euterpe's hello wait for the reviewer; its
 * looks go on in silence.
 */
const FREE_WAITS = (turn) => turn.kind === "chat" || turn.kind === "session_start";
function setAuto(m) {
    router.auto = m.reply ? { reply: m.reply, ms: m.ms ?? 900, skip: m.free ? FREE_WAITS : null } : null;
    router.autoState = { on: !!router.auto, free: !!(m.reply && m.free) };
    post({ type: "mind", op: "auto", ...router.autoState });
}
inbox.on("mind-auto", setAuto);

// The fake Claude Code's turns and control requests (it talks to the host through the server).
const procs = new Map();
inbox.on("proc-hello", (m, env) => {
    procs.set(env.from, m);
    if (m.kind === "claude-mind") { router.lastInstructions = m.systemPrompt; }
    post({ type: "proc", op: "hello", proc: env.from, kind: m.kind, args: m.args, systemPrompt: m.systemPrompt });
    router.events.emit("proc", { proc: env.from, ...m });
});
inbox.on("proc-bye", (m, env) => { procs.delete(env.from); post({ type: "proc", op: "bye", proc: env.from, code: m.code }); });
inbox.on("mind-turn", async (m, env) => {
    const reply = await router.turn({ api: "claude", model: m.model, text: m.text, proc: env.from });
    send("proc", { type: "reply", turnId: m.turnId, reply }, { proc: env.from });
});
inbox.on("mind-control", (m, env) => {
    const refused = world?.claude?.refuseModels?.includes?.(m.model) ? (world.claude.refusal || `model '${m.model}' is not available for your account`) : null;
    router.events.emit("control", m);
    setTimeout(() => send("proc", { type: "control", reqId: m.reqId, error: refused }, { proc: env.from }), 250);
});
inbox.on("mind-info", (m) => {
    if (m.tools) { router.lastTools = m.tools.map((x) => ({ name: x.name, description: x.description, parameters: x.inputSchema })); router.builtinTools = m.builtin; }
    if (m.toolResult) { router.toolResults = [...(router.toolResults || []), m.toolResult]; }
    post({ type: "mind", op: "info", ...m });
});

// ---------- the world, and the extension in it ----------
let world, wb, ext, extApi, context, driver;
let ending = false;

async function shutdown(code) {
    if (ending) { return; }
    ending = true;
    try { await Promise.race([Promise.resolve(ext?.deactivate?.()), new Promise((r) => setTimeout(r, 1500))]); } catch { /* going anyway */ }
    for (const d of context?.subscriptions || []) { try { d.dispose(); } catch { /* ignore */ } }
    setTimeout(() => process.exit(code), 200);
}
inbox.on("stop", () => shutdown(0));

process.on("unhandledRejection", (err) => log(`unhandled rejection in the extension host: ${err?.stack || err}`));
process.on("uncaughtException", (err) => log(`uncaught exception in the extension host: ${err?.stack || err}`));

inbox.on("init", async (init) => {
    try {
        await start(init);
    } catch (err) {
        post({ type: "scenario", op: "error", message: `The run couldn't start: ${err.message}`, stack: err.stack });
    }
});

async function start(init) {
    const scenarios = require(path.join(REPO, "bench", "scenarios"));
    const scenario = scenarios.byId(init.scenario);
    if (!scenario) { throw new Error(`no scenario ${init.scenario}`); }
    const spec = typeof scenario.world === "function" ? scenario.world() : (scenario.world || {});
    // After a reload, VS Code knows Euterpe's settings again, and keeps what it kept (settings, secrets, state).
    let kept = null;
    if (init.reload) {
        try { kept = JSON.parse(fs.readFileSync(path.join(init.worldDir, "world.json"), "utf8")); } catch { /* nothing kept */ }
        spec.unknownSettings = [];
    }
    world = buildWorld(init.worldDir, spec);
    if (kept) { world.restore(kept); }

    // The world's environment, and nothing of the real machine's.
    const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("BENCH_")));
    for (const k of Object.keys(process.env)) { delete process.env[k]; }
    Object.assign(process.env, world.env, keep);
    if (spec.arch) { Object.defineProperty(process, "arch", { value: spec.arch, configurable: true }); }

    const bench = {
        ui: { post, widget },
        world,
        origin: `http://127.0.0.1:${PORT}`,
        site,
        log,
        clipboard: "",
        proposalScheme: "euterpe-proposal",
        reload: () => { world.save(); send("server", { type: "reload" }); },
        external: (uri) => onExternal(uri),
    };
    wb = createVscode(bench);
    const net = createNetwork(world, router, log);
    globalThis.fetch = net.fetch;
    const cp = createChildProcess(world, { spawned: (kind, file, args) => log(`runs ${kind === "claude" ? "Claude Code" : "Electron"}: ${file} ${args.join(" ").slice(0, 200)}`) });
    const zip = init.electronZip && fs.existsSync(init.electronZip) ? fs.readFileSync(init.electronZip) : Buffer.alloc(0);
    const https = net.createHttps(zip);

    const bundle = init.bundle;
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === "vscode") { return wb.api; }
        if (parent && parent.filename === bundle) {
            if (request === "child_process") { return cp; }
            if (request === "https") { return https; }
        }
        return load.apply(this, arguments);
    };

    // The extension's context, as VS Code gives it.
    const extUri = T.Uri.file(world.extRoot);
    const memento = (store) => ({
        get: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? JSON.parse(JSON.stringify(store[k])) : d),
        update: async (k, v) => { if (v === undefined) { delete store[k]; } else { store[k] = JSON.parse(JSON.stringify(v)); } world.save(); post({ type: "state", store: store === world.globalState ? "global" : "workspace", key: k, value: v ?? null }); },
        keys: () => Object.keys(store),
        setKeysForSync: () => { },
    });
    const secretChange = new T.EventEmitter();
    context = {
        subscriptions: [],
        extensionPath: extUri.fsPath,
        extensionUri: extUri,
        globalStorageUri: T.Uri.file(world.storage),
        globalStoragePath: T.Uri.file(world.storage).fsPath,
        storageUri: T.Uri.file(path.join(world.userData, "workspaceStorage", "7f3c1a9e2b", world.extId)),
        logUri: T.Uri.file(path.join(world.appData, "Code", "logs", "bench", "exthost", world.extId)),
        globalState: memento(world.globalState),
        workspaceState: memento(world.workspaceState),
        secrets: {
            get: async (k) => world.secrets[k],
            store: async (k, v) => { world.secrets[k] = String(v); world.save(); secretChange.fire({ key: k }); post({ type: "secrets", keys: Object.keys(world.secrets) }); },
            delete: async (k) => { delete world.secrets[k]; world.save(); secretChange.fire({ key: k }); post({ type: "secrets", keys: Object.keys(world.secrets) }); },
            keys: async () => Object.keys(world.secrets),
            onDidChange: secretChange.event,
        },
        extensionMode: T.ExtensionMode.Production,
        extension: { id: world.extId, extensionPath: extUri.fsPath, extensionUri: extUri, packageJSON: world.packageJSON, isActive: true },
        asAbsolutePath: (rel) => path.join(extUri.fsPath, rel),
        environmentVariableCollection: { replace() { }, append() { }, prepend() { }, get() { }, forEach() { }, delete() { }, clear() { } },
    };

    post({
        type: "world",
        scenario: scenario.id,
        dirs: { root: world.dir, home: world.home, workspace: world.workspaceDir, extension: context.extensionPath, storage: world.storage, euterpe: world.euterpeHome },
        trusted: world.trusted, remote: world.remoteName, provider: world.config.user["euterpe.provider"] || "claude",
        user: world.config.user, workspace: world.config.workspace, registry: world.config.registry, folders: world.folders,
        secrets: Object.keys(world.secrets),
    });

    // The documents the writer has open when the window comes up.
    const open = spec.open ?? (world.workspaceDir && fs.existsSync(path.join(world.workspaceDir, "draft.md")) ? ["ws/draft.md"] : []);
    for (const f of open) { await wb.openDocument(world.where(f)); }

    driver = createDriver({
        post, send, inbox, world, wb, widgets, widgetEvents, router, net, log, scenario, procs, last,
        get ext() { return extApi; },
        get overlayUp() { return state.overlayUp; },
        outputText: () => outputText,
        warp: (ms) => { warp += ms; log(`(time jumps ${Math.round(ms / 1000)} s ahead)`); },
        secret: (key, value) => (value === null ? context.secrets.delete(key) : context.secrets.store(key, value)),
        /** Stop a stand-in (the overlay's window closing, Claude Code crashing). */
        kill: (kind, code = 0) => {
            for (const [id, p] of procs) { if (p.kind === kind) { send("proc", { type: "exit", code }, { proc: id }); } }
        },
        bench: () => bench,
    });

    ext = require(bundle);
    extApi = ext.activate(context);
    post({ type: "scenario", op: "activated" });
    // (a reloaded window ends its scenario: what's left is free play)
    if (init.free) {
        setAuto({ reply: SILENCE, ms: 1000, free: true });
        post({ type: "scenario", op: init.reload ? "done" : "free" });
        return;
    }
    try {
        await scenario.run(driver);
        post({ type: "scenario", op: "done" });
    } catch (err) {
        if (err && err.benchStopped) { return; }
        post({ type: "scenario", op: "error", message: err.message, stack: err.stack });
    }
}

// The browser the writer would see: OpenAI's sign-in page (the bench's stand-in), or any page.
const browserPages = new Map();
let pageSeq = 0;
function onExternal(uri) {
    const url = uri.toString();
    const id = `page-${++pageSeq}`;
    const signIn = /^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/.test(url);
    browserPages.set(id, { id, url, signIn });
    post({ type: "browser", op: "open", id, url: uri.scheme === "file" ? uri.fsPath : url, kind: signIn ? "chatgpt-signin" : uri.scheme === "file" ? "folder" : "page" });
    driver?.browserOpened({ id, url, signIn });
}
inbox.on("browser-answer", async (m) => {
    const page = browserPages.get(m.id);
    if (!page?.signIn || page.answered) { return; }
    page.answered = true;
    const net = driver?.net;
    const back = net.authorize(page.url, m.answer);
    post({ type: "browser", op: "navigate", id: m.id, url: back });
    try {
        const res = await net.realFetch(back);
        post({ type: "browser", op: "page", id: m.id, url: back, status: res.status, html: await res.text() });
    } catch (err) {
        post({ type: "browser", op: "page", id: m.id, url: back, status: 0, html: `<p>This site can't be reached: ${String(err.message)}</p>` });
    }
});
inbox.on("browser-close", (m) => browserPages.delete(m.id));
// A link the writer followed in Euterpe's window (overlay/main.js: shell.openExternal).
inbox.on("electron-external", (m) => { try { onExternal(T.Uri.parse(m.url)); } catch (err) { log(`couldn't open ${m.url}: ${err.message}`); } });

// ---------- what the writer does in the page ----------
inbox.on("command", (m) => {
    // A resource from the page (an editor's title bar passes its document) arrives as { $uri }.
    const args = (m.args || []).map((a) => (a && typeof a === "object" && typeof a.$uri === "string" ? T.Uri.parse(a.$uri) : a));
    void Promise.resolve(wb?.runCommand(m.command, ...args)).catch((err) => log(`command ${m.command} failed: ${err.stack || err}`));
});
inbox.on("tab-activate", (m) => wb?.activateTab(m.id));
inbox.on("tab-close", (m) => wb?.closeTab(m.id));
inbox.on("doc-edit", (m) => wb?.edit(m.uri, m.start, m.end, m.text));
inbox.on("doc-select", (m) => wb?.select(m.uri, m.anchor, m.active));
inbox.on("doc-save", (m) => void wb?.save(m.uri));
inbox.on("webview-message", (m) => wb?.webviewMessage(m.id, m.message));
inbox.on("terminal-input", (m) => wb?.terminalInput(m.id, m.data));
inbox.on("terminal-ready", (m) => wb?.terminalReady(m.id));
inbox.on("trust-grant", () => wb?.grantTrust());
inbox.on("focus", (m) => wb?.setFocused(!!m.focused));
inbox.on("resync", () => {
    wb?.resync();
    for (const w of widgets.values()) { post({ type: "widget", op: "open", id: w.id, spec: w.spec }); }
    if (router.autoState) { post({ type: "mind", op: "auto", ...router.autoState }); }
});
inbox.on("open-document", async (m) => { try { await wb?.openDocument(m.path); } catch (err) { log(err.message); } });

send("server", { type: "host-ready", pid: process.pid });
