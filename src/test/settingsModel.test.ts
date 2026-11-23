import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { ATTENTION } from "../attention";
import { OPENAI_MODELS } from "../models";
import { AVATAR_SCALES, checkSetting, EFFORTS, MACHINE_SETTINGS, modelViews, SETTINGS } from "../settingsModel";

// The settings package.json contributes, by key (without "euterpe."), across its sections.
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
const contributed: Record<string, any> = {};
for (const section of manifest.contributes.configuration) {
    for (const [key, schema] of Object.entries(section.properties)) { contributed[key.replace(/^euterpe\./, "")] = schema; }
}

test("the settings window covers every setting, and only those", () => {
    assert.deepEqual(Object.keys(SETTINGS).sort(), Object.keys(contributed).sort());
});

test("the paths and the API's address are exactly the machine settings, which a workspace can't set", () => {
    const machine = Object.keys(contributed).filter((k) => contributed[k].scope === "machine");
    assert.deepEqual([...MACHINE_SETTINGS].sort(), machine.sort());
});

test("the window's choices are package.json's", () => {
    assert.deepEqual([...EFFORTS], contributed.effort.enum);
    assert.deepEqual([...AVATAR_SCALES], contributed.avatarScale.enum);
    assert.deepEqual(Object.keys(ATTENTION), contributed.attention.enum);
    // each default is one the window accepts
    for (const [key, schema] of Object.entries(contributed)) {
        assert.deepEqual(checkSetting(key, schema.default), { key, value: schema.default }, key);
    }
});

test("choices are checked before they become settings", () => {
    assert.deepEqual(checkSetting("persona", "warm"), { key: "persona", value: "warm" });
    assert.equal(checkSetting("persona", "../warm"), null);
    assert.equal(checkSetting("mascot", "sub/boo"), null);
    assert.equal(checkSetting("avatarScale", 7), null);
    assert.equal(checkSetting("avatarScale", "4"), null);
    assert.equal(checkSetting("effort", "extreme"), null);
    assert.equal(checkSetting("effort", "max"), null);
    assert.equal(checkSetting("effort", ""), null);
    assert.equal(checkSetting("attention", "rapt"), null);
    assert.equal(checkSetting("followActiveEditor", "true"), null);
    assert.deepEqual(checkSetting("debugMind", false), { key: "debugMind", value: false });
});

test("a model is one word Claude Code resolves", () => {
    for (const m of ["claude-sonnet-5-5", "claude-opus-5-5[1m]", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/x", ""]) {
        assert.deepEqual(checkSetting("model", m), { key: "model", value: m }, m);
    }
    assert.deepEqual(checkSetting("model", " claude-sonnet-5-5 "), { key: "model", value: "claude-sonnet-5-5" });
    assert.equal(checkSetting("model", "claude sonnet"), null);
    assert.equal(checkSetting("model", "x".repeat(201)), null);
});

test("a path is one line, trimmed", () => {
    assert.deepEqual(checkSetting("homeDir", "  ~/Sync/euterpe  "), { key: "homeDir", value: "~/Sync/euterpe" });
    assert.equal(checkSetting("claudePath", "C:\\claude.exe\n--dangerous"), null);
    assert.equal(checkSetting("electronPath", "x".repeat(1025)), null);
    assert.equal(checkSetting("personaFile", 5), null);
});

test("only Euterpe's own settings can be set", () => {
    for (const key of ["claudeArgs", "__proto__", "constructor", "toString", 3, null]) {
        assert.equal(checkSetting(key, "x"), null, String(key));
    }
});

test("the models offered: Euterpe's picks, and the current one", () => {
    const ids = (current: string) => modelViews(current).map((m) => m.id);
    assert.deepEqual(ids(""), ["haiku", "sonnet", "opus", "fable"]);
    assert.deepEqual(ids("sonnet[1m]"), ["haiku", "sonnet", "opus", "fable"]);
    assert.deepEqual(ids("claude-opus-5"), ["haiku", "sonnet", "opus", "fable", "claude-opus-5"]);
});

test("the provider, the API's address and its model are checked too", () => {
    assert.deepEqual(checkSetting("provider", "openai"), { key: "provider", value: "openai" });
    assert.equal(checkSetting("provider", "gemini"), null);
    assert.deepEqual(checkSetting("openaiBaseUrl", " https://openrouter.ai/api/v1 "), { key: "openaiBaseUrl", value: "https://openrouter.ai/api/v1" });
    assert.deepEqual(checkSetting("openaiBaseUrl", ""), { key: "openaiBaseUrl", value: "" });
    for (const bad of ["openrouter.ai", "file:///etc", "javascript:alert(1)", "https://x.y/\nhttps://evil", 5]) { assert.equal(checkSetting("openaiBaseUrl", bad), null, String(bad)); }
    assert.deepEqual(checkSetting("openaiModel", "meta-llama/llama-3.3-70b-instruct:free"), { key: "openaiModel", value: "meta-llama/llama-3.3-70b-instruct:free" });
    assert.equal(checkSetting("openaiModel", "gpt 5"), null);
});

test("the models offered off Claude: OpenAI's picks on its API, the one named elsewhere", () => {
    const ids = (current: string, openaiApi: boolean) => modelViews(current, "openai", openaiApi).map((m) => m.id);
    const picks = OPENAI_MODELS.map((m) => m.id);
    assert.deepEqual(ids("", true), picks);
    assert.deepEqual(ids("gpt-older", true), [...picks, "gpt-older"]);
    assert.deepEqual(ids("", false), []);
    assert.deepEqual(ids("qwen3-coder:30b", false), ["qwen3-coder:30b"]);
});

test("on GitHub Copilot: the models it offers, and the one named if it's none of them", () => {
    assert.deepEqual(checkSetting("provider", "copilot"), { key: "provider", value: "copilot" });
    assert.deepEqual(checkSetting("copilotModel", "claude-sonnet-4.5"), { key: "copilotModel", value: "claude-sonnet-4.5" });
    assert.equal(checkSetting("copilotModel", "claude sonnet"), null);
    const offered = [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", detail: "" }];
    assert.deepEqual(modelViews("", "copilot", true, offered).map((m) => m.id), ["gpt-6.1-sol"], "never OpenAI's picks, whatever the API's address");
    assert.deepEqual(modelViews("gone-model", "copilot", false, offered).map((m) => m.id), ["gpt-6.1-sol", "gone-model"]);
    assert.deepEqual(modelViews("", "copilot", true).map((m) => m.id), []);
});
