import * as assert from "node:assert/strict";
import { test } from "node:test";
import { applyHunks, diffLines, hunkHeader, toHunks } from "../lineDiff";

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

function roundTrip(a: string[], b: string[], context: number): void {
    const ops = diffLines(a, b);
    assert.ok(ops, "diff should not bail out");
    const hunks = toHunks(ops!, context);
    assert.deepEqual(applyHunks(a, hunks), b);
}

test("identical inputs produce no hunks", () => {
    const a = ["one", "two", "three"];
    const ops = diffLines(a, a.slice())!;
    assert.equal(toHunks(ops).length, 0);
});

test("a single changed line becomes one -/+ hunk with context", () => {
    const a = ["a", "b", "c", "d", "e", "f", "g"];
    const b = ["a", "b", "c", "D", "e", "f", "g"];
    const hunks = toHunks(diffLines(a, b)!, 2);
    assert.equal(hunks.length, 1);
    assert.equal(hunkHeader(hunks[0]), "@@ -2,5 +2,5 @@");
    assert.deepEqual(hunks[0].lines.map((l) => l.kind + l.text), [" b", " c", "-d", "+D", " e", " f"]);
});

test("insertions into an empty document", () => {
    roundTrip([], ["hello", "world"], 2);
    roundTrip([""], ["", "new line"], 1);
});

test("deleting everything", () => {
    roundTrip(["x", "y", "z"], [], 2);
});

test("distant edits make separate hunks", () => {
    const a = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const b = a.slice();
    b[3] = "changed early";
    b[35] = "changed late";
    const hunks = toHunks(diffLines(a, b)!, 2);
    assert.equal(hunks.length, 2);
    assert.deepEqual(applyHunks(a, hunks), b);
});

test("bails out (null) when the edit distance exceeds the cap", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    assert.equal(diffLines(a, b, 20), null);
    assert.ok(diffLines(a, b, 1000));
});

test("property: applying the hunks to old reproduces new (random edits)", () => {
    const rand = rng(42);
    const alphabet = ["", "the", "a quick fox", "lorem", "ipsum", "dolor", "x", "y"];
    for (let iter = 0; iter < 400; iter++) {
        const n = Math.floor(rand() * 30);
        const a = Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]);
        const b = a.slice();
        const edits = Math.floor(rand() * 6);
        for (let e = 0; e < edits; e++) {
            const at = Math.floor(rand() * (b.length + 1));
            const r = rand();
            if (r < 0.35) { b.splice(at, 0, alphabet[Math.floor(rand() * alphabet.length)] + e); }
            else if (r < 0.7 && b.length) { b.splice(Math.min(at, b.length - 1), 1); }
            else if (b.length) { b[Math.min(at, b.length - 1)] = `edited ${iter}.${e}`; }
        }
        for (const context of [0, 1, 2, 3]) {
            roundTrip(a, b, context);
        }
    }
});
