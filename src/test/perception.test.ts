import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
    CURSOR, DocSnapshot, formatActivity, formatDuration, markLines, PerceptionWriter,
    SEL_CLOSE, SEL_OPEN, selectedText, SensorState,
} from "../perception";

const LINES = [
    "# On the large object heap",
    "",
    "The allocation happens on the large object heap, which changes everything.",
    "Objects bigger than 85,000 bytes end up there.",
    "",
    "They are collected only with gen 2.",
];

function doc(over: Partial<DocSnapshot> = {}): DocSnapshot {
    return {
        key: "file:///e%3A/blog/post.md",
        name: "post.md",
        languageId: "markdown",
        workspace: "E:\\blog",
        dirty: false,
        lines: LINES.slice(),
        cursor: { line: 3, character: 10 },
        selection: null,
        ...over,
    };
}

/** The sample doc is tiny, so the 40% large-change rule is off unless a test is about it. */
function writer(opts: ConstructorParameters<typeof PerceptionWriter>[0] = {}): PerceptionWriter {
    return new PerceptionWriter({ largeChangeRatio: 1, ...opts });
}

function state(over: Partial<SensorState> = {}): SensorState {
    return {
        now: new Date(2026, 8, 25, 21, 40, 12),
        focused: true,
        unfocusedMs: null,
        sinceLastEditMs: 11_000,
        sinceLastSaveMs: null,
        activity: Array.from({ length: 12 }, (_, i) => (i === 10 ? { added: 42, removed: 3 } : { added: 0, removed: 0 })),
        ...over,
    };
}

test("the first perception carries the full text with the cursor marked", () => {
    const w = writer();
    const p = w.render("session_start", doc(), state());
    assert.equal(p.full, true);
    assert.match(p.text, /^<euterpe:perception reason="session_start">\n/);
    assert.match(p.text, /<\/euterpe:perception>$/);
    assert.match(p.text, /document \(full text, 6 lines\):\n<document>\n# On the large object heap/);
    assert.ok(p.text.includes(`Objects bi${CURSOR}gger than 85,000 bytes`));
    assert.match(p.text, /time: Fri 2026-09-25 21:40:12/);
    assert.match(p.text, /file: post\.md \(markdown\) — workspace: E:\\blog/);
    assert.match(p.text, /last edit: 11 s ago · last save: not saved this session/);
    assert.match(p.text, /cursor: line 4 of 6 · selection: none/);
    assert.match(p.text, /· · · · · · · · · · \+42\/-3 ·/);
});

test("after a commit, a small edit is sent as a diff with the cursor inside the hunk", () => {
    const w = writer();
    w.render("session_start", doc(), state()).commit();
    const lines = LINES.slice();
    lines[5] = "They are collected only with gen 2, which is expensive.";
    const p = w.render("pause", doc({ lines, cursor: { line: 5, character: 56 } }), state());
    assert.equal(p.full, false);
    assert.equal(p.unchanged, false);
    assert.ok(!p.text.includes("<document>"));
    assert.match(p.text, /<diff>\n@@ -4,3 \+4,3 @@\n Objects bigger/);
    assert.ok(p.text.includes("-They are collected only with gen 2."));
    assert.ok(p.text.includes(`+They are collected only with gen 2, which is expensive.${CURSOR}`));
    assert.ok(!p.text.includes("cursor context"), "cursor is visible in the hunk");
});

test("the cursor outside every hunk gets a cursor-context block", () => {
    const w = writer();
    w.render("session_start", doc(), state()).commit();
    const lines = LINES.slice();
    lines[5] = "Changed last line.";
    const p = w.render("pause", doc({ lines, cursor: { line: 0, character: 2 } }), state());
    assert.match(p.text, /cursor context \(lines 1–2\):\n<cursor-context>\n# ⟨cursor⟩On the large/);
});

test("an unchanged document says so, with cursor context", () => {
    const w = writer();
    w.render("session_start", doc(), state()).commit();
    const p = w.render("chat", doc({ cursor: { line: 2, character: 4 } }), state());
    assert.equal(p.unchanged, true);
    assert.match(p.text, /document: unchanged since your last look\./);
    assert.ok(p.text.includes(`The ${CURSOR}allocation happens`));
});

test("a selection is marked in the full text and quoted in its own block", () => {
    const w = writer();
    const d = doc({ selection: { start: { line: 2, character: 4 }, end: { line: 2, character: 14 } }, cursor: { line: 2, character: 14 } });
    assert.equal(selectedText(d), "allocation");
    const p = w.render("session_start", d, state());
    assert.ok(p.text.includes(`The ${SEL_OPEN}allocation${SEL_CLOSE} happens`));
    assert.ok(!p.text.includes(CURSOR), "a selection stands in for the cursor");
    assert.match(p.text, /cursor: line 3 of 6 · selection: lines 3–3/);
    assert.match(p.text, /selected text \(lines 3–3\):\n<selection>\nallocation\n<\/selection>\n<\/euterpe:perception>$/);
});

test("multi-line selections quote the exact text", () => {
    const d = doc({ selection: { start: { line: 2, character: 63 }, end: { line: 3, character: 7 } } });
    assert.equal(selectedText(d), "everything.\nObjects");
    const marked = markLines(d);
    assert.ok(marked[2].endsWith(`${SEL_OPEN}everything.`));
    assert.ok(marked[3].startsWith(`Objects${SEL_CLOSE}`));
});

test("without a commit the baseline doesn't move (a failed turn re-diffs from what Euterpe saw)", () => {
    const w = writer();
    w.render("session_start", doc(), state()).commit();
    const lines1 = LINES.slice(); lines1[5] = "first edit";
    w.render("pause", doc({ lines: lines1 }), state()); // not committed
    const lines2 = lines1.slice(); lines2[0] = "# New title";
    const p = w.render("pause", doc({ lines: lines2 }), state());
    assert.ok(p.text.includes("-They are collected only with gen 2."), "diff is still against the committed baseline");
    assert.ok(p.text.includes("-# On the large object heap"));
});

test("invalidate forces the next perception to be full, once", () => {
    const w = writer();
    w.render("session_start", doc(), state()).commit();
    w.invalidate();
    const p = w.render("pause", doc(), state());
    assert.equal(p.full, true);
    p.commit();
    assert.equal(w.render("pause", doc(), state()).full, false);
});

test("full resync after N diffs", () => {
    const w = writer({ resyncEvery: 3 });
    w.render("session_start", doc(), state()).commit();
    const fulls: boolean[] = [];
    for (let i = 0; i < 6; i++) {
        const lines = LINES.slice();
        lines[5] = `edit ${i}`;
        const p = w.render("pause", doc({ lines }), state());
        fulls.push(p.full);
        p.commit();
    }
    assert.deepEqual(fulls, [false, false, true, false, false, true]);
});

test("a large change is sent in full", () => {
    const w = new PerceptionWriter();
    w.render("session_start", doc(), state()).commit();
    const lines = ["Completely", "different", "text", "now", "", "!"];
    assert.equal(w.render("pause", doc({ lines }), state()).full, true);
});

test("switching back to a seen document yields a diff; a new document is full", () => {
    const w = writer();
    w.render("session_start", doc(), state()).commit();
    const other = doc({ key: "file:///e%3A/blog/notes.md", name: "notes.md", lines: ["notes"] , cursor: { line: 0, character: 0 } });
    const p1 = w.render("doc_switch", other, state());
    assert.equal(p1.full, true);
    p1.commit();
    const back = w.render("doc_switch", doc(), state());
    assert.equal(back.full, false);
    assert.equal(back.unchanged, true);
});

test("events since the last look are told in the header, and make the view worth a turn", () => {
    const w = writer();
    w.render("session_start", doc(), state()).commit();
    const quiet = w.render("pause", doc(), state());
    assert.equal(quiet.unchanged, true);
    assert.doesNotMatch(quiet.text, /^since your last look:/m);
    const p = w.render("edit_review", doc(), state({ events: ["the writer rejected your edit to post.md."] }));
    assert.equal(p.unchanged, false, "not skipped as 'nothing new'");
    assert.match(p.text, /reason="edit_review"/);
    assert.match(p.text, /selection: none\nsince your last look: the writer rejected your edit to post\.md\.\ndocument: unchanged since your last look\./);
});

test("session_end is announced in the header", () => {
    const w = writer();
    w.render("session_start", doc(), state()).commit();
    const p = w.render("session_end", doc(), state({ focused: false, unfocusedMs: 5 * 60_000 }));
    assert.match(p.text, /reason="session_end"/);
    assert.match(p.text, /the writer is ending the session\./);
    assert.match(p.text, /VS Code: not focused for 5 min/);
});

test("long documents are windowed around the cursor", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i} ` + "x".repeat(60));
    const w = writer({ docCharCap: 5_000 });
    const p = w.render("session_start", doc({ lines, cursor: { line: 1500, character: 3 } }), state());
    assert.match(p.text, /document \(lines \d+–\d+ of 2000, windowed around the cursor\)/);
    assert.ok(p.text.includes(`Par${CURSOR}agraph 1500`));
    assert.ok(p.text.includes("not shown)"));
    assert.ok(p.text.length < 7_000);
});

test("a cursor remembered past the end of a long document windows its end", () => {
    // The document shrank while it wasn't on screen (an accepted edit, say): the view still gets written.
    const lines = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} ` + "x".repeat(60));
    const w = writer({ docCharCap: 5_000 });
    const p = w.render("session_start", doc({ lines, cursor: { line: 1500, character: 3 } }), state());
    assert.match(p.text, /document \(lines \d+–300 of 300, windowed around the cursor\)/);
    const selected = w.render("chat", doc({ lines, selection: { start: { line: 900, character: 0 }, end: { line: 901, character: 2 } } }), state());
    assert.match(selected.text, /document \(lines \d+–300 of 300, windowed around the cursor\)/);
});

test("formatting helpers", () => {
    assert.equal(formatDuration(4_400), "4 s");
    assert.equal(formatDuration(125_000), "2 min");
    assert.equal(formatDuration(80 * 60_000), "1 h 20 min");
    assert.equal(formatActivity([{ added: 0, removed: 0 }, { added: 5, removed: 0 }, { added: 0, removed: 2 }, { added: 3, removed: 1 }]), "· +5 -2 +3/-1");
});
