// Euterpe's mind, at the reviewer's fingertips: the turns it gets (what it reads, every look and
// every chat), and its answers. A scenario scripts them; otherwise the reviewer answers here, or
// lets the bench answer on its own.
import { net } from "./net.js";
import { el, esc } from "./util.js";

const EXPRESSIONS = ["neutral", "reading", "happy", "laugh", "excited", "love", "proud", "smug", "mischief", "playful", "wink", "thinking", "curious", "idea", "confused", "surprised", "concerned", "sad", "shy", "sleepy", "bored", "determined", "cool"];
const ACTIONS = ["", "wave", "nod", "headshake", "jump", "bounce", "clap", "cheer", "shrug", "facepalm", "peek", "stretch", "yawn", "spin", "dance", "startle"];

const turns = [];
export const mindInfo = { systemPrompt: null, tools: null, procs: new Map() };
let auto = null;
let freePlay = false;   // this run is free play (the scenario let go)
let body = null;

export function mountMind() {
    body = document.getElementById("mind-body");
    render();
}

net.on("mind", (m) => {
    if (m.op === "turn") { turns.unshift({ ...m.turn, waiting: true, at: Date.now() }); turns.length = Math.min(turns.length, 40); }
    else if (m.op === "reply") { const t = turns.find((x) => x.id === m.id); if (t) { t.waiting = false; t.reply = m.reply; } }
    else if (m.op === "auto") { auto = m.on ? { free: !!m.free } : null; if (m.free) { freePlay = true; } }
    else if (m.op === "info") { if (m.tools) { mindInfo.tools = m.tools; mindInfo.builtin = m.builtin; } if (m.toolResult) { turns[0] && (turns[0].tool = m.toolResult); } }
    render();
});
net.on("proc", (m) => {
    if (m.op === "hello" && m.kind === "claude-mind") { mindInfo.systemPrompt = m.systemPrompt; mindInfo.args = m.args; }
});

export function resetMind() { turns.length = 0; auto = null; freePlay = false; mindInfo.systemPrompt = null; mindInfo.tools = null; render(); }

function render() {
    if (!body) { return; }
    const waiting = turns.filter((t) => t.waiting).length;
    const badge = document.getElementById("mind-badge");
    badge.textContent = String(waiting);
    badge.classList.toggle("hidden", !waiting);
    if (waiting) { document.getElementById("mind-panel").open = true; }
    body.innerHTML = "";
    // (in free play, the bench answers Euterpe's looks; chats and the hello wait for you, here)
    const free = freePlay;
    const autoBox = el("label", { class: "small muted", style: { display: "flex", gap: "6px", alignItems: "center", margin: "6px 0" } },
        el("input", { type: "checkbox", checked: !!auto, onchange: (e) => net.host({ type: "mind-auto", reply: e.target.checked ? { expression: "reading", say: null, notes: 0, action: null } : null, ms: 1000, free }) }),
        free ? "Answer Euterpe's looks on my own (silently): you answer its hello and the chat, here" : "Answer turns nobody scripted on my own (silently)");
    body.append(autoBox);
    if (!turns.length) { body.append(el("div", { class: "muted small", text: "No turns yet: the mind gets one when a session starts, at each look, and when you talk to Euterpe." })); }
    for (const t of turns.slice(0, 12)) {
        const what = t.kind === "chat" ? `chat: “${(t.chat || "").slice(0, 80)}”` : t.kind;
        const row = el("div", { class: `turn${t.waiting ? " waiting" : ""}` },
            el("div", {}, el("span", { class: "k", text: t.waiting ? "⏳ " : "✓ " }), el("span", { class: "k", text: what }), el("span", { class: "muted", text: ` · ${t.api}${t.model ? ` · ${t.model}` : ""}${t.effort ? ` · ${t.effort}` : ""}` })));
        const det = el("details", {}, el("summary", { class: "small muted", text: "What the mind reads" }), el("pre", { text: t.text || "" }));
        row.append(det);
        if (t.reply) { row.append(el("div", { class: "small muted", html: `answered: ${esc(JSON.stringify(t.reply).slice(0, 200))}` })); }
        if (t.waiting) { row.append(form(t)); }
        body.append(row);
    }
}

function form(t) {
    const expr = el("select", {}, ...EXPRESSIONS.map((e) => el("option", { value: e, text: e, selected: e === (t.kind === "chat" ? "happy" : "reading") })));
    const act = el("select", {}, ...ACTIONS.map((a) => el("option", { value: a, text: a || "(no gesture)" })));
    const say = el("textarea", { placeholder: "What Euterpe says (empty: it stays silent)" });
    const notes = el("input", { type: "number", min: 0, value: 0, style: { width: "60px" }, title: "Notes it's holding" });
    const send = (reply) => net.host({ type: "mind-reply", id: t.id, reply });
    const why = el("input", { type: "text", placeholder: "Why it fails, as Claude Code or the API says it", value: t.api === "claude" ? "API Error: 529 Overloaded" : "Service unavailable" });
    const f = el("div", { class: "mind-form" },
        el("div", { class: "row" }, expr, act, el("span", { class: "small muted", text: "notes" }), notes),
        say,
        el("div", { class: "row" },
            el("button", { class: "btn primary", text: "Answer", onclick: () => send({ expression: expr.value, say: say.value.trim() || null, notes: +notes.value || 0, action: act.value || null }) }),
            el("button", { class: "btn", text: "Stay silent", onclick: () => send({ expression: expr.value, say: null, notes: +notes.value || 0, action: null }) })),
        el("div", { class: "row" }, why,
            el("button", { class: "btn danger", text: "Fail the turn", onclick: () => { const w = why.value.trim(); if (w) { send(t.api === "claude" ? { error: w } : { error: { status: 503, message: w } }); } } })));
    return f;
}
