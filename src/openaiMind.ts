// The mind on an OpenAI-compatible API: the writer's ChatGPT plan, OpenAI's API, or any provider
// that speaks it (OpenRouter, a local Ollama or LM Studio...), with the writer's own key; and GitHub
// Copilot's models, which copilot.ts lets speak Chat Completions. Unlike the
// Claude mind there's no agent process: the conversation lives here, and so does the loop that runs
// the mind's tools (agentTools.ts, and the extension's own: propose_edit, the mascot tools) until it
// answers. Two dialects: OpenAI's Responses API (reasoning carried across turns, web search,
// answers held to Euterpe's reply schema) and Chat Completions, which every provider speaks.

import OpenAI, { APIError, APIUserAbortError } from "openai";
import { MANAGE_USAGE_URL, SignInNeeded } from "./chatgpt";
import { McpTool, McpToolResult } from "./mcpServer";
import { Mind, MindOptions, TurnFailure } from "./mind";
import { MindEvent } from "./mindConsole";
import { ACTIONS, EXPRESSIONS } from "./protocol";

type RequestOptions = { signal?: AbortSignal; headers?: Record<string, string> };

/** The part of the OpenAI client the mind uses; tests pass a fake. */
export interface ModelApi {
    responses: { create(body: any, options?: RequestOptions): Promise<any> };
    chat: { completions: { create(body: any, options?: RequestOptions): Promise<any> } };
}

/** A ChatGPT sign-in (chatgpt.ts): the headers each request on the plan carries. */
export interface PlanAuth {
    /** `force`: the backend refused the last ones, so the token is renewed first. */
    headers(force?: boolean): Promise<Record<string, string>>;
}

export interface OpenAIMindOptions extends MindOptions {
    /** Where the API is, e.g. https://api.openai.com/v1. */
    baseURL: string;
    /** How the writer knows it, in what the mind says of it ("ChatGPT", "OpenRouter"...): its host by default. */
    name?: string;
    /** The writer's key ("" for a local server that needs none, or a ChatGPT plan). */
    apiKey: string;
    /** On a ChatGPT plan: the sign-in, instead of a key. Its backend only answers in a stream. */
    chatgpt?: PlanAuth;
    /** Reasoning effort ("" = the model's default). */
    effort: string;
    /** "responses": OpenAI's Responses API; "chat": Chat Completions. */
    api: "responses" | "chat";
    /** The system prompt. */
    instructions: string;
    /** What the mind can do: the working tools and the extension's own. */
    tools: McpTool[];
    /** The API's own web search (OpenAI's Responses API). */
    webSearch: boolean;
    /** Hold answers to the reply schema, and use OpenAI's cache key and stateless reasoning (OpenAI's own API). */
    openaiExtras: boolean;
    /** Summarize the conversation once a turn reads more than this many tokens (Attention.compactWindow). */
    compactWindow: number;
    /** What the debug console shows. */
    onEvent?: (e: MindEvent) => void;
    /** Mirror requests and answers into the log. */
    debug: boolean;
    /** Injectable for tests (default: the OpenAI SDK's client), or another way to the models (GitHub Copilot's). */
    client?: ModelApi;
    /** What a failure means, where the client knows better than the API's errors (GitHub Copilot's); undefined: the API's reading. */
    describeFailure?: (err: unknown, model: string) => ApiFailure | undefined;
    /** How the mind is paid for, in the log ("on your GitHub Copilot plan"): from the key or sign-in by default. */
    auth?: string;
}

/** What a failed call means for the session, in words for the writer. */
export interface ApiFailure {
    failure: TurnFailure;
    why: string;
    /** The conversation is too long for the model: summarized, then the turn again. */
    overflow?: boolean;
    /** A usage limit on the writer's ChatGPT plan. */
    limit?: boolean;
}

/**
 * A client for an OpenAI-compatible API, with the writer's key only. The SDK would otherwise send
 * OPENAI_ORG_ID and OPENAI_PROJECT_ID from the environment wherever the base URL points, and a key
 * header to a local server that wants none.
 */
export function apiClient(baseURL: string, apiKey: string, o: { maxRetries?: number; timeout?: number } = {}): OpenAI {
    return new OpenAI({
        baseURL,
        apiKey: apiKey || "none",
        organization: null,
        project: null,
        maxRetries: o.maxRetries ?? 2,
        ...(o.timeout ? { timeout: o.timeout } : {}),
        ...(apiKey ? {} : { defaultHeaders: { Authorization: null } }),
    });
}

/** Tool rounds in one turn before the mind is asked to answer with what it has. */
const MAX_STEPS = 40;
/** Optional parameters a provider may refuse ("Unsupported parameter"): dropped, and the call tried again. */
const OPTIONAL = ["prompt_cache_key", "reasoning", "reasoning_effort", "text", "response_format", "include", "store", "parallel_tool_calls", "web_search",
    // what a provider's answers carry of its reasoning, sent back with them in a chat history
    "reasoning_content", "reasoning_details", "reasoning_text"] as const;
type Optional = typeof OPTIONAL[number];
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/**
 * The fields of a chat answer that hold the model's reasoning, by provider: DeepSeek's and
 * Fireworks' reasoning_content, OpenRouter's reasoning_details, Ollama's and vLLM's reasoning
 * (reasoning_text here, as the request knows it). Some providers require them back with the
 * answer (DeepSeek refuses a history with tool calls without them), some refuse them (Groq):
 * they go back until refused.
 */
const CHAT_REASONING: Record<string, Optional> = { reasoning_content: "reasoning_content", reasoning_details: "reasoning_details", reasoning: "reasoning_text" };

/** Euterpe's reply, as a strict JSON schema (see mind/system-prompt.md). */
export const REPLY_SCHEMA = {
    type: "object",
    properties: {
        expression: { type: "string", enum: [...EXPRESSIONS] },
        say: { anyOf: [{ type: "string" }, { type: "null" }] },
        notes: { type: "integer" },
        action: { anyOf: [{ type: "string", enum: [...ACTIONS] }, { type: "null" }] },
    },
    required: ["expression", "say", "notes", "action"],
    additionalProperties: false,
};

const SUMMARY_REQUEST = [
    "[Euterpe's harness: your conversation is getting long, so it's being summarized to keep you quick. Write the summary you'll continue from, for yourself:",
    "what the writer is working on and where they are in it; how the session has gone; what they asked of you and what you answered or promised;",
    "the notes you're holding back (each one); edits you proposed and what they decided; running jokes and the mood between you; anything they told you about themselves or how they want you to be.",
    "Leave out the document itself: you'll see it in full again right after. Plain prose and short lists, no JSON this time.]",
].join(" ");

interface ToolCall { id: string; name: string; args: string }
interface Usage { input: number; cached: number; output: number }
interface Read { calls: ToolCall[]; text: string; usage: Usage; incomplete?: string }

/** How one API keeps the conversation and talks about tools. */
interface Dialect {
    addUser(text: string): void;
    /** The request for the next step. The tools stay listed (they're part of the cached prefix), but `answer` forbids them. */
    request(o: Step): Record<string, unknown>;
    /** Read an answer, and keep it in the conversation. */
    take(res: any): Read;
    addResults(results: { call: ToolCall; result: McpToolResult }[]): void;
    /** A point to go back to when a turn fails, so no tool call is left without its result. */
    mark(): number;
    rollback(mark: number): void;
    reset(): void;
    /** A side question on the conversation as it is (the summary): asked, answered, and left out of it. */
    aside(text: string, model: string, effort: string): Record<string, unknown>;
}

/** One request's settings: the model, its effort, whether it must answer now (no tools), held to the reply schema. */
interface Step { model: string; effort: string; answer: boolean; structured: boolean }

export class OpenAIMind extends Mind {
    private readonly client: ModelApi;
    private readonly dialect: Dialect;
    private readonly host: string;
    private turnAbort: AbortController | null = null;
    private compacting: AbortController | null = null;
    /** Text the next turn opens with: the summary of the conversation before it. */
    private prefix = "";
    private dropped = new Set<Optional>();
    private effort: string;
    private okTurns = 0;
    /** How much the last call of the last turn read: the conversation's size. */
    private lastInput = 0;

    constructor(private readonly opts: OpenAIMindOptions) {
        super(opts);
        this.effort = opts.effort;
        this.host = opts.name ?? hostOf(opts.baseURL);
        // On a plan, a refused request isn't tried again blindly: a usage limit would only be hit again.
        this.client = opts.client ?? (apiClient(opts.baseURL, opts.apiKey, { maxRetries: opts.chatgpt ? 0 : 2 }) as unknown as ModelApi);
        const tools = opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
        this.dialect = opts.api === "responses"
            ? new ResponsesDialect(opts.instructions, tools, () => this.useWebSearch, () => this.sessionId, opts.openaiExtras, this.dropped)
            : new ChatDialect(opts.instructions, tools, () => this.sessionId, opts.openaiExtras, this.dropped);
    }

    private get useWebSearch(): boolean {
        return this.opts.webSearch && !this.dropped.has("web_search");
    }

    protected launch(): void {
        const auth = this.opts.auth ?? (this.opts.chatgpt ? "on your ChatGPT plan" : this.opts.apiKey ? "with your API key" : "with no key");
        this.opts.log(`mind ready: model ${this.currentModel} via ${this.host} (${this.opts.api === "responses" ? "Responses API" : "Chat Completions"}), ${auth}, tools ${this.opts.tools.map((t) => t.name).join(", ")}${this.opts.webSearch ? ", web_search" : ""}`);
        this.opts.onEvent?.({ kind: "ready", text: `model ${this.currentModel} via ${this.host}` });
    }

    protected canSend(): boolean {
        return this.compacting === null;
    }

    /** Any model name goes: one the API doesn't know fails the next turn, and the mind goes back. */
    protected requestModel(): Promise<string | null> {
        return Promise.resolve(null);
    }

    protected interruptTurn(): void {
        this.turnAbort?.abort();
    }

    protected shutdown(): void {
        const turn = this.turnAbort, compacting = this.compacting;
        this.turnAbort = null;
        this.compacting = null;
        turn?.abort();
        compacting?.abort();
    }

    protected sendTurn(text: string): void {
        const ctl = new AbortController();
        this.turnAbort = ctl;
        const started = Date.now();
        this.opts.onEvent?.({ kind: "sent", text });
        void this.runTurn(text, ctl.signal).then(
            ({ raw, usage, calls }) => {
                if (this.turnAbort !== ctl) { return; }
                this.turnAbort = null;
                this.okTurns++;
                this.opts.onEvent?.({ kind: "turn", ok: true, secs: (Date.now() - started) / 1000, detail: `${calls} ${calls === 1 ? "call" : "calls"} · in ${usage.input} (cached ${usage.cached}) · out ${usage.output}` });
                // Grown too long: the next turn waits for the summary (held before this one ends, so none slips in).
                const summarize = this.lastInput > this.opts.compactWindow && !this.compacting ? new AbortController() : null;
                if (summarize) { this.compacting = summarize; }
                this.completeTurn(raw);
                if (summarize) { void this.compact(summarize); }
            },
            (err) => {
                if (this.turnAbort !== ctl) { return; }
                this.turnAbort = null;
                this.turnFailed(err, ctl.signal.aborted, (Date.now() - started) / 1000);
            });
    }

    private async runTurn(text: string, signal: AbortSignal): Promise<{ raw: string; usage: Usage; calls: number }> {
        const d = this.dialect;
        const mark = d.mark();
        d.addUser(this.prefix ? `${this.prefix}\n\n${text}` : text);
        const total: Usage = { input: 0, cached: 0, output: 0 };
        let calls = 0;
        try {
            for (let step = 0; ; step++) {
                const last = step >= MAX_STEPS;   // enough tools: an answer now
                const res = await this.call(() => d.request({ model: this.currentModel, effort: this.effort, answer: last, structured: true }), signal);
                calls++;
                const r = d.take(res);
                total.input += r.usage.input; total.cached += r.usage.cached; total.output += r.usage.output;
                this.lastInput = r.usage.input + r.usage.output;
                if (r.incomplete) { this.opts.log(`the answer stopped short: ${r.incomplete}`); }
                if (r.text.trim()) { this.opts.onEvent?.({ kind: "say", text: r.text }); }
                if (!r.calls.length || last) {
                    this.prefix = "";
                    return { raw: r.text, usage: total, calls };
                }
                const results: { call: ToolCall; result: McpToolResult }[] = [];
                for (const call of r.calls) {
                    results.push({ call, result: await this.runTool(call, signal) });
                }
                d.addResults(results);
            }
        } catch (err) {
            d.rollback(mark);
            throw err;
        }
    }

    private async runTool(call: ToolCall, signal: AbortSignal): Promise<McpToolResult> {
        this.opts.onEvent?.({ kind: "tool", name: call.name, input: call.args });
        if (this.opts.debug) { this.opts.log(`[tool] ${call.name} ${call.args.slice(0, 500)}`); }
        const tool = this.opts.tools.find((t) => t.name === call.name);
        let result: McpToolResult;
        if (!tool) {
            result = { text: `There's no tool called ${call.name}.`, isError: true };
        } else {
            let args: unknown;
            try { args = call.args.trim() ? JSON.parse(call.args) : {}; } catch { args = null; }
            if (!args || typeof args !== "object" || Array.isArray(args)) {
                result = { text: "The arguments weren't a JSON object.", isError: true };
            } else {
                try {
                    result = await tool.call(args as Record<string, unknown>, signal);
                } catch (err) {
                    this.opts.log(`tool ${call.name} failed: ${(err as Error).stack ?? err}`);
                    result = { text: `The tool failed: ${(err as Error).message}`, isError: true };
                }
            }
        }
        if (signal.aborted) { throw new APIUserAbortError(); }
        this.opts.onEvent?.({ kind: "tool-result", text: result.text, error: !!result.isError });
        return result;
    }

    /**
     * One request. A provider that refuses one of the optional parameters is asked again without
     * it, and an effort the model doesn't take is moved to the nearest one it does.
     */
    private async call(build: () => Record<string, unknown>, signal: AbortSignal): Promise<any> {
        for (let attempt = 0; ; attempt++) {
            const body = build();
            if (this.opts.debug) { this.opts.log(`[api >>] ${JSON.stringify({ ...body, instructions: undefined, input: undefined, messages: undefined }).slice(0, 600)}`); }
            try {
                const res = this.opts.api === "responses"
                    ? await this.respond(body, signal)
                    : await this.client.chat.completions.create(body, { signal });
                if (this.opts.debug) { this.opts.log(`[api <<] ${JSON.stringify(res).slice(0, 1500)}`); }
                return res;
            } catch (err) {
                if (attempt >= OPTIONAL.length + 2 || !(err instanceof APIError) || (err.status !== 400 && err.status !== 422)) { throw err; }
                const effort = this.effort && betterEffort(err, this.effort);
                if (effort !== undefined && effort !== this.effort) {
                    this.opts.log(`${this.currentModel} doesn't take effort ${this.effort}: ${effort || "its default"} instead`);
                    this.effort = effort;
                    continue;
                }
                const param = refusedParam(err, body);
                if (!param) { throw err; }
                this.opts.log(`${this.host} refused ${param}: going on without it (${errorText(err).slice(0, 200)})`);
                this.dropped.add(param);
            }
        }
    }

    /**
     * A Responses call. On a ChatGPT plan: streamed (its backend answers no other way) with the
     * sign-in's headers, and once more with a renewed token if the backend refuses the one it got.
     */
    private async respond(body: Record<string, unknown>, signal: AbortSignal): Promise<any> {
        const plan = this.opts.chatgpt;
        if (!plan) { return this.client.responses.create(body, { signal }); }
        for (let renewed = false; ; renewed = true) {
            const headers = await plan.headers(renewed);
            try {
                return await finalResponse(await this.client.responses.create({ ...body, stream: true }, { signal, headers }));
            } catch (err) {
                if (renewed || !(err instanceof APIError) || err.status !== 401) { throw err; }
                this.opts.log(`${this.host} refused the sign-in's token: renewing it`);
            }
        }
    }

    private turnFailed(err: unknown, aborted: boolean, secs: number): void {
        const f = aborted
            ? { failure: "other" as TurnFailure, why: this.inflight?.interrupted ? "Euterpe got stuck on that one for minutes and let it go." : "The turn was cancelled." }
            : this.describe(err);
        this.opts.log(`turn failed: ${aborted ? "cancelled" : errorText(err).slice(0, 400)}`);
        this.opts.onEvent?.({ kind: "turn", ok: false, secs, detail: f.why });
        // (the session offers the way to the plan's usage settings)
        if (f.limit) { this.emit("plan-limit", f.why); }
        if (f.overflow && this.dialect.mark() > 0) {
            // Too long for the model: summarize, then the same turn again, in full.
            void this.compact().then(() => {
                if (!this.retryTurn()) { this.failTurn(f.why, "other"); }
            });
            return;
        }
        // A first turn that the API refuses for good (a wrong address or model): every turn would.
        const fatal = this.okTurns === 0 && f.failure === "other" && err instanceof APIError && [400, 403, 404, 422].includes(err.status ?? 0);
        if (fatal) { this.die(f.why); return; }
        this.failTurn(f.why, f.failure);
    }

    private describe(err: unknown): ApiFailure {
        return this.opts.describeFailure?.(err, this.currentModel) ?? describeApiFailure(err, this.host, this.currentModel, !!this.opts.chatgpt);
    }

    /**
     * Replace the conversation with the mind's own summary of it; the next turn opens with it, and
     * sees the document in full. Turns wait meanwhile. A conversation already too long for the model
     * can't be summarized by it: it's dropped instead (the mind's memory file keeps what matters).
     */
    private async compact(ctl = new AbortController()): Promise<void> {
        if ((this.compacting && this.compacting !== ctl) || this.disposed) { return; }
        this.compacting = ctl;
        const before = this.lastInput;
        try {
            const res = await this.call(() => this.dialect.aside(SUMMARY_REQUEST, this.currentModel, this.effort), ctl.signal);
            const summary = textOf(res, this.opts.api).trim();
            if (!summary) { throw new Error("the summary came back empty"); }
            this.dialect.reset();
            this.prefix = `[Your conversation so far was summarized to keep you quick. Your summary of it:]\n<summary>\n${summary}\n</summary>`;
            this.lastInput = 0;
            this.opts.log(`conversation summarized: ${before} tokens → about ${Math.round(summary.length / 4)}`);
            this.compacted();
        } catch (err) {
            if (ctl.signal.aborted) { return; }
            this.opts.log(`couldn't summarize the conversation: ${errorText(err).slice(0, 300)}`);
            if (this.describe(err).overflow) {
                this.dialect.reset();
                this.prefix = "[Your conversation so far grew too long for this model, and was let go. Your memory file keeps what you know of the writer; the document comes again in full.]";
                this.lastInput = 0;
                this.compacted();
            }
        } finally {
            if (this.compacting === ctl) {
                this.compacting = null;
                this.pump();
            }
        }
    }
}

// ---------- the Responses API ----------

class ResponsesDialect implements Dialect {
    private items: any[] = [];

    constructor(
        private readonly instructions: string,
        private readonly tools: { name: string; description: string; parameters: object }[],
        private readonly webSearch: () => boolean,
        private readonly cacheKey: () => string,
        private readonly openai: boolean,
        private readonly dropped: Set<Optional>,
    ) {}

    addUser(text: string): void {
        this.items.push({ role: "user", content: [{ type: "input_text", text }] });
    }

    request(o: Step, input = this.items): Record<string, unknown> {
        const body: Record<string, unknown> = {
            model: o.model,
            instructions: this.instructions,
            input,
            tools: [
                ...this.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
                ...(this.webSearch() ? [{ type: "web_search" }] : []),
            ],
        };
        if (o.answer) { body.tool_choice = "none"; }
        if (o.effort) { body.reasoning = { effort: o.effort }; }
        if (this.openai) {
            // Stateless: nothing kept on OpenAI's side, and the reasoning comes back encrypted for the next call.
            body.store = false;
            body.include = ["reasoning.encrypted_content"];
            body.prompt_cache_key = this.cacheKey();
            if (o.structured) { body.text = { format: { type: "json_schema", name: "euterpe_reply", strict: true, schema: REPLY_SCHEMA } }; }
        }
        return without(body, this.dropped);
    }

    take(res: any): Read {
        const output: any[] = Array.isArray(res?.output) ? res.output : [];
        // As they came (reasoning items carry their encrypted content back), minus who made them.
        this.items.push(...output.map((item) => {
            if (!item || typeof item !== "object" || !("created_by" in item)) { return item; }
            const { created_by: _by, ...rest } = item;
            return rest;
        }));
        const calls = output.filter((i) => i?.type === "function_call")
            .map((i) => ({ id: String(i.call_id), name: String(i.name), args: typeof i.arguments === "string" ? i.arguments : JSON.stringify(i.arguments ?? {}) }));
        const u = res?.usage ?? {};
        return {
            calls,
            text: textOf(res, "responses"),
            usage: { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0 },
            incomplete: res?.status === "incomplete" ? String(res?.incomplete_details?.reason ?? "incomplete") : undefined,
        };
    }

    addResults(results: { call: ToolCall; result: McpToolResult }[]): void {
        for (const { call, result } of results) {
            const text = result.isError ? `Error: ${result.text}` : result.text;
            this.items.push({
                type: "function_call_output",
                call_id: call.id,
                output: result.images?.length
                    ? [{ type: "input_text", text }, ...result.images.map((i) => ({ type: "input_image", image_url: `data:${i.mimeType};base64,${i.data}`, detail: "auto" }))]
                    : text,
            });
        }
    }

    mark(): number { return this.items.length; }
    rollback(mark: number): void { this.items.splice(mark); }
    reset(): void { this.items = []; }

    aside(text: string, model: string, effort: string): Record<string, unknown> {
        return this.request({ model, effort, answer: true, structured: false }, [...this.items, { role: "user", content: [{ type: "input_text", text }] }]);
    }
}

// ---------- Chat Completions ----------

class ChatDialect implements Dialect {
    private messages: any[] = [];

    constructor(
        private readonly instructions: string,
        private readonly tools: { name: string; description: string; parameters: object }[],
        private readonly cacheKey: () => string,
        private readonly openai: boolean,
        private readonly dropped: Set<Optional>,
    ) {}

    addUser(text: string): void {
        this.messages.push({ role: "user", content: text });
    }

    request(o: Step, messages = this.messages): Record<string, unknown> {
        // A provider that refused the reasoning fields gets the history without them.
        const refused = Object.keys(CHAT_REASONING).filter((f) => this.dropped.has(CHAT_REASONING[f]));
        const history = refused.length ? messages.map((m) => {
            if (m.role !== "assistant" || !refused.some((f) => f in m)) { return m; }
            const copy = { ...m };
            for (const f of refused) { delete copy[f]; }
            return copy;
        }) : messages;
        const body: Record<string, unknown> = {
            model: o.model,
            // "system": what every provider takes ("developer" is OpenAI's own)
            messages: [{ role: "system", content: this.instructions }, ...history],
        };
        if (this.tools.length) {
            body.tools = this.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
            if (o.answer) { body.tool_choice = "none"; }
        }
        if (o.effort) { body.reasoning_effort = o.effort; }
        if (this.openai) {
            body.prompt_cache_key = this.cacheKey();
            if (o.structured) { body.response_format = { type: "json_schema", json_schema: { name: "euterpe_reply", strict: true, schema: REPLY_SCHEMA } }; }
        }
        return without(body, this.dropped);
    }

    take(res: any): Read {
        const choice = res?.choices?.[0] ?? {};
        const m = choice.message ?? {};
        const calls: ToolCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : [])
            .filter((c: any) => c?.function?.name)
            .map((c: any, i: number) => ({ id: String(c.id ?? `call_${i}`), name: String(c.function.name), args: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) }));
        const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join("") : "";
        // What the model said, the tools it called (as the provider wrote them: some sign them),
        // and its reasoning, in whichever field this provider keeps it.
        const answer: Record<string, unknown> = { role: "assistant", content: text || (calls.length ? null : "") };
        if (calls.length) {
            answer.tool_calls = (m.tool_calls as any[]).filter((c) => c?.function?.name).map((c, i) => ({ ...c, id: calls[i].id, type: "function" }));
        }
        for (const field of Object.keys(CHAT_REASONING)) {
            if (m[field] !== undefined && m[field] !== null && m[field] !== "") { answer[field] = m[field]; }
        }
        this.messages.push(answer);
        const u = res?.usage ?? {};
        return {
            calls,
            text,
            usage: { input: u.prompt_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0, output: u.completion_tokens ?? 0 },
            incomplete: choice.finish_reason === "length" || choice.finish_reason === "content_filter" ? String(choice.finish_reason) : undefined,
        };
    }

    addResults(results: { call: ToolCall; result: McpToolResult }[]): void {
        const images: { name: string; url: string }[] = [];
        for (const { call, result } of results) {
            this.messages.push({ role: "tool", tool_call_id: call.id, content: result.isError ? `Error: ${result.text}` : result.text });
            for (const i of result.images ?? []) { images.push({ name: call.name, url: `data:${i.mimeType};base64,${i.data}` }); }
        }
        // A tool message carries text only: pictures follow, as from the writer's side.
        if (images.length) {
            this.messages.push({
                role: "user",
                content: [{ type: "text", text: `[The picture${images.length > 1 ? "s" : ""} from ${[...new Set(images.map((i) => i.name))].join(", ")}:]` },
                    ...images.map((i) => ({ type: "image_url", image_url: { url: i.url } }))],
            });
        }
    }

    mark(): number { return this.messages.length; }
    rollback(mark: number): void { this.messages.splice(mark); }
    reset(): void { this.messages = []; }

    aside(text: string, model: string, effort: string): Record<string, unknown> {
        return this.request({ model, effort, answer: true, structured: false }, [...this.messages, { role: "user", content: text }]);
    }
}

// ---------- reading answers and errors ----------

/**
 * The response a stream of Responses events comes to: the one its last event carries, with the
 * items the stream delivered one by one when that last event leaves them out (a ChatGPT plan's
 * does). A failure in the stream becomes the error the API would have answered with.
 */
export async function finalResponse(stream: AsyncIterable<any>): Promise<any> {
    let done: any = null;
    const items: { index: number; item: any }[] = [];
    try {
        for await (const e of stream) {
            if (e?.type === "response.output_item.done" && e.item) { items.push({ index: Number(e.output_index ?? items.length), item: e.item }); }
            else if (e?.type === "response.completed" || e?.type === "response.incomplete") { done = e.response; }
            else if (e?.type === "response.failed") { throw streamError(e.response?.error); }
        }
    } catch (err) {
        // The SDK's own word for an error event: no status, as if the API were out of reach.
        if (err instanceof APIError && err.status === undefined && !(err instanceof APIUserAbortError) && err.constructor === APIError) {
            throw streamError({ ...(err.error ?? {}), message: (err.error as any)?.message ?? err.message });
        }
        throw err;
    }
    if (!done) { throw new Error("The answer was cut off before it ended."); }
    if ((!Array.isArray(done.output) || !done.output.length) && items.length) {
        return { ...done, output: items.sort((a, b) => a.index - b.index).map((i) => i.item) };
    }
    return done;
}

/** The HTTP status each of a ChatGPT plan's errors comes with, when it arrives inside a stream instead. */
const PLAN_ERROR_STATUS: Record<string, number> = {
    subscription_sharing_usage_limit_exceeded: 429, subscription_sharing_user_not_eligible: 403, subscription_sharing_usage_unavailable: 503,
    subscription_sharing_unsupported_capability: 400, subscription_sharing_route_not_supported: 403, subscription_sharing_invalid_user: 401,
    subscription_sharing_user_unavailable: 503, chatpass_v2_scope_not_authorized: 403, chatpass_v2_invalid_authorization_context: 403,
};

/** An error from inside a stream, with the status the API would have given it. */
function streamError(e: any): APIError {
    const code = typeof e?.code === "string" ? e.code : undefined;
    const message = typeof e?.message === "string" && e.message ? e.message : "The answer failed.";
    const status = PLAN_ERROR_STATUS[(code ?? "").replace("subscription_sharing_v2_", "subscription_sharing_")]
        ?? (/usage_limit|rate_limit/.test(code ?? e?.type ?? "") ? 429 : /server_error|overloaded|internal/.test(code ?? "") ? 500 : 400);
    return APIError.generate(status, { error: { ...e, code, message } }, message, new Headers());
}

function without(body: Record<string, unknown>, dropped: Set<Optional>): Record<string, unknown> {
    for (const p of dropped) {
        if (p === "web_search") {
            if (Array.isArray(body.tools)) { body.tools = (body.tools as any[]).filter((t) => t?.type !== "web_search"); }
        } else {
            delete body[p];
        }
    }
    return body;
}

/** The text of an answer: the Responses API's output messages, or the chat message. */
function textOf(res: any, api: "responses" | "chat"): string {
    if (api === "chat") {
        const c = res?.choices?.[0]?.message?.content;
        return typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join("") : "";
    }
    if (typeof res?.output_text === "string" && res.output_text) { return res.output_text; }
    return (Array.isArray(res?.output) ? res.output : [])
        .filter((i: any) => i?.type === "message")
        .flatMap((i: any) => (Array.isArray(i.content) ? i.content : []))
        .filter((c: any) => c?.type === "output_text")
        .map((c: any) => c.text ?? "")
        .join("");
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function hostOf(baseURL: string): string {
    try { return new URL(baseURL).host; } catch { return baseURL; }
}

/** The optional parameter a 400 is about, if it's one this request had. */
function refusedParam(err: APIError, body: Record<string, unknown>): Optional | null {
    // (a ChatGPT plan says so with subscription_sharing_unsupported_capability, naming the param)
    const text = `${err.param ?? ""} ${err.code ?? ""} ${errorText(err)}`.toLowerCase();
    if (/web_search/.test(text) && Array.isArray(body.tools) && (body.tools as any[]).some((t) => t?.type === "web_search")) { return "web_search"; }
    if (!/unsupported|unrecognized|unknown|not supported|not allowed|extra (inputs|fields)|invalid (parameter|field)|does not support|isn't supported|is not permitted/.test(text)) { return null; }
    const sentBack = Array.isArray(body.messages) ? (body.messages as any[]).filter((m) => m?.role === "assistant") : [];
    for (const [field, p] of Object.entries(CHAT_REASONING)) {
        if (sentBack.some((m) => field in m) && new RegExp(`\\b${field}\\b`).test(text)) { return p; }
    }
    for (const p of OPTIONAL) {
        if (p !== "web_search" && p in body && text.includes(p === "text" ? "text.format" : p)) { return p; }
    }
    if (body.text && /json_schema|structured output|text\.format|response format/.test(text)) { return "text"; }
    if (body.response_format && /json_schema|response_format/.test(text)) { return "response_format"; }
    return null;
}

/**
 * When the model refuses the effort asked for: the nearest it takes, from the values its error
 * lists (the highest below the one asked for, else the lowest); "" when it lists none, so the model
 * picks; undefined when the error isn't about effort.
 */
export function betterEffort(err: { param?: string | null; message: string }, wanted: string): string | undefined {
    const text = `${err.param ?? ""} ${err.message}`;
    if (!/reasoning[._]effort|reasoning\.effort|effort/i.test(text) || !/unsupported|not supported|does not support|invalid/i.test(text)) { return undefined; }
    const listed = text.match(/supported values are:?\s*([^.]*)/i)?.[1] ?? "";
    const offered = EFFORTS.filter((e) => new RegExp(`['"\`]${e}['"\`]`).test(listed));
    if (!offered.length) { return ""; }
    const at = EFFORTS.indexOf(wanted);
    const below = offered.filter((e) => EFFORTS.indexOf(e) <= at);
    return below.length ? below[below.length - 1] : offered[0];
}

/**
 * What a failed call means for the session, in words for the writer. `plan`: on a ChatGPT plan,
 * signed in rather than with a key; a sign-in that ended there holds the turns until the writer
 * signs in again ("signed-out").
 */
export function describeApiFailure(err: unknown, host: string, model: string, plan = false): ApiFailure {
    if (err instanceof SignInNeeded) { return { failure: "signed-out", why: err.message }; }
    const message = errorText(err).replace(/^\d{3}\s+/, "");
    if (!(err instanceof APIError) || err.status === undefined) {
        return { failure: "other", why: `Euterpe couldn't reach ${host}: ${message.slice(0, 200)}` };
    }
    const code = String(err.code ?? "");
    const lower = message.toLowerCase();
    const type = err.type ?? (err.error as any)?.type;
    if (plan) {
        // The plan's own errors (and their preview spellings, subscription_sharing_v2_*).
        switch (String(err.code ?? (err.error as any)?.code ?? type ?? "").replace("subscription_sharing_v2_", "subscription_sharing_")) {
            case "subscription_sharing_usage_limit_exceeded":
                return { failure: "other", limit: true, why: `You've reached a usage limit on your ChatGPT plan: your plan's own, or the one you set for Euterpe. Manage it in ChatGPT's settings (${MANAGE_USAGE_URL.replace("https://", "")}); Euterpe's Light attention spends less of it.` };
            case "subscription_sharing_user_not_eligible":
                return { failure: "sign-in", why: "Your ChatGPT account can't use its plan in other apps: that's for ChatGPT Plus and Pro. Euterpe can use an OpenAI API key instead (OpenAI API, in its settings)." };
            case "subscription_sharing_usage_unavailable":
            case "subscription_sharing_user_unavailable":
                return { failure: "other", why: "ChatGPT couldn't check your plan's usage just now: Euterpe tries again at its next look." };
            case "subscription_sharing_invalid_user":
            case "chatpass_v2_scope_not_authorized":
            case "chatpass_v2_invalid_authorization_context":
                return { failure: "sign-in", why: `ChatGPT didn't accept Euterpe's permission to use your plan (${message.slice(0, 160)}): sign in again in Euterpe's settings, then start the session again.` };
        }
    }
    switch (err.status) {
        case 401:
            return plan
                ? { failure: "signed-out", why: `ChatGPT refused Euterpe's sign-in (${message.slice(0, 160)}).` }
                : { failure: "sign-in", why: `${host} refused Euterpe's API key (${message.slice(0, 200)}). Set the key again in Euterpe's settings, then start the session again.` };
        case 403:
            return /model/.test(lower)
                ? { failure: "model", why: `${host} won't run Euterpe's mind on ${model} ${plan ? "on your plan" : "for this key"}: ${message.slice(0, 200)} Pick another with Euterpe: Choose Model.` }
                : { failure: "other", why: `${host} turned the request down: ${message.slice(0, 250)}` };
        case 404:
            return code === "model_not_found" || /model/.test(lower)
                ? { failure: "model", why: `${host} doesn't know the model ${model}: it may not exist, or ${plan ? "your plan" : "this key"} can't use it. Pick another with Euterpe: Choose Model.` }
                : { failure: "other", why: `${host} has no API there (404: ${message.slice(0, 150)}). Check the address in Euterpe's settings.` };
        case 429:
            return /quota|credit|spend_limit|usage_limit/.test(code) || err.type === "insufficient_quota" || /quota|credit|billing|spend limit/.test(lower)
                ? { failure: "other", why: `Your account at ${host} is out of credit (${message.slice(0, 160)}): Euterpe can't think until it's topped up.` }
                : { failure: "other", why: `${host} is rate-limiting Euterpe for now (${message.slice(0, 160)}). It tries again at its next look.` };
    }
    if (code === "context_length_exceeded" || /context length|context window|maximum context|too many tokens|prompt is too long|reduce the length/.test(lower)) {
        return { failure: "other", overflow: true, why: `${model} can't read that much at once: its context is too small for Euterpe's instructions and your document. (A model on your computer may need a longer context.)` };
    }
    if ((err.status === 400 || err.status === 422) && /model/.test(lower) && /not (supported|found|exist|available)|does not exist|invalid model|unknown model/.test(lower)) {
        return { failure: "model", why: `${host} can't run Euterpe's mind on ${model}: ${message.slice(0, 200)} Pick another with Euterpe: Choose Model.` };
    }
    return { failure: "other", why: err.status >= 500 ? `${host} had trouble answering (${err.status}): ${message.slice(0, 200)}` : `${host} refused Euterpe's request (${err.status}): ${message.slice(0, 250)}` };
}
