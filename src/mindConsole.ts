import * as vscode from "vscode";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";

const BODY_LIMIT = 1500;

/** What a mind with no stream of its own (openaiMind.ts) tells the console. */
export type MindEvent =
    | { kind: "ready"; text: string }
    /** A turn's text: a perception, with the writer's chat if it's one. */
    | { kind: "sent"; text: string }
    | { kind: "say"; text: string }
    | { kind: "tool"; name: string; input: string }
    | { kind: "tool-result"; text: string; error: boolean }
    | { kind: "turn"; ok: boolean; secs: number; detail: string };

function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit)}… (+${text.length - limit} chars)`;
}

/**
 * A debug terminal for the mind ("Euterpe Mind" in the terminal panel).
 * The mind is a headless piped process, so there is no real console to
 * unhide; this pseudoterminal renders its stream-json traffic as a
 * readable transcript instead. Anything typed into it is delivered to
 * the mind as a chat turn — a side channel next to the overlay chat.
 */
export class MindConsole implements vscode.Pseudoterminal {
    private static current: MindConsole | null = null;

    private readonly writeEmitter = new vscode.EventEmitter<string>();
    readonly onDidWrite = this.writeEmitter.event;

    private readonly terminal: vscode.Terminal;
    private opened = false;
    private pending = "";
    private inputLine = "";

    constructor(private onSend: ((text: string) => void) | null) {
        // One console at a time; a new session replaces the previous one.
        MindConsole.current?.dispose();
        MindConsole.current = this;
        this.terminal = vscode.window.createTerminal({ name: "Euterpe Mind", pty: this });
        this.terminal.show(true);
        this.line(`${DIM}Euterpe mind console — raw traffic is in the Euterpe output channel; type here to talk to Euterpe directly.${RESET}`);
    }

    open(): void {
        this.opened = true;
        if (this.pending) {
            this.writeEmitter.fire(this.pending);
            this.pending = "";
        }
    }

    close(): void {
        if (MindConsole.current === this) {
            MindConsole.current = null;
        }
    }

    handleInput(data: string): void {
        if (!this.onSend || data.startsWith("\x1b")) { return; } // ignore arrow keys etc.
        for (const ch of data) {
            if (ch === "\r") {
                const text = this.inputLine.trim();
                this.inputLine = "";
                this.write("\r\n");
                if (text) {
                    this.line(`${BOLD}${MAGENTA}you (console):${RESET} ${text}`);
                    this.onSend(text);
                }
            } else if (ch === "\x7f" || ch === "\b") {
                if (this.inputLine) {
                    this.inputLine = this.inputLine.slice(0, -1);
                    this.write("\b \b");
                }
            } else if (ch >= " ") {
                this.inputLine += ch;
                this.write(ch);
            }
        }
    }

    /** Render what an API mind did. */
    event(e: MindEvent): void {
        switch (e.kind) {
            case "ready": this.line(`${CYAN}● ${e.text}${RESET}`); break;
            case "sent": this.renderSent(e.text); break;
            case "say": this.line(`${GREEN}Euterpe:${RESET} ${e.text.trim()}`); break;
            case "tool": this.line(`${CYAN}⚙ ${e.name}${RESET} ${DIM}${truncate(e.input, 200)}${RESET}`); break;
            case "tool-result": this.line(`${e.error ? RED : DIM}↩ ${truncate(e.text, 200)}${RESET}`); break;
            case "turn": this.line(e.ok
                ? `${YELLOW}✓ turn ${e.secs.toFixed(1)}s · ${e.detail}${RESET}`
                : `${RED}✗ turn failed after ${e.secs.toFixed(1)}s: ${truncate(e.detail, 200)}${RESET}`);
                break;
        }
    }

    /** Render one line of stream-json traffic (dir: what we sent / what came back). */
    traffic(dir: "out" | "in", rawLine: string): void {
        try {
            if (dir === "out") {
                this.renderOut(rawLine);
            } else {
                this.renderIn(rawLine);
            }
        } catch {
            this.line(`${DIM}${truncate(rawLine, 400)}${RESET}`);
        }
    }

    sessionEnded(): void {
        this.onSend = null;
        this.line("");
        this.line(`${DIM}── session ended ──${RESET}`);
    }

    dispose(): void {
        if (MindConsole.current === this) {
            MindConsole.current = null;
        }
        this.terminal.dispose();
    }

    private renderOut(rawLine: string): void {
        const msg = JSON.parse(rawLine);
        if (msg.type === "control_request") {
            this.line(`${DIM}▸ control: ${msg.request?.subtype ?? "?"}${msg.request?.model ? ` ${msg.request.model}` : ""}${RESET}`);
            return;
        }
        this.renderSent(msg?.message?.content?.[0]?.text ?? "");
    }

    private renderSent(text: string): void {
        const perception = text.match(/<euterpe:perception reason="([\w-]+)">\n?([\s\S]*?)\n?<\/euterpe:perception>/);
        const chat = text.match(/<euterpe:chat>\n?([\s\S]*?)\n?<\/euterpe:chat>/);
        this.line("");
        if (perception) {
            this.line(`${MAGENTA}▸ perception (${perception[1]})${RESET}`);
            this.line(`${DIM}${truncate(perception[2], BODY_LIMIT)}${RESET}`);
        }
        if (chat) {
            this.line(`${BOLD}${MAGENTA}▸ writer:${RESET} ${chat[1]}`);
        }
        if (!perception && !chat) {
            this.line(`${DIM}${truncate(text, BODY_LIMIT)}${RESET}`);
        }
    }

    private renderIn(rawLine: string): void {
        const msg = JSON.parse(rawLine);
        switch (msg.type) {
            case "system":
                if (msg.subtype === "init") {
                    this.line(`${CYAN}● session ${msg.session_id} · model ${msg.model}${RESET}`);
                }
                break;
            case "assistant":
                for (const item of msg?.message?.content ?? []) {
                    if (item.type === "text" && item.text?.trim()) {
                        this.line(`${GREEN}Euterpe:${RESET} ${item.text.trim()}`);
                    } else if (item.type === "tool_use") {
                        this.line(`${CYAN}⚙ ${item.name}${RESET} ${DIM}${truncate(JSON.stringify(item.input ?? {}), 200)}${RESET}`);
                    }
                }
                break;
            case "user":
                for (const item of msg?.message?.content ?? []) {
                    if (item.type === "tool_result") {
                        const content = typeof item.content === "string"
                            ? item.content
                            : JSON.stringify(item.content ?? "");
                        this.line(`${DIM}↩ ${truncate(content, 200)}${RESET}`);
                    }
                }
                break;
            case "result": {
                const u = msg.usage ?? {};
                const secs = ((msg.duration_ms ?? 0) / 1000).toFixed(1);
                if (msg.subtype === "success" && !msg.is_error) {
                    this.line(`${YELLOW}✓ turn ${secs}s · cache read ${u.cache_read_input_tokens ?? 0} · cache write ${u.cache_creation_input_tokens ?? 0} · in ${u.input_tokens ?? 0} · out ${u.output_tokens ?? 0}${RESET}`);
                } else {
                    const why = typeof msg.result === "string" && msg.result ? `: ${truncate(msg.result, 200)}` : "";
                    this.line(`${RED}✗ turn failed (${msg.subtype})${why} after ${secs}s${RESET}`);
                }
                break;
            }
        }
    }

    private line(text: string): void {
        this.write(text + "\r\n");
    }

    private write(text: string): void {
        const out = text.replace(/(?<!\r)\n/g, "\r\n");
        if (this.opened) {
            this.writeEmitter.fire(out);
        } else {
            this.pending += out; // pty not attached yet; flush in open()
        }
    }
}
