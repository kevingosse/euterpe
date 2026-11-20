import { ChildProcess, spawn } from "child_process";
import { ATTENTION } from "./attention";
import { Mind, MindOptions, TurnFailure } from "./mind";

export interface ClaudeMindOptions extends MindOptions {
    claudePath: string;
    /** "" = the CLI's default effort. */
    effort: string;
    /** Claude Code config directory (CLAUDE_CONFIG_DIR) for the mind's process; "" = inherit the environment. */
    configDir: string;
    systemPromptFile: string;
    /** --settings file, written by the session from mindSettings(). */
    settingsFile: string;
    memoryDir: string;
    workspaceDir: string;
    /** --mcp-config file for the extension's own tools (propose_edit); "" = none. */
    mcpConfigFile: string;
    /** Claude Code's auto-compact window (Attention.compactWindow); default: the closest attention's. */
    compactWindow?: number;
    /** Mirror the raw stream-json traffic into the log. */
    debug: boolean;
    /** Tap on the same traffic for richer rendering (debug console). */
    onTraffic?: (dir: "out" | "in", line: string) => void;
    /** Injectable for tests. */
    spawnProcess?: (command: string, args: string[], cwd: string) => ChildProcess;
}

/**
 * A working agent's toolset. Left out on purpose: subagents, skills, scheduling
 * and monitors, which run in the background and would start turns of their own
 * outside the extension's turn-taking.
 */
const TOOLS = [
    "Bash", ...(process.platform === "win32" ? ["PowerShell"] : []),
    "Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit", "WebSearch", "WebFetch",
];
/** The extension's own tools, served over MCP (see proposals.ts). */
export const MCP_SERVER_NAME = "euterpe";
const MAX_RESTARTS = 3;
const CONTROL_TIMEOUT_MS = 10_000;
/** How long an interrupted turn gets to end before its process is taken for hung. */
const INTERRUPT_GRACE_MS = 60_000;
const STDERR_TAIL = 20;

/**
 * The claude CLI arguments. Euterpe's process is isolated from the user's own Claude
 * Code setup: --setting-sources local skips the user and project settings (so no
 * CLAUDE.md, hooks or plugins), --strict-mcp-config drops every MCP server and
 * connector but the extension's own, and --tools pins the built-in toolset.
 * Without this Euterpe would inherit the user's coding instructions, connectors
 * (Drive, Gmail…) and Stop hooks. (--safe-mode also drops the servers given with
 * --mcp-config; --restricted confines the file tools and refuses bypassPermissions.)
 * Within that, Euterpe has a full agent's reach — any file, the shell, the web —
 * with no permission prompts: where it may go unasked is the system prompt's
 * business (the workspace, its own memory), not the harness's.
 */
export function buildMindArgs(o: {
    sessionId: string;
    resume: boolean;
    systemPromptFile: string;
    /** --settings file (see mindSettings): kept out of the command line, it may hold credentials. */
    settingsFile: string;
    workspaceDir: string;
    mcpConfigFile: string;
    model: string;
    effort: string;
}): string[] {
    const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        o.resume ? "--resume" : "--session-id", o.sessionId,
        // Full replacement: the default Claude Code prompt is a coding
        // agent's, and would fight the persona. system-prompt.md is
        // self-contained (identity, IO contract, memory, tool rules).
        "--system-prompt-file", o.systemPromptFile,
        "--setting-sources", "local",
        "--strict-mcp-config",
        "--tools", TOOLS.join(","),
        "--permission-mode", "bypassPermissions",
        // the few things bypass mode still asks about are refused, not left hanging
        "--permission-prompts", "none",
        "--settings", o.settingsFile,
        "--add-dir", o.workspaceDir,
    ];
    if (o.mcpConfigFile) { args.push("--mcp-config", o.mcpConfigFile); }
    if (o.model) { args.push("--model", o.model); }
    if (o.effort) { args.push("--effort", o.effort); }
    return args;
}

/**
 * Keys of the writer's own Claude settings that decide how Claude Code signs in and reaches
 * the API. --setting-sources local keeps those settings away from the mind (their CLAUDE.md,
 * hooks and plugins have no business there), but without these a sign-in other than the
 * standard login — an API key or key helper, Bedrock, Vertex, a gateway, a proxy — would
 * fail for Euterpe while working in the writer's terminal.
 */
const AUTH_SETTINGS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "forceLoginMethod", "forceLoginOrgUUID"];
const AUTH_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_SKIP_|CLAUDE_CODE_CLIENT_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_OAUTH_TOKEN$|AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_|VERTEX_REGION_|AZURE_|(HTTPS?|NO)_PROXY$|NODE_EXTRA_CA_CERTS$|SSL_CERT_)/i;

/**
 * The mind's --settings: no co-author trailer (commits Euterpe makes for the writer are
 * theirs), plus the sign-in part of the writer's own Claude settings (userSettings: their
 * settings.json, parsed; anything else counts as none).
 */
export function mindSettings(userSettings: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = { attribution: { commit: "", pr: "" } };
    if (!userSettings || typeof userSettings !== "object") { return out; }
    const s = userSettings as Record<string, unknown>;
    for (const k of AUTH_SETTINGS) {
        if (typeof s[k] === "string" && s[k]) { out[k] = s[k]; }
    }
    if (s.env && typeof s.env === "object") {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
            if (AUTH_ENV.test(k) && typeof v === "string") { env[k] = v; }
        }
        if (Object.keys(env).length) { out.env = env; }
    }
    return out;
}

/**
 * Variables a Claude Code session (or its IDE integration) sets for its own children. An
 * editor launched from inside one inherits them, and they would make the mind believe it's
 * nested in that session, or signed in through it.
 */
const INHERITED_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"];

/**
 * The environment of the claude process. CLAUDE_CONFIG_DIR decides which Claude
 * Code installation runs the mind — its login (a subscription or an API key),
 * settings and session history — and VS Code started from the Start menu doesn't
 * necessarily have the one a shell launcher sets, so it can be pinned here.
 * compactWindow: see Attention.compactWindow; the perceptions of an hour ago aren't
 * worth keeping verbatim at the price of re-reading them at every look.
 */
export function buildMindEnv(base: NodeJS.ProcessEnv, configDir: string, compactWindow = ATTENTION.close.compactWindow): NodeJS.ProcessEnv {
    const inherited = { ...base };
    for (const k of INHERITED_MARKERS) { delete inherited[k]; }
    const env: NodeJS.ProcessEnv = {
        ...inherited,
        // The 1h prompt-cache TTL normally comes from the user's settings env;
        // perceptions can be many minutes apart, so make sure it's on.
        ENABLE_PROMPT_CACHING_1H: "1",
        // Euterpe keeps its own memory in its home, not Claude Code's.
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        // A background command would start a turn of its own when it finishes,
        // outside the extension's turn-taking.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        // Capped by the model's own window; the environment beats any settings file.
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactWindow),
    };
    if (configDir) { env.CLAUDE_CONFIG_DIR = configDir; }
    return env;
}

/**
 * The mind on Claude: a persistent `claude` headless process (stream-json in/out), on the
 * writer's own Claude Code login. It keeps the process alive, resuming the same conversation
 * if it crashes.
 */
export class ClaudeMind extends Mind {
    private proc: ChildProcess | null = null;
    private buffer = "";
    private restarts = 0;
    private okTurnsThisProcess = 0;
    private stderrLines: string[] = [];
    private loggedModel = false;
    private initModel = "";
    private controlSeq = 0;
    /** Control requests waiting for Claude Code's answer, by request_id: settled with its error, or null. */
    private readonly controls = new Map<string, (error: string | null) => void>();

    constructor(private readonly opts: ClaudeMindOptions) {
        super(opts);
    }

    /**
     * Tell the running process to use `model`; between restarts, the next launch takes it.
     * Turns wait for the answer (Claude Code may check the account first), so the next one
     * runs on the model that was asked for.
     */
    protected requestModel(model: string): Promise<string | null> {
        if (!this.proc) { return Promise.resolve(null); }
        return new Promise((resolve) => {
            const id = `model-${++this.controlSeq}`;
            const settle = (error: string | null) => {
                clearTimeout(timer);
                this.controls.delete(id);
                resolve(error);
                this.pump();
            };
            // A Claude Code that never answers: take it as done (a failing turn would tell).
            const timer = setTimeout(() => settle(null), CONTROL_TIMEOUT_MS);
            timer.unref?.();
            this.controls.set(id, settle);
            this.write({ type: "control_request", request_id: id, request: model ? { subtype: "set_model", model } : { subtype: "set_model" } });
        });
    }

    /** Graceful: close stdin and let it exit; `now` kills immediately. */
    protected shutdown(now: boolean): void {
        this.settleControls();
        const proc = this.proc;
        this.proc = null;
        if (proc) {
            try { proc.stdin?.end(); } catch { /* ignore */ }
            if (now) {
                try { proc.kill(); } catch { /* ignore */ }
            } else {
                setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 3000);
            }
        }
    }

    // ---------- process ----------

    protected launch(resume: boolean): void {
        const args = buildMindArgs({
            sessionId: this.sessionId,
            resume,
            systemPromptFile: this.opts.systemPromptFile,
            settingsFile: this.opts.settingsFile,
            workspaceDir: this.opts.workspaceDir,
            mcpConfigFile: this.opts.mcpConfigFile,
            model: this.currentModel,
            effort: this.opts.effort,
        });
        this.opts.log(`${resume ? "resuming" : "spawning"} ${this.opts.claudePath} (session ${this.sessionId})`);
        const inherited = process.env.CLAUDE_CONFIG_DIR;
        this.opts.log(`claude config: ${this.opts.configDir
            ? `${this.opts.configDir} (euterpe.claudeConfigDir)`
            : inherited ? `${inherited} (inherited CLAUDE_CONFIG_DIR)` : "~/.claude (Claude Code default)"}`);
        if (this.opts.debug) {
            this.opts.log(`args: ${JSON.stringify(args)}`);
        }

        // The mind lives in a separate home, not the writer's project: a stable
        // Claude Code project dir across sessions, and no stray CLAUDE.md
        // from a coding repo bleeding into the mind's context. The workspace is
        // reachable via --add-dir and announced in every perception.
        const proc = this.opts.spawnProcess
            ? this.opts.spawnProcess(this.opts.claudePath, args, this.opts.memoryDir)
            : spawn(this.opts.claudePath, args, {
                cwd: this.opts.memoryDir,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                env: buildMindEnv(process.env, this.opts.configDir, this.opts.compactWindow),
            });
        this.proc = proc;
        this.buffer = "";
        this.okTurnsThisProcess = 0;

        proc.stdout!.setEncoding("utf8");
        proc.stdout!.on("data", (chunk: string) => { if (proc === this.proc) { this.onStdout(chunk); } });
        proc.stderr!.setEncoding("utf8");
        proc.stderr!.on("data", (chunk: string) => {
            for (const l of chunk.split(/\r?\n/)) {
                if (!l.trim()) { continue; }
                this.stderrLines.push(l.trim());
                this.opts.log(`[claude stderr] ${l.trim()}`);
            }
            this.stderrLines.splice(0, Math.max(0, this.stderrLines.length - STDERR_TAIL));
        });
        // Writing to a pipe whose process just died raises EPIPE on stdin;
        // unhandled, that would take the extension host down with it.
        proc.stdin!.on("error", (err) => this.opts.log(`claude stdin error: ${err.message}`));
        proc.on("exit", (code) => this.onExit(proc, code));
        proc.on("error", (err) => this.onSpawnError(proc, err));
    }

    private onSpawnError(proc: ChildProcess, err: Error): void {
        if (proc !== this.proc) { return; }
        this.proc = null;
        this.opts.log(`claude spawn error: ${err.message}`);
        this.die(`Could not run \`${this.opts.claudePath}\` (${err.message}). Is Claude Code installed? Set euterpe.claudePath if it isn't on PATH.`);
    }

    private onExit(proc: ChildProcess, code: number | null): void {
        if (proc !== this.proc) { return; }
        this.proc = null;
        this.opts.log(`claude exited with code ${code}`);
        const inflight = this.inflight;
        this.inflight = null;
        this.settleControls();   // a restart launches on the model asked for
        if (this.disposed) { return; }

        this.opts.invalidate();
        if (inflight) {
            inflight.turn.waiters.forEach((w) => w(null));
            if (inflight.turn.kind === "chat") {
                this.emit("turn-error", "Euterpe lost the thread mid-answer — could you say that again?", "chat");
            }
        }

        // A process that never managed a single turn won't do better on a
        // retry (bad model name, not logged in, broken install): report it.
        if (this.okTurnsThisProcess === 0 || this.restarts >= MAX_RESTARTS) {
            const why = this.okTurnsThisProcess === 0
                ? `Euterpe's mind (claude) exited with code ${code} before answering.`
                : `Euterpe's mind (claude) crashed ${this.restarts + 1} times.`;
            this.die(why + this.stderrSuffix());
            return;
        }
        this.restarts++;
        this.opts.log(`resuming the conversation (restart ${this.restarts}/${MAX_RESTARTS})`);
        this.emit("restarted", this.restarts);
        setTimeout(() => {
            if (this.disposed || this.isDead) { return; }
            this.launch(true);
            this.pump();
        }, 1000);
    }

    /** No answer is coming for the control requests sent: the process is gone. */
    private settleControls(): void {
        for (const settle of [...this.controls.values()]) { settle(null); }
    }

    private stderrSuffix(): string {
        const tail = this.stderrLines.slice(-6).join(" · ");
        return tail ? ` Last output: ${tail.slice(0, 600)}` : "";
    }

    // ---------- turns ----------

    protected canSend(): boolean {
        return this.proc !== null && this.controls.size === 0;
    }

    protected sendTurn(text: string): void {
        this.write({
            type: "user",
            message: { role: "user", content: [{ type: "text", text }] },
        });
    }

    private write(obj: object): void {
        const line = JSON.stringify(obj);
        if (this.opts.debug) {
            this.opts.log(`[mind >>] ${line}`);
        }
        this.opts.onTraffic?.("out", line);
        this.proc?.stdin?.write(line + "\n");
    }

    protected interruptTurn(): void {
        const proc = this.proc;
        if (!proc) { return; }
        this.write({
            type: "control_request",
            request_id: `interrupt-${Date.now()}`,
            request: { subtype: "interrupt" },
        });
        // A process too stuck to hear that would hold every turn behind this one for good, with
        // Euterpe looking alive: it's stopped instead, and the conversation resumed (onExit).
        const stuck = this.inflight;
        const timer = setTimeout(() => {
            if (this.proc !== proc || !stuck || this.inflight !== stuck) { return; }
            this.opts.log("the stuck turn didn't end: restarting claude");
            try { proc.kill(); } catch { /* gone already */ }
        }, INTERRUPT_GRACE_MS);
        timer.unref?.();
    }

    private onStdout(chunk: string): void {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) { continue; }
            if (this.opts.debug) {
                this.opts.log(`[mind <<] ${line}`);
            }
            this.opts.onTraffic?.("in", line);
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                this.opts.log(`unparseable stdout line: ${line.slice(0, 200)}`);
                continue;
            }
            this.onMessage(msg);
        }
    }

    private onMessage(msg: any): void {
        if (msg.type === "system" && msg.subtype === "init" && this.loggedModel) {
            // Again after a model switch or a restart.
            if (msg.model !== this.initModel) { this.opts.log(`mind now on model ${msg.model}`); }
            this.initModel = msg.model;
        } else if (msg.type === "system" && msg.subtype === "init") {
            this.loggedModel = true;
            this.initModel = msg.model;
            // "none" = the Claude login (a subscription); anything else names the API key paying for it
            const login = msg.apiKeySource === undefined ? "unknown"
                : msg.apiKeySource === "none" ? "Claude login (subscription)" : `API key (${msg.apiKeySource})`;
            this.opts.log(`mind ready: model ${msg.model}, billed to: ${login}, tools ${JSON.stringify(msg.tools)}`);
            for (const s of Array.isArray(msg.mcp_servers) ? msg.mcp_servers : []) {
                if (s?.status !== "connected") { this.opts.log(`tool server ${s?.name} is ${s?.status} — Euterpe can't propose edits`); }
            }
            // A managed Claude Code policy can forbid skipping permission prompts; with no one
            // to answer them, every tool call would then be refused.
            if (typeof msg.permissionMode === "string" && msg.permissionMode !== "bypassPermissions") {
                this.opts.log(`permission mode is ${msg.permissionMode}, not bypassPermissions`);
                this.emit("restricted", msg.permissionMode);
            }
        } else if (msg.type === "system" && msg.subtype === "compact_boundary") {
            const m = msg.compact_metadata ?? {};
            this.opts.log(`conversation compacted (${m.trigger ?? "?"}): ${m.pre_tokens ?? "?"} → ${m.post_tokens ?? "?"} tokens`);
            this.compacted();
        } else if (msg.type === "rate_limit_event" && msg.rate_limit_info?.status && msg.rate_limit_info.status !== "allowed") {
            this.opts.log(`rate limit: ${JSON.stringify(msg.rate_limit_info)}`);
        } else if (msg.type === "control_response") {
            const r = msg.response ?? {};
            this.controls.get(r.request_id)?.(r.subtype === "error" ? String(r.error || "refused") : null);
        } else if (msg.type === "result") {
            this.onResult(msg);
        }
    }

    private onResult(msg: any): void {
        if (msg.subtype === "success" && !msg.is_error) {
            this.okTurnsThisProcess++;
            this.completeTurn(String(msg.result ?? ""));
            return;
        }
        const why = describeFailure(msg, this.inflight?.interrupted ?? false);
        this.opts.log(`turn failed (${msg.subtype}): ${JSON.stringify(msg).slice(0, 400)}`);
        const failure: TurnFailure = isSignInFailure(msg) ? "sign-in" : isModelFailure(msg) ? "model" : "other";
        this.failTurn(why, failure);
    }
}

const SIGN_IN_FAILURE = /not logged in|please run \/login|invalid api key|login expired|oauth token (has been )?(revoked|expired)|invalid auth token|could not resolve authentication|apiKeyHelper.*fail/i;

/** A turn that failed because Claude Code couldn't sign in (as opposed to a flaky one). */
export function isSignInFailure(msg: any): boolean {
    return typeof msg?.result === "string" && SIGN_IN_FAILURE.test(msg.result);
}

const MODEL_FAILURE = /issue with the selected model \(([^)]*)\)|the model (\S+) is not available on your/i;

/** A turn that failed because Claude Code can't run the model it was given (unknown, or out of this account's reach). */
export function isModelFailure(msg: any): boolean {
    return typeof msg?.result === "string" && MODEL_FAILURE.test(msg.result);
}

/** A short human explanation of a failed turn. */
export function describeFailure(msg: any, interrupted: boolean): string {
    if (interrupted) {
        return "Euterpe got stuck on that one for minutes and let it go.";
    }
    const text = typeof msg.result === "string" ? msg.result.trim() : "";
    if (isSignInFailure(msg)) {
        return `Euterpe's mind couldn't sign in to Claude ("${text.slice(0, 200)}"). Check that Claude Code works in a terminal: run \`claude\`, and /login if it asks. Then start the session again.`;
    }
    const model = text.match(MODEL_FAILURE);
    if (model) {
        return `Claude Code can't run Euterpe's mind on ${model[1] || model[2] || "that model"}: it may not exist, or you may not have access to it. Pick another with Euterpe: Choose Model.`;
    }
    const limit = text.match(/usage limit reached\|(\d{9,})/i);
    if (limit) {
        const at = new Date(Number(limit[1]) * 1000);
        return `Claude usage limit reached — Euterpe will be back around ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
    }
    if (text) {
        return text.length > 300 ? text.slice(0, 300) + "…" : text;
    }
    const errors = Array.isArray(msg.errors) ? msg.errors.join("; ") : "";
    return `Euterpe's turn failed (${msg.subtype ?? "unknown error"}${errors ? `: ${errors.slice(0, 200)}` : ""}).`;
}
