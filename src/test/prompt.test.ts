import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { ATTENTION } from "../attention";
import { assemblePrompt, platformName } from "../prompt";

const FILL = {
    persona: "Be kind.", memoryDir: "C:\\Users\\writer\\.euterpe", platform: "Windows (x64)", editor: "Visual Studio Code",
    cadence: ATTENTION.relaxed.cadence, body: "a small ghost; you float", mascotGuide: "C:\\ext\\docs\\mascots.md",
    web: "fetch web pages", fileTools: "write_file or edit_file",
};

test("the bundled template has no blank left once filled", () => {
    const template = fs.readFileSync(path.join(__dirname, "..", "..", "mind", "system-prompt.md"), "utf8");
    const prompt = assemblePrompt(template, FILL);
    assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
    assert.ok(prompt.includes("C:/Users/writer/.euterpe/memory.md"));
    assert.ok(prompt.includes("runs Windows (x64)"));
    assert.ok(prompt.includes("while they write in Visual Studio Code"));
    assert.ok(prompt.includes("While they write, you look when they stop for a few seconds, and at least every minute"));
    assert.ok(prompt.includes("small pixel creature in the corner: a small ghost; you float. It breathes"));
    assert.ok(prompt.includes("`C:/ext/docs/mascots.md`"));
    assert.ok(prompt.includes("run shell commands, and fetch web pages. Nothing asks"));
    assert.ok(prompt.includes("use `propose_edit`, not write_file or edit_file."));
    assert.ok(prompt.trimEnd().endsWith("Be kind."));
});

test("a persona is inserted as written, replacement patterns included", () => {
    const prompt = assemblePrompt("## Persona\n\n{{PERSONA}}", { ...FILL, persona: "Costs $& and $1, or $$." });
    assert.equal(prompt, "## Persona\n\nCosts $& and $1, or $$.");
});

test("the platform is named the way people name it", () => {
    assert.equal(platformName("darwin", "arm64"), "macOS (Apple silicon)");
    assert.equal(platformName("darwin", "x64"), "macOS (Intel)");
    assert.equal(platformName("win32", "x64"), "Windows (x64)");
    assert.equal(platformName("linux", "arm64"), "Linux (arm64)");
});
