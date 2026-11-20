import * as assert from "node:assert/strict";
import { test } from "node:test";
import { APIError } from "openai";
import { McpTool } from "../mcpServer";
import { SignInNeeded } from "../chatgpt";
import { betterEffort, describeApiFailure, finalResponse, ModelApi, OpenAIMind, PlanAuth, REPLY_SCHEMA } from "../openaiMind";
import { DocSnapshot, PerceptionWriter, SensorState } from "../perception";
import { ACTIONS, EXPRESSIONS } from "../protocol";

const quiet = () => { /* no log */ };
const tick = () => new Promise((r) => setImmediate(r));
const QUIET = '{"expression":"neutral","say":null,"notes":0,"action":null}';

/** An API error as the SDK makes it from a response. */
const apiError = (status: number, error: object | string) => APIError.generate(status, { error }, undefined, new Headers());

type Handler = (body: any) => any;

/**
 * A client that answers from a script, one handler per request, and keeps what it was sent. A
 * streamed request gets the answer as the events that carry it (or `{ events }`, as they are).
 */
class FakeApi implements ModelApi {
    readonly bodies: any[] = [];
    readonly headers: (Record<string, string> | undefined)[] = [];
    private readonly script: Handler[] = [];
    private waiting: ((h: Handler) => void) | null = null;

    readonly responses = {
        create: async (body: any, o?: { signal?: AbortSignal; headers?: Record<string, string> }) => {
            this.headers.push(o?.headers);
            const res = await this.next(body, o?.signal);
            if (!body.stream) { return res; }
            const events = res?.events ?? [{ type: "response.created" }, { type: "response.output_text.delta", delta: "…" }, { type: "response.completed", response: res }];
            return (async function* () { yield* events; })();
        },
    };
    readonly chat = { completions: { create: (body: any, o?: { signal?: AbortSignal }) => this.next(body, o?.signal) } };

    /** The next answer: a value, or a function of the request (which may throw). */
    then(h: Handler | object): this {
        const handler = typeof h === "function" ? h as Handler : () => h;
        if (this.waiting) { const w = this.waiting; this.waiting = null; w(handler); } else { this.script.push(handler); }
        return this;
    }

    private async next(body: any, signal?: AbortSignal): Promise<any> {
        this.bodies.push(JSON.parse(JSON.stringify(body)));
        const h = this.script.shift() ?? await new Promise<Handler>((resolve, reject) => {
            this.waiting = resolve;
            signal?.addEventListener("abort", () => reject(new (require("openai").APIUserAbortError)()));
        });
        return h(body);
    }
}

// Answers in each dialect.
const respText = (text: string, usage = { input_tokens: 1000, output_tokens: 20 }) =>
    ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage });
const respCall = (name: string, args: object, id = "c1") =>
    ({ status: "completed", output: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" }, { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 900, output_tokens: 30 } });
const chatText = (text: string, prompt_tokens = 1000) => ({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens, completion_tokens: 20 } });
const chatCall = (name: string, args: object, id = "t1") =>
    ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 900, completion_tokens: 30 } });

function harness(o: { api?: "responses" | "chat"; openai?: boolean; tools?: McpTool[]; model?: string; effort?: string; compactWindow?: number; webSearch?: boolean; chatgpt?: PlanAuth; log?: (m: string) => void } = {}) {
    const api = new FakeApi();
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
    const events: string[] = [];
    const calls: string[] = [];
    const tools: McpTool[] = o.tools ?? [{
        name: "read_file", description: "Read a file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        call: async (args) => { calls.push(`read_file ${args.path}`); return { text: "the file's text" }; },
    }];
    const mind = new OpenAIMind({
        baseURL: "https://api.example/v1", apiKey: "k", model: o.model ?? "gpt-test", effort: o.effort ?? "",
        api: o.api ?? "responses", instructions: "You are Euterpe.", tools, webSearch: o.webSearch ?? false, openaiExtras: o.openai ?? true,
        compactWindow: o.compactWindow ?? 1_000_000, debug: false, log: o.log ?? quiet, client: api, chatgpt: o.chatgpt,
        perceive: (reason) => writer.render(reason, snapshot(), state()),
        invalidate: () => writer.invalidate(),
    });
    for (const e of ["response", "thinking", "turn-error", "died", "signed-out", "compacted", "model-refused"]) {
        mind.on(e, (...a: unknown[]) => events.push(`${e}:${a.map(String).join(",")}`));
    }
    return { mind, api, events, calls, writer, edit(newLines: string[]) { lines = newLines; } };
}

/** Until `cond` holds (a few event-loop turns at most). */
async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !cond(); i++) { await tick(); }
    assert.ok(cond());
}

test("a turn on the Responses API: tools run until the answer, and the request is OpenAI's stateless kind", async () => {
    const h = harness({ webSearch: true, effort: "low" });
    h.mind.start();
    h.api.then(respCall("read_file", { path: "notes.md" })).then(respText('{"expression":"happy","say":"Hi!","notes":0,"action":"wave"}'));
    const r = await h.mind.requestPerception("session_start");
    assert.deepEqual(r, { expression: "happy", say: "Hi!", notes: 0, action: "wave" });
    assert.deepEqual(h.calls, ["read_file notes.md"]);
    const [first, second] = h.api.bodies;
    assert.equal(first.instructions, "You are Euterpe.");
    assert.equal(first.store, false);
    assert.deepEqual(first.include, ["reasoning.encrypted_content"]);
    assert.equal(first.prompt_cache_key, h.mind.sessionId);
    assert.deepEqual(first.reasoning, { effort: "low" });
    assert.deepEqual(first.text.format, { type: "json_schema", name: "euterpe_reply", strict: true, schema: REPLY_SCHEMA });
    assert.deepEqual(first.tools.map((t: any) => t.type === "function" ? t.name : t.type), ["read_file", "web_search"]);
    assert.ok(first.tools.every((t: any) => t.type !== "function" || t.strict === false));
    assert.match(first.input[0].content[0].text, /^<euterpe:perception reason="session_start">/);
    // the second call carries the reasoning (encrypted), the call and its output
    assert.deepEqual(second.input.slice(1).map((i: any) => i.type), ["reasoning", "function_call", "function_call_output"]);
    assert.equal(second.input[2].call_id, "c1");
    assert.equal(second.input[3].output, "the file's text");
    h.mind.dispose(true);
});

test("on a ChatGPT plan: streamed, with the sign-in's headers, and a refused token renewed once", async () => {
    const asked: boolean[] = [];
    const plan: PlanAuth = { headers: async (force = false) => { asked.push(force); return { Authorization: force ? "Bearer new" : "Bearer old", "ChatGPT-Account-ID": "acc-1" }; } };
    const logged: string[] = [];
    const h = harness({ chatgpt: plan, webSearch: true, log: (m) => logged.push(m) });
    h.mind.start();
    h.api.then(() => { throw apiError(401, { message: "Token expired", type: "invalid_request_error" }); })
        .then(respText('{"expression":"happy","say":"Hi!","notes":0,"action":null}'));
    const r = await h.mind.requestPerception("session_start");
    assert.equal(r?.say, "Hi!");
    assert.deepEqual(asked, [false, true]);
    assert.deepEqual(h.api.headers.map((x) => x?.Authorization), ["Bearer old", "Bearer new"]);
    assert.ok(h.api.bodies.every((b) => b.stream === true && b.store === false));
    assert.ok(logged.some((l) => /refused the sign-in's token: renewing it/.test(l)));
    assert.ok(logged.some((l) => /on your ChatGPT plan/.test(l)));
    h.mind.dispose(true);
});

test("on a plan, a token refused even renewed holds the turns until the writer signs in again", async () => {
    let token = "x";
    const plan: PlanAuth = { headers: async () => ({ Authorization: `Bearer ${token}` }) };
    const h = harness({ chatgpt: plan });
    h.mind.start();
    h.api.then(() => { throw apiError(401, { message: "Nope" }); }).then(() => { throw apiError(401, { message: "Still nope" }); });
    const look = h.mind.requestPerception("session_start");
    await until(() => h.mind.waitingForSignIn);
    assert.ok(h.events.some((e) => /^signed-out:ChatGPT refused Euterpe's sign-in \(.*Still nope/.test(e)), h.events.join("\n"));
    assert.ok(!h.events.some((e) => e.startsWith("died") || e.startsWith("turn-error")), h.events.join("\n"));
    // what the writer says waits too, and carries a fresher view than the look that waited
    const chat = h.mind.sendChat("Still there?");
    assert.equal(await look, null);
    await tick();
    assert.equal(h.api.bodies.length, 2, "nothing goes out while the sign-in is missing");
    token = "y";
    h.api.then(respText('{"expression":"happy","say":"Back!","notes":0,"action":null}'));
    h.mind.resume();
    assert.equal((await chat)?.say, "Back!");
    assert.equal(h.api.headers.at(-1)?.Authorization, "Bearer y");
    assert.equal(h.mind.waitingForSignIn, false);
    h.mind.dispose(true);
});

test("on a plan, a sign-in that ended holds the look; signed in again, the look that waited goes, in full", async () => {
    let ended = true;
    const plan: PlanAuth = {
        headers: async () => {
            if (ended) { throw new SignInNeeded("Euterpe's ChatGPT sign-in has ended: OpenAI didn't renew it."); }
            return { Authorization: "Bearer fresh" };
        },
    };
    const h = harness({ chatgpt: plan });
    h.mind.start();
    const look = h.mind.requestPerception("session_start");
    await until(() => h.mind.waitingForSignIn);
    assert.ok(h.events.includes("signed-out:Euterpe's ChatGPT sign-in has ended: OpenAI didn't renew it."), h.events.join("\n"));
    assert.equal(h.api.bodies.length, 0);
    // a later look joins the one that waits
    const another = h.mind.requestPerception("pause");
    ended = false;
    h.api.then(respText('{"expression":"happy","say":"Hi again!","notes":0,"action":null}'));
    h.mind.resume();
    const [a, b] = await Promise.all([look, another]);
    assert.deepEqual([a?.say, b?.say], ["Hi again!", "Hi again!"]);
    assert.equal(h.api.bodies.length, 1);
    assert.match(h.api.bodies[0].input[0].content[0].text, /^<euterpe:perception reason="session_start">[\s\S]*document \(full text/);
    // held again, then the session ends: what waited is let go
    ended = true;
    h.edit(["Hello, again.", "", "Second paragraph."]);
    const waiting = h.mind.requestPerception("pause");
    await until(() => h.mind.waitingForSignIn);
    h.mind.dispose(true);
    assert.equal(await waiting, null);
    assert.equal(h.mind.waitingForSignIn, false);
});

test("a stream's last word is the response; a failure in it is the API's error", async () => {
    const res = respText("ok");
    const stream = (events: any[]) => (async function* () { yield* events; })();
    assert.deepEqual(await finalResponse(stream([{ type: "response.created" }, { type: "response.completed", response: res }])), res);
    assert.deepEqual(await finalResponse(stream([{ type: "response.incomplete", response: { ...res, status: "incomplete" } }])), { ...res, status: "incomplete" });
    await assert.rejects(finalResponse(stream([{ type: "response.created" }])), /cut off/);
    const failed = await finalResponse(stream([{ type: "response.failed", response: { error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } } }])).catch((e) => e);
    assert.ok(failed instanceof APIError);
    assert.equal(failed.status, 400);
    assert.ok(describeApiFailure(failed, "ChatGPT", "gpt-5.6-sol", true).overflow);
    // the SDK's own error for an error event comes with no status: it gets one
    const sdk = await finalResponse((async function* () { yield { type: "response.created" }; throw new APIError(undefined, { code: "server_error", message: "Overloaded" }, undefined, undefined); })()).catch((e) => e);
    assert.equal(sdk.status, 500);
    assert.match(describeApiFailure(sdk, "ChatGPT", "m", true).why, /ChatGPT had trouble answering \(500\): Overloaded/);
});

test("a plan's errors, in words: its limits (and where to manage them), who can't use it, and what to do", () => {
    const limit = describeApiFailure(apiError(429, { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit exceeded" }), "ChatGPT", "gpt-6.1-sol", true);
    assert.equal(limit.failure, "other");
    assert.ok(limit.limit);
    assert.match(limit.why, /usage limit on your ChatGPT plan: your plan's own, or the one you set for Euterpe\. Manage it in ChatGPT's settings \(chatgpt\.com\/settings\/usage\)/);
    // the preview's spelling, too
    assert.ok(describeApiFailure(apiError(429, { code: "subscription_sharing_v2_usage_limit_exceeded", message: "x" }), "ChatGPT", "m", true).limit);
    const ineligible = describeApiFailure(apiError(403, { code: "subscription_sharing_user_not_eligible", message: "x" }), "ChatGPT", "m", true);
    assert.equal(ineligible.failure, "sign-in", "every turn would fail");
    assert.match(ineligible.why, /Plus and Pro.*API key/);
    assert.match(describeApiFailure(apiError(503, { code: "subscription_sharing_usage_unavailable", message: "x" }), "ChatGPT", "m", true).why, /tries again at its next look/);
    assert.equal(describeApiFailure(apiError(403, { code: "chatpass_v2_scope_not_authorized", message: "x" }), "ChatGPT", "m", true).failure, "sign-in");
    // a sign-in that ended, or a token refused, waits for the writer to sign in again; a key refused ends the session
    assert.deepEqual(describeApiFailure(new SignInNeeded("Sign in again."), "ChatGPT", "m", true), { failure: "signed-out", why: "Sign in again." });
    assert.equal(describeApiFailure(apiError(401, { message: "Token expired" }), "ChatGPT", "m", true).failure, "signed-out");
    assert.equal(describeApiFailure(apiError(401, { message: "Bad key" }), "api.openai.com", "m").failure, "sign-in");
    // with a key, a 429 about quota is an account out of credit
    assert.match(describeApiFailure(apiError(429, { type: "insufficient_quota", message: "quota" }), "api.openai.com", "m").why, /out of credit/);
});

test("on a plan, a usage limit in the stream reaches the session (once per turn), and a refused capability is dropped", async () => {
    const plan: PlanAuth = { headers: async () => ({ Authorization: "Bearer x" }) };
    const h = harness({ chatgpt: plan, webSearch: true });
    const limits: string[] = [];
    h.mind.on("plan-limit", (why: string) => limits.push(why));
    h.mind.start();
    h.api.then({ events: [{ type: "response.created" }, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit" } } }] });
    assert.equal(await h.mind.requestPerception("session_start"), null);
    assert.equal(limits.length, 1);
    assert.ok(h.events.some((e) => /^turn-error:You've reached a usage limit/.test(e)), h.events.join("\n"));
    // web search refused on this account: the next turn goes without it
    h.api.then(() => { throw apiError(400, { code: "subscription_sharing_unsupported_capability", param: "tools[1]", message: "web_search is not available for this account" }); })
        .then(respText(QUIET));
    assert.ok(await h.mind.requestPerception("pause"));
    const [refused, again] = h.api.bodies.slice(-2);
    assert.ok(refused.tools.some((t: any) => t.type === "web_search"));
    assert.ok(!again.tools.some((t: any) => t.type === "web_search"));
    h.mind.dispose(true);
});

test("the reply schema names every expression and action", () => {
    assert.deepEqual(REPLY_SCHEMA.properties.expression.enum, [...EXPRESSIONS]);
    assert.deepEqual(REPLY_SCHEMA.properties.action.anyOf[0].enum, [...ACTIONS]);
});

test("Chat Completions for another provider: a system message, tool messages, and pictures after them", async () => {
    const picture: McpTool = {
        name: "preview_mascot", description: "Look.", inputSchema: { type: "object", properties: {} },
        call: async () => ({ text: "Owl, as the writer would see it.", images: [{ data: "AAAA", mimeType: "image/png" }] }),
    };
    const h = harness({ api: "chat", openai: false, tools: [picture], effort: "medium" });
    h.mind.start();
    h.api.then(chatCall("preview_mascot", {})).then(chatText("Sure! " + QUIET));
    const r = await h.mind.requestPerception("session_start");
    assert.equal(r?.expression, "neutral");
    const [first, second] = h.api.bodies;
    assert.equal(first.messages[0].role, "system");
    assert.equal(first.reasoning_effort, "medium");
    for (const k of ["prompt_cache_key", "response_format", "store", "include"]) { assert.ok(!(k in first), k); }
    assert.deepEqual(first.tools[0], { type: "function", function: { name: "preview_mascot", description: "Look.", parameters: { type: "object", properties: {} } } });
    const tail = second.messages.slice(-3);
    assert.equal(tail[0].tool_calls[0].function.name, "preview_mascot");
    assert.deepEqual(tail[1], { role: "tool", tool_call_id: "t1", content: "Owl, as the writer would see it." });
    assert.equal(tail[2].role, "user");
    assert.deepEqual(tail[2].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
    h.mind.dispose(true);
});

test("a parameter the provider refuses is dropped, and the call made again", async () => {
    const h = harness({ api: "chat", openai: false, effort: "low" });
    h.mind.start();
    h.api.then(() => { throw apiError(400, { message: "Unrecognized request argument supplied: reasoning_effort", param: "reasoning_effort" }); })
        .then(chatText(QUIET));
    assert.ok(await h.mind.requestPerception("session_start"));
    assert.equal(h.api.bodies[0].reasoning_effort, "low");
    assert.ok(!("reasoning_effort" in h.api.bodies[1]));
    // and it stays dropped
    h.edit(["Hello there.", "", "Second paragraph."]);
    h.api.then(chatText(QUIET));
    await h.mind.requestPerception("pause");
    assert.ok(!("reasoning_effort" in h.api.bodies[2]));
    h.mind.dispose(true);
});

test("an effort the model doesn't take moves to the nearest one it does", async () => {
    assert.equal(betterEffort({ param: "reasoning.effort", message: "Unsupported value: 'max' is not supported with this model. Supported values are: 'low', 'medium', and 'high'." }, "max"), "high");
    assert.equal(betterEffort({ message: "Unsupported value: 'reasoning.effort' does not support 'minimal'. Supported values are: 'low' and 'high'." }, "minimal"), "low");
    assert.equal(betterEffort({ message: "reasoning_effort is not supported for this model" }, "low"), "");
    assert.equal(betterEffort({ message: "Unsupported parameter: 'temperature'" }, "low"), undefined);
    const h = harness({ effort: "max" });
    h.mind.start();
    h.api.then(() => { throw apiError(400, { message: "Unsupported value: 'max' is not supported with this model. Supported values are: 'low', 'medium', 'high' and 'xhigh'.", param: "reasoning.effort" }); })
        .then(respText(QUIET));
    assert.ok(await h.mind.requestPerception("session_start"));
    assert.deepEqual(h.api.bodies[1].reasoning, { effort: "xhigh" });
    h.mind.dispose(true);
});

test("a refused key ends the session, saying where to set it", async () => {
    const h = harness();
    h.mind.start();
    h.api.then(() => { throw apiError(401, { message: "Incorrect API key provided: sk-…abcd.", code: "invalid_api_key" }); });
    assert.equal(await h.mind.requestPerception("session_start"), null);
    const died = h.events.find((e) => e.startsWith("died:"));
    assert.ok(died && /api\.example refused Euterpe's API key .*Set the key again/.test(died), died);
    assert.equal(h.mind.alive, false);
});

test("a first turn the API refuses for good (a wrong address) ends the session", async () => {
    const h = harness({ api: "chat", openai: false });
    h.mind.start();
    h.api.then(() => { throw apiError(404, "404 page not found"); });
    assert.equal(await h.mind.requestPerception("session_start"), null);
    const died = h.events.find((e) => e.startsWith("died:"));
    assert.ok(died && /has no API there/.test(died), died);
});

test("a picked model the API doesn't know: back to the one before, and the turn again", async () => {
    const h = harness({ model: "gpt-good" });
    h.mind.start();
    h.api.then(respText(QUIET));
    await h.mind.requestPerception("session_start");
    assert.equal(await h.mind.setModel("gpt-nope"), null);
    h.api.then(() => { throw apiError(404, { message: "The model `gpt-nope` does not exist or you do not have access to it.", code: "model_not_found" }); })
        .then(respText('{"expression":"happy","say":"Here.","notes":0,"action":null}'));
    const chat = await h.mind.sendChat("Still there?");
    assert.equal(chat?.say, "Here.");
    assert.ok(h.events.includes("model-refused:gpt-nope,gpt-good"), h.events.join(" | "));
    assert.deepEqual(h.api.bodies.slice(1).map((b) => b.model), ["gpt-nope", "gpt-good"]);
    assert.match(h.api.bodies[2].input.at(-1).content[0].text, /document \(full text[\s\S]*<euterpe:chat>\nStill there\?\n<\/euterpe:chat>$/);
    assert.equal(h.mind.model, "gpt-good");
    h.mind.dispose(true);
});

test("a long conversation is summarized after the turn; the next opens with the summary and the whole document", async () => {
    const h = harness({ compactWindow: 5000 });
    h.mind.start();
    h.api.then(respText(QUIET, { input_tokens: 6000, output_tokens: 10 }));
    await h.mind.requestPerception("session_start");
    // the summary is asked for on the conversation as it is, and answered in prose
    h.api.then((body) => {
        assert.equal(body.tool_choice, "none");
        assert.ok(!body.text, "no JSON for the summary");
        assert.match(body.input.at(-1).content[0].text, /summarized/);
        return respText("We talked about the heap.");
    });
    await tick(); await tick();
    assert.ok(h.events.includes("compacted:"));
    h.api.then(respText(QUIET));
    await h.mind.requestPerception("pause");
    const last = h.api.bodies.at(-1);
    assert.equal(last.input.length, 1, "the conversation starts over");
    assert.match(last.input[0].content[0].text, /^\[Your conversation so far was summarized[\s\S]*We talked about the heap\.[\s\S]*<euterpe:perception reason="pause">[\s\S]*document \(full text/);
    h.mind.dispose(true);
});

test("a turn too long for the model: the conversation is summarized, and the turn sent again in full", async () => {
    const h = harness();
    h.mind.start();
    h.api.then(respText(QUIET));
    await h.mind.requestPerception("session_start");
    h.edit(["Hello there.", "", "Second paragraph."]);
    h.api.then(() => { throw apiError(400, { message: "This model's maximum context length is 128000 tokens.", code: "context_length_exceeded" }); })
        .then(respText("The summary."))
        .then(respText('{"expression":"curious","say":null,"notes":1,"action":null}'));
    const r = await h.mind.sendChat("What do you think?");
    assert.equal(r?.notes, 1);
    assert.ok(h.events.includes("compacted:"));
    assert.ok(!h.events.some((e) => e.startsWith("turn-error")), h.events.join(" | "));
    const retry = h.api.bodies.at(-1);
    assert.equal(retry.input.length, 1);
    assert.match(retry.input[0].content[0].text, /The summary\.[\s\S]*document \(full text[\s\S]*What do you think\?/);
    h.mind.dispose(true);
});

test("a turn stuck for minutes is let go, and the mind goes on", async () => {
    const h = harness();
    h.mind.start();
    const p = h.mind.requestPerception("session_start");
    await tick();
    (h.mind as any).inflight.interrupted = true;   // as the watchdog marks it
    (h.mind as any).interruptTurn();
    assert.equal(await p, null);
    assert.ok(h.events.some((e) => e.startsWith("turn-error:Euterpe got stuck")), h.events.join(" | "));
    assert.ok(h.mind.alive);
    h.mind.dispose(true);
});

test("failures are explained in the writer's terms", () => {
    const why = (status: number, error: object | string) => describeApiFailure(apiError(status, error), "openrouter.ai", "x/model");
    assert.equal(why(429, { message: "You exceeded your current quota", code: "insufficient_quota" }).failure, "other");
    assert.match(why(429, { message: "You exceeded your current quota", code: "insufficient_quota" }).why, /out of credit/);
    assert.match(why(429, { message: "Rate limit reached" }).why, /rate-limiting/);
    assert.equal(why(404, "model 'x/model' not found").failure, "model");
    assert.equal(why(400, { message: "x/model is not a valid model ID" }).failure, "other");
    assert.equal(why(400, { message: "invalid model: x/model is not supported" }).failure, "model");
    assert.ok(why(400, { message: "prompt is too long: 210000 tokens > 200000 maximum" }).overflow);
    assert.match(describeApiFailure(new Error("fetch failed"), "localhost:11434", "llama").why, /couldn't reach localhost:11434/);
});

test("a chat answer's reasoning goes back with it, until the provider refuses it", async () => {
    const h = harness({ api: "chat", openai: false });
    h.mind.start();
    const thought = (text: string, extra: object) => ({ choices: [{ message: { role: "assistant", content: text, ...extra }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    h.api.then(thought(QUIET, { reasoning_content: "They just started.", reasoning: "Same, as Ollama says it." }));
    await h.mind.requestPerception("session_start");
    h.edit(["Hello there.", "", "Second paragraph."]);
    h.api.then((body) => {
        const answer = body.messages.find((m: any) => m.role === "assistant");
        assert.equal(answer.reasoning_content, "They just started.");
        assert.equal(answer.reasoning, "Same, as Ollama says it.");
        throw apiError(400, { message: "'messages.2' : for 'role:assistant' the following must be satisfied[('messages.2.reasoning' : property 'reasoning' is unsupported)]" });
    }).then((body) => {
        const answer = body.messages.find((m: any) => m.role === "assistant");
        assert.ok(!("reasoning" in answer), "the refused field is gone");
        assert.equal(answer.reasoning_content, "They just started.", "the other stays");
        return chatText(QUIET);
    });
    assert.ok(await h.mind.requestPerception("pause"));
    h.mind.dispose(true);
});

test("a turn waiting while the conversation is summarized goes after the summary, not before", async () => {
    const h = harness({ compactWindow: 5000 });
    h.mind.start();
    h.api.then(respText(QUIET, { input_tokens: 6000, output_tokens: 10 }));
    const first = h.mind.requestPerception("session_start");
    const chat = h.mind.sendChat("Ready?");   // queued behind the first turn
    await first;
    await tick();
    assert.equal(h.api.bodies.length, 2, "the summary is asked for before the chat goes");
    assert.match(h.api.bodies[1].input.at(-1).content[0].text, /summarized/);
    h.api.then(respText("All quiet so far."));
    await tick(); await tick();
    h.api.then(respText('{"expression":"happy","say":"Ready.","notes":0,"action":null}'));
    assert.equal((await chat)?.say, "Ready.");
    assert.match(h.api.bodies[2].input[0].content[0].text, /All quiet so far\.[\s\S]*<euterpe:chat>\nReady\?/);
    h.mind.dispose(true);
});

test("a conversation too long even to summarize is let go, and the turn sent again in full", async () => {
    const h = harness();
    h.mind.start();
    h.api.then(respText(QUIET));
    await h.mind.requestPerception("session_start");
    const overflow = () => { throw apiError(400, { message: "This model's maximum context length is 32768 tokens.", code: "context_length_exceeded" }); };
    h.api.then(overflow).then(overflow).then(respText('{"expression":"curious","say":"Where were we?","notes":0,"action":null}'));
    const r = await h.mind.sendChat("Still with me?");
    assert.equal(r?.say, "Where were we?");
    const retry = h.api.bodies.at(-1);
    assert.equal(retry.input.length, 1);
    assert.match(retry.input[0].content[0].text, /^\[Your conversation so far grew too long[\s\S]*document \(full text[\s\S]*Still with me\?/);
    h.mind.dispose(true);
});

test("the client sends the writer's key only, and nothing from the environment", async () => {
    const http = require("node:http") as typeof import("node:http");
    const seen: Record<string, string | string[] | undefined>[] = [];
    const server = http.createServer((req, res) => {
        seen.push(req.headers);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: "m1", object: "model" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    const saved = { org: process.env.OPENAI_ORG_ID, project: process.env.OPENAI_PROJECT_ID, key: process.env.OPENAI_API_KEY };
    process.env.OPENAI_ORG_ID = "org-work";
    process.env.OPENAI_PROJECT_ID = "proj-work";
    process.env.OPENAI_API_KEY = "sk-work";
    try {
        const { apiClient } = require("../openaiMind") as typeof import("../openaiMind");
        for await (const _ of apiClient(base, "sk-mine").models.list()) { /* one page */ }
        for await (const _ of apiClient(base, "").models.list()) { /* one page */ }
    } finally {
        server.close();
        for (const [k, v] of [["OPENAI_ORG_ID", saved.org], ["OPENAI_PROJECT_ID", saved.project], ["OPENAI_API_KEY", saved.key]] as const) {
            if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; }
        }
    }
    assert.equal(seen[0].authorization, "Bearer sk-mine");
    assert.equal(seen[1].authorization, undefined, "no key header for a server that needs none");
    for (const h of seen) {
        assert.equal(h["openai-organization"], undefined);
        assert.equal(h["openai-project"], undefined);
    }
});
