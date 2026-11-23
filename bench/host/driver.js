// The scenario's hands: what a scenario script does to the workbench, the overlay and the mind,
// and how it waits for what Euterpe shows. Every wait has a time limit, and says what it waited
// for when it runs out, so a scenario that no longer matches the extension says why.
"use strict";

const { EventEmitter } = require("events");

const TIMEOUT = 25_000;

class ScenarioError extends Error { }

const plain = (s) => String(s ?? "").replace(/\$\([^)]+\)\s*/g, "").trim();

/** An index among `labels` for `which`: a number, a label (codicons aside), or a pattern. */
function indexOf(labels, which, what) {
    if (typeof which === "number") {
        if (which < 0 || which >= labels.length) { throw new ScenarioError(`${what}: there's no choice #${which} (there are ${labels.length})`); }
        return which;
    }
    const i = labels.findIndex((l) => (which instanceof RegExp ? which.test(plain(l)) || which.test(l) : plain(l) === plain(which) || l === which));
    if (i < 0) { throw new ScenarioError(`${what}: no "${which}" among ${labels.map((l) => `"${plain(l)}"`).join(", ") || "nothing"}`); }
    return i;
}

function textMatches(want, ...texts) {
    if (want === undefined) { return true; }
    return texts.some((t) => t !== undefined && t !== null && (want instanceof RegExp ? want.test(String(t)) : String(t).includes(want)));
}

function createDriver(ctx) {
    const { post, send, inbox, world, wb, widgets, widgetEvents, router, log, scenario, last } = ctx;
    let stopped = false;
    const stops = [];
    inbox.on("stop", () => { stopped = true; for (const s of stops.splice(0)) { s(); } });
    const guard = (p) => new Promise((resolve, reject) => {
        stops.push(() => reject(Object.assign(new Error("stopped"), { benchStopped: true })));
        p.then(resolve, reject);
    });

    /** Wait for `test()` to give something, re-checking on every event the host raises. */
    function until(test, { timeout = TIMEOUT, what = "a condition", every = 120 } = {}) {
        return guard(new Promise((resolve, reject) => {
            const started = Date.now();
            const tick = () => {
                if (stopped) { return; }
                let v;
                try { v = test(); } catch (err) { reject(err); return; }
                if (v) { resolve(v); return; }
                if (Date.now() - started > timeout) { reject(new ScenarioError(`Timed out after ${Math.round(timeout / 1000)} s waiting for ${what}`)); return; }
                setTimeout(tick, every);
            };
            tick();
        }));
    }

    function claim(kind, filter, what) {
        const fits = (w) => w.open && !w.claimed && w.spec.widget === kind && filter(w.spec);
        return until(() => {
            const w = [...widgets.values()].find(fits);
            if (w) { w.claimed = true; }
            return w;
        }, { what, timeout: filter.timeout || TIMEOUT });
    }
    const closed = (w) => guard(new Promise((resolve) => { if (!w.open) { resolve(); return; } const f = (x) => { if (x === w) { widgetEvents.off("close", f); resolve(); } }; widgetEvents.on("close", f); }));

    // ---------- messages ----------
    async function message(f = {}) {
        const filter = (s) => (f.severity === undefined || s.severity === f.severity) && (f.modal === undefined || s.modal === f.modal) && textMatches(f.text, s.message, s.detail);
        filter.timeout = f.timeout;
        const what = `a${f.modal ? " modal" : f.modal === false ? " notification" : ""} ${f.severity || ""} message${f.text ? ` saying ${f.text}` : ""}`.replace(/\s+/g, " ");
        const w = await claim("message", filter, what);
        const labels = w.spec.items.map((i) => i.title);
        return {
            id: w.id, spec: w.spec, text: w.spec.message, detail: w.spec.detail, buttons: labels, modal: w.spec.modal, severity: w.spec.severity,
            click(which) { const index = indexOf(labels, which, `the message "${w.spec.message.slice(0, 60)}"`); post({ type: "widget-act", id: w.id, act: "click", index }); w.emit("answer", { index }); },
            close() { w.emit("answer", { index: null }); },
            closed: closed(w),
        };
    }

    // ---------- quick picks and input boxes ----------
    async function quickPick(f = {}) {
        const filter = (s) => textMatches(f.title, s.title) && textMatches(f.text, s.title, s.placeholder);
        filter.timeout = f.timeout;
        const w = await claim("quickpick", filter, `a quick pick${f.title ? ` titled ${f.title}` : ""}${f.text ? ` about ${f.text}` : ""}`);
        const labels = () => w.spec.items.map((i) => i.label);
        const pickable = () => w.spec.items.map((i) => (i.kind === -1 ? "\u0000separator" : i.label));
        return {
            id: w.id, get spec() { return w.spec; }, get items() { return w.spec.items; }, labels,
            pick(which) { const index = indexOf(pickable(), which, `the quick pick "${w.spec.title || w.spec.placeholder}"`); post({ type: "widget-act", id: w.id, act: "pick", index }); w.emit("accept", { index }); },
            button(which, button = 0) { const index = indexOf(pickable(), which, `the quick pick "${w.spec.title || w.spec.placeholder}"`); post({ type: "widget-act", id: w.id, act: "button", index, button }); w.emit("button", { index, button }); },
            type(value) { w.update({ value }); w.emit("value", { value }); },
            hide() { w.emit("hide"); },
            closed: closed(w),
        };
    }

    async function input(f = {}) {
        const filter = (s) => textMatches(f.title, s.title) && textMatches(f.text, s.title, s.prompt, s.placeHolder);
        filter.timeout = f.timeout;
        const w = await claim("input", filter, `an input box${f.title ? ` titled ${f.title}` : ""}`);
        let typed = w.spec.value || "";
        return {
            id: w.id, get spec() { return w.spec; },
            /** Type into it (replacing what's there); resolves with the validation message, if any. */
            async type(value) {
                typed = value;
                w.update({ value, typedByScenario: true });
                w.emit("value", { value });
                await until(() => w.spec.checked === value || !w.open, { what: "the input box's validation", timeout: 5000 });
                return w.spec.validation?.message ?? null;
            },
            accept(value) { if (value !== undefined) { typed = value; w.update({ value }); } w.emit("accept", { value: typed }); },
            cancel() { w.emit("hide"); },
            closed: closed(w),
        };
    }

    // ---------- progress and dialogs ----------
    async function progress(f = {}) {
        const filter = (s) => textMatches(f.title, s.title) && (f.location === undefined || s.location === f.location);
        filter.timeout = f.timeout;
        const w = await claim("progress", filter, `progress${f.title ? ` titled ${f.title}` : ""}`);
        return { id: w.id, get spec() { return w.spec; }, cancel() { w.emit("cancel"); }, done: closed(w) };
    }

    async function dialog(f = {}) {
        const filter = (s) => textMatches(f.title, s.title);
        filter.timeout = f.timeout;
        const w = await claim("open-dialog", filter, `an open dialog${f.title ? ` titled ${f.title}` : ""}`);
        return {
            id: w.id, spec: w.spec, offered: w.spec.offered,
            choose(...files) { w.emit("answer", { paths: files.map((p) => world.where(p)) }); },
            cancel() { w.emit("answer", { paths: null }); },
            closed: closed(w),
        };
    }

    // ---------- review checkpoints ----------
    let waitingNext = null;
    inbox.on("next", () => { const r = waitingNext; waitingNext = null; r?.(); });
    async function screen(key, title, notes = "", opts = {}) {
        await wait(opts.settle ?? 700);
        post({ type: "checkpoint", key: `${scenario.id}/${key}`, title, notes, focus: opts.focus || null, step: opts.step || null });
        await guard(new Promise((resolve) => { waitingNext = resolve; }));
    }
    const wait = (ms) => guard(new Promise((r) => setTimeout(r, ms)));

    // ---------- the page: the overlay, webviews, the workbench ----------
    let actSeq = 0;
    const acts = new Map();
    inbox.on("act-done", (m) => { const a = acts.get(m.id); if (a) { acts.delete(m.id); m.error ? a.reject(new ScenarioError(m.error)) : a.resolve(m.result); } });
    function act(target, action, ...args) {
        const id = `act-${++actSeq}`;
        return guard(new Promise((resolve, reject) => {
            acts.set(id, { resolve, reject });
            post({ type: "act", id, target, action, args });
            setTimeout(() => { if (acts.delete(id)) { reject(new ScenarioError(`The page didn't do "${action}" on ${target} in time (is the bench's page open?)`)); } }, 30_000);
        }));
    }

    const sessionEvents = new EventEmitter();
    let sub = null;
    const watchSession = () => {
        if (sub || !ctx.ext) { return; }
        sub = ctx.ext.onEvent((e) => sessionEvents.emit(e.kind, e));
    };
    function sessionEvent(kind, timeout = 40_000) {
        watchSession();
        return guard(new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new ScenarioError(`Timed out after ${timeout / 1000} s waiting for the session to report "${kind}"`)), timeout);
            sessionEvents.once(kind, (e) => { clearTimeout(t); resolve(e); });
        }));
    }

    // ---------- the mind ----------
    const mind = {
        /** The next turn (that nobody scripted) gets this reply; `when`: "chat", a perception reason, a pattern or a test. */
        reply(reply, opts = {}) { router.scripted.push({ reply, when: opts.when, delay: opts.delay }); },
        replies(...list) { for (const r of list) { mind.reply(r); } },
        /** Replies for every turn nobody scripted, after `ms` (null: wait for the reviewer at the mind's controls). */
        auto(reply, ms = 900) { router.auto = reply ? { reply, ms } : null; post({ type: "mind", op: "auto", reply, ms }); },
        handler(fn) { router.handler = fn; },
        /** Wait for the next turn; reply to it with turn.reply(…) if nothing else does. */
        turn(f = {}) {
            return guard(new Promise((resolve, reject) => {
                const t = setTimeout(() => { router.events.off("turn", on); reject(new ScenarioError(`Timed out waiting for the mind's next turn${f.kind ? ` (${f.kind})` : ""}`)); }, f.timeout || 40_000);
                const on = (turn) => {
                    if (turn.claimed || (f.kind && turn.kind !== f.kind && turn.reason !== f.kind)) { return; }
                    turn.claimed = true;
                    clearTimeout(t);
                    router.events.off("turn", on);
                    resolve({ ...turn, reply: (r) => router.answer(turn.id, r) });
                };
                router.events.on("turn", on);
            }));
        },
        /** Wait for a control request (a model switch) the fake Claude Code received. */
        control() { return guard(new Promise((resolve) => router.events.once("control", resolve))); },
        /** What the mind was last given: its instructions (the system prompt), its tools, and what its tools answered. */
        get instructions() { return router.lastInstructions; },
        get tools() { return router.lastTools || []; },
        get builtinTools() { return router.builtinTools || []; },
        get toolResults() { return router.toolResults || []; },
    };

    // ---------- the writer at the keyboard ----------
    async function type(text, opts = {}) {
        const e = wb.api.window.activeTextEditor;
        if (!e) { throw new ScenarioError("There's no document to type in"); }
        const d = e.document;
        let at = opts.at === "end" || opts.at === undefined ? d.getText().length - (d.getText().endsWith("\n") ? 1 : 0) : opts.at;
        if (typeof opts.after === "string") { const i = d.getText().indexOf(opts.after); if (i >= 0) { at = i + opts.after.length; } }
        const words = String(text).match(/\s*\S+|\s+$/g) || [text];
        for (const w of words) {
            wb.edit(d.uri, at, at, w);
            at += w.length;
            await wait(opts.pace ?? 70);
        }
    }

    // ---------- the browser ----------
    const browserQueue = [];
    const browser = {
        next(f = {}) {
            return until(() => { const i = browserQueue.findIndex((p) => !p.claimed && textMatches(f.url, p.url)); if (i < 0) { return null; } const p = browserQueue[i]; p.claimed = true; return p; }, { what: `the browser to open${f.url ? ` ${f.url}` : ""}` })
                .then((p) => ({
                    ...p,
                    answer: (a) => inbox.emit("browser-answer", { id: p.id, answer: a }),
                    close: () => { post({ type: "browser", op: "close", id: p.id }); inbox.emit("browser-close", { id: p.id }); },
                }));
        },
    };

    return {
        world, wb, vscode: wb.api, log, ScenarioError,
        get ext() { return ctx.ext; },
        get net() { return ctx.net; },
        browserOpened: (p) => browserQueue.push(p),
        /** Run a command as the writer would (palette, keybinding, status bar…); its promise. */
        run(command, ...args) {
            const p = Promise.resolve(wb.runCommand(command, ...args));
            p.catch((err) => log(`command ${command} failed: ${err.stack || err}`));
            return p;
        },
        message, modal: (f = {}) => message({ ...f, modal: true }), notification: (f = {}) => message({ ...f, modal: false }),
        quickPick, input, progress, dialog,
        screen, wait, until, type,
        note(text) { post({ type: "narration", text }); },
        overlay: {
            /** The avatar's window is up, and connected to the extension. */
            ready: () => until(() => ctx.overlayUp, { what: "the overlay's window", timeout: 30_000 }),
            do: (action, ...args) => act("overlay", action, ...args),
            /** Euterpe's bubble, up and done writing itself out: its text. */
            bubble: () => act("overlay", "wait-bubble"),
            /** The chat log says this (a message from Euterpe, the writer, or the system). */
            chat: (text) => act("overlay", "wait-chat", text),
        },
        webview: {
            do: (action, ...args) => act("webview", action, ...args),
            panel: () => [...wb.panels.values()][0],
        },
        page: { do: (action, ...args) => act("workbench", action, ...args) },
        session: {
            started: () => sessionEvent("started"),
            ended: () => sessionEvent("ended", 60_000),
            response: () => sessionEvent("response"),
            turnError: () => sessionEvent("turn-error"),
        },
        mind, browser,
        statusbar: () => last.statusbar?.items || [],
        status: () => (last.statusbar?.items || []).find((i) => /Euterpe/.test(i.text || "")),
        tabs: () => wb.tabs().map((t) => ({ id: t._id, label: t.label, kind: t._kind, active: t.isActive })),
        output: () => ctx.outputText(),
        /** Set a setting as the writer would in settings.json (user settings). */
        async set(key, value) {
            await wb.api.workspace.getConfiguration("euterpe").update(key.replace(/^euterpe\./, ""), value, 1);
        },
        /** Time jumps ahead, as the extension reads it (Date.now). */
        warp: (ms) => ctx.warp(ms),
        /** Stop a stand-in: "electron" (the overlay's window closes) or "claude-mind" (Claude Code exits, with `code`). */
        kill: (kind, code) => ctx.kill(kind, code),
        /** A page of VS Code's own, or a document the bench shows, in an editor tab. */
        openPage: (page, label, extra) => wb.openPage(page, label, extra),
        /** The writer opens a file in an editor (a path in the world: "ws/…", "~/…"). */
        open: (file, opts) => wb.openDocument(world.where(file), opts),
        /** The writer closes a tab (by its label). */
        closeTab(label) { const tab = wb.tabs().find((x) => x.label === label || (label instanceof RegExp && label.test(x.label))); if (!tab) { throw new ScenarioError(`no tab "${label}"`); } wb.closeTab(tab._id); },
        /** The writer brings a tab forward (by its label). */
        showTab(label) { const tab = wb.tabs().find((x) => x.label === label || (label instanceof RegExp && label.test(x.label))); if (!tab) { throw new ScenarioError(`no tab "${label}"`); } wb.activateTab(tab._id); },
        /** The fake world's settings, as they are now (user settings). */
        settings: () => ({ ...world.config.user }),
        /** A secret in VS Code's secret storage changes (an API key, the ChatGPT sign-in): null removes it. */
        secret: (key, value) => ctx.secret(key, value),
        /** The writer trusts the folder (Workspace Trust's Trust button). */
        trust: () => wb.grantTrust(),
        /** GitHub Copilot changes, as VS Code tells extensions: `models` it offers, `access` (VS Code's answer), `error` for every request (see world.js). */
        copilot: (patch) => wb.setCopilot(patch),
        /** The writer types a line in a terminal (the mind's debug console), and presses Enter. */
        async terminalType(text) {
            const id = [...wb.terminals.keys()].pop();
            if (!id) { throw new ScenarioError("there's no terminal"); }
            for (const ch of text) { wb.terminalInput(id, ch); await wait(25); }
            wb.terminalInput(id, "\r");
        },
        /** Something the world holds back until the scenario says (see world specs: "pauseAt"). */
        release(name) { world.gates = { ...(world.gates || {}), [name]: true }; },
        /** A file in the world, as it is now (a path in the world: "ws/…", "~/…"). */
        read(file) { try { return require("fs").readFileSync(world.where(file), "utf8"); } catch { return null; } },
    };
}

module.exports = { createDriver, ScenarioError };
