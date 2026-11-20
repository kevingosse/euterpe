// A small line-based diff (Myers' O(ND) algorithm) producing unified-diff hunks.
// Pure and vscode-free, so it can be unit-tested.

export type OpKind = "equal" | "delete" | "insert";

export interface DiffOp {
    kind: OpKind;
    text: string;
    /** 0-based index in the old lines (equal/delete). */
    aIndex: number;
    /** 0-based index in the new lines (equal/insert). */
    bIndex: number;
}

export interface HunkLine {
    kind: " " | "-" | "+";
    text: string;
    /** 0-based index in the new lines, for context and inserted lines. */
    bIndex: number | null;
}

export interface Hunk {
    /** 0-based start and length in the old lines. */
    aStart: number;
    aLen: number;
    /** 0-based start and length in the new lines. */
    bStart: number;
    bLen: number;
    lines: HunkLine[];
}

/**
 * Edit script turning `a` into `b`, or null when the two differ by more than
 * `maxEdits` line insertions/deletions (the caller then sends the whole text).
 */
export function diffLines(a: string[], b: string[], maxEdits = 400): DiffOp[] | null {
    // Trim the common prefix and suffix: prose edits are local, so this
    // usually leaves Myers a handful of lines to chew on.
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) { pre++; }
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre &&
        a[a.length - 1 - suf] === b[b.length - 1 - suf]) { suf++; }

    const midA = a.slice(pre, a.length - suf);
    const midB = b.slice(pre, b.length - suf);
    const mid = myers(midA, midB, maxEdits);
    if (!mid) { return null; }

    const ops: DiffOp[] = [];
    for (let i = 0; i < pre; i++) {
        ops.push({ kind: "equal", text: a[i], aIndex: i, bIndex: i });
    }
    for (const op of mid) {
        ops.push({ ...op, aIndex: op.aIndex + pre, bIndex: op.bIndex + pre });
    }
    for (let i = 0; i < suf; i++) {
        const ai = a.length - suf + i;
        const bi = b.length - suf + i;
        ops.push({ kind: "equal", text: a[ai], aIndex: ai, bIndex: bi });
    }
    return ops;
}

function myers(a: string[], b: string[], maxEdits: number): DiffOp[] | null {
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0) { return []; }
    const max = Math.min(n + m, maxEdits);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];

    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                x = v[offset + k + 1];          // step down: insert b[y]
            } else {
                x = v[offset + k - 1] + 1;      // step right: delete a[x]
            }
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                return backtrack(trace, a, b, offset, d);
            }
        }
    }
    return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, dEnd: number): DiffOp[] {
    const ops: DiffOp[] = [];
    let x = a.length;
    let y = b.length;
    for (let d = dEnd; d >= 0; d--) {
        const v = trace[d];
        const k = x - y;
        let prevK: number;
        if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
            prevK = k + 1;
        } else {
            prevK = k - 1;
        }
        const prevX = d === 0 ? 0 : v[offset + prevK];
        const prevY = d === 0 ? 0 : prevX - prevK;
        while (x > prevX && y > prevY) {
            x--; y--;
            ops.push({ kind: "equal", text: a[x], aIndex: x, bIndex: y });
        }
        if (d > 0) {
            if (x === prevX) {
                ops.push({ kind: "insert", text: b[prevY], aIndex: prevX, bIndex: prevY });
            } else {
                ops.push({ kind: "delete", text: a[prevX], aIndex: prevX, bIndex: prevY });
            }
        }
        x = prevX;
        y = prevY;
    }
    return ops.reverse();
}

/** Group an edit script into unified-diff hunks with `context` lines around each change. */
export function toHunks(ops: DiffOp[], context = 2): Hunk[] {
    const hunks: Hunk[] = [];
    const changeIdx: number[] = [];
    ops.forEach((op, i) => { if (op.kind !== "equal") { changeIdx.push(i); } });
    if (changeIdx.length === 0) { return hunks; }

    // Merge changes whose context windows touch into one range of ops.
    const ranges: [number, number][] = [];
    for (const i of changeIdx) {
        const lo = Math.max(0, i - context);
        const hi = Math.min(ops.length - 1, i + context);
        const last = ranges[ranges.length - 1];
        if (last && lo <= last[1] + 1) {
            last[1] = Math.max(last[1], hi);
        } else {
            ranges.push([lo, hi]);
        }
    }

    for (const [lo, hi] of ranges) {
        const slice = ops.slice(lo, hi + 1);
        const first = slice[0];
        const hunk: Hunk = {
            aStart: first.aIndex,
            aLen: 0,
            bStart: first.bIndex,
            bLen: 0,
            lines: [],
        };
        for (const op of slice) {
            if (op.kind === "equal") {
                hunk.aLen++; hunk.bLen++;
                hunk.lines.push({ kind: " ", text: op.text, bIndex: op.bIndex });
            } else if (op.kind === "delete") {
                hunk.aLen++;
                hunk.lines.push({ kind: "-", text: op.text, bIndex: null });
            } else {
                hunk.bLen++;
                hunk.lines.push({ kind: "+", text: op.text, bIndex: op.bIndex });
            }
        }
        hunks.push(hunk);
    }
    return hunks;
}

/** The unified-diff header of a hunk, with 1-based line numbers. */
export function hunkHeader(h: Hunk): string {
    // Unified-diff convention: an empty range is reported at the line before it.
    const a = h.aLen === 0 ? h.aStart : h.aStart + 1;
    const b = h.bLen === 0 ? h.bStart : h.bStart + 1;
    return `@@ -${a},${h.aLen} +${b},${h.bLen} @@`;
}

/** Apply hunks to the old lines (used by tests to prove the diff is faithful). */
export function applyHunks(a: string[], hunks: Hunk[]): string[] {
    const out: string[] = [];
    let ai = 0;
    for (const h of hunks) {
        while (ai < h.aStart) { out.push(a[ai++]); }
        for (const line of h.lines) {
            if (line.kind === " ") {
                if (a[ai] !== line.text) { throw new Error(`context mismatch at old line ${ai}`); }
                out.push(a[ai++]);
            } else if (line.kind === "-") {
                if (a[ai] !== line.text) { throw new Error(`deletion mismatch at old line ${ai}`); }
                ai++;
            } else {
                out.push(line.text);
            }
        }
    }
    while (ai < a.length) { out.push(a[ai++]); }
    return out;
}

/** Characters touched by a diff (deleted + inserted lines), to judge whether it's "large". */
export function changedChars(ops: DiffOp[]): number {
    let n = 0;
    for (const op of ops) {
        if (op.kind !== "equal") { n += op.text.length + 1; }
    }
    return n;
}
