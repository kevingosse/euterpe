import * as crypto from "crypto";
import { EventEmitter } from "events";
import { PerceptionReason, REASON_PRIORITY, RenderedPerception } from "./perception";
import { isAction, isExpression, MindResponse } from "./protocol";

/** What every mind needs, whichever model it thinks with (claudeMind.ts, openaiMind.ts). */
export interface MindOptions {
    /** The model to start on: "" = the backend's default. */
    model: string;
    log: (msg: string) => void;
    /** Writes the perception block for a turn at the moment it is sent, so it is never stale. */
    perceive: (reason: PerceptionReason) => RenderedPerception;
    /** The next perception must carry the full document (something may have been missed). */
    invalidate: () => void;
}

type Waiter = (response: MindResponse | null) => void;

type QueuedTurn =
    | { kind: "perception"; reason: PerceptionReason; waiters: Waiter[]; retried?: boolean }
    | { kind: "chat"; text: string; waiters: Waiter[]; retried?: boolean };

interface InFlight {
    turn: QueuedTurn;
    commit: () => void;
    startedAt: number;
    warned: boolean;
    interrupted: boolean;
    /** The conversation was compacted during this turn. */
    compacted: boolean;
}

/**
 * Why a turn failed, as far as the turn-taking goes: a sign-in or a model that can't run would fail
 * every turn; a sign-in that ended ("signed-out") holds the turns until the writer signs in again.
 */
export type TurnFailure = "sign-in" | "signed-out" | "model" | "other";

const TURN_WARN_MS = 120_000;
const TURN_INTERRUPT_MS = 240_000;

/**
 * Euterpe's mind: a model on the other side of a pipe or an API, taking one turn at a time.
 * All judgment lives over there; this class only moves messages, serializes turns, coalesces
 * stale perceptions, and lets the writer switch models mid-session. How a turn reaches the
 * model is the backend's business (ClaudeMind, OpenAIMind); a backend reports each turn's end
 * with completeTurn or failTurn.
 *
 * Events: "response" (MindResponse, turn kind), "thinking", "turn-error" (text, turn kind),
 * "died" (message), "signed-out" (message: turns wait for resume()), "compacted", "model-refused"
 * (failed model, model back on), and per backend "restarted" (count) and "restricted" (permission mode).
 */
export abstract class Mind extends EventEmitter {
    readonly sessionId = crypto.randomUUID();
    private queue: QueuedTurn[] = [];
    protected inflight: InFlight | null = null;
    protected disposed = false;
    private dead = false;
    /** The sign-in ended: turns wait until the writer signs in again (resume). */
    private held = false;
    private watchdog: NodeJS.Timeout | null = null;
    /** "" = the backend's default. The writer can switch it mid-session. */
    protected currentModel: string;
    /** After a switch, the model to go back to if the new one can't run a turn; null once one has. */
    private switchedFrom: string | null = null;

    constructor(private readonly base: MindOptions) {
        super();
        this.currentModel = base.model;
    }

    /** Alive and able to take turns (possibly mid-restart). */
    get alive(): boolean {
        return !this.disposed && !this.dead;
    }

    /** The model the mind runs on ("" = the backend's default). */
    get model(): string {
        return this.currentModel;
    }

    get isBusy(): boolean {
        return this.inflight !== null;
    }

    /** Its sign-in ended: turns wait until the writer signs in again. */
    get waitingForSignIn(): boolean {
        return this.held && this.alive;
    }

    /** The writer signed in again: the turns that waited go now. */
    resume(): void {
        if (!this.held || !this.alive) { return; }
        this.held = false;
        this.base.log("signed in again: Euterpe goes on");
        this.pump();
    }

    start(): void {
        this.launch(false);
        this.watchdog = setInterval(() => this.checkTurn(), 10_000);
        this.watchdog.unref?.();
    }

    /**
     * The writer said something. Always delivered, in order, ahead of any
     * waiting perception — and it carries its own fresh perception block, so
     * a perception still waiting in the queue has nothing left to say.
     */
    sendChat(text: string): Promise<MindResponse | null> {
        return new Promise((resolve) => {
            if (!this.alive) { resolve(null); return; }
            for (let i = this.queue.length - 1; i >= 0; i--) {
                const t = this.queue[i];
                if (t.kind === "perception" && t.reason !== "session_end") {
                    this.queue.splice(i, 1);
                    t.waiters.forEach((w) => w(null));
                }
            }
            const turn: QueuedTurn = { kind: "chat", text, waiters: [resolve] };
            const end = this.queue.findIndex((t) => t.kind === "perception"); // only session_end can remain
            if (end >= 0) { this.queue.splice(end, 0, turn); } else { this.queue.push(turn); }
            this.pump();
        });
    }

    /**
     * Wake the mind with a perception. At most one perception waits in the queue;
     * a newer request merges into it (the more significant reason wins —
     * the snapshot itself is only taken when the turn is sent).
     * Resolves with the response to that turn, or null if it was superseded
     * or failed.
     */
    requestPerception(reason: PerceptionReason): Promise<MindResponse | null> {
        return new Promise((resolve) => {
            if (!this.alive) { resolve(null); return; }
            if (reason !== "session_end" && this.queue.some((t) => t.kind === "chat")) {
                resolve(null); // a queued chat will carry a fresher view anyway
                return;
            }
            const waiting = this.queue.find((t) => t.kind === "perception");
            if (waiting && waiting.kind === "perception") {
                if (REASON_PRIORITY[reason] >= REASON_PRIORITY[waiting.reason]) {
                    waiting.reason = reason;
                }
                waiting.waiters.push(resolve);
            } else {
                this.queue.push({ kind: "perception", reason, waiters: [resolve] });
            }
            this.pump();
        });
    }

    /**
     * Think with another model from the next turn on. The conversation carries over (only the
     * prompt cache starts afresh). Resolves with the backend's reason if it refuses the model
     * (one it doesn't know, or that this account can't choose), else null. A model it takes but
     * can't run fails the next turn instead: the mind then goes back to the one before, retries
     * the turn, and says so ("model-refused").
     */
    setModel(model: string): Promise<string | null> {
        if (model === this.currentModel || !this.alive) { return Promise.resolve(null); }
        const from = this.currentModel;
        const unconfirmed = this.switchedFrom;
        this.currentModel = model;
        this.switchedFrom = unconfirmed ?? from;   // back to the last model that ran a turn
        this.base.log(`switching to ${model || "the default model"}`);
        return this.requestModel(model).then((error) => {
            if (error && this.currentModel === model) {
                this.base.log(`${model || "the default model"} was refused: ${error}`);
                this.currentModel = from;
                this.switchedFrom = unconfirmed;
            }
            return error;
        });
    }

    /** Graceful: let the backend finish what it can; `now` stops everything at once. */
    dispose(now = false): void {
        if (this.disposed) { return; }
        this.disposed = true;
        if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
        this.flushWaiters();
        this.shutdown(now);
    }

    // ---------- the backend ----------

    /** Get ready to take turns (a process to spawn, or nothing); `resume` continues the conversation. */
    protected abstract launch(resume: boolean): void;
    /** Whether a turn can be sent now (a process is there, no model switch is pending...). */
    protected abstract canSend(): boolean;
    /** Send one turn's text; its end comes back through completeTurn or failTurn. */
    protected abstract sendTurn(text: string): void;
    /**
     * Use `model` from the next turn on; resolves with the backend's reason if it refuses it, else
     * null. Turns wait while it's pending (canSend), so the next one runs on the model asked for.
     */
    protected abstract requestModel(model: string): Promise<string | null>;
    /** Stop a turn that has been running for minutes (the backend survives it). */
    protected abstract interruptTurn(): void;
    /** Let go of the backend (dispose). */
    protected abstract shutdown(now: boolean): void;

    // ---------- turns ----------

    protected pump(): void {
        if (this.inflight || this.held || this.disposed || this.dead || !this.canSend()) { return; }
        const turn = this.queue.shift();
        if (!turn) { return; }

        let rendered: RenderedPerception;
        try {
            rendered = this.base.perceive(turn.kind === "chat" ? "chat" : turn.reason);
        } catch (err) {
            this.base.log(`could not take a perception snapshot: ${(err as Error).message}`);
            turn.waiters.forEach((w) => w(null));
            this.pump();
            return;
        }
        // Cost throttle: a pause/heartbeat with nothing new to see (a chat
        // turn already carried the latest text) isn't worth a turn.
        if (turn.kind === "perception" && rendered.unchanged &&
            (turn.reason === "pause" || turn.reason === "heartbeat")) {
            turn.waiters.forEach((w) => w(null));
            this.pump();
            return;
        }
        const text = turn.kind === "chat"
            ? `${rendered.text}\n<euterpe:chat>\n${turn.text}\n</euterpe:chat>`
            : rendered.text;

        this.inflight = { turn, commit: rendered.commit, startedAt: Date.now(), warned: false, interrupted: false, compacted: false };
        if (turn.kind === "chat") {
            this.emit("thinking");
        }
        this.sendTurn(text);
    }

    /** The turn in flight ended with the mind's answer (its raw text). */
    protected completeTurn(raw: string): void {
        const inflight = this.inflight;
        this.inflight = null;
        const kind = inflight?.turn.kind ?? "perception";
        this.switchedFrom = null;   // the model runs
        inflight?.commit();
        if (inflight?.compacted) { this.base.invalidate(); }
        const response = parseMindResponse(raw, this.base.log);
        this.emit("response", response, kind);
        inflight?.turn.waiters.forEach((w) => w(response));
        this.pump();
    }

    /** The turn in flight failed; `why` is meant for the writer. */
    protected failTurn(why: string, failure: TurnFailure): void {
        const inflight = this.inflight;
        this.inflight = null;
        const kind = inflight?.turn.kind ?? "perception";
        if (failure === "sign-in") {
            // Nothing will work until the writer signs in again: end the session and say how.
            inflight?.turn.waiters.forEach((w) => w(null));
            this.die(why);
            return;
        }
        if (failure === "signed-out") {
            // Nothing works until the writer signs in again, which the session asks: the turn waits
            // for it, with the ones behind it, and goes first (with a full view) once they have.
            this.held = true;
            if (inflight) {
                this.base.invalidate();
                this.queue.unshift(inflight.turn);
            }
            this.emit("signed-out", why);
            return;
        }
        if (failure === "model") {
            if (this.switchedFrom !== null && inflight) {
                // The model just picked can't run here: back to the one before, and the turn again.
                const failed = this.currentModel;
                const back = this.switchedFrom;
                this.currentModel = back;
                this.switchedFrom = null;
                this.base.log(`${failed} can't run a turn: back to ${back || "the default model"}`);
                this.base.invalidate();
                this.queue.unshift(inflight.turn);   // sent once the switch back is done
                void this.requestModel(back);
                this.emit("model-refused", failed, back);
                this.pump();   // at once if the backend switched at once (canSend says)
                return;
            }
            // Every turn would fail the same way.
            inflight?.turn.waiters.forEach((w) => w(null));
            this.die(why);
            return;
        }
        // The mind may not have taken it in: resend the whole picture next time.
        this.base.invalidate();
        this.emit("turn-error", why, kind);
        inflight?.turn.waiters.forEach((w) => w(null));
        this.pump();
    }

    /**
     * Send the turn in flight again, with a fresh and full view (what it carried was written for a
     * conversation that's gone, say summarized to fit). Once per turn: false if it was already
     * retried, and the caller fails it instead.
     */
    protected retryTurn(): boolean {
        const inflight = this.inflight;
        if (!inflight || inflight.turn.retried) { return false; }
        this.inflight = null;
        inflight.turn.retried = true;
        this.base.invalidate();
        this.queue.unshift(inflight.turn);
        this.pump();
        return true;
    }

    /**
     * The conversation was summarized. The mind's copy of the document is in a summary now, so
     * the next view must be full; for a turn in flight, only once it commits (a commit clears the
     * invalidation).
     */
    protected compacted(): void {
        if (this.inflight) { this.inflight.compacted = true; } else { this.base.invalidate(); }
        this.emit("compacted");
    }

    /** The mind can't go on (the message says why, for the writer). */
    protected die(message: string): void {
        if (this.dead) { return; }
        this.dead = true;
        this.flushWaiters();
        if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
        this.emit("died", message);
    }

    protected get isDead(): boolean {
        return this.dead;
    }

    private flushWaiters(): void {
        const inflight = this.inflight;
        this.inflight = null;
        inflight?.turn.waiters.forEach((w) => w(null));
        for (const t of this.queue.splice(0)) { t.waiters.forEach((w) => w(null)); }
    }

    /** A stuck turn blocks everything behind it; interrupt it (the backend survives). */
    private checkTurn(): void {
        const f = this.inflight;
        if (!f) { return; }
        const age = Date.now() - f.startedAt;
        if (age > TURN_WARN_MS && !f.warned) {
            f.warned = true;
            this.base.log(`turn has been running for ${Math.round(age / 1000)} s`);
        }
        if (age > TURN_INTERRUPT_MS && !f.interrupted) {
            f.interrupted = true;
            this.base.log("interrupting a stuck turn");
            this.interruptTurn();
        }
    }
}

/**
 * Euterpe is instructed to answer with a bare JSON object. Models being
 * models, tolerate fences and stray prose; on total failure treat the text
 * as speech rather than dropping it.
 */
export function parseMindResponse(raw: string, log: (m: string) => void): MindResponse {
    const trimmed = raw.trim();
    const fallback: MindResponse = { expression: "neutral", say: trimmed || null, notes: 0, action: null };
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates = [fence ? fence[1].trim() : null, extractObject(trimmed)].filter((c): c is string => !!c);
    for (const c of candidates) {
        let obj: any;
        try {
            obj = JSON.parse(c);
        } catch {
            continue;
        }
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) { continue; }
        return {
            expression: isExpression(obj.expression) ? obj.expression : "neutral",
            say: typeof obj.say === "string" && obj.say.trim() ? obj.say : null,
            notes: Number.isFinite(obj.notes) ? Math.max(0, Math.floor(obj.notes)) : 0,
            action: isAction(obj.action) ? obj.action : null,
        };
    }
    if (trimmed) {
        log(`mind response was not valid JSON, using as speech: ${trimmed.slice(0, 120)}`);
    }
    return fallback;
}

/** The first balanced {...} in the text (string-aware), or null. */
function extractObject(text: string): string | null {
    const start = text.indexOf("{");
    if (start < 0) { return null; }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escaped) { escaped = false; }
            else if (c === "\\") { escaped = true; }
            else if (c === "\"") { inString = false; }
        } else if (c === "\"") {
            inString = true;
        } else if (c === "{") {
            depth++;
        } else if (c === "}") {
            depth--;
            if (depth === 0) { return text.slice(start, i + 1); }
        }
    }
    return null;
}
