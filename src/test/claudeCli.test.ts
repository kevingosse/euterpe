import * as assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCandidates, ClaudeNotFound, compareVersions, Machine, MIN_CLAUDE_VERSION, parseClaudeVersion, resolveClaude } from "../claudeCli";

const quiet = () => { /* no log */ };

function windows(files: string[], PATH: string): Machine {
    const set = new Set(files.map((f) => f.toLowerCase()));
    return {
        platform: "win32",
        home: "C:\\Users\\w",
        env: { PATH, APPDATA: "C:\\Users\\w\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\w\\AppData\\Local" },
        exists: (p) => set.has(p.toLowerCase()),
    };
}

function mac(files: string[], PATH: string): Machine {
    const set = new Set(files);
    return { platform: "darwin", home: "/Users/m", env: { PATH }, exists: (p) => set.has(p) };
}

test("versions: only Claude Code's own answer counts, compared numerically", () => {
    assert.equal(parseClaudeVersion("2.1.283 (Claude Code)\n"), "2.1.283");
    assert.equal(parseClaudeVersion("Claude 1.0.9"), null);   // the desktop app, or anything else named claude
    assert.equal(compareVersions("2.1.259", "2.1.259"), 0);
    assert.equal(compareVersions("2.1.1000", "2.1.259"), 1);
    assert.equal(compareVersions("2.0.99", "2.1.0"), -1);
    assert.equal(compareVersions("3", "2.9.9"), 1);
});

test("Windows: Claude Desktop's alias is skipped, npm's shim leads to its real binary", () => {
    const npmDir = "C:\\Users\\w\\AppData\\Roaming\\npm";
    const m = windows([
        "C:\\Users\\w\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe",
        `${npmDir}\\claude.cmd`,
        `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
        "C:\\Users\\w\\.local\\bin\\claude.exe",
    ], `C:\\Users\\w\\AppData\\Local\\Microsoft\\WindowsApps;${npmDir}`);
    const c = claudeCandidates("", null, m);
    assert.deepEqual(c.map((x) => x.source), ["npm (PATH)", "native installer"]);
    assert.equal(c[0].path, `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`);
});

test("macOS: PATH first, then the installers' usual places, then the Claude Code extension's copy", () => {
    const m = mac(["/Users/m/.local/bin/claude", "/opt/homebrew/bin/claude", "/ext/claude"], "/usr/bin:/bin");
    assert.deepEqual(claudeCandidates("", "/ext/claude", m).map((x) => x.source),
        ["native installer", "Homebrew", "Claude Code VS Code extension"]);
    // on PATH as well: found there first, and not listed twice
    const onPath = mac(["/Users/m/.local/bin/claude"], "/Users/m/.local/bin:/usr/bin");
    assert.deepEqual(claudeCandidates("", null, onPath).map((x) => x.source), ["PATH"]);
});

test("an explicit euterpe.claudePath is the only candidate; 'claude' still means automatic", () => {
    const m = mac(["/Users/m/.local/bin/claude", "/custom/claude"], "");
    assert.deepEqual(claudeCandidates("/custom/claude", null, m).map((x) => x.path), ["/custom/claude"]);
    assert.deepEqual(claudeCandidates("/missing/claude", null, m), []);
    assert.deepEqual(claudeCandidates("claude", null, m).map((x) => x.source), ["native installer"]);
});

test("resolveClaude takes the first recent Claude Code and explains every failure", async () => {
    const m = mac(["/Users/m/.local/bin/claude", "/opt/homebrew/bin/claude", "/ext/claude"], "");
    const versions: Record<string, string | null> = {
        "/Users/m/.local/bin/claude": null,      // not Claude Code
        "/opt/homebrew/bin/claude": "2.1.100",   // too old
        "/ext/claude": "2.1.283",
    };
    const probe = async (exe: string) => versions[exe] ?? null;
    const found = await resolveClaude("", "/ext/claude", {}, quiet, m, probe);
    assert.deepEqual(found, { path: "/ext/claude", source: "Claude Code VS Code extension", version: "2.1.283" });

    await assert.rejects(resolveClaude("", null, {}, quiet, m, probe), (err: Error) =>
        new RegExp(`2\\.1\\.100 .* needs ${MIN_CLAUDE_VERSION.replace(/\./g, "\\.")}`).test(err.message) && !(err instanceof ClaudeNotFound));
    // Nowhere at all: the one failure that offers the other minds (extension.ts).
    await assert.rejects(resolveClaude("", null, {}, quiet, mac([], ""), probe), (err: Error) => /isn't installed/.test(err.message) && err instanceof ClaudeNotFound);
    await assert.rejects(resolveClaude("/custom/claude", null, {}, quiet, m, probe), (err: Error) =>
        /euterpe\.claudePath is set to \/custom\/claude/.test(err.message) && !(err instanceof ClaudeNotFound));
});
