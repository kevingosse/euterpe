import * as assert from "node:assert/strict";
import { test } from "node:test";
import { APIUserAbortError } from "openai";
import { copilotApi, CopilotError, copilotDefault, copilotDetail, copilotModelsOf, describeCopilotFailure, JUSTIFICATION, LmClasses, RESULTS_LINE, toMessages } from "../copilot";
import { McpTool } from "../mcpServer";
import { modelName, rememberCopilotModels } from "../models";
import { OpenAIMind } from "../openaiMind";
import { DocSnapshot, PerceptionWriter, SensorState } from "../perception";

// ---------- VS Code's Language Model API, as far as the adapter goes ----------

class TextPart { constructor(public value: string) {} }
class ToolCallPart { constructor(public callId: string, public name: string, public input: object) {} }
class ToolResultPart { constructor(public callId: string, public content: unknown[]) {} }
class DataPart {
    constructor(public data: Uint8Array, public mimeType: string) {}
    static image(data: Uint8Array, mime: string) { return new DataPart(data, mime); }
}
class ChatMessage {
    constructor(public role: number, public content: unknown[]) {}
    static User(c: string | unknown[]) { return new ChatMessage(1, typeof c === "string" ? [new TextPart(c)] : c); }
    static Assistant(c: string | unknown[]) { return new ChatMessage(2, typeof c === "string" ? [new TextPart(c)] : c); }
}
class LmError extends Error {
    constructor(message: string, public code: string, options?: { cause?: unknown }) { super(message, options); }
}
class TokenSource {
    cancelled = false;
    disposed = false;
    readonly token = { isCancellationRequested: false };
    cancel() { this.cancelled = true; this.token.isCancellationRequested = true; sources.push(this); }
    dispose() { this.disposed = true; }
}
const sources: TokenSource[] = [];

const vs = {
    LanguageModelChatMessage: ChatMessage, LanguageModelTextPart: TextPart, LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart, LanguageModelDataPart: DataPart, LanguageModelError: LmError, CancellationTokenSource: TokenSource,
} as unknown as LmClasses;

type Answer = unknown[] | Error | ((token: { isCancellationRequested: boolean }) => Promise<unknown[]>);

/** A Copilot model that answers from a script (the parts of each answer's stream), and keeps what it was sent. */
function fakeChat(id = "claude-sonnet-9") {
    const sent: { messages: ChatMessage[]; options: any }[] = [];
    const script: Answer[] = [];
    const chat = {
        id, name: "Claude Sonnet 9", family: id, vendor: "copilot", version: "1", maxInputTokens: 100_000,
        countTokens: async (text: string) => Math.ceil(text.length / 3),
        sendRequest: async (messages: ChatMessage[], options: any, token: { isCancellationRequested: boolean }) => {
            sent.push({ messages, options });
            const a = script.shift();
            if (!a) { throw new Error("nothing scripted"); }
            if (a instanceof Error) { throw a; }
            const parts = typeof a === "function" ? await a(token) : a;
            return { stream: (async function* () { yield* parts; })(), text: (async function* () { /* unused */ })() };
        },
    };
    return { chat, sent, then(a: Answer) { script.push(a); return this; } };
}

const api = (chat: unknown) => copilotApi({ vs, model: async (id) => ((chat as { id: string }).id === id ? chat as any : undefined) });

// ---------- the models ----------

test("Copilot's models, once each and by name; Euterpe's pick is Auto, else the newest Terra, else the newest Sol, else the first", () => {
    const listed = copilotModelsOf([
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", family: "gpt-6.1-sol", maxInputTokens: 200_000 },
        { id: "gpt-6-terra", name: "GPT-6 Terra", family: "gpt-6-terra", maxInputTokens: 200_000 },
        { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", family: "gpt-6.1-terra", maxInputTokens: 200_000 },
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", family: "claude-sonnet-4.5", maxInputTokens: 128_000 },
        { id: "claude-sonnet-10", name: "Claude Sonnet 10", family: "claude-sonnet-10", maxInputTokens: 128_000 },
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5 (again)", family: "claude-sonnet-4.5", maxInputTokens: 128_000 },
        { id: "auto", name: "Auto", family: "auto", maxInputTokens: NaN },
    ]);
    assert.deepEqual(listed.map((m) => m.name), ["Auto", "Claude Sonnet 4.5", "Claude Sonnet 10", "GPT-6 Terra", "GPT-6.1 Sol", "GPT-6.1 Terra"]);
    assert.equal(listed[0].maxInputTokens, 0, "a window VS Code doesn't give is none");
    assert.equal(copilotDefault(listed), "auto");
    assert.equal(copilotDetail("auto", "auto"), "Copilot chooses the model. Euterpe's pick");
    assert.equal(copilotDetail("gpt-6.1-terra", "auto"), "");
    assert.equal(copilotDetail("gpt-6.1-terra", "gpt-6.1-terra"), "Euterpe's pick");
    assert.equal(copilotDefault(listed.filter((m) => m.id !== "auto")), "gpt-6.1-terra", "no Auto: the newest Terra");
    assert.equal(copilotDefault([{ id: "claude-sonnet-10" }, { id: "gpt-6-sol" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }]), "gpt-6.1-sol");
    assert.equal(copilotDefault([{ id: "solar-1" }, { id: "terrain-2" }, { id: "gemini-9-pro" }]), "solar-1", "no Terra, no Sol: the first");
    assert.equal(copilotDefault([]), undefined);
    rememberCopilotModels(listed);
    assert.equal(modelName("claude-sonnet-10", "copilot"), "Claude Sonnet 10");
    assert.equal(modelName("unheard-of", "copilot"), "unheard-of");
    assert.equal(modelName("", "copilot"), "Euterpe's pick");
});

// ---------- the conversation, in VS Code's terms ----------

test("a conversation in VS Code's terms: instructions from the writer's side, results together and first, calls as calls", () => {
    const messages = toMessages(vs, [
        { role: "system", content: "You are Euterpe." },
        { role: "user", content: "<perception/>" },
        { role: "assistant", content: null, tool_calls: [
            { id: "a", type: "function", function: { name: "read_file", arguments: '{"path":"x.md"}' } },
            { id: "b", type: "function", function: { name: "show_mascot", arguments: "" } },
        ] },
        { role: "tool", tool_call_id: "a", content: "the text" },
        { role: "tool", tool_call_id: "b", content: "Error: no" },
        { role: "user", content: [{ type: "text", text: "[The picture from show_mascot:]" }, { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] },
        { role: "assistant", content: "" },   // nothing said: nothing kept
        { role: "user", content: "<perception 2/>" },
        { role: "assistant", content: '{"say":null}' },
    ]) as unknown as ChatMessage[];
    assert.deepEqual(messages.map((m) => m.role), [1, 2, 1, 2]);
    assert.deepEqual(messages[0].content.map((p: any) => p.value), ["You are Euterpe.", "<perception/>"]);
    const calls = messages[1].content as ToolCallPart[];
    assert.deepEqual(calls.map((c) => [c.callId, c.name, c.input]), [["a", "read_file", { path: "x.md" }], ["b", "show_mascot", {}]]);
    const back = messages[2].content;
    assert.ok(back[0] instanceof ToolResultPart && back[1] instanceof ToolResultPart, "the results first");
    assert.deepEqual((back[0] as ToolResultPart).content.map((p: any) => p.value), ["the text"]);
    assert.equal((back[2] as TextPart).value, "[The picture from show_mascot:]");
    assert.deepEqual([...(back[3] as DataPart).data], [1, 2, 3]);
    assert.equal((back[3] as DataPart).mimeType, "image/png");
    assert.equal((back[4] as TextPart).value, "<perception 2/>", "an empty answer leaves the writer's side as one message");
    assert.equal(back.filter((p) => p instanceof TextPart && p.value === RESULTS_LINE).length, 0, "results with words need no line");
    assert.deepEqual(messages[3].content.map((p: any) => p.value), ['{"say":null}']);

    // Results with no words: a line after them (Copilot's Auto refuses a request whose last message has
    // no words), on every such message, so earlier requests read the same.
    const call = (id: string) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] });
    const bare = toMessages(vs, [
        { role: "user", content: "<perception/>" },
        call("a"), { role: "tool", tool_call_id: "a", content: "one" },
        call("b"), { role: "tool", tool_call_id: "b", content: "two" },
    ]) as unknown as ChatMessage[];
    for (const i of [2, 4]) {
        const parts = bare[i].content;
        assert.ok(parts[0] instanceof ToolResultPart, "the results first");
        assert.equal((parts[1] as TextPart).value, RESULTS_LINE);
    }

    // A VS Code with no pictures: the picture is a word instead.
    const older = toMessages({ ...vs, LanguageModelDataPart: undefined } as LmClasses,
        [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] }]) as unknown as ChatMessage[];
    assert.match((older[0].content[0] as TextPart).value, /picture/);
});

test("an answer comes back as Chat Completions gives it: words, calls, and what the request read", async () => {
    const m = fakeChat();
    m.then([new TextPart("Let me look. "), { kind: "thinking" }, new ToolCallPart("c1", "read_file", { path: "x.md" })]);
    const tools = [{ type: "function", function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
    const res = await api(m.chat).chat.completions.create({ model: m.chat.id, messages: [{ role: "system", content: "abc" }, { role: "user", content: "def" }], tools, reasoning_effort: "low", response_format: {} });
    assert.equal(res.choices[0].message.content, "Let me look. ");
    assert.deepEqual(res.choices[0].message.tool_calls, [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"x.md"}' } }]);
    assert.equal(res.choices[0].finish_reason, "tool_calls");
    assert.equal(res.usage.prompt_tokens, Math.ceil("abc\ndef".length / 3), "the model's own count");
    const { options } = m.sent[0];
    assert.equal(options.justification, JUSTIFICATION);
    assert.deepEqual(options.tools, [{ name: "read_file", description: "Read a file.", inputSchema: tools[0].function.parameters }]);
    assert.deepEqual(options.configuration, { reasoningEffort: "low" }, "the effort, as Copilot reads it");
    assert.equal(Object.keys(options).sort().join(), "configuration,justification,tools", "nothing VS Code doesn't take");

    // An answer now: the tools stay listed, and a call is let go. No effort: Copilot's own.
    m.then([new TextPart("{}"), new ToolCallPart("c2", "read_file", {})]);
    const now = await api(m.chat).chat.completions.create({ model: m.chat.id, messages: [{ role: "user", content: "x" }], tools, tool_choice: "none" });
    assert.equal(now.choices[0].message.tool_calls, undefined);
    assert.equal(m.sent[1].options.tools.length, 1);
    assert.equal(m.sent[1].options.configuration, undefined);
});

test("a model Copilot doesn't offer, and a request cancelled midway", async () => {
    const m = fakeChat();
    await assert.rejects(api(m.chat).chat.completions.create({ model: "gone", messages: [] }), (e: unknown) => e instanceof CopilotError && e.code === "NotFound");

    let release!: () => void;
    m.then(() => new Promise((resolve) => { release = () => resolve([new TextPart("late")]); }));
    const ctl = new AbortController();
    const pending = api(m.chat).chat.completions.create({ model: m.chat.id, messages: [{ role: "user", content: "x" }] }, { signal: ctl.signal });
    await new Promise((r) => setImmediate(r));
    ctl.abort();
    release();
    await assert.rejects(pending, APIUserAbortError);
    assert.ok(sources.some((s) => s.cancelled), "VS Code's request was cancelled too");
});

test("Copilot's failures, in words for the writer", async () => {
    const m = fakeChat();
    const fail = async (err: Error) => {
        m.then(err);
        try { await api(m.chat).chat.completions.create({ model: m.chat.id, messages: [{ role: "user", content: "x" }] }); } catch (e) { return describeCopilotFailure(e, "Claude Sonnet 9"); }
        assert.fail("it went through");
    };
    const denied = await fail(new LmError("The user didn't allow it.", "NoPermissions"));
    assert.equal(denied?.failure, "sign-in");
    assert.match(denied!.why, /allow it when VS Code asks/);
    assert.equal((await fail(new LmError("gone", "NotFound")))?.failure, "model");
    const blocked = await fail(new LmError("You have been rate-limited.", "Blocked"));
    assert.equal(blocked?.failure, "other");
    assert.match(blocked!.why, /limiting Euterpe for now: You have been rate-limited/);
    assert.match((await fail(new LmError("Monthly quota reached.", "Blocked")))!.why, /usage limit on your GitHub Copilot plan: Monthly quota reached/);
    assert.match((await fail(new Error("Request took too long.")))!.why, /couldn't answer/, "a slow answer isn't a long conversation");
    const long = await fail(new LmError("Request failed", "Unknown", { cause: new Error("prompt token count of 140000 exceeds the limit of 128000") }));
    assert.ok(long?.overflow, "the cause tells");
    assert.match((await fail(new Error("socket hang up")))!.why, /couldn't answer: socket hang up/);
    assert.equal(describeCopilotFailure(new Error("not Copilot's"), "m"), undefined);
});

// ---------- the mind on it ----------

function harness(m: ReturnType<typeof fakeChat>, tools: McpTool[] = []) {
    const writer = new PerceptionWriter({ largeChangeRatio: 1 });
    const snapshot = (): DocSnapshot => ({ key: "k", name: "post.md", languageId: "markdown", workspace: "W", dirty: false, lines: ["Hello."], cursor: { line: 0, character: 0 }, selection: null });
    const state = (): SensorState => ({ now: new Date(), focused: true, unfocusedMs: null, sinceLastEditMs: 1000, sinceLastSaveMs: null, activity: [] });
    const events: string[] = [];
    const mind = new OpenAIMind({
        baseURL: "", name: "GitHub Copilot", apiKey: "", model: m.chat.id, effort: "", api: "chat", instructions: "You are Euterpe.", tools,
        webSearch: false, openaiExtras: false, compactWindow: 1_000_000, debug: false, log: () => { /* quiet */ },
        client: api(m.chat), describeFailure: describeCopilotFailure,
        perceive: (reason) => writer.render(reason, snapshot(), state()), invalidate: () => writer.invalidate(),
    });
    for (const e of ["response", "turn-error", "died"]) { mind.on(e, (...a: unknown[]) => events.push(`${e}:${a.map(String).join(",")}`)); }
    return { mind, events };
}

test("the mind on Copilot: its tools run until it answers, and a refusal of consent ends the session", async () => {
    const calls: string[] = [];
    const read: McpTool = {
        name: "read_file", description: "Read a file.", inputSchema: { type: "object", properties: { path: { type: "string" } } },
        call: async (args) => { calls.push(String(args.path)); return { text: "notes" }; },
    };
    const m = fakeChat();
    m.then([new ToolCallPart("c1", "read_file", { path: "memory.md" })])
        .then([new TextPart('{"expression":"happy","say":"Hi!","notes":0,"action":null}')]);
    const h = harness(m, [read]);
    h.mind.start();
    const r = await h.mind.requestPerception("session_start");
    assert.deepEqual(r, { expression: "happy", say: "Hi!", notes: 0, action: null });
    assert.deepEqual(calls, ["memory.md"]);
    const second = m.sent[1].messages;
    assert.deepEqual(second.map((x) => x.role), [1, 2, 1]);
    assert.match((second[0].content[0] as TextPart).value, /^You are Euterpe\./);
    assert.match((second[0].content[1] as TextPart).value, /^<euterpe:perception reason="session_start">/);
    assert.equal((second[2].content[0] as ToolResultPart).callId, "c1");

    m.then(new LmError("The user cancelled.", "NoPermissions"));
    assert.equal(await h.mind.sendChat("hello?"), null);
    assert.ok(h.events.some((e) => /^died:.*allow it when VS Code asks/.test(e)), h.events.join("\n"));
    h.mind.dispose(true);
});
