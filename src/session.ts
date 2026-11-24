import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { agentTools } from "./agentTools";
import { Attention, attentionFor } from "./attention";
import { MANAGE_USAGE_URL } from "./chatgpt";
import { ClaudeMind, MCP_SERVER_NAME, mindSettings } from "./claudeMind";
import { updateSetting } from "./config";
import { COPILOT_NAME, describeCopilotFailure } from "./copilot";
import { chooseMascot, CLAWD, defaultMascot, findMascot, Mascot } from "./mascots";
import { mascotTools } from "./mascotTools";
import { McpServer, McpTool } from "./mcpServer";
import { Mind } from "./mind";
import { MindConsole } from "./mindConsole";
import { defaultModel, modelName, modelSetting, sameModel } from "./models";
import { ModelApi, OpenAIMind, PlanAuth } from "./openaiMind";
import { OverlayBridge } from "./overlayBridge";
import { PerceptionWriter } from "./perception";
import { choosePersona, Persona } from "./personas";
import { assemblePrompt, platformName } from "./prompt";
import { Decision, EditProposals } from "./proposals";
import { MindResponse } from "./protocol";
import { Endpoint, Provider } from "./providers";
import { displayName, isWatchable, Sensors } from "./sensors";

const GOODBYE_TIMEOUT_MS = 25_000;
/** The longest conversation a mind on an API keeps before summarizing it (see OpenAIMind's compactWindow). */
const API_COMPACT_WINDOW = 240_000;
/** On GitHub Copilot, the share of the model's window a conversation fills before it's summarized (the size is an estimate). */
const COPILOT_WINDOW_SHARE = 0.7;
const NOTES_REQUEST = "[The writer clicked your notes badge — they'd like the notes you're holding.]";

/** What the mind hears about its proposed edits, in the next perception. */
const DECISIONS: Record<Decision, (file: string) => string> = {
    accepted: (f) => `the writer accepted your edit to ${f}.`,
    rejected: (f) => `the writer rejected your edit to ${f}.`,
    dismissed: (f) => `the writer closed your proposed edit to ${f} without accepting it.`,
    stale: (f) => `the writer tried to accept your edit to ${f}, but the text it was meant for had changed since, so nothing was applied.`,
};

export type SessionEvent =
    | { kind: "started" }
    | { kind: "response"; response: MindResponse; turn: "chat" | "perception" }
    | { kind: "turn-error"; text: string }
    | { kind: "ended" };

export interface SessionHooks {
    log: (msg: string) => void;
    /** The session is gone (ended, failed, or torn down). */
    onEnded: () => void;
    onLeaving?: () => void;
    onEvent?: (e: SessionEvent) => void;
    /** Show the writer a mascot's model sheet (for an offer from the mind). */
    previewMascot?: (m: Mascot) => Promise<void>;
    /** Sign in with ChatGPT again (the mind's sign-in ended): true once signed in. */
    signIn?: () => Promise<boolean>;
    /** The mind waits for the writer to sign in again (true), or goes on (false). */
    onSignInWait?: (waiting: boolean) => void;
}

/**
 * Euterpe's home (euterpe.homeDir, else ~/.euterpe): memory, the writer's personas and mascots,
 * and the Claude Code project the mind runs in. EUTERPE_MEMORY_DIR overrides it (tests).
 */
export function memoryDir(): string {
    if (process.env.EUTERPE_MEMORY_DIR) { return process.env.EUTERPE_MEMORY_DIR; }
    const setting = vscode.workspace.getConfiguration("euterpe").get<string>("homeDir")?.trim();
    return setting ? expandHome(setting) : path.join(os.homedir(), ".euterpe");
}

/** A path with a leading ~ expanded. */
export function expandHome(p: string): string {
    return /^~([\\/]|$)/.test(p) ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * euterpe.claudeConfigDir with a leading ~ expanded; "" means inherit. A folder that
 * doesn't exist is refused: claude would quietly start a fresh, logged-out config there.
 */
export function resolveConfigDir(setting: string): string {
    const raw = setting.trim();
    if (!raw) { return ""; }
    const dir = expandHome(raw);
    if (!fs.existsSync(dir)) {
        throw new Error(`euterpe.claudeConfigDir points to ${dir}, which doesn't exist (it should be a Claude Code config folder, like ~/.claude).`);
    }
    return dir;
}

/** One writing session: the mind, the overlay, and the sensors on the writer's documents. */
export class WritingSession implements vscode.Disposable {
    private mind: Mind | null = null;
    private overlay: OverlayBridge | null = null;
    private sensors: Sensors | null = null;
    private proposals: EditProposals | null = null;
    private tools: McpServer | null = null;
    private readonly writer = new PerceptionWriter();
    /** Events for the next perception, until a turn carrying them succeeds. */
    private readonly events: string[] = [];
    private console: MindConsole | null = null;
    /** The session's own files (prompt, settings, tool config): private to the writer, removed at the end. */
    private tmpDir = "";
    private mascot: Mascot = CLAWD;
    /** What it started with of the settings only a new session takes on (the settings window tells the writer). */
    startedWith: StartedWith | null = null;
    private ending: Promise<void> | null = null;
    private finished = false;
    /** The writer is being asked to sign in again (the mind's sign-in ended), and why. */
    private askingSignIn = false;
    private signedOutWhy = "";

    constructor(
        /** The document the session starts on; none: the first one the writer opens. */
        private readonly document: vscode.TextDocument | undefined,
        private readonly extensionRoot: string,
        private readonly runtime: SessionRuntime,
        private readonly hooks: SessionHooks,
    ) {}

    /** What the mind runs on. */
    get provider(): Provider {
        return this.runtime.mind.provider;
    }

    async start(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration("euterpe");
        const log = this.hooks.log;
        const runtime = this.runtime.mind;
        const provider = runtime.provider;
        const configDir = runtime.provider === "claude" ? resolveConfigDir(cfg.get<string>("claudeConfigDir") || "") : "";
        const home = memoryDir();
        fs.mkdirSync(home, { recursive: true });
        const attention = attentionFor(cfg.get<string>("attention"));
        const persona = this.choosePersona(cfg, home);
        log(`persona: ${persona.name} (${persona.bundled ? "bundled" : persona.file})`);
        this.startedWith = {
            persona: persona.id,
            avatarScale: cfg.get<number>("avatarScale") ?? 4,
            effort: cfg.get<string>("effort") ?? "",
            attention: cfg.get<string>("attention") ?? "",
            followActiveEditor: cfg.get<boolean>("followActiveEditor") ?? true,
            debugMind: cfg.get<boolean>("debugMind") ?? false,
        };
        const bundledMascots = path.join(this.extensionRoot, "mascots");
        const { mascot, missing } = chooseMascot(cfg.get<string>("mascot") ?? "", bundledMascots, path.join(home, "mascots"), provider);
        if (missing) { log(`mascot "${missing}" isn't in ${path.join(home, "mascots")} or among the bundled ones: ${mascot.name} instead`); }
        this.mascot = mascot;
        log(`mascot: ${mascot.name}${mascot.file ? ` (${mascot.file})` : ""}`);
        // The API's own web search is OpenAI's (its API's, or the plan's); elsewhere the mind fetches pages.
        const webSearch = runtime.provider === "claude" || (runtime.provider === "openai" && (runtime.endpoint.openai || runtime.endpoint.chatgpt));
        const prompt = this.assemblePrompt(home, persona, attention, mascot, provider, webSearch);
        // mkdtemp makes it 0700 on macOS and Linux, where the temp dir can be shared.
        this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-"));

        const doc = this.document;
        const workspaceDir =
            (doc && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath) ??
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
            (!doc || doc.isUntitled ? home : path.dirname(doc.fileName));

        const overlayDir = process.env.EUTERPE_OVERLAY_DIR || this.locate("overlay");
        const overlay = new OverlayBridge({
            overlayDir,
            electronPath: this.runtime.electronPath,
            scale: Math.min(6, Math.max(2, Math.round(cfg.get<number>("avatarScale") ?? 4))),
            mascotFile: mascot.file,
            // Off Claude, a pack that doesn't hold up leaves the default pack on stage, never Clawd.
            fallbackMascotFile: provider === "claude" ? null : findMascot(defaultMascot(provider), bundledMascots, "", provider)?.file ?? null,
            theme: provider,
            log,
        });
        this.overlay = overlay;

        const debug = cfg.get<boolean>("debugMind") ?? false;
        if (debug) {
            this.console = new MindConsole((text) => {
                overlay.send({ type: "user-echo", text });
                this.talk(text);
            });
        }

        const sensors = new Sensors(this.document, {
            wake: (reason) => void this.mind?.requestPerception(reason),
            typing: (active) => overlay.send({ type: "activity", typing: active }),
            switched: (doc) => log(`following ${doc.fileName}`),
        }, { attention, follow: cfg.get<boolean>("followActiveEditor") ?? true });
        this.sensors = sensors;

        // Edits the writer asked for: proposed by the mind through its tool server,
        // reviewed in a diff, applied only on Accept.
        const proposals = new EditProposals({
            log,
            resolve: (file) => this.resolveFile(file, workspaceDir),
            displayName,
            apply: (edit) => sensors.ownEdit(() => vscode.workspace.applyEdit(edit)),
            onState: (id, file, state) => overlay.send({ type: "proposal", id, file, state }),
            onDecided: (file, decision) => {
                this.events.push(DECISIONS[decision](file));
                sensors.wake("edit_review");
            },
        });
        this.proposals = proposals;
        // The extension's own tools: over MCP for Claude Code, called in place by a mind on an API.
        const ownTools: McpTool[] = [
            proposals.tool(),
            ...mascotTools({
                electronPath: this.runtime.electronPath, overlayDir, home, tmpDir: this.tmpDir,
                offer: (m) => void this.offerMascot(m),
            }),
        ];
        const effort = cfg.get<string>("effort") || "";
        const perception = {
            log,
            perceive: (reason: Parameters<Mind["requestPerception"]>[0]) => {
                const events = this.events.slice();
                const r = this.writer.render(reason, sensors.snapshot(), { ...sensors.state(), events });
                return { ...r, commit: () => { r.commit(); this.events.splice(0, events.length); } };
            },
            invalidate: () => this.writer.invalidate(),
        };

        let mind: Mind;
        if (runtime.provider === "claude") {
            const tools = new McpServer(MCP_SERVER_NAME, ownTools, log);
            this.tools = tools;
            mind = new ClaudeMind({
                ...perception,
                claudePath: runtime.claudePath,
                model: cfg.get<string>("model")?.trim() || defaultModel("claude", false),
                effort,
                configDir,
                systemPromptFile: this.writePrivate("system-prompt.md", prompt),
                settingsFile: this.writePrivate("settings.json", JSON.stringify(this.settingsFor(configDir))),
                memoryDir: home,
                workspaceDir,
                mcpConfigFile: path.join(this.tmpDir, "tools.json"),
                compactWindow: attention.compactWindow,
                debug,
                onTraffic: this.console ? (dir, line) => this.console?.traffic(dir, line) : undefined,
            });
        } else if (runtime.provider === "copilot") {
            const window = runtime.context > 0 ? Math.floor(runtime.context * COPILOT_WINDOW_SHARE) : API_COMPACT_WINDOW;
            mind = new OpenAIMind({
                ...perception,
                baseURL: "",
                name: COPILOT_NAME,
                auth: "on your GitHub Copilot plan, through VS Code",
                apiKey: "",
                model: runtime.model,
                effort,
                api: "chat",
                instructions: prompt,
                tools: [...agentTools({ home, tmpDir: this.tmpDir }), ...ownTools],
                webSearch: false,
                openaiExtras: false,
                compactWindow: Math.min(attention.compactWindow, API_COMPACT_WINDOW, window),
                client: runtime.api,
                describeFailure: describeCopilotFailure,
                debug,
                onEvent: this.console ? (e) => this.console?.event(e) : undefined,
            });
        } else {
            const { endpoint } = runtime;
            // OpenAI's own servers are the Responses API's home; Chat Completions is what every provider speaks.
            const responses = endpoint.openai || endpoint.chatgpt;
            mind = new OpenAIMind({
                ...perception,
                baseURL: endpoint.baseURL,
                name: endpoint.chatgpt ? "ChatGPT" : undefined,
                apiKey: runtime.apiKey,
                chatgpt: runtime.chatgpt,
                model: runtime.model,
                effort,
                api: responses ? "responses" : "chat",
                instructions: prompt,
                tools: [...agentTools({ home, tmpDir: this.tmpDir }), ...ownTools],
                webSearch: responses,
                openaiExtras: responses,
                // OpenAI bills a request past 272K input tokens at double rates: summarize well before.
                compactWindow: Math.min(attention.compactWindow, API_COMPACT_WINDOW),
                debug,
                onEvent: this.console ? (e) => this.console?.event(e) : undefined,
            });
        }
        this.mind = mind;

        mind.on("response", (r: MindResponse, turn: "chat" | "perception") => {
            overlay.send({ type: "mind", expression: r.expression, say: r.say, notes: r.notes, action: r.action });
            overlay.send({ type: "status", state: "idle" });
            this.hooks.onEvent?.({ kind: "response", response: r, turn });
        });
        mind.on("thinking", () => overlay.send({ type: "status", state: "thinking" }));
        mind.on("turn-error", (text: string, turn: "chat" | "perception") => {
            overlay.send({ type: "status", state: "idle" });
            // A failed silent perception isn't worth bothering the writer about
            // unless it says something they need to know (e.g. a usage limit).
            if (turn === "chat" || /limit|auth|log ?in|credit|key/i.test(text)) {
                overlay.send({ type: "error", text });
            }
            this.hooks.onEvent?.({ kind: "turn-error", text });
        });
        // The next perception carries the whole document again; say why.
        mind.on("compacted", () => this.events.push("your conversation so far was summarized to keep it short, so the whole document comes again."));
        mind.on("restarted", (n: number) => {
            log(`mind restarted (${n})`);
            overlay.send({ type: "error", text: "Euterpe's mind hiccuped and restarted — back now, still remembering the session." });
        });
        mind.on("died", (message: string) => {
            log(`mind died: ${message}`);
            if (!this.ending) {
                void vscode.window.showErrorMessage(message);
                void this.end(false);
            }
        });
        // The ChatGPT sign-in ended (OpenAI wouldn't renew it): the session waits for a new one.
        mind.on("signed-out", (why: string) => {
            log(`mind waits for a sign-in: ${why}`);
            this.signedOutWhy = why;
            overlay.send({ type: "status", state: "idle" });
            overlay.send({ type: "error", text: "Euterpe's ChatGPT sign-in has ended: continue with ChatGPT in VS Code to go on." });
            this.hooks.onSignInWait?.(true);
            this.askToSignIn();
        });
        mind.on("restricted", (mode: string) => {
            void vscode.window.showWarningMessage(`Your Claude Code setup doesn't let Euterpe skip permission prompts (it runs in "${mode}" mode, perhaps by your organization's policy), and nobody is there to answer them: Euterpe can read along and talk, but its tools — memory, edits, the web — will be refused.`);
        });
        // A usage limit on the writer's ChatGPT plan: the way to its settings, once a session (the looks would hit it again).
        let limitShown = false;
        mind.on("plan-limit", (why: string) => {
            if (limitShown) { return; }
            limitShown = true;
            void vscode.window.showWarningMessage(why, "Manage Usage").then((pick) => {
                if (pick) { void vscode.env.openExternal(vscode.Uri.parse(MANAGE_USAGE_URL)); }
            });
        });
        mind.on("model-refused", (failed: string, back: string) => {
            // The writer just picked it (Choose Model): the setting goes back too, or the next session would start on it.
            const key = modelSetting(provider);
            const settings = vscode.workspace.getConfiguration("euterpe");
            if (sameModel(settings.get<string>(key) ?? "", failed)) {
                void updateSetting(key, back);
            }
            const who = runtime.provider === "claude" ? "Claude Code" : runtime.provider === "copilot" ? COPILOT_NAME : runtime.endpoint.name;
            // (Copilot only offers models that exist, and that the writer has)
            const maybe = runtime.provider === "copilot" ? "" : ": it may not exist, or you may not have access to it";
            void vscode.window.showWarningMessage(`${who} can't run Euterpe on ${modelName(failed, provider)}${maybe}. Euterpe is back on ${modelName(back, provider)}.`);
        });

        overlay.on("message", (msg) => {
            if (msg.type === "chat") {
                overlay.send({ type: "user-echo", text: msg.text });
                this.talk(msg.text);
            } else if (msg.type === "notes") {
                this.talk(NOTES_REQUEST);
            } else if (msg.type === "close") {
                log("writer closed Euterpe from the overlay");
                void this.end(true);
            } else if (msg.type === "proposal") {
                if (msg.decision === "accept") { void proposals.accept(msg.id); }
                else if (msg.decision === "reject") { proposals.reject(msg.id); }
                else if (msg.decision === "show") { void proposals.show(msg.id); }
            }
        });
        overlay.on("died", (why?: string) => {
            if (!this.ending) {
                if (why) { void vscode.window.showErrorMessage(`Euterpe's window couldn't start (${why}): ending the session.`); }
                else { void vscode.window.showInformationMessage("Euterpe's window closed — ending the session."); }
                void this.end(false);
            }
        });

        try {
            await overlay.start();
            if (this.tools) {
                await this.tools.start();
                this.writePrivate("tools.json", JSON.stringify(this.tools.config()));
            }
        } catch (err) {
            this.teardown();
            throw err;
        }
        if (this.ending || this.finished) { return; } // ended while the overlay was starting
        mind.start();
        sensors.start();
        log(`session started on ${sensors.watched?.fileName ?? "no document yet"} (workspace ${workspaceDir})`);
        this.hooks.onEvent?.({ kind: "started" });
    }

    /** The writer said something from VS Code ("Talk to Euterpe"): same path as the overlay chat. */
    chat(text: string): void {
        if (!this.mind || this.ending) { return; }
        this.overlay?.send({ type: "user-echo", text });
        this.talk(text);
    }

    /** A ChatGPT sign-in (in this window or another): a mind that waited for one goes on. */
    signedIn(): void {
        if (!this.mind?.waitingForSignIn || this.ending) { return; }
        this.mind.resume();
        this.hooks.onSignInWait?.(false);
    }

    /** What the writer says reaches the mind; while it waits for a sign-in, it waits too, and they're asked again. */
    private talk(text: string): void {
        if (!this.mind) { return; }
        if (this.mind.waitingForSignIn) {
            this.overlay?.send({ type: "error", text: "Euterpe answers once you continue with ChatGPT in VS Code." });
            // The first ask may have slipped into the notification center: they're asking for Euterpe now.
            this.askToSignIn(true);
        }
        void this.mind.sendChat(text);
    }

    /**
     * The mind's sign-in ended: ask the writer to sign in again, and go on once they have. One ask
     * at a time, unless `again` (they spoke to Euterpe meanwhile).
     */
    private askToSignIn(again = false): void {
        const signIn = this.hooks.signIn;
        if ((this.askingSignIn && !again) || !signIn || this.ending) { return; }
        this.askingSignIn = true;
        void vscode.window.showWarningMessage(`${this.signedOutWhy} Continue with ChatGPT to go on: Euterpe waits meanwhile.`, "Continue with ChatGPT").then(async (pick) => {
            try {
                if (pick && !this.ending && await signIn()) { this.signedIn(); }
            } finally {
                this.askingSignIn = false;
            }
        });
    }

    /** The edit under review, if any. */
    get pendingEditId(): string | undefined {
        return this.proposals?.pendingId;
    }

    /** Accept or reject the edit under review; `id` (from a diff's buttons) must be the pending one. */
    decideEdit(accept: boolean, id?: string): void {
        if (accept) { void this.proposals?.accept(id); } else { this.proposals?.reject(id); }
    }

    /**
     * The file the mind means: the document it's watching by default, an open
     * document by the name perceptions use (or its path), else a path on disk,
     * relative to the workspace.
     */
    private resolveFile(file: string | undefined, workspaceDir: string): vscode.Uri {
        const watched = this.sensors?.watched ?? this.document;
        if (!file) {
            if (!watched) { throw new Error("The writer has no document open: name the file to change (absolute, or relative to the workspace)."); }
            return watched.uri;
        }
        const norm = (s: string) => {
            const p = s.replace(/\\/g, "/");
            return process.platform === "win32" ? p.toLowerCase() : p;
        };
        const wanted = norm(file);
        const open = vscode.workspace.textDocuments.find((d) =>
            isWatchable(d) && (norm(displayName(d.uri)) === wanted || norm(d.fileName) === wanted));
        return open?.uri ?? vscode.Uri.file(path.resolve(workspaceDir, file));
    }

    /**
     * End the session. With a goodbye, the mind gets a last perception and the
     * overlay gets time to show the answer before the exit animation.
     */
    end(goodbye = true): Promise<void> {
        if (this.ending) { return this.ending; }
        this.ending = (async () => {
            this.hooks.onLeaving?.();
            this.sensors?.stop();
            const mind = this.mind;
            // A mind waiting for a sign-in has no goodbye to say.
            if (goodbye && mind?.alive && !mind.waitingForSignIn) {
                const r = await Promise.race([
                    mind.requestPerception("session_end"),
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), GOODBYE_TIMEOUT_MS)),
                ]);
                if (r) {
                    await new Promise((resolve) => setTimeout(resolve, readingDelay(r.say)));
                }
            }
            await this.overlay?.shutdown(4_000);
            this.teardown();
        })();
        return this.ending;
    }

    /** Immediate teardown, no goodbye (VS Code is closing). */
    dispose(): void {
        this.sensors?.stop();
        this.overlay?.dispose();
        this.mind?.dispose(true);
        this.teardown();
    }

    private teardown(): void {
        if (this.finished) { return; }
        this.finished = true;
        this.sensors?.dispose();
        this.mind?.dispose();
        this.proposals?.dispose();   // an edit still under review is withdrawn, its diff closed
        this.tools?.close();
        this.overlay?.dispose();
        // Terminal stays open for post-mortem reading; the next session replaces it.
        this.console?.sessionEnded();
        // The mind read these when it started; a restart (--resume) happens before teardown.
        if (this.tmpDir) {
            try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        this.hooks.log("session ended");
        this.hooks.onEvent?.({ kind: "ended" });
        this.hooks.onEnded();
    }

    /** A directory the extension ships (overlay/, mind/). */
    private locate(dir: string): string {
        const full = path.join(this.extensionRoot, dir);
        if (!fs.existsSync(full)) { throw new Error(`cannot locate ${dir}/ in ${this.extensionRoot}`); }
        return full;
    }

    /** Write one of the session's files, readable by the writer only; returns its path. */
    private writePrivate(name: string, content: string): string {
        const file = path.join(this.tmpDir, name);
        fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
        return file;
    }

    private assemblePrompt(home: string, persona: Persona, attention: Attention, mascot: Mascot, provider: Provider, webSearch: boolean): string {
        const template = fs.readFileSync(path.join(this.locate("mind"), "system-prompt.md"), "utf8");
        return assemblePrompt(template, {
            persona: persona.body, memoryDir: home, platform: platformName(), editor: vscode.env.appName, cadence: attention.cadence,
            body: mascot.body, mascotGuide: path.join(this.extensionRoot, "docs", "mascots.md"),
            web: webSearch ? "search and fetch the web" : "fetch web pages (there's no search tool, but a search engine's results page is a web page too)",
            fileTools: provider === "claude" ? "Write or Edit" : "write_file or edit_file",
        });
    }

    /** The body Euterpe wears now. */
    get wearing(): Mascot {
        return this.mascot;
    }

    /** The model the mind runs on now; undefined before it's there. */
    get model(): string | undefined {
        return this.mind?.model;
    }

    /** Another model for the mind (the writer picked one), from its next turn: why it was refused, or null. */
    changeModel(model: string): Promise<string | null> {
        if (!this.mind || this.ending) { return Promise.resolve(null); }
        return this.mind.setModel(model);
    }

    /** A new body (the writer picked one): the old one walks off, the new one in, and the mind hears of it. */
    changeMascot(m: Mascot): void {
        if (!this.overlay || this.ending || m.id === this.mascot.id) { return; }
        this.mascot = m;
        this.overlay.send({ type: "mascot", id: m.id, pack: m.pack });
        this.events.push(`you have a new body: ${m.name}, ${m.body}.`);
        this.hooks.log(`mascot: ${m.name}${m.file ? ` (${m.file})` : ""}`);
    }

    /** The mind made a mascot (offer_mascot): the writer decides whether it's worn. */
    private async offerMascot(m: Mascot): Promise<void> {
        for (;;) {
            const pick = await vscode.window.showInformationMessage(`Euterpe made you a mascot: ${m.name}. ${m.description} Wear it?`, "Wear It", "Preview", "Not Now");
            if (this.ending || this.finished) { return; }
            if (pick === "Preview") {
                await this.hooks.previewMascot?.(m);
                continue;
            }
            if (pick === "Wear It") {
                await updateSetting("mascot", m.id);
                this.changeMascot(m);
                this.events.push(`the writer is wearing ${m.name}, the mascot you made.`);
            } else {
                this.events.push(`the writer didn't put on ${m.name}, the mascot you offered${pick ? "" : " (they let the offer go by)"}. It stays in your mascots folder.`);
            }
            this.sensors?.wake("edit_review");
            return;
        }
    }

    /** euterpe.persona (the writer's own, or a bundled one), else the default. */
    private choosePersona(cfg: vscode.WorkspaceConfiguration, home: string): Persona {
        const mine = path.join(home, "personas");
        const { persona, missing } = choosePersona(cfg.get<string>("persona") ?? "", path.join(this.locate("mind"), "personas"), mine);
        if (missing) { this.hooks.log(`persona "${missing}" isn't in ${mine} or among the bundled ones: ${persona.name} instead`); }
        return persona;
    }

    /** The mind's --settings, with the sign-in part of the writer's own Claude settings carried over. */
    private settingsFor(configDir: string): Record<string, unknown> {
        const dir = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
        let user: unknown = null;
        try {
            user = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
        } catch { /* no settings, or unreadable: the standard login needs none */ }
        const settings = mindSettings(user);
        const carried = Object.keys(settings).filter((k) => k !== "attribution" && k !== "env")
            .concat(Object.keys((settings.env as object | undefined) ?? {}).map((k) => `env ${k}`));
        if (carried.length) { this.hooks.log(`carried over from your Claude settings: ${carried.join(", ")}`); }
        return settings;
    }
}

/** The settings a session takes on when it starts, as it started with them. */
export interface StartedWith {
    persona: string;
    avatarScale: number;
    effort: string;
    attention: string;
    followActiveEditor: boolean;
    debugMind: boolean;
}

/** What a session runs on, found before it starts (see extension.ts). */
export interface SessionRuntime {
    /** The Electron executable for the overlay (electronRuntime.ts). */
    electronPath: string;
    mind: MindRuntime;
}

/**
 * What the mind runs on: Claude Code (claudeCli.ts), or an OpenAI-compatible API with the writer's
 * key, or their ChatGPT plan with their sign-in (`chatgpt`, chatgpt.ts), or the models their GitHub
 * Copilot plan offers in VS Code (`api`, copilot.ts; `context`: the model's window, in tokens).
 */
export type MindRuntime =
    | { provider: "claude"; claudePath: string }
    | { provider: "openai"; endpoint: Endpoint; apiKey: string; model: string; chatgpt?: PlanAuth }
    | { provider: "copilot"; model: string; context: number; api: ModelApi };

/** Time to read Euterpe's last words before the overlay plays its exit. */
function readingDelay(say: string | null): number {
    return say ? Math.min(10_000, 3_000 + 40 * say.length) : 1_500;
}
