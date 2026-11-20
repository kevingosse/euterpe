import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { chooseMascot, CLAWD, defaultMascot, findMascot, listMascots, loadMascotFile, MAX_MASCOT_BYTES } from "../mascots";
import { sheetProblems } from "../sheet";

const BUNDLED = path.join(__dirname, "..", "..", "mascots");

function scratch(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-mascots-"));
}
const pack = (name: string, extra: object = {}) => JSON.stringify({ name, colors: { B: "#aabbcc" }, views: { front: { rows: ["BB"], eyes: [[0, 0]] } }, ...extra });

test("Clawd comes first, then the bundled packs, each named, described and given a body", () => {
    const all = listMascots(BUNDLED, "");
    assert.equal(all[0], CLAWD);
    assert.ok(all.length > 1, "at least one bundled pack");
    for (const m of all) {
        assert.ok(m.name && m.description && m.body, m.id);
        assert.doesNotMatch(m.body, /\b(she|he|her|him|his|hers)\b/i, `${m.id}'s body gives Euterpe a gender`);
    }
});

test("the writer's packs shadow bundled ones; Clawd's name stays Clawd's", () => {
    const mine = scratch();
    fs.writeFileSync(path.join(mine, "boo.json"), pack("My Boo"));
    fs.writeFileSync(path.join(mine, "clawd.json"), pack("Impostor"));
    fs.writeFileSync(path.join(mine, "notes.txt"), "not a mascot");
    fs.writeFileSync(path.join(mine, "broken.json"), "{ nope");
    const all = listMascots(BUNDLED, mine);
    assert.equal(all.find((m) => m.id === "boo")?.name, "My Boo");
    assert.equal(all.filter((m) => m.id === "clawd").length, 1);
    assert.equal(findMascot("clawd", BUNDLED, mine), CLAWD);
    assert.equal(findMascot("boo", BUNDLED, mine)?.bundled, false);
    assert.equal(findMascot("../boo", BUNDLED, mine), null);
    assert.ok(!all.some((m) => m.id === "broken"));
});

test("a missing mascot leaves Clawd on stage, and says which", () => {
    assert.deepEqual(chooseMascot("gone", BUNDLED, ""), { mascot: CLAWD, missing: "gone" });
    assert.deepEqual(chooseMascot("", BUNDLED, ""), { mascot: CLAWD });
});

test("a pack's text reaches the mind on one line, capped; a body is made up if it has none", () => {
    const dir = scratch(), file = path.join(dir, "Night Owl.json");
    fs.writeFileSync(file, pack("Owl", { body: "a round owl\nwith\tbig eyes " + "x".repeat(400) }));
    const m = loadMascotFile(file);
    assert.equal(m.id, "night-owl");
    assert.ok(m.body.startsWith("a round owl with big eyes x"));
    assert.equal(m.body.length, 280);
    fs.writeFileSync(file, pack("Owl"));
    assert.equal(loadMascotFile(file).body, "a small pixel creature called Owl");
});

test("what isn't a mascot is refused with the reason", () => {
    const dir = scratch(), file = path.join(dir, "x.json");
    for (const [content, why] of [
        ["{ nope", /isn't valid JSON/],
        ["[1, 2]", /a JSON object/],
        [JSON.stringify({ views: { front: { rows: [] } } }), /has no "name"/],
        [JSON.stringify({ name: "Nobody" }), /no front view/],
        [JSON.stringify({ name: "Big", views: { front: { rows: ["x".repeat(MAX_MASCOT_BYTES)] } } }), /at most/],
    ] as const) {
        fs.writeFileSync(file, content);
        assert.throws(() => loadMascotFile(file), why);
    }
});

test("the renderer's report is read for the pack's problems, without Chromium's own log", () => {
    const stderr = "[1234:0927/221530.123:ERROR:gpu_init.cc(1)] GPU says hi\ninvalid: colors.\"B\" is missing.\nviews.front.rows[2] has \"Z\".\n";
    assert.equal(sheetProblems(stderr, 2), "colors.\"B\" is missing.\nviews.front.rows[2] has \"Z\".");
    assert.match(sheetProblems("boom\n", 1), /couldn't be drawn \(exit 1\): boom/);
});

test("off Claude, Clawd stays out: the lists leave it out, and Inky is the default body", () => {
    const all = listMascots(BUNDLED, "", "openai");
    assert.ok(!all.some((m) => m.id === "clawd"));
    assert.ok(all.some((m) => m.id === "inky"));
    assert.equal(findMascot("clawd", BUNDLED, "", "openai"), null);
    // Clawd, the setting's default, isn't "missing": it waits for Claude
    assert.deepEqual(chooseMascot("clawd", BUNDLED, "", "openai").mascot.id, "inky");
    assert.equal(chooseMascot("clawd", BUNDLED, "", "openai").missing, undefined);
    assert.equal(chooseMascot("", BUNDLED, "", "openai").mascot.id, "inky");
    assert.equal(chooseMascot("boo", BUNDLED, "", "openai").mascot.id, "boo");
    assert.deepEqual([chooseMascot("gone", BUNDLED, "", "openai").mascot.id, chooseMascot("gone", BUNDLED, "", "openai").missing], ["inky", "gone"]);
    // and back on Claude, Clawd is back
    assert.equal(chooseMascot("clawd", BUNDLED, "", "claude").mascot, CLAWD);
    assert.equal(defaultMascot("openai"), "inky");
    assert.equal(defaultMascot("claude"), "clawd");
});

test("off Claude, the writer's own pack named clawd is still theirs to wear", () => {
    const mine = scratch();
    fs.writeFileSync(path.join(mine, "my-clawd.json"), pack("My Clawd"));
    assert.equal(chooseMascot("my-clawd", BUNDLED, mine, "openai").mascot.name, "My Clawd");
});
