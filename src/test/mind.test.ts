import * as assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { buildMindArgs, buildMindEnv, ClaudeMind, describeFailure, isModelFailure, isSignInFailure, mindSettings } from "../claudeMind";
import { parseMindResponse } from "../mind";
import { DocSnapshot, PerceptionWriter, SensorState } from "../perception";

const quiet = () => { /* no log */ };

// ---------- parseMindResponse ----------

test("parses a bare JSON reply", () => {
    const r = parseMindResponse('{"expression":"happy","say":"Nice.","notes":2,"action":"nod"}', quiet);
    assert.deepEqual(r, { expression: "happy", say: "Nice.", notes: 2, action: "nod" });
});

test("silence and missing fields", () => {
    const r = parseMindResponse('{"expression":"reading","say":null,"notes":0}', quiet);
    assert.deepEqual(r, { expression: "reading", say: null, notes: 0, action: null });
    assert.equal(parseMindResponse('{"expression":"happy","say":"   ","notes":1}', quiet).say, null);
});

test("tolerates code fences and prose around the JSON", () => {
    assert.equal(parseMindResponse('```json\n{"expression":"wink","say":"hi","notes":0}\n```', quiet).expression, "wink");
    const r = parseMindResponse('Sure! {"expression":"curious","say":"Why {this}?","notes":1} Hope that helps}', quiet);
    assert.equal(r.expression, "curious");
    assert.equal(r.say, "Why {this}?");
});

test("unknown expression/action values degrade gracefully", () => {
    const r = parseMindResponse('{"expression":"ecstatic","say":"x","notes":-3,"action":"backflip"}', quiet);
    assert.equal(r.expression, "neutral");
    assert.equal(r.action, null);
    assert.equal(r.notes, 0);
});

test("non-JSON text becomes speech rather than being dropped", () => {
    assert.deepEqual(parseMindResponse("Just words, no JSON.", quiet), { expression: "neutral", say: "Just words, no JSON.", notes: 0, action: null });
    assert.equal(parseMindResponse("", quiet).say, null);
    assert.equal(parseMindResponse("[1,2,3]", quiet).say, "[1,2,3]");
});

test("describeFailure explains usage limits and interruptions", () => {
    assert.match(describeFailure({ result: "Claude AI usage limit reached|1790370000", subtype: "success", is_error: true }, false), /usage limit reached — Euterpe will be back around/);
    assert.match(describeFailure({ subtype: "error_during_execution" }, true), /stuck/);
    assert.match(describeFailure({ subtype: "error_max_turns", errors: ["too many"] }, false), /error_max_turns: too many/);
});

// Claude Code's own words, first party and on a cloud provider
const NO_SUCH_MODEL = "There's an issue with the selected model (claude-opus-9). It may not exist or you may not have access to it. Run --model to pick a different model.";
const NOT_DEPLOYED = "The model claude-opus-5-5 is not available on your bedrock deployment. Try switching to claude-opus-5, or ask your admin to enable this model.";

test("a model Claude Code can't run is recognized, and explained with the way out", () => {
    for (const result of [NO_SUCH_MODEL, NOT_DEPLOYED]) {
        const msg = { subtype: "success", is_error: true, result };
        assert.ok(isModelFailure(msg), result);
        assert.ok(!isSignInFailure(msg), result);
        assert.match(describeFailure(msg, false), /^Claude Code can't run Euterpe's mind on claude-opus-(9|5-5): .*Choose Model\.$/);
    }
    assert.ok(!isModelFailure({ subtype: "success", is_error: true, result: "Claude AI usage limit reached|1790370000" }));
});

// ---------- spawn environment ----------

test("the config dir setting pins CLAUDE_CONFIG_DIR; empty inherits it", () => {
    const base = { PATH: "p", CLAUDE_CONFIG_DIR: "C:\\Users\\k\\.claude", ANTHROPIC_BASE_URL: "https://gw" };
    const pinned = buildMindEnv(base, "D:\\claude-personal");
    assert.equal(pinned.CLAUDE_CONFIG_DIR, "D:\\claude-personal");
    assert.equal(pinned.ENABLE_PROMPT_CACHING_1H, "1");
    assert.equal(pinned.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(pinned.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    assert.equal(pinned.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
    assert.equal(buildMindEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" }, "").CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000",
        "the writer's own Claude Code window doesn't carry over");
    assert.equal(pinned.PATH, "p");
    assert.equal(buildMindEnv(base, "").CLAUDE_CONFIG_DIR, "C:\\Users\\k\\.claude");
    assert.equal(buildMindEnv({ PATH: "p" }, "").CLAUDE_CONFIG_DIR, undefined);
    assert.equal(base.CLAUDE_CONFIG_DIR, "C:\\Users\\k\\.claude", "the base environment isn't mutated");
});

test("an editor launched from inside a Claude Code session doesn't hand its markers to the mind", () => {
    const env = buildMindEnv({ PATH: "p", CLAUDECODE: "1", CLAUDE_CODE_SSE_PORT: "5123", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_USE_BEDROCK: "1" }, "");
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1", "the writer's own provider choice stays");
});

test("mindSettings carries over how the writer signs in, and nothing else", () => {
    const empty = { attribution: { commit: "", pr: "" } };
    assert.deepEqual(mindSettings(null), empty);
    assert.deepEqual(mindSettings("not an object"), empty);
    const s = mindSettings({
        apiKeyHelper: "~/bin/get-key.sh",
        awsAuthRefresh: "aws sso login",
        hooks: { Stop: [{ command: "notify" }] },
        permissions: { allow: ["Bash(*)"] },
        model: "opus",
        env: {
            ANTHROPIC_BASE_URL: "https://gateway.example",
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_PROFILE: "work",
            HTTPS_PROXY: "http://proxy:3128",
            NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
            DISABLE_TELEMETRY: "1",
            ANTHROPIC_API_KEY: 42,
        },
    });
    assert.deepEqual(s, {
        attribution: { commit: "", pr: "" },
        apiKeyHelper: "~/bin/get-key.sh",
        awsAuthRefresh: "aws sso login",
        env: {
            ANTHROPIC_BASE_URL: "https://gateway.example",
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_PROFILE: "work",
            HTTPS_PROXY: "http://proxy:3128",
            NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
        },
    });
});

test("a failed sign-in is recognized and explained; other failures aren't mistaken for one", () => {
    const loggedOut = { subtype: "success", is_error: true, result: "Not logged in · Please run /login" };
    assert.ok(isSignInFailure(loggedOut));
    assert.match(describeFailure(loggedOut, false), /couldn't sign in to Claude .*run `claude`/);
    assert.ok(isSignInFailure({ result: "Invalid API key · Fix external API key" }));
    assert.ok(!isSignInFailure({ result: "Claude AI usage limit reached|1790370000" }));
    assert.ok(!isSignInFailure({ subtype: "error_during_execution" }));
});

// ---------- spawn args ----------

test("spawn args isolate the mind from the user's Claude Code setup", () => {
    const args = buildMindArgs({
        sessionId: "S", resume: false, systemPromptFile: "p.md", settingsFile: "C:\\tmp\\settings.json",
        workspaceDir: "E:\\blog", mcpConfigFile: "C:\\tmp\\tools.json", model: "claude-sonnet-5[1m]", effort: "medium",
    });
    assert.equal(args[args.indexOf("--setting-sources") + 1], "local");
    assert.ok(args.includes("--strict-mcp-config"));
    // --safe-mode would drop the extension's own tool server, --restricted would fence the file tools in
    assert.ok(!args.includes("--safe-mode") && !args.includes("--restricted"));
    // a full agent's reach, with no one to answer a prompt
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
    assert.ok(!args.includes("--allowedTools"));
    const tools = args[args.indexOf("--tools") + 1].split(",");
    for (const t of ["Bash", "Read", "Write", "Edit", "WebSearch", "WebFetch"]) { assert.ok(tools.includes(t), t); }
    for (const t of ["Task", "Agent", "Skill", "Monitor", "CronCreate"]) { assert.ok(!tools.includes(t), t); }
    // a file, not inline JSON: it may carry the writer's credentials (see mindSettings)
    assert.equal(args[args.indexOf("--settings") + 1], "C:\\tmp\\settings.json");
    assert.equal(args[args.indexOf("--mcp-config") + 1], "C:\\tmp\\tools.json");
    assert.equal(args[args.indexOf("--add-dir") + 1], "E:\\blog");
    assert.equal(args[args.indexOf("--session-id") + 1], "S");
    assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5[1m]");
    assert.equal(args[args.indexOf("--effort") + 1], "medium");
    const resumed = buildMindArgs({ sessionId: "S", resume: true, systemPromptFile: "p.md", settingsFile: "s.json", workspaceDir: "w", mcpConfigFile: "", model: "", effort: "" });
    assert.equal(resumed[resumed.indexOf("--resume") + 1], "S");
    assert.ok(!resumed.includes("--session-id"));
    assert.ok(!resumed.includes("--model") && !resumed.includes("--effort"));
    assert.ok(!resumed.includes("--mcp-config"));
});

// ---------- the turn queue, against a fake claude process ----------

class FakeClaude extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    turns: string[] = [];
    controls: any[] = [];
    private buf = "";

    constructor(readonly args: string[]) {
        super();
        this.stdin.setEncoding("utf8");
        this.stdin.on("data", (chunk: string) => {
            this.buf += chunk;
            let nl: number;
            while ((nl = this.buf.indexOf("\n")) >= 0) {
                const msg = JSON.parse(this.buf.slice(0, nl));
                this.buf = this.buf.slice(nl + 1);
                if (msg.type === "user") { this.turns.push(msg.message.content[0].text); }
                else { this.controls.push(msg); }
                this.emit("turn");
            }
        });
    }

    compact(): void {
        this.stdout.write(JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 268000, post_tokens: 9000 } }) + "\n");
    }

    reply(result: string, extra: object = {}): void {
        this.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, ...extra }) + "\n");
    }

    /** Answer the last control request, as Claude Code does: success, or an error. */
    answer(error?: string): void {
        const request_id = this.controls.at(-1).request_id;
        this.stdout.write(JSON.stringify({ type: "control_response", response: error ? { subtype: "error", request_id, error } : { subtype: "success", request_id } }) + "\n");
    }

    crash(code = 1): void {
        this.emit("exit", code);
    }

    kill(): boolean {
        this.emit("exit", null);
        return true;
    }
}

const tick = () => new Promise((r) => setImmediate(r));

function harness() {
    const procs: FakeClaude[] = [];
    let lines = ["Hello.", "", "Second paragraph."];
    const writer = new PerceptionWriter({ largeChangeRatio: 1 });
    const snapshot = (): DocSnapshot => ({
        key: "k", name: "post.md", languageId: "markdown", workspace: "W", dirty: false,
        lines, cursor: { line: 0, character: 0 }, selection: null,
    });
    const state = (): SensorState => ({
        now: new Date(), focused: true, unfocusedMs: null, sinceLastEditMs: 1000, sinceLastSaveMs: null,
        activity: Array.from({ length: 12 }, () => ({ added: 0, removed: 0 })),
    });
    let invalidations = 0;
    const events: string[] = [];
    const mind = new ClaudeMind({
        claudePath: "claude", model: "", effort: "", configDir: "", systemPromptFile: "p.md", settingsFile: "s.json", memoryDir: "M", workspaceDir: "W",
        mcpConfigFile: "", log: quiet, debug: false,
        perceive: (reason) => writer.render(reason, snapshot(), state()),
        invalidate: () => { invalidations++; writer.invalidate(); },
        spawnProcess: (_cmd, args) => {
            const p = new FakeClaude(args);
            procs.push(p);
            return p as unknown as ChildProcess;
        },
    });
    for (const e of ["response", "thinking", "turn-error", "restarted", "died", "compacted", "model-refused"]) {
        mind.on(e, (...a: unknown[]) => events.push(`${e}:${a.map(String).join(",")}`));
    }
    return {
        mind, procs, events, writer,
        get invalidations() { return invalidations; },
        edit(newLines: string[]) { lines = newLines; },
    };
}

test("a perception turn: sent lazily, answered, committed", async () => {
    const h = harness();
    h.mind.start();
    const p = h.mind.requestPerception("session_start");
    await tick();
    assert.equal(h.procs.length, 1);
    assert.equal(h.procs[0].turns.length, 1);
    assert.match(h.procs[0].turns[0], /^<euterpe:perception reason="session_start">/);
    assert.ok(!h.writer.hasSeen("k"));
    h.procs[0].reply('{"expression":"happy","say":"Hi!","notes":0,"action":"wave"}');
    const r = await p;
    assert.deepEqual(r, { expression: "happy", say: "Hi!", notes: 0, action: "wave" });
    assert.ok(h.writer.hasSeen("k"), "committed on success");
    h.mind.dispose(true);
});

test("waiting perceptions coalesce; the more significant reason wins", async () => {
    const h = harness();
    h.mind.start();
    void h.mind.requestPerception("session_start");
    await tick();
    const a = h.mind.requestPerception("heartbeat");
    const b = h.mind.requestPerception("doc_switch");
    const c = h.mind.requestPerception("pause");
    h.procs[0].reply('{"expression":"neutral","say":null,"notes":0}');
    await tick();
    assert.equal(h.procs[0].turns.length, 2);
    assert.match(h.procs[0].turns[1], /reason="doc_switch"/);
    h.procs[0].reply('{"expression":"curious","say":null,"notes":0}');
    const results = await Promise.all([a, b, c]);
    assert.ok(results.every((r) => r?.expression === "curious"));
    h.mind.dispose(true);
});

test("a chat supersedes a waiting perception and carries its own fresh view", async () => {
    const h = harness();
    h.mind.start();
    void h.mind.requestPerception("session_start");
    await tick();
    const waiting = h.mind.requestPerception("pause");
    const chat = h.mind.sendChat("Is the title too long?");
    assert.equal(await waiting, null);
    h.procs[0].reply('{"expression":"neutral","say":null,"notes":0}');
    await tick();
    const sent = h.procs[0].turns[1];
    assert.match(sent, /^<euterpe:perception reason="chat">[\s\S]*document: unchanged since your last look\.[\s\S]*<\/euterpe:perception>\n<euterpe:chat>\nIs the title too long\?\n<\/euterpe:chat>$/);
    assert.ok(h.events.includes("thinking:"));
    h.procs[0].reply('{"expression":"thinking","say":"A bit.","notes":0}');
    assert.equal((await chat)?.say, "A bit.");
    h.mind.dispose(true);
});

test("a pause with nothing new to see is skipped; with changes it's a diff", async () => {
    const h = harness();
    h.mind.start();
    void h.mind.requestPerception("session_start");
    await tick();
    h.procs[0].reply('{"expression":"neutral","say":null,"notes":0}');
    await tick();
    assert.equal(await h.mind.requestPerception("pause"), null);
    assert.equal(h.procs[0].turns.length, 1, "no turn spent on an unchanged pause");
    h.edit(["Hello there.", "", "Second paragraph."]);
    const p = h.mind.requestPerception("pause");
    await tick();
    assert.equal(h.procs[0].turns.length, 2);
    assert.match(h.procs[0].turns[1], /<diff>\n@@ -1,3 \+1,3 @@\n-Hello\.\n\+⟨cursor⟩Hello there\.\n \n Second paragraph\.\n<\/diff>/);
    h.procs[0].reply('{"expression":"reading","say":null,"notes":0}');
    assert.equal((await p)?.expression, "reading");
    h.mind.dispose(true);
});

test("after a compaction mid-turn the turn still commits, and the next view is full", async () => {
    const h = harness();
    h.mind.start();
    void h.mind.requestPerception("session_start");
    await tick();
    h.procs[0].reply('{"expression":"neutral","say":null,"notes":0}');
    await tick();
    h.edit(["Hello there.", "", "Second paragraph."]);
    const p = h.mind.requestPerception("pause");
    await tick();
    assert.match(h.procs[0].turns[1], /<diff>/);
    h.procs[0].compact();
    h.procs[0].reply('{"expression":"reading","say":null,"notes":0}');
    assert.equal((await p)?.expression, "reading");
    assert.ok(h.events.includes("compacted:"));
    h.edit(["Hello there, you.", "", "Second paragraph."]);
    void h.mind.requestPerception("pause");
    await tick();
    assert.match(h.procs[0].turns[2], /document \(full text/);
    h.mind.dispose(true);
});

test("a failed turn doesn't commit and forces a full view next time", async () => {
    const h = harness();
    h.mind.start();
    const p = h.mind.requestPerception("session_start");
    await tick();
    h.procs[0].reply("Claude AI usage limit reached|1790370000", { is_error: true });
    assert.equal(await p, null);
    assert.equal(h.invalidations, 1);
    assert.ok(!h.writer.hasSeen("k"));
    assert.ok(h.events.some((e) => e.startsWith("turn-error:Claude usage limit reached")));
    h.mind.dispose(true);
});

test("after a crash it resumes the same conversation (and the next view is full)", async () => {
    const h = harness();
    h.mind.start();
    void h.mind.requestPerception("session_start");
    await tick();
    h.procs[0].reply('{"expression":"neutral","say":null,"notes":0}');
    await tick();
    const chat = h.mind.sendChat("still there?");
    await tick();
    h.procs[0].crash(3);
    assert.equal(await chat, null);
    assert.ok(h.events.includes("restarted:1"));
    assert.ok(h.events.some((e) => e.startsWith("turn-error:Euterpe lost the thread")));
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(h.procs.length, 2);
    const args = h.procs[1].args;
    assert.equal(args[args.indexOf("--resume") + 1], h.mind.sessionId);
    const p = h.mind.requestPerception("pause");
    await tick();
    assert.match(h.procs[1].turns[0], /document \(full text/);
    h.procs[1].reply('{"expression":"happy","say":null,"notes":0}');
    assert.equal((await p)?.expression, "happy");
    h.mind.dispose(true);
});

test("a turn that outlives its interruption has the process restarted, and the conversation resumed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const h = harness();
    h.mind.start();
    void h.mind.requestPerception("session_start");
    await tick();
    h.procs[0].reply('{"expression":"neutral","say":null,"notes":0}');
    await tick();
    const chat = h.mind.sendChat("still there?");
    await tick();
    t.mock.timers.tick(250_000);   // minutes without an answer: the watchdog interrupts the turn
    await tick();
    assert.equal(h.procs[0].controls.at(-1)?.request?.subtype, "interrupt");
    assert.ok(!h.events.includes("restarted:1"));
    t.mock.timers.tick(61_000);    // and no end to it either: the process is taken for hung
    assert.equal(await chat, null);
    assert.ok(h.events.includes("restarted:1"));
    t.mock.timers.tick(1_100);
    assert.equal(h.procs.length, 2);
    const args = h.procs[1].args;
    assert.equal(args[args.indexOf("--resume") + 1], h.mind.sessionId);
    h.mind.dispose(true);
});

test("an interrupted turn that ends in time leaves the process alone", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const h = harness();
    h.mind.start();
    const look = h.mind.requestPerception("session_start");
    await tick();
    t.mock.timers.tick(250_000);
    await tick();
    assert.equal(h.procs[0].controls.at(-1)?.request?.subtype, "interrupt");
    h.procs[0].stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }) + "\n");
    assert.equal(await look, null);
    assert.ok(h.events.some((e) => e.startsWith("turn-error:Euterpe got stuck")));
    t.mock.timers.tick(120_000);
    await tick();
    assert.equal(h.procs.length, 1);
    assert.ok(h.mind.alive);
    h.mind.dispose(true);
});

test("a process that dies before ever answering is reported, not retried", async () => {
    const h = harness();
    h.mind.start();
    const p = h.mind.requestPerception("session_start");
    await tick();
    h.procs[0].stderr.write("Error: invalid model\n");
    await tick();
    h.procs[0].crash(1);
    assert.equal(await p, null);
    assert.equal(h.procs.length, 1);
    const died = h.events.find((e) => e.startsWith("died:"));
    assert.ok(died && /before answering/.test(died) && /invalid model/.test(died), died);
    assert.equal(h.mind.alive, false);
    assert.equal(await h.mind.sendChat("hello?"), null);
});

// ---------- switching models mid-session ----------

const QUIET = '{"expression":"neutral","say":null,"notes":0}';

/** A mind that has greeted the writer: its first turn done. */
async function greeted() {
    const h = harness();
    h.mind.start();
    void h.mind.requestPerception("session_start");
    await tick();
    h.procs[0].reply(QUIET);
    await tick();
    return h;
}

test("a model switch reaches the running mind before its next turn, and a restart resumes on it", async () => {
    const h = await greeted();
    const switched = h.mind.setModel("claude-sonnet-5-5");
    const chat = h.mind.sendChat("Quicker now?");
    await tick();
    assert.deepEqual(h.procs[0].controls.at(-1).request, { subtype: "set_model", model: "claude-sonnet-5-5" });
    assert.equal(h.procs[0].turns.length, 1, "the chat waits until Claude Code has switched");
    h.procs[0].answer();
    assert.equal(await switched, null);
    await tick();
    assert.equal(h.procs[0].turns.length, 2);
    assert.equal(h.mind.model, "claude-sonnet-5-5");
    h.procs[0].reply('{"expression":"happy","say":"Much.","notes":0}');
    assert.equal((await chat)?.say, "Much.");

    h.procs[0].crash(3);
    await new Promise((r) => setTimeout(r, 1100));
    const args = h.procs[1].args;
    assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5-5");
    // back to Claude Code's default: a switch that names no model
    const reset = h.mind.setModel("");
    await tick();
    assert.deepEqual(h.procs[1].controls.at(-1).request, { subtype: "set_model" });
    h.procs[1].answer();
    assert.equal(await reset, null);
    assert.equal(h.mind.model, "");
    h.mind.dispose(true);
});

test("a model Claude Code refuses leaves the mind on the one it had", async () => {
    const h = await greeted();
    const switched = h.mind.setModel("claude-opus-9");
    await tick();
    h.procs[0].answer("Model 'claude-opus-9' not found");
    assert.equal(await switched, "Model 'claude-opus-9' not found");
    assert.equal(h.mind.model, "");
    // and turns go on
    const chat = h.mind.sendChat("Still there?");
    await tick();
    assert.equal(h.procs[0].turns.length, 2);
    h.procs[0].reply(QUIET);
    assert.ok(await chat);
    h.mind.dispose(true);
});

test("a picked model that can't run a turn: back to the one before, and the turn again", async () => {
    const h = await greeted();
    const switched = h.mind.setModel("claude-opus-9");
    await tick();
    h.procs[0].answer();
    await switched;
    const chat = h.mind.sendChat("Hello?");
    await tick();
    h.procs[0].reply(NO_SUCH_MODEL, { is_error: true });
    await tick();
    assert.ok(h.events.includes("model-refused:claude-opus-9,"), h.events.join(" | "));
    assert.ok(!h.events.some((e) => e.startsWith("turn-error") || e.startsWith("died")), h.events.join(" | "));
    assert.deepEqual(h.procs[0].controls.at(-1).request, { subtype: "set_model" });
    assert.equal(h.mind.model, "");
    assert.equal(h.procs[0].turns.length, 2, "the retry waits for the switch back");
    h.procs[0].answer();
    await tick();
    assert.equal(h.procs[0].turns.length, 3);
    assert.match(h.procs[0].turns[2], /document \(full text[\s\S]*<euterpe:chat>\nHello\?\n<\/euterpe:chat>$/);
    h.procs[0].reply('{"expression":"happy","say":"Hi!","notes":0}');
    assert.equal((await chat)?.say, "Hi!");
    h.mind.dispose(true);
});

test("a model that can't run from the start ends the session, saying why", async () => {
    const h = harness();
    h.mind.start();
    const p = h.mind.requestPerception("session_start");
    await tick();
    h.procs[0].reply(NO_SUCH_MODEL, { is_error: true });
    assert.equal(await p, null);
    const died = h.events.find((e) => e.startsWith("died:"));
    assert.ok(died && /can't run Euterpe's mind on claude-opus-9/.test(died), died);
    assert.equal(h.mind.alive, false);
});
