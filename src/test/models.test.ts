import * as assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_DEFAULT_MODEL, defaultModel, MODELS, modelName, modelsFor, OPENAI_DEFAULT_MODEL, OPENAI_MODELS, sameModel } from "../models";

test("a model goes by its name, whatever its spelling", () => {
    assert.equal(modelName("sonnet"), "Sonnet");
    assert.equal(modelName("opus[1m]"), "Opus");
    assert.equal(modelName(" Haiku "), "Haiku");
    assert.equal(modelName(""), "Sonnet", "an empty setting is Euterpe's default");
    assert.equal(modelName("claude-fable-5-1"), "claude-fable-5-1");
    assert.ok(sameModel("claude-opus-5-5[1m]", "claude-opus-5-5"));
    assert.ok(!sameModel("claude-opus-5-5", "claude-opus-5"));
    assert.ok(sameModel("", " "));
});

test("the picks are Claude Code's aliases, quickest first, with no [1m] suffix", () => {
    // Claude Code resolves an alias to the family's latest model, and refuses the [1m] suffix for an account without the 1M window.
    assert.deepEqual(MODELS.map((m) => m.id), ["haiku", "sonnet", "opus", "fable"]);
    assert.ok(MODELS.some((m) => m.id === CLAUDE_DEFAULT_MODEL), "the default is one of the picks");
});

test("OpenAI's picks, and what an empty setting means on each provider", () => {
    for (const m of OPENAI_MODELS) { assert.match(m.id, /^[a-z0-9][a-z0-9.-]*$/, m.id); }
    assert.equal(modelsFor("openai"), OPENAI_MODELS);
    assert.equal(modelsFor("claude"), MODELS);
    assert.equal(defaultModel("claude", true), CLAUDE_DEFAULT_MODEL);
    assert.equal(defaultModel("openai", true), OPENAI_DEFAULT_MODEL);
    assert.ok(OPENAI_MODELS.some((m) => m.id === OPENAI_DEFAULT_MODEL), "the default is one of the picks");
    assert.equal(defaultModel("openai", false), "", "another provider's model is the writer's to name");
    assert.equal(modelName(OPENAI_MODELS[0].id, "openai"), OPENAI_MODELS[0].name);
    assert.equal(modelName("llama3.3:70b", "openai"), "llama3.3:70b");
    assert.equal(modelName("", "openai"), "no model yet");
});
