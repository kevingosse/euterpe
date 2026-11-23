// Euterpe's mind on the writer's GitHub Copilot plan: the models Copilot offers them in VS Code, lent
// to extensions by VS Code's Language Model API (vscode.lm), with no key and no sign-in of Euterpe's
// own. VS Code asks the writer whether Euterpe may use them; the requests count toward their plan.
// The mind is OpenAIMind's, on Chat Completions: copilotApi speaks that to it, and VS Code's API to
// Copilot. That API has no system role (the instructions open the conversation, from the writer's
// side), no reasoning effort, no structured answers, and no token counts. VS Code's classes are passed
// in, so the tests run without VS Code.

import { APIUserAbortError } from "openai";
import type * as vscode from "vscode";
import { modelName } from "./models";
import type { ApiFailure, ModelApi } from "./openaiMind";

/** Copilot's models, to VS Code (LanguageModelChat.vendor). */
export const COPILOT_VENDOR = "copilot";
export const COPILOT_NAME = "GitHub Copilot";
/** What VS Code's consent dialog says Euterpe wants the models for. */
export const JUSTIFICATION = "Euterpe reads along as you write, and answers when you talk to it.";

/** The classes of VS Code's Language Model API that the adapter makes and recognizes. */
export type LmClasses = Pick<typeof vscode,
    "LanguageModelChatMessage" | "LanguageModelTextPart" | "LanguageModelToolCallPart" | "LanguageModelToolResultPart" | "LanguageModelError" | "CancellationTokenSource"> & {
    /** Pictures (not in every VS Code). */
    LanguageModelDataPart?: typeof vscode.LanguageModelDataPart;
};

/** A model Copilot offers, as Euterpe lists it. */
export interface CopilotModel {
    /** What euterpe.copilotModel holds. */
    id: string;
    name: string;
    family: string;
    /** The most it reads at once, in tokens (0 when VS Code doesn't say). */
    maxInputTokens: number;
}

/** The models Copilot offers, once each, by name. */
export function copilotModelsOf(chats: readonly Pick<vscode.LanguageModelChat, "id" | "name" | "family" | "maxInputTokens">[]): CopilotModel[] {
    const byId = new Map<string, CopilotModel>();
    for (const c of chats) {
        if (!c?.id || byId.has(c.id)) { continue; }
        byId.set(c.id, { id: c.id, name: c.name || c.id, family: c.family ?? "", maxInputTokens: Number.isFinite(c.maxInputTokens) ? c.maxInputTokens : 0 });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * The model Euterpe thinks with on Copilot when the writer chose none: its newest GPT Terra (cheap on
 * Copilot, and Euterpe looks at every pause), else its newest Sol, else the first it offers.
 */
export function copilotDefault(models: readonly { id: string; family?: string }[]): string | undefined {
    const newest = (tier: string) => {
        const re = new RegExp(`(^|[-.])${tier}($|[-.])`, "i");
        return models.filter((m) => re.test(m.id) || re.test(m.family ?? ""))
            .sort((a, b) => compareVersions(versionOf(b.id), versionOf(a.id)))[0];
    };
    return (newest("terra") ?? newest("sol") ?? models[0])?.id;
}

const versionOf = (id: string) => (id.match(/\d+/g) ?? []).map(Number);
function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? -1) - (b[i] ?? -1);
        if (d) { return d; }
    }
    return 0;
}

/** A failure of VS Code's Language Model API: its code (LanguageModelError's, or "Unknown"), and what it said. */
export class CopilotError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = "CopilotError";
    }
}

export interface CopilotApiOptions {
    vs: LmClasses;
    /** The model Copilot offers by this id, or undefined when it doesn't (any longer). */
    model(id: string): Promise<vscode.LanguageModelChat | undefined>;
}

/** Chat Completions, on GitHub Copilot's models: what OpenAIMind calls (as ModelApi). */
export function copilotApi(o: CopilotApiOptions): ModelApi {
    return {
        responses: { create: () => Promise.reject(new Error("GitHub Copilot's models answer Chat Completions only.")) },
        chat: { completions: { create: (body, options) => complete(o, body, options?.signal) } },
    };
}

/** One Chat Completions request, through VS Code: the answer as Chat Completions gives it. */
async function complete(o: CopilotApiOptions, body: any, signal?: AbortSignal): Promise<any> {
    const vs = o.vs;
    if (signal?.aborted) { throw new APIUserAbortError(); }
    const id = String(body?.model ?? "");
    const chat = await o.model(id);
    if (!chat) { throw new CopilotError("NotFound", `GitHub Copilot doesn't offer the model ${id}.`); }
    const history: any[] = Array.isArray(body?.messages) ? body.messages : [];
    const tools: vscode.LanguageModelChatTool[] = (Array.isArray(body?.tools) ? body.tools : [])
        .filter((t: any) => t?.function?.name)
        .map((t: any) => ({ name: String(t.function.name), description: String(t.function.description ?? ""), inputSchema: t.function.parameters ?? { type: "object", properties: {} } }));
    // An answer now: the tools stay listed (the conversation may hold calls to them), and any call is let go.
    const answerNow = body?.tool_choice === "none";
    const cts = new vs.CancellationTokenSource();
    const cancel = () => cts.cancel();
    signal?.addEventListener("abort", cancel);
    const read = inputTokens(chat, history);
    try {
        const res = await chat.sendRequest(toMessages(vs, history), { justification: JUSTIFICATION, ...(tools.length ? { tools } : {}) }, cts.token);
        let text = "";
        const calls: vscode.LanguageModelToolCallPart[] = [];
        for await (const part of res.stream) {
            if (part instanceof vs.LanguageModelTextPart) { text += part.value; }
            else if (part instanceof vs.LanguageModelToolCallPart) { calls.push(part); }
        }
        if (signal?.aborted) { throw new APIUserAbortError(); }
        const kept = answerNow ? [] : calls;
        const message: Record<string, unknown> = { role: "assistant", content: text };
        if (kept.length) {
            message.tool_calls = kept.map((c) => ({ id: c.callId, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
        }
        const written = text + calls.map((c) => JSON.stringify(c.input ?? {})).join("");
        return {
            choices: [{ index: 0, message, finish_reason: kept.length ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: await read, completion_tokens: Math.ceil(written.length / 4) },
        };
    } catch (err) {
        if (signal?.aborted || err instanceof APIUserAbortError) { throw new APIUserAbortError(); }
        throw copilotError(vs, err);
    } finally {
        signal?.removeEventListener("abort", cancel);
        cts.dispose();
    }
}

/**
 * A Chat Completions conversation in VS Code's terms. Only the writer's side and the model's: the
 * instructions are the writer's side's first words, a tool's result goes back from the writer's side,
 * and what one side says in a row is one message (all the results of a step together, as some models
 * require, then the pictures they came with).
 */
export function toMessages(vs: LmClasses, messages: readonly any[]): vscode.LanguageModelChatMessage[] {
    const turns: { user: boolean; parts: any[] }[] = [];
    const say = (user: boolean, parts: any[]) => {
        if (!parts.length) { return; }
        const last = turns[turns.length - 1];
        if (last && last.user === user) { last.parts.push(...parts); } else { turns.push({ user, parts }); }
    };
    for (const m of messages) {
        if (m?.role === "assistant") {
            const text = textOf(m.content);
            say(false, [
                ...(text ? [new vs.LanguageModelTextPart(text)] : []),
                ...(Array.isArray(m.tool_calls) ? m.tool_calls : []).filter((c: any) => c?.function?.name)
                    .map((c: any) => new vs.LanguageModelToolCallPart(String(c.id), String(c.function.name), argsOf(c.function.arguments))),
            ]);
        } else if (m?.role === "tool") {
            say(true, [new vs.LanguageModelToolResultPart(String(m.tool_call_id), [new vs.LanguageModelTextPart(textOf(m.content))])]);
        } else if (m) {
            say(true, userParts(vs, m.content));
        }
    }
    // Results before anything else the writer's side says (pictures, words): some models want them first.
    for (const t of turns) {
        if (t.user) { t.parts.sort((a, b) => Number(b instanceof vs.LanguageModelToolResultPart) - Number(a instanceof vs.LanguageModelToolResultPart)); }
    }
    return turns.map((t) => (t.user ? vs.LanguageModelChatMessage.User(t.parts) : vs.LanguageModelChatMessage.Assistant(t.parts)));
}

/** Words and pictures from the writer's side; a picture as words where VS Code takes none. */
function userParts(vs: LmClasses, content: unknown): any[] {
    if (!Array.isArray(content)) { const text = textOf(content); return text ? [new vs.LanguageModelTextPart(text)] : []; }
    return content.map((p: any) => {
        if (p?.type === "image_url") {
            const picture = /^data:([^;,]+);base64,(.*)$/s.exec(String(p.image_url?.url ?? ""));
            return picture && vs.LanguageModelDataPart
                ? vs.LanguageModelDataPart.image(Buffer.from(picture[2], "base64"), picture[1])
                : new vs.LanguageModelTextPart("[a picture this VS Code can't pass on]");
        }
        return new vs.LanguageModelTextPart(String(p?.text ?? ""));
    }).filter((p) => !(p instanceof vs.LanguageModelTextPart) || p.value);
}

function textOf(content: unknown): string {
    if (typeof content === "string") { return content; }
    return Array.isArray(content) ? content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("") : "";
}

function argsOf(args: unknown): object {
    if (args && typeof args === "object") { return args as object; }
    try {
        const v = JSON.parse(String(args ?? "") || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
        return {};
    }
}

/**
 * How much a request reads, in tokens: the model's own count of its words, else an estimate. The API
 * says nothing of it, and the mind summarizes its conversation by it.
 */
async function inputTokens(chat: vscode.LanguageModelChat, messages: readonly any[]): Promise<number> {
    const text = messages.map((m) => [textOf(m?.content), ...(Array.isArray(m?.tool_calls) ? m.tool_calls.map((c: any) => String(c?.function?.arguments ?? "")) : [])].join("\n")).join("\n");
    const estimate = Math.ceil(text.length / 4);
    try {
        const counted = await Promise.race([chat.countTokens(text), new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 5_000).unref?.(); })]);
        return typeof counted === "number" && counted > 0 ? counted : estimate;
    } catch {
        return estimate;
    }
}

/** A failure of VS Code's API, with what it said (a LanguageModelError's cause is often the telling part). */
function copilotError(vs: LmClasses, err: unknown): CopilotError {
    if (err instanceof CopilotError) { return err; }
    const code = err instanceof vs.LanguageModelError ? err.code || "Unknown" : "Unknown";
    const said = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "").trim();
    const message = [...new Set([said(err), said((err as { cause?: unknown })?.cause)].filter(Boolean))].join(": ") || "no reason given";
    return new CopilotError(code, message);
}

/** What a failure on GitHub Copilot means for the session, in words for the writer; undefined when it isn't Copilot's. */
export function describeCopilotFailure(err: unknown, id: string): ApiFailure | undefined {
    if (!(err instanceof CopilotError)) { return undefined; }
    const said = err.message.slice(0, 200);
    const lower = err.message.toLowerCase();
    const model = modelName(id, "copilot");
    // (the plan's allowance is spent, rather than a pause asked for)
    const spent = /quota|allowance|monthly|premium request|upgrade/.test(lower);
    switch (err.code) {
        case "NoPermissions":
            // (VS Code's own words name Euterpe by its extension id: the log has them)
            return { failure: "sign-in", why: "Euterpe may not use GitHub Copilot's models: start the session again, and allow it when VS Code asks." };
        case "NotFound":
            return { failure: "model", why: `GitHub Copilot doesn't offer ${model} here. Pick another with Euterpe: Choose Model.` };
        case "Blocked":
            return { failure: "other", why: spent ? `You've reached a usage limit on your GitHub Copilot plan: ${said}` : `GitHub Copilot is limiting Euterpe for now: ${said}` };
    }
    if (/token limit|exceeds the limit|context (length|window)|maximum context|too many tokens|(prompt|input|messages?) (is |are )?too long|max_prompt_tokens/.test(lower)) {
        return { failure: "other", overflow: true, why: `${model} can't read that much at once on GitHub Copilot: its context is too small for Euterpe's instructions and your document.` };
    }
    if (/off_topic|off-topic/.test(lower)) {
        return { failure: "other", why: "GitHub Copilot turned that one down as off-topic." };
    }
    if (spent) {
        return { failure: "other", why: `You've reached a usage limit on your GitHub Copilot plan: ${said}` };
    }
    if (/rate.?limit|usage limit|limit (reached|exceeded)/.test(lower)) {
        return { failure: "other", why: `GitHub Copilot is limiting Euterpe for now: ${said}` };
    }
    if (/model/.test(lower) && /not (supported|found|available|enabled)|unsupported|disabled/.test(lower)) {
        return { failure: "model", why: `GitHub Copilot can't run Euterpe's mind on ${model}: ${said} Pick another with Euterpe: Choose Model.` };
    }
    return { failure: "other", why: `GitHub Copilot couldn't answer: ${said}` };
}
