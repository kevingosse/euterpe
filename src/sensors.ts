import * as path from "path";
import * as vscode from "vscode";
import { Attention, ATTENTION } from "./attention";
import { DocSnapshot, NoDocument, PerceptionReason, Position, REASON_PRIORITY, SensorState } from "./perception";

// These constants, and the cadence in attention.ts, are cost/latency throttles for how often the
// mind is woken — they carry no behavioral policy. Deciding what a pause (or an idle half hour)
// *means* is the mind's job. A turn takes the mind about two seconds, so at the closest attention
// a typo reaches it a few seconds after the writer draws breath.
const IDLE_MARKS_MS = [10 * 60_000, 30 * 60_000]; // one perception at each mark of silence
const DOC_SWITCH_SETTLE_MS = 2_000;   // a glance at another file isn't a switch
const TYPING_QUIET_MS = 3_000;        // avatar reflexes: "stopped typing" after this
const TYPING_PING_GAP_MS = 1_500;
const BUCKET_MS = 10_000;
const TRACE_WINDOW_MS = 120_000;

interface EditRecord {
    time: number;
    added: number;
    removed: number;
}

export interface SensorOptions {
    /** How often the mind gets a look (euterpe.attention). */
    attention: Attention;
    /** Follow the writer to whatever document they switch to (euterpe.followActiveEditor). */
    follow: boolean;
}

export interface SensorEvents {
    /** Wake the mind with a perception. */
    wake(reason: PerceptionReason): void;
    /** Raw typing activity, for the avatar's reflexes (no mind involved). */
    typing(active: boolean): void;
    /** The watched document changed (following the active editor). */
    switched(doc: vscode.TextDocument): void;
}

/** Documents Euterpe can follow: real text files and untitled buffers — not output panes, diffs or settings UIs. */
export function isWatchable(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === "file" || doc.uri.scheme === "untitled";
}

/** A document's name as perceptions show it: path relative to the workspace, or the untitled name. */
export function displayName(uri: vscode.Uri): string {
    return uri.scheme === "untitled" ? uri.path : vscode.workspace.asRelativePath(uri, false);
}

/**
 * Pure sensor: records raw activity on the document the writer is working on
 * (following the active editor) and wakes the mind on a cost-bounded cadence.
 * Snapshots are taken on demand, when a turn is actually sent. A session can
 * start with no document open: the first one the writer opens is the one.
 */
export class Sensors implements vscode.Disposable {
    private document: vscode.TextDocument | undefined;
    private edits: EditRecord[] = [];
    private lastEditAt: number | null = null;
    private saves = new Map<string, number>();
    private selections = new Map<string, vscode.Selection>();
    private lastPerceptionAt = 0;
    /** When the current stretch of typing began (the first edit after a pause). */
    private burstStartedAt = 0;
    private pauseSent = true; // don't report a pause before any activity
    private typing = false;
    private lastTypingPingAt = 0;
    private focused = vscode.window.state.focused;
    private unfocusedSince: number | null = this.focused ? null : Date.now();
    private pendingReason: PerceptionReason | null = null;
    private gapTimer: NodeJS.Timeout | undefined;
    private pauseTimer: NodeJS.Timeout | undefined;
    private typingTimer: NodeJS.Timeout | undefined;
    private switchTimer: NodeJS.Timeout | undefined;
    private idleTimers: NodeJS.Timeout[] = [];
    private subscriptions: vscode.Disposable[] = [];
    private running = false;
    private ownEdits = 0;

    constructor(
        document: vscode.TextDocument | undefined,
        private readonly events: SensorEvents,
        private readonly options: SensorOptions = { attention: ATTENTION.close, follow: true },
    ) {
        this.document = document;
        const editor = document && vscode.window.visibleTextEditors.find((e) => e.document === document);
        if (editor) { this.selections.set(editor.document.uri.toString(), editor.selection); }
    }

    /** The document Euterpe reads; undefined until the writer opens one. */
    get watched(): vscode.TextDocument | undefined {
        return this.document;
    }

    /** Start listening, and wake the mind for the session start. */
    start(): void {
        this.running = true;
        // A document the writer opened while Euterpe was on its way is the session's.
        const editor = vscode.window.activeTextEditor;
        if (!this.document && editor && isWatchable(editor.document)) {
            this.document = editor.document;
            this.selections.set(editor.document.uri.toString(), editor.selection);
            this.events.switched(editor.document);
        }
        this.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document === this.document && this.ownEdits === 0) { this.onEdit(e); }
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                this.saves.set(doc.uri.toString(), Date.now());
            }),
            vscode.window.onDidChangeTextEditorSelection((e) => {
                this.selections.set(e.textEditor.document.uri.toString(), e.selections[0]);
                // Moving around the text is presence too: idle means nobody's here.
                if (e.textEditor.document === this.document) { this.armIdle(); }
            }),
            vscode.window.onDidChangeWindowState((s) => {
                if (s.focused === this.focused) { return; }
                this.focused = s.focused;
                this.unfocusedSince = s.focused ? null : Date.now();
            }),
            vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveEditor(editor)),
            // The watched document is gone: on to the one the writer is in, whatever the setting.
            vscode.workspace.onDidCloseTextDocument((doc) => {
                if (doc === this.document) { this.onActiveEditor(vscode.window.activeTextEditor); }
            }),
        );
        this.armIdle();
        this.fire("session_start");
    }

    /** Stop listening and waking the mind. Snapshots keep working (for the goodbye). */
    stop(): void {
        this.running = false;
        clearTimeout(this.gapTimer);
        clearTimeout(this.pauseTimer);
        clearTimeout(this.typingTimer);
        clearTimeout(this.switchTimer);
        this.idleTimers.forEach(clearTimeout);
        this.idleTimers = [];
        this.subscriptions.forEach((s) => s.dispose());
        this.subscriptions = [];
        if (this.typing) {
            this.typing = false;
            this.events.typing(false);
        }
    }

    dispose(): void {
        this.stop();
    }

    /**
     * Apply an edit the writer accepted from Euterpe. It isn't the writer typing:
     * no activity in the trace, no typing reflex, no pause to report. (The
     * document change arrives before applyEdit resolves.)
     */
    async ownEdit(apply: () => Thenable<boolean>): Promise<boolean> {
        this.ownEdits++;
        try {
            return await apply();
        } finally {
            this.ownEdits--;
        }
    }

    /** Something the mind should hear about happened (outside the writer's typing). */
    wake(reason: PerceptionReason): void {
        this.request(reason);
    }

    // ---------- snapshots ----------

    snapshot(): DocSnapshot | NoDocument {
        const doc = this.document;
        if (!doc) { return { key: null, workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(none)" }; }
        const key = doc.uri.toString();
        const active = vscode.window.activeTextEditor;
        const editor = active?.document === doc
            ? active
            : vscode.window.visibleTextEditors.find((e) => e.document === doc);
        const sel = editor?.selection ?? this.selections.get(key);

        const lines: string[] = [];
        for (let i = 0; i < doc.lineCount; i++) { lines.push(doc.lineAt(i).text); }

        const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
        const workspace = folder?.uri.fsPath
            ?? (doc.isUntitled
                ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(none)"
                : path.dirname(doc.fileName));
        const name = displayName(doc.uri);

        // Within the document as it is now: a remembered cursor (the document isn't on screen) can
        // lie past the end of a text that shrank since, after an accepted edit, say.
        const pos = (p: vscode.Position): Position => { const v = doc.validatePosition(p); return { line: v.line, character: v.character }; };
        return {
            key,
            name,
            languageId: doc.languageId,
            workspace,
            dirty: doc.isDirty,
            lines,
            cursor: sel ? pos(sel.active) : { line: 0, character: 0 },
            selection: sel && !sel.isEmpty ? { start: pos(sel.start), end: pos(sel.end) } : null,
        };
    }

    state(): SensorState {
        const now = Date.now();
        this.edits = this.edits.filter((r) => now - r.time <= TRACE_WINDOW_MS);
        const bucketCount = TRACE_WINDOW_MS / BUCKET_MS;
        const buckets = Array.from({ length: bucketCount }, () => ({ added: 0, removed: 0 }));
        for (const r of this.edits) {
            const idx = Math.min(bucketCount - 1, Math.floor((now - r.time) / BUCKET_MS));
            const b = buckets[bucketCount - 1 - idx];
            b.added += r.added;
            b.removed += r.removed;
        }
        const saved = this.document && this.saves.get(this.document.uri.toString());
        return {
            now: new Date(now),
            focused: this.focused,
            unfocusedMs: this.unfocusedSince === null ? null : now - this.unfocusedSince,
            sinceLastEditMs: this.lastEditAt === null ? null : now - this.lastEditAt,
            sinceLastSaveMs: saved === undefined ? null : now - saved,
            activity: buckets,
        };
    }

    // ---------- raw activity ----------

    private onEdit(e: vscode.TextDocumentChangeEvent): void {
        let added = 0;
        let removed = 0;
        for (const c of e.contentChanges) {
            added += c.text.length;
            removed += c.rangeLength;
        }
        if (added === 0 && removed === 0) { return; }
        const now = Date.now();
        this.edits.push({ time: now, added, removed });
        this.lastEditAt = now;
        if (this.pauseSent) { this.burstStartedAt = now; }
        this.pauseSent = false;

        // Body reflexes (the avatar glances at the text); the mind isn't involved.
        if (!this.typing && now - this.lastTypingPingAt >= TYPING_PING_GAP_MS) {
            this.typing = true;
            this.lastTypingPingAt = now;
            this.events.typing(true);
        }
        clearTimeout(this.typingTimer);
        this.typingTimer = setTimeout(() => {
            if (this.typing) {
                this.typing = false;
                this.events.typing(false);
            }
        }, TYPING_QUIET_MS);

        clearTimeout(this.pauseTimer);
        this.pauseTimer = setTimeout(() => this.onPause(), this.options.attention.pauseMs);
        this.armIdle();
        this.maybeHeartbeat(now);
    }

    private onActiveEditor(editor: vscode.TextEditor | undefined): void {
        clearTimeout(this.switchTimer);
        if (!editor || !isWatchable(editor.document) || editor.document === this.document) { return; }
        const target = editor.document;
        this.switchTimer = setTimeout(() => {
            const now = vscode.window.activeTextEditor;
            if (!this.running || now?.document !== target) { return; }
            // Staying with the session's document only goes while it's there: once it's closed (or
            // an untitled one was saved, which closes it for the file), nothing more would be seen.
            // With none yet, the first one the writer opens is the session's.
            if (!this.options.follow && this.document && !this.document.isClosed) { return; }
            this.document = target;
            this.selections.set(target.uri.toString(), now.selection);
            this.events.switched(target);
            this.request("doc_switch");
        }, DOC_SWITCH_SETTLE_MS);
    }

    // ---------- waking the mind (cost throttles only) ----------

    private onPause(): void {
        if (this.pauseSent || !this.running) { return; }
        this.pauseSent = true;
        this.request("pause");
    }

    /** Typing without a pause for a while: keep the mind caught up anyway. */
    private maybeHeartbeat(now: number): void {
        if (now - Math.max(this.burstStartedAt, this.lastPerceptionAt) < this.options.attention.heartbeatMs) { return; }
        this.request("heartbeat");
    }

    /** One wake-up at each idle mark; any edit or cursor move starts the count again. */
    private armIdle(): void {
        this.idleTimers.forEach(clearTimeout);
        this.idleTimers = IDLE_MARKS_MS.map((ms) => setTimeout(() => this.request("idle"), ms));
    }

    /** Wake the mind now, or as soon as the minimum gap allows (keeping the most significant reason). */
    private request(reason: PerceptionReason): void {
        if (!this.running) { return; }
        const wait = this.lastPerceptionAt + this.options.attention.minGapMs - Date.now();
        if (wait <= 0 && !this.gapTimer) {
            this.fire(reason);
            return;
        }
        if (!this.pendingReason || REASON_PRIORITY[reason] >= REASON_PRIORITY[this.pendingReason]) {
            this.pendingReason = reason;
        }
        if (!this.gapTimer) {
            this.gapTimer = setTimeout(() => {
                this.gapTimer = undefined;
                const r = this.pendingReason;
                this.pendingReason = null;
                if (r && this.running) { this.fire(r); }
            }, Math.max(0, wait));
        }
    }

    private fire(reason: PerceptionReason): void {
        this.lastPerceptionAt = Date.now();
        this.events.wake(reason);
    }
}
