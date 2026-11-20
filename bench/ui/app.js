// The bench's page: the tour on the left, the desktop in the middle (the VS Code window and the
// overlay, run for real), the screen under review on the right. A scenario plays until it reaches
// a screen to review; Next goes on.
import { net, connect } from "./net.js";
import { el, esc, debounce } from "./util.js";
import { mountWorkbench, W, resetWorkbench, setLight, showEuterpeTooltip, hideTooltip, render as renderWorkbench } from "./workbench.js";
import { resetWidgets } from "./widgets.js";
import { resetWebviews, webviewFrame } from "./webviews.js";
import { resetElectron, overlayWindow, pickMenu, menuShown } from "./electron.js";
import { resetBrowser } from "./browser.js";
import { mountMind, resetMind, mindInfo } from "./mind.js";
import { loadStrings, capture, covered, coverageStats, renderCoverage, C } from "./coverage.js";
import { mountComments, setMode, setReview, commentNode, editInPlace, renderAllComments, peek, openPopover, openTextPopover } from "./comments.js";
import { renderTour, scenarioStatus } from "./tour.js";
import { openPalette, closePalette } from "./palette.js";
import { forgetFiles } from "./pages.js";

const A = {
    catalog: { chapters: [] }, review: { comments: [], screens: {}, scenarios: {} },
    scenario: null, run: null, state: "idle", checkpoint: null, notes: [], error: null,
    seen: new Set(), screensThisRun: [], world: null,
    autoPlay: false, chain: localStorage.getItem("bench.chain") === "1",
    released: false,
};
const $ = (id) => document.getElementById(id);

// ---------- start ----------
mountWorkbench($("desktop"));
mountMind();
W.interactive = () => A.state === "free" || A.state === "done" || A.state === "error" || A.released;
setLight(localStorage.getItem("bench.light") === "1");
mountComments({
    context: () => ({
        scenario: A.scenario, scenarioTitle: scenarioOf(A.scenario)?.title, screen: A.checkpoint?.key, screenTitle: A.checkpoint?.title,
        world: A.world ? { provider: A.world.provider, trusted: A.world.trusted, remote: A.world.remote || undefined } : undefined,
    }),
    onSaved: () => { },
});
connect();

Promise.all([fetch("/api/catalog").then((r) => r.json()), fetch("/api/review").then((r) => r.json())]).then(([catalog, review]) => {
    A.catalog = catalog;
    A.review = review;
    setReview(review);
    renderAll();
});
void loadStrings();
window.addEventListener("bench:strings", () => updateCoverageBadge());
window.addEventListener("bench:rerender", () => renderWorkbench());
window.addEventListener("bench:review", () => renderSide());

const scenarioOf = (id) => A.catalog.chapters.flatMap((c) => c.scenarios).find((s) => s.id === id);
const chapterOf = (id) => A.catalog.chapters.find((c) => c.scenarios.some((s) => s.id === id));
const allScenarios = () => A.catalog.chapters.flatMap((c) => c.scenarios);

// ---------- runs ----------
function start(id, free = false) {
    A.scenario = id;
    A.state = "starting";
    A.checkpoint = null;
    A.notes = [];
    A.error = null;
    A.released = false;
    A.screensThisRun = [];
    clearStage();
    net.server({ type: "start", scenario: id, free });
    renderAll();
}
function clearStage() {
    resetWidgets(); resetWebviews(); resetElectron(); resetBrowser(); resetMind(); resetWorkbench(); closePalette(); forgetFiles();
    $("banner").classList.add("hidden");
}

net.on("hello", (m) => {
    if (m.run) {
        net.run = m.run.id; A.run = m.run.id; A.scenario = m.run.scenario; A.state = m.run.free ? "free" : "playing";
        clearStage();
        net.host({ type: "resync" });
        renderAll();
    }
    if (m.build && !m.build.ok) { banner(`Euterpe doesn't build: ${m.build.error}`); }
});
net.on("run", (m) => {
    if (m.op === "started") {
        net.run = m.run; A.run = m.run; A.scenario = m.scenario;
        if (!m.reload) { clearStage(); A.notes = []; A.error = null; A.checkpoint = null; }
        A.state = m.free ? "free" : "playing";
        // (the reloaded host says the scenario is done, which records it as played to its end)
        if (m.reload) { clearStage(); banner("VS Code reloaded the window (the bench restarted this world's extension host): the scenario ends here, and the world is yours to play in.", "info"); }
    } else if (m.op === "stopped" && m.run === A.run) {
        if (A.state === "playing" || A.state === "review") { A.state = "stopped"; }
    } else if (m.op === "failed") {
        A.state = "error"; A.error = { message: m.error || "The run couldn't start." };
    }
    renderAll();
});
net.on("scenario", (m) => {
    if (m.run && m.run !== A.run) { return; }
    if (m.op === "done") {
        A.state = "done";
        net.server({ type: "review", op: "scenario", scenario: A.scenario, screens: A.screensThisRun });
        if (A.chain || A.autoPlay) { setTimeout(() => { if (A.state === "done") { nextScenario(); } }, A.autoPlay ? 1200 : 2500); }
    } else if (m.op === "error") {
        A.state = "error";
        A.error = { message: m.message, stack: m.stack };
    } else if (m.op === "free") { A.state = "free"; }
    renderAll();
});
net.on("narration", (m) => { A.notes.push(m.text); renderSide(); });
net.on("world", (m) => { A.world = m; });
net.on("bench-log", (m) => { const pre = $("bench-log"); pre.textContent += `${m.text}\n`; if (pre.textContent.length > 60000) { pre.textContent = pre.textContent.slice(-40000); } pre.scrollTop = pre.scrollHeight; });
net.on("build", (m) => { if (!m.ok) { banner(`Euterpe doesn't build: ${m.error}`); } else if (A.run) { banner("Euterpe's code changed: restart this scenario to run the new code.", "info", "Restart", () => restart()); } });
net.on("files-changed", () => { forgetFiles(); if (A.run) { banner("Euterpe's files changed: restart this scenario to see them.", "info", "Restart", () => restart()); } });
net.on("catalog-changed", () => fetch("/api/catalog").then((r) => r.json()).then((c) => { A.catalog = c; renderTourBox(); }));
net.on("review", (m) => { A.review = m.data; setReview(m.data); renderTourBox(); renderSide(); updateCoverageBadge(); $("comment-count").textContent = String(A.review.comments.filter((c) => c.status === "open").length); if (!$("view-comments").classList.contains("hidden")) { showComments(); } });
net.on("net-closed", () => banner("The bench's server is gone: start it again (node bench), and this page reconnects."));
net.on("net-open", () => { if (!$("banner").textContent.includes("restart")) { $("banner").classList.add("hidden"); } });

function banner(text, kind = "", action, fn) {
    const b = $("banner");
    b.className = kind;
    b.innerHTML = "";
    b.append(el("span", { text }));
    if (action) { b.append(el("button", { class: "btn", text: action, onclick: () => { b.classList.add("hidden"); fn(); } })); }
    b.append(el("button", { class: "btn", text: "✕", onclick: () => b.classList.add("hidden") }));
}

function restart() { if (A.scenario) { start(A.scenario); } }
function nextScenario() {
    const list = allScenarios();
    const i = list.findIndex((s) => s.id === A.scenario);
    if (i >= 0 && i < list.length - 1) { start(list[i + 1].id); }
}

// ---------- screens to review ----------
net.on("checkpoint", (m) => {
    if (m.run && m.run !== A.run) { return; }
    A.checkpoint = m;
    A.state = "review";
    A.seen = new Set();
    A.screensThisRun.push(m.key);
    hideTooltip();
    if (m.focus === "status-tooltip") { showEuterpeTooltip(); }
    holdBubble(true);
    setTimeout(snapshot, 60);
    setTimeout(snapshot, 900);
    const prior = A.review.screens?.[m.key];
    net.server({ type: "review", op: "screen", key: m.key, title: m.title, scenario: A.scenario });
    if (prior?.reviewed) { A.prior = prior; } else { A.prior = null; }
    renderAll();
    if (A.autoPlay) { setTimeout(() => { if (A.checkpoint === m && A.state === "review") { next(true); } }, 1600); }
});

/**
 * While a screen is under review, Euterpe's bubble stays up (as if the pointer rested on it, which
 * holds it on the real overlay too); it goes on its way when the review does.
 */
function holdBubble(on) {
    const w = overlayWindow();
    const fw = w?.frame.contentWindow;
    const bubble = fw?.document?.getElementById("bubble");
    if (!bubble) { return; }
    if (on && !fw.__benchHold) {
        fw.__benchHold = (e) => { if (e.target === bubble) { e.stopImmediatePropagation(); } };
        fw.document.addEventListener("mouseleave", fw.__benchHold, true);
        bubble.dispatchEvent(new fw.MouseEvent("mouseenter"));
    } else if (!on && fw.__benchHold) {
        fw.document.removeEventListener("mouseleave", fw.__benchHold, true);
        fw.__benchHold = null;
        bubble.dispatchEvent(new fw.MouseEvent("mouseleave"));
    }
}

function roots() {
    const out = [{ root: $("desktop"), win: window }];
    const frames = [...$("desktop").querySelectorAll("iframe")];
    for (const f of frames) { try { if (f.contentDocument?.body && f.getClientRects().length) { out.push({ root: f.contentDocument.body, win: f.contentWindow }); } } catch { /* another origin */ } }
    return out;
}
function snapshot() {
    if (A.state !== "review" || !C.loaded) { return; }
    const cap = capture(roots());
    for (const id of covered(cap)) { A.seen.add(id); }
    A.lastTexts = cap.blob;
}
const watchScreen = debounce(snapshot, 400);
new MutationObserver(watchScreen).observe($("desktop"), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style"] });
setInterval(() => { if (A.state === "review") { snapshot(); } }, 1500);

function fingerprint(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
}

function next(auto = false) {
    if (A.state === "done") { nextScenario(); return; }
    if (A.state !== "review") { return; }
    snapshot();
    const texts = (A.lastTexts || "").split("\n").filter(Boolean);
    const stable = texts.filter((t) => !/\d{1,2}:\d{2}(:\d{2})?/.test(t) && !/\\\.worlds\\/.test(t));
    const fp = fingerprint(stable.join("\n"));
    const prior = A.review.screens?.[A.checkpoint.key];
    const changed = !!prior?.fingerprint && prior.fingerprint !== fp;
    net.server({ type: "review", op: "screen", key: A.checkpoint.key, title: A.checkpoint.title, scenario: A.scenario, reviewed: !auto, fingerprint: fp, texts: stable.slice(0, 400), seenIds: [...A.seen] });
    void changed;
    if (!auto) { patchScreen(A.checkpoint.key, { seenIds: [...A.seen] }); }
    holdBubble(false);
    A.state = "playing";
    net.host({ type: "next" });
    renderAll();
}
function patchScreen(key, patch) { A.review.screens[key] = { ...(A.review.screens[key] || {}), ...patch }; }

// ---------- the scenario's hands, on the page ----------
net.on("act", async (m) => {
    const done = (result) => net.host({ type: "act-done", id: m.id, result: result ?? null });
    const fail = (error) => net.host({ type: "act-done", id: m.id, error: String(error) });
    try {
        if (m.target === "workbench") { done(await workbenchAct(m.action, ...(m.args || []))); }
        else if (m.target === "overlay") { done(await overlayAct(m.action, ...(m.args || []))); }
        else if (m.target === "webview") { done(await webviewAct(m.action, ...(m.args || []))); }
        else { fail(`no target ${m.target}`); }
    } catch (err) { fail(err.message || err); }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, ms = 15000, what = "it") {
    const t0 = Date.now();
    for (;;) { const v = test(); if (v) { return v; } if (Date.now() - t0 > ms) { throw new Error(`the page waited for ${what} in vain`); } await sleep(100); }
}

async function workbenchAct(action, arg) {
    switch (action) {
        case "hover-status": return showEuterpeTooltip();
        case "unhover": hideTooltip(); return true;
        case "palette": openPalette({ interactive: false, filter: arg ?? "Euterpe" }); return true;
        case "close-palette": closePalette(); return true;
        case "center": window.dispatchEvent(new CustomEvent("bench:center")); return true;
        case "panel": W.panel.visible = arg !== false; W.panel.view = "output"; renderWorkbench(); return true;
        case "scroll-to": {
            const all = [...$("desktop").querySelectorAll(".blk, .set-item, .set-group, h1, h2, h3")];
            const target = all.find((e) => e.textContent.trim() === arg) || all.find((e) => e.textContent.includes(arg));
            target?.scrollIntoView({ block: "start" });
            return !!target;
        }
        case "extension-tab": {
            const t = document.querySelector(".page[data-surface=extension-page] .tabs span:nth-child(" + ({ details: 1, features: 2 }[arg] || 1) + ")");
            t?.click();
            return !!t;
        }
        default: throw new Error(`unknown workbench action ${action}`);
    }
}

async function overlayAct(action, ...args) {
    const w = await until(() => overlayWindow(), 20000, "the overlay's window");
    const fw = w.frame.contentWindow;
    await until(() => fw.__euterpe, 15000, "the overlay's page");
    const E = fw.__euterpe;
    const body = () => {
        const s = E.stage, c = s.canvas.getBoundingClientRect();
        const b = s.box || { x: c.width / 2 - 20, y: c.height - 60, w: 40, h: 40 };
        return { x: c.left + b.x + b.w / 2, y: c.top + b.y + b.h / 2 };
    };
    const fire = (target, type, at, extra = {}) => target.dispatchEvent(new fw.MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: extra.button ?? 0, buttons: extra.buttons ?? 0 }));
    switch (action) {
        case "openChat": E.openChat(true); return true;
        case "closeChat": E.closeChat(); return true;
        case "type": E.type(args[0]); return true;
        case "badge": { const b = fw.document.getElementById("notes-badge"); if (b.classList.contains("hidden")) { throw new Error("the notes badge isn't showing"); } b.click(); return true; }
        case "menu": {
            const at = body();
            await sleep(50);
            fire(fw.document.elementFromPoint(at.x, at.y) || fw.document.body, "contextmenu", at, { button: 2 });
            await until(() => menuShown(), 8000, "the overlay's menu");
            return true;
        }
        case "text-menu": {
            const sel = args[0] || "#bubble-content, .msg.euterpe";
            const t = fw.document.querySelector(sel);
            if (!t) { throw new Error(`nothing matches ${sel} in the overlay`); }
            const r = t.getBoundingClientRect();
            const range = fw.document.createRange();
            range.selectNodeContents(t);
            fw.getSelection().removeAllRanges();
            if (args[1] !== false) { fw.getSelection().addRange(range); }
            fire(t, "contextmenu", { x: r.left + 10, y: r.top + 8 }, { button: 2 });
            await until(() => menuShown(), 8000, "the text menu");
            return true;
        }
        case "pick": { const ok = pickMenu(args[0] ?? null); if (!ok) { throw new Error(`no menu item ${args[0]}`); } return true; }
        case "boop": {
            const at = body();
            const t = fw.document.elementFromPoint(at.x, at.y) || fw.document.body;
            t.dispatchEvent(new fw.PointerEvent("pointerdown", { bubbles: true, clientX: at.x, clientY: at.y, screenX: at.x, screenY: at.y, button: 0, pointerId: 1 }));
            await sleep(60);
            t.dispatchEvent(new fw.PointerEvent("pointerup", { bubbles: true, clientX: at.x, clientY: at.y, screenX: at.x, screenY: at.y, button: 0, pointerId: 1 }));
            return true;
        }
        case "proposal": {
            const rows = fw.document.querySelectorAll(".msg.proposal:not(.settled)");
            const row = rows[rows.length - 1];
            if (!row) { throw new Error("no open edit in the chat"); }
            row.querySelector(`button[data-decision="${args[0]}"]`).click();
            return true;
        }
        case "click-link": {
            const links = fw.document.querySelectorAll("#chat-log a[data-href], #bubble a[data-href]");
            const a = links[links.length - 1];
            if (!a) { throw new Error("no link in Euterpe's words"); }
            a.click();
            return a.dataset.href;
        }
        case "copy-code": {
            const b = [...fw.document.querySelectorAll("#chat-log .copy-btn, #bubble .copy-btn")].pop();
            if (!b) { throw new Error("no code block to copy"); }
            b.click();
            return true;
        }
        case "selectAll": { const i = fw.document.getElementById("chat-input"); i.focus(); i.value = args[0] || i.value; i.select(); return true; }
        case "wait-bubble": {
            // up, and done writing itself out
            await until(() => { const b = fw.document.getElementById("bubble"); return !b.classList.contains("hidden") && ![...b.querySelectorAll(".ghost")].some((g) => g.textContent); }, args[0] || 25000, "Euterpe's bubble");
            return fw.document.getElementById("bubble-content").textContent;
        }
        case "wait-chat": {
            // the chat log has a message saying this (Euterpe's, the writer's, or the system's)
            const want = args[0];
            await until(() => [...fw.document.querySelectorAll("#chat-log .msg")].some((m) => m.textContent.includes(want)), args[1] || 25000, `"${want}" in the chat`);
            return true;
        }
        case "wait-thinking": await until(() => fw.document.querySelector(".thinking-row"), 15000, "the thinking dots"); return true;
        case "bubble-text": return fw.document.getElementById("bubble-content").textContent;
        case "cut": {
            // VS Code goes away: the line to the extension closes, and won't open again
            fw.__benchNoReconnect = true;
            for (const s of fw.__benchSockets || []) { s.close(); }
            return true;
        }
        case "close-ws": {
            // the extension goes away: the overlay's line to it closes, and stays closed
            const sockets = fw.__benchSockets || [];
            for (const s of sockets) { s.close(); }
            return sockets.length;
        }
        default: throw new Error(`unknown overlay action ${action}`);
    }
}

async function webviewAct(action, ...args) {
    const f = await until(() => webviewFrame(), 15000, "the webview");
    // (its document changes when its page loads: always the current one)
    const doc = () => f.contentDocument;
    const q = (sel) => { const e = doc()?.querySelector(sel); if (!e) { throw new Error(`nothing matches ${sel} in the webview`); } return e; };
    await until(() => doc()?.querySelector("#app") && !doc().querySelector("#app[aria-busy]"), 15000, "the settings window to draw");
    switch (action) {
        case "click": q(args[0]).click(); await sleep(150); return true;
        case "scroll": q(args[0]).scrollIntoView({ block: args[1] || "start" }); await sleep(120); return true;
        case "top": f.contentWindow.scrollTo(0, 0); return true;
        case "type": { const e = q(args[0]); e.focus(); e.value = args[1]; e.dispatchEvent(new f.contentWindow.Event("input", { bubbles: true })); if (args[2] !== false) { e.dispatchEvent(new f.contentWindow.Event("change", { bubbles: true })); } return true; }
        case "submit": { const e = q(args[0]); e.requestSubmit ? e.requestSubmit() : e.submit(); return true; }
        case "open-setup": { const d = q("details.setup"); if (!d.open) { d.querySelector("summary").click(); } await sleep(200); return true; }
        case "text": return q(args[0]).textContent;
        case "exists": return !!doc()?.querySelector(args[0]);
        case "wait": await until(() => doc()?.querySelector(args[0]), args[1] || 15000, args[0]); return true;
        default: throw new Error(`unknown webview action ${action}`);
    }
}

// ---------- drawing the bench ----------
function renderAll() { renderTourBox(); renderBar(); renderSide(); updateCoverageBadge(); $("comment-count").textContent = String(A.review.comments.filter((c) => c.status === "open").length); }

function renderTourBox() {
    renderTour($("tour"), A.catalog, A.review, A.scenario, {
        start: (id) => start(id),
        options: {
            autoPlay: A.autoPlay, chain: A.chain,
            setAutoPlay: (on) => { A.autoPlay = on; if (on && A.state === "review") { next(true); } },
            setChain: (on) => { A.chain = on; localStorage.setItem("bench.chain", on ? "1" : "0"); },
        },
    });
}

function renderBar() {
    const s = scenarioOf(A.scenario), ch = chapterOf(A.scenario);
    $("where-scenario").textContent = s ? `${ch ? `${ch.title} › ` : ""}${s.title}` : "Euterpe review bench";
    const states = { idle: "Pick a scenario in the tour to start", starting: "Starting…", playing: "Playing…", review: A.checkpoint?.title || "", done: "This scenario is over: Next for the next one, or play freely", error: "The scenario broke (see the right)", free: "Free play: click, type, run commands", stopped: "Stopped" };
    $("where-screen").textContent = states[A.state] ?? "";
    const pill = $("run-state");
    const label = { idle: "idle", starting: "starting", playing: "playing", review: "review", done: "done", error: "broken", free: "free play", stopped: "stopped" }[A.state];
    pill.textContent = A.released && A.state !== "free" ? "free play" : label;
    pill.className = `pill ${{ playing: "playing", starting: "playing", review: "review", done: "done", error: "error", free: "free" }[A.state] || ""}${A.released ? " free" : ""}`;
    $("btn-next").disabled = !(A.state === "review" || (A.state === "done" && allScenarios().findIndex((x) => x.id === A.scenario) < allScenarios().length - 1));
    $("btn-next").innerHTML = A.state === "done" ? 'Next scenario <i class="codicon codicon-arrow-right"></i>' : 'Next <i class="codicon codicon-arrow-right"></i>';
    $("btn-restart").disabled = !A.scenario;
    $("btn-free").disabled = !A.run || A.state === "free" || A.released;
}

function renderSide() {
    const card = $("screen-card");
    card.innerHTML = "";
    const s = scenarioOf(A.scenario);
    if (!s) {
        card.append(el("h3", { text: "Euterpe's review bench" }),
            el("div", { class: "screen-notes", html: "<p>The tour on the left goes through every screen and every text Euterpe has, one scenario at a time. Each scenario runs the real extension in a world of its own (a writer's machine, with Claude Code or ChatGPT, Electron, a draft), and stops at each screen for you to review.</p><p><b>Comment</b> (C) lets you point at anything and say what should change; <b>Next</b> (N) goes on. Your comments go to <code>bench/review.json</code>, for Claude to act on.</p><p><b>Coverage</b> lists every text in Euterpe's sources, and which ones you haven't seen yet.</p>" }));
        // where the review stands: the first scenario not reviewed to its end
        const todo = allScenarios().find((x) => scenarioStatus(x, A.review).state !== "done");
        if (todo) {
            const begun = allScenarios().some((x) => scenarioStatus(x, A.review).screens);
            card.append(el("div", { class: "side-actions" }, el("button", { class: "btn primary", text: begun ? `Go on with the tour: ${todo.title}` : "Start the tour", onclick: () => start(todo.id) })));
        }
    } else {
        if (A.checkpoint && (A.state === "review" || A.state === "playing")) {
            card.append(el("h3", { text: A.checkpoint.title }));
            if (A.checkpoint.notes) { card.append(el("div", { class: "screen-notes", text: A.checkpoint.notes })); }
            if (A.prior?.reviewed) { card.append(el("div", { class: "small muted", style: { marginTop: "6px" }, text: `You reviewed this screen on ${new Date(A.prior.reviewed).toLocaleString()}.` })); }
            card.append(el("div", { class: "screen-key", text: A.checkpoint.key }));
            if (A.state === "playing") { card.append(el("div", { class: "small muted", style: { marginTop: "6px" }, text: "Playing on to the next screen…" })); }
        } else {
            card.append(el("h3", { text: s.title }));
            if (s.summary) { card.append(el("div", { class: "screen-notes", text: s.summary })); }
        }
        for (const n of A.notes.slice(-4)) { card.append(el("div", { class: "small", style: { marginTop: "6px", color: "#cfc4d6" }, text: `▸ ${n}` })); }
        if (A.error) {
            card.append(el("div", { class: "error-box", style: { marginTop: "8px" } }, el("div", { text: `The scenario broke: ${A.error.message}` }), A.error.stack ? el("pre", { text: A.error.stack.split("\n").slice(1, 8).join("\n") }) : null,
                el("div", { class: "small", style: { marginTop: "4px" }, text: "Its world stays as it was: you can look around (Play freely), and tell Claude." })));
        }
        const actions = el("div", { class: "side-actions" });
        actions.append(el("button", { class: "btn", html: '<i class="codicon codicon-comment"></i> Comment on this screen', onclick: () => openPopover(null, null, null, true) }));
        card.append(actions);
    }
    const sc = $("screen-comments");
    sc.innerHTML = "";
    const key = A.checkpoint?.key;
    const mine = A.review.comments.filter((c) => (key ? c.screen === key : c.scenario === A.scenario && A.scenario));
    sc.append(el("h3", { text: key ? `Comments on this screen (${mine.length})` : `Comments on this scenario (${mine.length})` }));
    if (!mine.length) { sc.append(el("div", { class: "muted small", text: "None yet. Press C, point at what you want to change, and click it." })); }
    for (const c of mine) { const n = commentNode(c, { onEdit: () => editInPlace(n, c) }); sc.append(n); }
}

function updateCoverageBadge() {
    if (!C.loaded) { return; }
    const st = coverageStats(A.review);
    $("coverage-pct").textContent = `${st.pct}%`;
}

// ---------- the bar's buttons, and keys ----------
$("btn-next").addEventListener("click", () => next());
$("btn-restart").addEventListener("click", restart);
$("btn-free").addEventListener("click", () => { A.released = true; renderAll(); net.host({ type: "mind-auto", reply: { expression: "reading", say: null, notes: 0, action: null }, ms: 1000, free: true }); });
$("tour-toggle").addEventListener("click", () => $("layout").classList.toggle("no-tour"));
$("btn-theme").addEventListener("click", () => { setLight(!W.light); localStorage.setItem("bench.light", W.light ? "1" : "0"); });
$("btn-comments").addEventListener("click", () => { const v = $("view-comments"); if (v.classList.contains("hidden")) { showComments(); } else { v.classList.add("hidden"); } });
$("btn-coverage").addEventListener("click", () => { const v = $("view-coverage"); if (v.classList.contains("hidden")) { showCoverage(); } else { v.classList.add("hidden"); } });
function showComments() { const v = $("view-comments"); $("view-coverage").classList.add("hidden"); v.classList.remove("hidden"); renderAllComments(v, A.review, { jump: (id) => { v.classList.add("hidden"); start(id); } }); }
function showCoverage() { const v = $("view-coverage"); $("view-comments").classList.add("hidden"); v.classList.remove("hidden"); renderCoverage(v, A.review, { onPeek: (file, line, after) => peek(file, line, after), onComment: (s, anchor) => openTextPopover(s, anchor) }); }
document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.tagName === "SELECT")) { return; }
    if (e.ctrlKey || e.metaKey || e.altKey) { return; }
    if (e.key === "n" || e.key === "N" || (e.key === "Enter" && A.state === "review")) { e.preventDefault(); next(); }
    else if (e.key === "r" || e.key === "R") { restart(); }
    else if (e.key === "t" || e.key === "T") { $("layout").classList.toggle("no-tour"); }
});
// the desktop's size is the overlay's screen: keep it when the page resizes
window.addEventListener("resize", debounce(() => { /* Electron windows keep their bounds, as on a real screen */ }, 300));
void esc;
void mindInfo;
void setMode;
