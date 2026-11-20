// A stand-in for Claude Code, as Euterpe runs it: `claude --version`, `claude auth status`, and the
// mind (`claude -p --input-format stream-json --output-format stream-json …`). The mind speaks
// Claude Code's stream-json; each turn's answer comes from the bench (the scenario, or the reviewer
// at the mind's controls), and the tools it calls are the extension's own, over its MCP server.
// How this "installation" behaves is in the note that stands in for the executable (BENCH_EXE).
"use strict";

const fs = require("fs");
const readline = require("readline");

const note = (() => { try { return JSON.parse(fs.readFileSync(process.env.BENCH_EXE, "utf8")); } catch { return {}; } })();
const args = process.argv.slice(2);

if (args[0] === "--version") {
    if (note.notClaude) { process.stdout.write("1.4.2\n"); process.exit(0); }
    process.stdout.write(`${note.version || "2.1.283"} (Claude Code)\n`);
    process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
    if (note.noAuthAnswer) { process.stdout.write("error: unknown command 'auth'\n"); process.exit(1); }
    const a = note.auth || { loggedIn: false };
    const out = a.loggedIn
        ? { loggedIn: true, authMethod: a.authMethod || "claude.ai", apiProvider: a.apiProvider || "firstParty", ...(a.subscriptionType ? { subscriptionType: a.subscriptionType } : {}), ...(a.email ? { email: a.email } : {}) }
        : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exit(a.loggedIn ? 0 : 1);
}
if (!args.includes("-p") && !args.includes("--print")) {
    process.stderr.write("The bench's Claude Code only plays --version, auth status and -p.\n");
    process.exit(2);
}

// ---------- the mind ----------
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sessionId = arg("--session-id") || arg("--resume") || "00000000-0000-0000-0000-000000000000";
const RESOLVED = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-1" };
const resolve = (m) => (m ? RESOLVED[m.toLowerCase().replace(/\[1m\]$/, "")] || m : "claude-sonnet-5-5");
let model = resolve(arg("--model"));
const read = (f) => { try { return f ? fs.readFileSync(f, "utf8") : null; } catch { return null; } };
const mcp = (() => { try { return JSON.parse(read(arg("--mcp-config"))); } catch { return null; } })();

const ws = new WebSocket(`ws://127.0.0.1:${process.env.BENCH_PORT}/ws?role=proc&run=${encodeURIComponent(process.env.BENCH_RUN)}&kind=claude`);
const outbox = [];
let open = false;
function send(msg) { const line = JSON.stringify({ to: "host", run: process.env.BENCH_RUN, msg }); if (open) { ws.send(line); } else { outbox.push(line); } }
ws.addEventListener("open", () => { open = true; for (const l of outbox.splice(0)) { ws.send(l); } });
ws.addEventListener("close", () => process.exit(0));
ws.addEventListener("error", () => { });

const waiting = new Map();
ws.addEventListener("message", (e) => {
    let env;
    try { env = JSON.parse(String(e.data)); } catch { return; }
    const m = env.msg || {};
    if (m.type === "reply" || m.type === "control") { const w = waiting.get(m.turnId || m.reqId); if (w) { waiting.delete(m.turnId || m.reqId); w(m); } }
    if (m.type === "exit") { process.exit(m.code ?? 0); }
});
const ask = (id, msg) => new Promise((r) => { waiting.set(id, r); send(msg); });

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

const tools = (arg("--tools") || "").split(",").filter(Boolean);
send({
    type: "proc-hello", kind: "claude-mind", pid: process.pid, args, cwd: process.cwd(), model,
    systemPrompt: read(arg("--system-prompt-file")), settings: read(arg("--settings")), mcp,
    env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null, CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, ENABLE_PROMPT_CACHING_1H: process.env.ENABLE_PROMPT_CACHING_1H },
});

async function mcpCall(method, params) {
    const server = mcp?.mcpServers && Object.values(mcp.mcpServers)[0];
    if (!server) { return { error: "no MCP server" }; }
    const res = await fetch(server.url, {
        method: "POST",
        headers: { ...(server.headers || {}), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    return res.json();
}

// What the mind's tools are, as Claude Code would list them (for the bench's view of what Euterpe is given).
setTimeout(async () => {
    try {
        const listed = await mcpCall("tools/list", {});
        send({ type: "mind-info", tools: listed?.result?.tools || [], builtin: tools });
    } catch { /* no tools to show */ }
}, 300);

const mcpTools = (mcp?.mcpServers ? Object.keys(mcp.mcpServers) : []).flatMap((s) => ["propose_edit", "preview_mascot", "offer_mascot"].map((t) => `mcp__${s}__${t}`));
emit({
    type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: [...tools, ...mcpTools],
    mcp_servers: (mcp?.mcpServers ? Object.keys(mcp.mcpServers) : []).map((name) => ({ name, status: note.mcpStatus || "connected" })),
    model, permissionMode: note.permissionMode || "bypassPermissions", apiKeySource: note.apiKeySource || "none",
    claude_code_version: note.version || "2.1.283", output_style: "default", agents: [], skills: [], plugins: [],
});

let turnSeq = 0, inflight = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(text) {
    const turnId = `t${++turnSeq}-${process.pid}`;
    const started = Date.now();
    const mine = { turnId, interrupted: false };
    inflight = mine;
    const { reply = {} } = await ask(turnId, { type: "mind-turn", turnId, text, model });
    if (inflight !== mine) { return; }   // interrupted meanwhile
    for (const l of [].concat(reply.stderr || [])) { process.stderr.write(`${l}\n`); }
    if (reply.crash !== undefined) { await sleep(50); process.exit(reply.crash); }
    if (reply.delay) { await sleep(reply.delay); }
    if (inflight !== mine) { return; }
    for (const t of reply.tools || []) {
        const id = `toolu_${Math.random().toString(36).slice(2, 12)}`;
        emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", model, content: [{ type: "tool_use", id, name: `mcp__euterpe__${t.name}`, input: t.args || {} }] } });
        let content = "", isError = false;
        try {
            const r = await mcpCall("tools/call", { name: t.name, arguments: t.args || {} });
            content = (r?.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n") || JSON.stringify(r?.error || r);
            isError = !!r?.result?.isError || !!r?.error;
        } catch (err) { content = String(err.message); isError = true; }
        emit({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
        send({ type: "mind-info", toolResult: { name: t.name, args: t.args, content, isError } });
    }
    if (reply.compact) { emit({ type: "system", subtype: "compact_boundary", session_id: sessionId, compact_metadata: { trigger: "auto", pre_tokens: 268000, post_tokens: 14200 } }); }
    if (reply.rateLimit) { emit({ type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: reply.rateLimit, resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: "five_hour" } }); }
    const duration_ms = Date.now() - started;
    const usage = { input_tokens: 9, cache_creation_input_tokens: 412, cache_read_input_tokens: 21480, output_tokens: 58 };
    if (reply.error !== undefined) {
        emit({ type: "result", subtype: "success", is_error: true, result: reply.error, duration_ms, duration_api_ms: duration_ms, num_turns: 1, session_id: sessionId, total_cost_usd: 0, usage });
        return;
    }
    if (reply.fail) {
        emit({ type: "result", subtype: reply.fail.subtype || "error_during_execution", is_error: true, errors: reply.fail.errors, duration_ms, num_turns: 1, session_id: sessionId, usage });
        return;
    }
    const out = reply.raw !== undefined ? reply.raw : JSON.stringify({ expression: reply.expression || "neutral", say: reply.say ?? null, notes: reply.notes ?? 0, action: reply.action ?? null });
    emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", model, content: [{ type: "text", text: out }] } });
    emit({ type: "result", subtype: "success", is_error: false, result: out, duration_ms, duration_api_ms: duration_ms - 40, num_turns: 1, session_id: sessionId, total_cost_usd: 0.0123, usage });
}

const queue = [];
let busy = false;
async function pump() {
    if (busy) { return; }
    busy = true;
    while (queue.length) {
        const job = queue.shift();
        try { await job(); } catch (err) { process.stderr.write(`bench claude: ${err.stack || err}\n`); }
    }
    busy = false;
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "user") {
        const text = (msg.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        queue.push(() => turn(text));
        void pump();
    } else if (msg.type === "control_request") {
        const r = msg.request || {};
        if (r.subtype === "interrupt") {
            const was = inflight;
            inflight = null;
            if (was) { emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request was aborted."], duration_ms: 0, session_id: sessionId }); }
            emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
        } else if (r.subtype === "set_model") {
            void ask(msg.request_id, { type: "mind-control", reqId: msg.request_id, subtype: "set_model", model: r.model }).then((answer) => {
                if (answer.error) {
                    emit({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: answer.error } });
                } else {
                    model = resolve(r.model);
                    emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
                    emit({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools, mcp_servers: [], model, permissionMode: note.permissionMode || "bypassPermissions", apiKeySource: note.apiKeySource || "none" });
                }
            });
        } else {
            emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
        }
    }
}).on("close", () => setTimeout(() => process.exit(0), 100));
