import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ATTENTION, attentionFor } from "../attention";
import { buildMindEnv } from "../claudeMind";

test("an attention level is looked up by name, anything else is the closest", () => {
    assert.equal(attentionFor("relaxed"), ATTENTION.relaxed);
    assert.equal(attentionFor(""), ATTENTION.close);
    assert.equal(attentionFor(undefined), ATTENTION.close);
    assert.equal(attentionFor("constructor"), ATTENTION.close);
});

test("less attention means fewer looks and a shorter conversation", () => {
    const [close, relaxed, light] = [ATTENTION.close, ATTENTION.relaxed, ATTENTION.light];
    for (const [a, b] of [[close, relaxed], [relaxed, light]]) {
        assert.ok(a.pauseMs < b.pauseMs && a.heartbeatMs < b.heartbeatMs && a.minGapMs < b.minGapMs);
        assert.ok(a.compactWindow > b.compactWindow);
    }
});

test("the compaction window reaches the mind's environment", () => {
    assert.equal(buildMindEnv({}, "", ATTENTION.light.compactWindow).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "120000");
    assert.equal(buildMindEnv({}, "").CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
});
