import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { choosePersona, findPersona, isPersonaId, listPersonas, loadPersonaFile, MAX_PERSONA_BYTES, newPersonaText, parsePersona, personaId } from "../personas";

const BUNDLED = path.join(__dirname, "..", "..", "mind", "personas");

function scratch(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-personas-"));
}

test("a header names and describes a persona, and comments stay out of the prompt", () => {
    const p = parsePersona("---\r\nname: Night Owl\r\ndescription: Up late with you.\r\n---\r\n<!-- a note to myself -->\r\nYou are nocturnal.\r\n", "night-owl", "x.md", false);
    assert.equal(p.name, "Night Owl");
    assert.equal(p.description, "Up late with you.");
    assert.equal(p.body, "You are nocturnal.");
});

test("without a header the name comes from the file", () => {
    const p = parsePersona("You are terse.", "dry-wit", "dry-wit.md", false);
    assert.equal(p.name, "Dry Wit");
    assert.equal(p.description, "");
    assert.equal(p.body, "You are terse.");
});

test("persona ids are plain file names", () => {
    assert.equal(personaId("My Editor!"), "my-editor");
    assert.equal(personaId("Écrivain d'été"), "ecrivain-d-ete");
    assert.equal(personaId("???"), "persona");
    assert.ok(isPersonaId("warm"));
    assert.ok(!isPersonaId("../warm"));
    assert.ok(!isPersonaId("sub/warm"));
    assert.ok(!isPersonaId(""));
});

test("the bundled personas are all there, named, described and genderless", () => {
    const all = listPersonas(BUNDLED, "");
    assert.deepEqual(all.map((p) => p.id).sort(), ["cheeky", "coach", "drill-sergeant", "editor", "fan", "warm"]);
    for (const p of all) {
        assert.ok(p.name && p.description && p.body.startsWith("Your name is Euterpe"), p.id);
        assert.doesNotMatch(p.body, /\b(she|he|her|him|his|hers)\b/i, `${p.id} gives Euterpe a gender`);
    }
});

test("the writer's own personas shadow bundled ones, and a missing one falls back to the default", () => {
    const mine = scratch();
    fs.writeFileSync(path.join(mine, "warm.md"), "---\nname: My Warm\n---\nMine.");
    fs.writeFileSync(path.join(mine, "not a persona.txt"), "ignored");
    const all = listPersonas(BUNDLED, mine);
    assert.equal(all.find((p) => p.id === "warm")?.name, "My Warm");
    assert.equal(all.find((p) => p.id === "warm")?.bundled, false);
    assert.equal(findPersona("../warm", BUNDLED, mine), null);

    assert.equal(choosePersona("warm", BUNDLED, mine).persona.body, "Mine.");
    const gone = choosePersona("vanished", BUNDLED, mine);
    assert.equal(gone.persona.id, "cheeky");
    assert.equal(gone.missing, "vanished");
    assert.equal(choosePersona("", BUNDLED, mine).persona.id, "cheeky");
});

test("a persona file is named after itself, and an oversized one is refused", () => {
    const dir = scratch();
    const file = path.join(dir, "Stage Fright.md");
    fs.writeFileSync(file, "You are shy.");
    assert.equal(loadPersonaFile(file).body, "You are shy.");
    assert.equal(loadPersonaFile(file).id, "stage-fright");
    fs.writeFileSync(file, "x".repeat(MAX_PERSONA_BYTES + 1));
    assert.throws(() => loadPersonaFile(file), /at most/);
});

test("a new persona starts as a copy of another, with notes that stay out of the prompt", () => {
    const warm = findPersona("warm", BUNDLED, "")!;
    const p = parsePersona(newPersonaText("Sunny", warm), "sunny", "sunny.md", false);
    assert.equal(p.name, "Sunny");
    assert.equal(p.body, warm.body);
});
