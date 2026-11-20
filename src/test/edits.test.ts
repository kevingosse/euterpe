import * as assert from "node:assert/strict";
import { test } from "node:test";
import { applyReplacements, parseEdits, planEdits, TextEdit } from "../edits";
import { CURSOR, SEL_CLOSE, SEL_OPEN } from "../perception";

const TEXT = "# Title\n\nThe heap is large. The heap is slow.\nObjects bigger than 85,000 bytes end up there.\n";

const edit = (oldText: string, newText: string, replaceAll = false): TextEdit => ({ oldText, newText, replaceAll });

function apply(text: string, edits: TextEdit[]): string {
    const plan = planEdits(text, edits, "post.md");
    if (!plan.ok) { throw new Error(plan.error); }
    return applyReplacements(text, plan.replacements);
}

function failure(text: string, edits: TextEdit[]): string {
    const plan = planEdits(text, edits, "post.md");
    assert.equal(plan.ok, false);
    return plan.ok ? "" : plan.error;
}

test("a unique old_text is replaced", () => {
    assert.equal(apply(TEXT, [edit("end up there", "land there")]),
        TEXT.replace("end up there", "land there"));
});

test("several edits are matched against the document as it is now", () => {
    const out = apply(TEXT, [edit("# Title", "# The large object heap"), edit("85,000", "85 000")]);
    assert.ok(out.startsWith("# The large object heap\n"));
    assert.ok(out.includes("bigger than 85 000 bytes"));
});

test("text that isn't there, or is there twice, is refused with a reason", () => {
    assert.match(failure(TEXT, [edit("the stack", "x")]), /isn't in post\.md/);
    assert.match(failure(TEXT, [edit("The heap is", "A heap is")]), /appears 2 times in post\.md.*replace_all/);
    assert.equal(apply(TEXT, [edit("The heap", "A heap", true)]), TEXT.replace(/The heap/g, "A heap"));
    assert.match(failure(TEXT, [edit("# Title", "x"), edit("the stack", "y")]), /^edit 2: /);
});

test("overlapping or empty-handed edits are refused", () => {
    assert.match(failure(TEXT, [edit("is large. The heap", "x"), edit("The heap is slow", "y")]), /overlap/);
    assert.match(failure(TEXT, [edit("slow", "slow")]), /nothing would change/);
    assert.match(failure(TEXT, [edit("", "Intro. ")]), /old_text is empty/);
});

test("an empty old_text fills an empty (or new) document", () => {
    assert.equal(apply("", [edit("", "# Notes\n\n- one\n")]), "# Notes\n\n- one\n");
    assert.match(failure("", [edit("", "a"), edit("", "b")]), /empty/);
});

test("perception markers copied along with the text are ignored", () => {
    const out = apply(TEXT, [edit(`The heap is ${SEL_OPEN}slow${SEL_CLOSE}.`, "The heap is slow to collect.")]);
    assert.ok(out.includes("The heap is slow to collect.\n"));
    assert.equal(apply(TEXT, [edit(`Obj${CURSOR}ects bigger`, "Objects larger")]), TEXT.replace("Objects bigger", "Objects larger"));
});

test("CRLF documents take the mind's \\n text", () => {
    const crlf = TEXT.replace(/\n/g, "\r\n");
    const out = apply(crlf, [edit("slow.\nObjects", "slow.\n\nObjects")]);
    assert.ok(out.includes("slow.\r\n\r\nObjects"));
    assert.ok(!/[^\r]\n/.test(out), "every line ending stays CRLF");
});

test("the tool's edits argument is validated", () => {
    assert.deepEqual(parseEdits([{ old_text: "a", new_text: "b" }, { old_text: "c", new_text: "", replace_all: true }]),
        [edit("a", "b"), edit("c", "", true)]);
    assert.equal(typeof parseEdits([]), "string");
    assert.equal(typeof parseEdits("a"), "string");
    assert.match(parseEdits([{ old_text: "a" }]) as string, /edit 1: needs old_text and new_text/);
});
