// What Euterpe perceives, and how it is written down for the mind. Pure and
// vscode-free (the sensors fill these structures), so it can be unit-tested.
//
// Euterpe keeps a running picture of each document from the snapshots already
// SEEN; after the first full view, the mind mostly receives diffs against
// that picture. This keeps the context small over a long session (big
// contexts get compacted, and compaction forgets held notes and running
// jokes) without making Euterpe any less caught up.

import { applyHunks, changedChars, diffLines, hunkHeader, toHunks } from "./lineDiff";

export type PerceptionReason =
    | "session_start"
    | "pause"
    | "heartbeat"
    | "doc_switch"
    | "idle"
    | "edit_review"
    | "chat"
    | "session_end";

/** When two wake-ups collide, the more significant reason is the one kept. */
export const REASON_PRIORITY: Record<PerceptionReason, number> = {
    heartbeat: 0,
    pause: 1,
    idle: 2,
    edit_review: 3,
    chat: 4,
    doc_switch: 5,
    session_start: 6,
    session_end: 7,
};

export interface Position {
    /** 0-based. */
    line: number;
    /** 0-based. */
    character: number;
}

/** The document as it is right now. */
export interface DocSnapshot {
    /** Stable key for the document (its URI). */
    key: string;
    /** Display name: path relative to the workspace, or the untitled name. */
    name: string;
    languageId: string;
    workspace: string;
    /** Unsaved changes. */
    dirty: boolean;
    lines: string[];
    cursor: Position;
    /** Non-empty selection, or null. */
    selection: { start: Position; end: Position } | null;
}

/** Raw facts about the writer's activity, measured by the sensors. */
export interface SensorState {
    now: Date;
    /** Is a VS Code window focused? */
    focused: boolean;
    /** How long VS Code has been unfocused, or null while focused. */
    unfocusedMs: number | null;
    /** Since the last edit of the watched document, or null if none this session. */
    sinceLastEditMs: number | null;
    /** Since the last save of the watched document, or null if not saved this session. */
    sinceLastSaveMs: number | null;
    /** Chars added/removed per 10 s bucket, oldest first, covering the last 2 minutes. */
    activity: { added: number; removed: number }[];
    /** Things that happened since the last perception Euterpe took in (e.g. the writer accepted an edit). */
    events?: string[];
}

export interface RenderedPerception {
    text: string;
    /** Whether the document body was sent in full (vs a diff or "unchanged"). */
    full: boolean;
    /** Nothing new: the document is exactly what Euterpe last saw (cursor and selection aside), and no events. */
    unchanged: boolean;
    /** Call once the turn carrying this perception succeeded: it becomes the new baseline. */
    commit(): void;
}

export interface PerceptionOptions {
    /** Send the full text again after this many diffs, so small misreadings can't accumulate. */
    resyncEvery: number;
    /** A diff touching more than this fraction of the document is sent as full text instead. */
    largeChangeRatio: number;
    /** Full text beyond this many chars is windowed around the cursor. */
    docCharCap: number;
    /** Cap for the "selected text" block. */
    selectionCap: number;
    /** Context lines around each diff hunk. */
    diffContext: number;
}

export const DEFAULT_PERCEPTION_OPTIONS: PerceptionOptions = {
    resyncEvery: 12,
    largeChangeRatio: 0.4,
    docCharCap: 40_000,
    selectionCap: 4_000,
    diffContext: 2,
};

export const CURSOR = "⟨cursor⟩";
export const SEL_OPEN = "⟨selection⟩";
export const SEL_CLOSE = "⟨/selection⟩";

interface Baseline {
    lines: string[];
    /** Diffs sent since the last full text. */
    diffsSinceFull: number;
}

/**
 * Renders perceptions and keeps the per-document baselines — the version of
 * each document Euterpe has actually seen. Rendering is side-effect free; a
 * baseline only moves when the turn that carried it succeeds (commit).
 */
export class PerceptionWriter {
    private baselines = new Map<string, Baseline>();
    private forceFull = false;
    private readonly opts: PerceptionOptions;

    constructor(opts: Partial<PerceptionOptions> = {}) {
        this.opts = { ...DEFAULT_PERCEPTION_OPTIONS, ...opts };
    }

    /** Next perception sends full text (after a failed turn or a mind restart). */
    invalidate(): void {
        this.forceFull = true;
    }

    hasSeen(key: string): boolean {
        return this.baselines.has(key);
    }

    render(reason: PerceptionReason, doc: DocSnapshot, state: SensorState): RenderedPerception {
        const base = this.baselines.get(doc.key);
        const header = renderHeader(reason, doc, state);
        const selection = renderSelection(doc, this.opts.selectionCap);

        let body: string | null = null;
        let full = true;
        let unchanged = false;
        let diffsSinceFull = 0;

        const wantFull = !base || this.forceFull || reason === "session_start";
        if (!wantFull && base) {
            const ops = diffLines(base.lines, doc.lines);
            const docChars = doc.lines.reduce((n, l) => n + l.length + 1, 0);
            if (ops) {
                const changed = changedChars(ops);
                if (changed === 0) {
                    body = "document: unchanged since your last look." + cursorContext(doc);
                    full = false;
                    unchanged = true;
                    diffsSinceFull = base.diffsSinceFull;
                } else if (base.diffsSinceFull + 1 < this.opts.resyncEvery &&
                    changed <= this.opts.largeChangeRatio * Math.max(docChars, 1)) {
                    body = renderDiff(ops, doc, this.opts.diffContext);
                    full = false;
                    diffsSinceFull = base.diffsSinceFull + 1;
                }
            }
        }
        if (body === null) {
            body = renderFull(doc, this.opts.docCharCap);
        }

        const parts = [header, body];
        if (selection) { parts.push(selection); }
        const text = `<euterpe:perception reason="${reason}">\n${parts.join("\n")}\n</euterpe:perception>`;

        const lines = doc.lines.slice();
        return {
            text,
            full,
            unchanged: unchanged && !state.events?.length,
            commit: () => {
                this.baselines.set(doc.key, { lines, diffsSinceFull: full ? 0 : diffsSinceFull });
                this.forceFull = false;
            },
        };
    }
}

// ---------- rendering ----------

function renderHeader(reason: PerceptionReason, doc: DocSnapshot, s: SensorState): string {
    const lines: string[] = [];
    lines.push(`time: ${formatClock(s.now)}`);
    lines.push(`file: ${doc.name} (${doc.languageId}${doc.dirty ? ", unsaved changes" : ""}) — workspace: ${doc.workspace}`);
    lines.push(`VS Code: ${s.focused ? "focused" : s.unfocusedMs === null ? "not focused" : `not focused for ${formatDuration(s.unfocusedMs)}`}`);
    const edit = s.sinceLastEditMs === null ? "no edits yet this session" : `${formatDuration(s.sinceLastEditMs)} ago`;
    const save = s.sinceLastSaveMs === null ? "not saved this session" : `${formatDuration(s.sinceLastSaveMs)} ago`;
    lines.push(`last edit: ${edit} · last save: ${save}`);
    lines.push(`typing (last 2 min, 10 s buckets, oldest → newest, chars +added/-removed): ${formatActivity(s.activity)}`);
    const sel = doc.selection
        ? `lines ${doc.selection.start.line + 1}–${doc.selection.end.line + 1}`
        : "none";
    lines.push(`cursor: line ${doc.cursor.line + 1} of ${doc.lines.length} · selection: ${sel}`);
    for (const e of s.events ?? []) {
        lines.push(`since your last look: ${e}`);
    }
    if (reason === "session_end") {
        lines.push("the writer is ending the session.");
    }
    return lines.join("\n");
}

function renderFull(doc: DocSnapshot, cap: number): string {
    const marked = markLines(doc);
    const total = marked.reduce((n, l) => n + l.length + 1, 0);
    if (total <= cap) {
        return `document (full text, ${doc.lines.length} lines):\n<document>\n${marked.join("\n")}\n</document>`;
    }
    // Window around the cursor, biased toward what came before it. (Within the document: a cursor
    // past its end would leave no line to start from.)
    const focus = Math.min(Math.max(doc.selection ? doc.selection.start.line : doc.cursor.line, 0), marked.length - 1);
    let lo = focus;
    let hi = focus;
    let size = marked[focus].length + 1;
    const budgetBefore = Math.floor(cap * 0.7);
    while (lo > 0 && size + marked[lo - 1].length + 1 <= budgetBefore) { lo--; size += marked[lo].length + 1; }
    while (hi < marked.length - 1 && size + marked[hi + 1].length + 1 <= cap) { hi++; size += marked[hi].length + 1; }
    while (lo > 0 && size + marked[lo - 1].length + 1 <= cap) { lo--; size += marked[lo].length + 1; }
    const body: string[] = [];
    if (lo > 0) { body.push(`… (lines 1–${lo} not shown)`); }
    body.push(...marked.slice(lo, hi + 1));
    if (hi < marked.length - 1) { body.push(`… (lines ${hi + 2}–${marked.length} not shown)`); }
    return `document (lines ${lo + 1}–${hi + 1} of ${doc.lines.length}, windowed around the cursor):\n<document>\n${body.join("\n")}\n</document>`;
}

function renderDiff(ops: NonNullable<ReturnType<typeof diffLines>>, doc: DocSnapshot, context: number): string {
    const hunks = toHunks(ops, context);
    const marked = markLines(doc);
    const focusLine = doc.selection ? null : doc.cursor.line;
    let cursorShown = false;
    const out: string[] = [];
    for (const h of hunks) {
        out.push(hunkHeader(h));
        for (const l of h.lines) {
            if (l.bIndex !== null) {
                if (l.bIndex === focusLine) { cursorShown = true; }
                out.push(l.kind + marked[l.bIndex]);
            } else {
                out.push(l.kind + l.text);
            }
        }
    }
    const text = `changes since your last look (unified diff; "-" lines are gone, "+" lines are new, line numbers are -old,+new):\n<diff>\n${out.join("\n")}\n</diff>`;
    return cursorShown ? text : text + cursorContext(doc, marked);
}

/**
 * The cursor's line ±1 with the marker, for when the marker isn't visible
 * elsewhere — so "what about this paragraph?" can be resolved without the
 * full text. Empty when a selection stands in for the cursor.
 */
function cursorContext(doc: DocSnapshot, marked = markLines(doc)): string {
    if (doc.selection || doc.lines.length === 0) { return ""; }
    const focus = Math.min(doc.cursor.line, doc.lines.length - 1);
    const lo = Math.max(0, focus - 1);
    const hi = Math.min(doc.lines.length - 1, focus + 1);
    return `\ncursor context (lines ${lo + 1}–${hi + 1}):\n<cursor-context>\n${marked.slice(lo, hi + 1).join("\n")}\n</cursor-context>`;
}

function renderSelection(doc: DocSnapshot, cap: number): string | null {
    if (!doc.selection) { return null; }
    let text = selectedText(doc);
    if (!text) { return null; }
    let note = "";
    if (text.length > cap) {
        note = ` (first ${cap} of ${text.length} chars)`;
        text = text.slice(0, cap) + "…";
    }
    return `selected text (lines ${doc.selection.start.line + 1}–${doc.selection.end.line + 1})${note}:\n<selection>\n${text}\n</selection>`;
}

export function selectedText(doc: DocSnapshot): string {
    const sel = doc.selection;
    if (!sel) { return ""; }
    const { start, end } = sel;
    if (start.line === end.line) {
        return (doc.lines[start.line] ?? "").slice(start.character, end.character);
    }
    const parts = [(doc.lines[start.line] ?? "").slice(start.character)];
    for (let i = start.line + 1; i < end.line; i++) { parts.push(doc.lines[i] ?? ""); }
    parts.push((doc.lines[end.line] ?? "").slice(0, end.character));
    return parts.join("\n");
}

/** The document lines with ⟨cursor⟩ or ⟨selection⟩…⟨/selection⟩ markers inserted. */
export function markLines(doc: DocSnapshot): string[] {
    const lines = doc.lines.slice();
    const insert = (p: Position, marker: string) => {
        const line = Math.min(Math.max(p.line, 0), lines.length - 1);
        if (line < 0) { return; }
        const s = lines[line];
        const ch = Math.min(Math.max(p.character, 0), s.length);
        lines[line] = s.slice(0, ch) + marker + s.slice(ch);
    };
    if (lines.length === 0) { lines.push(""); }
    if (doc.selection) {
        // End first, so inserting it doesn't shift the start on the same line.
        insert(doc.selection.end, SEL_CLOSE);
        insert(doc.selection.start, SEL_OPEN);
    } else {
        insert(doc.cursor, CURSOR);
    }
    return lines;
}

// ---------- formatting helpers ----------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Fri 2026-09-25 21:40:12": the mind has no other way to know the date. */
export function formatClock(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return `${DAYS[d.getDay()]} ${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) { return `${s} s`; }
    const m = Math.floor(s / 60);
    if (m < 60) { return `${m} min`; }
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h} h ${rm} min` : `${h} h`;
}

export function formatActivity(buckets: { added: number; removed: number }[]): string {
    return buckets.map((b) => {
        if (!b.added && !b.removed) { return "·"; }
        if (!b.removed) { return `+${b.added}`; }
        if (!b.added) { return `-${b.removed}`; }
        return `+${b.added}/-${b.removed}`;
    }).join(" ");
}

// Re-exported for tests that want to check the diff round-trips.
export { applyHunks, diffLines, toHunks };
