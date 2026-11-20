import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { test } from "node:test";

// The avatar's engine is browser script (overlay/renderer/clawd); everything up to the director
// is plain JavaScript, so it runs here as the overlay loads it.
const ENGINE = ["core.js", "glyphs.js", "rig.js", "body.js", "pack.js", "emotes.js", "acting.js", "director.js"];
const dir = path.join(__dirname, "..", "..", "overlay", "renderer", "clawd");
const bundled = path.join(__dirname, "..", "..", "mascots");

function engine(): any {
    const window: any = {};
    const context = vm.createContext({ window });
    for (const file of ENGINE) vm.runInContext(fs.readFileSync(path.join(dir, file), "utf8"), context, { filename: file });
    return window.Clawd;
}

const C = engine();
const R: number = C.RELAX;
// a director that has been on stage for a while, feeling `name` since t = 0
function feeling(name: string, opts?: object) {
    const d = new C.Director({ seed: 1 });
    d.enter(-30);
    d.setExpression(name, 0, opts);
    return d;
}

test("a mood relaxes into neutral when nothing renews it", () => {
    const d = feeling("smug");
    assert.equal(d.expressionAt(R - 1), "smug");
    assert.equal(d.expressionAt(R + 1), "neutral");
    assert.equal(d.expressionAt(600), "neutral");
});

test("big feelings pass through their settle first", () => {
    const d = feeling("laugh");
    assert.equal(d.expressionAt(1), "laugh");
    assert.equal(d.expressionAt(10), "happy");
    assert.equal(d.expressionAt(10 + R), "neutral");
});

test("a doze and a calm face stay", () => {
    assert.equal(feeling("sleepy").expressionAt(600), "sleepy");
    assert.equal(feeling("neutral").expressionAt(600), "neutral");
});

test("a mood repeated in silence doesn't come back once it has passed", () => {
    const d = feeling("love");
    d.setExpression("happy", 20, { fresh: false });   // where love settles anyway
    assert.equal(d.expressionAt(20 + R), "neutral");
    d.setExpression("happy", 20 + R + 5, { fresh: false });
    d.setExpression("love", 20 + R + 10, { fresh: false });
    assert.equal(d.expressionAt(20 + R + 11), "neutral");
    // a change is a change, silent or not
    d.setExpression("curious", 20 + R + 12, { fresh: false });
    assert.equal(d.expressionAt(20 + R + 13), "curious");
});

test("with words or a gesture, the same mood lasts longer, or comes back", () => {
    const d = feeling("happy");
    d.setExpression("happy", R - 5, { fresh: true });
    assert.equal(d.expressionAt(R + 5), "happy");
    assert.equal(d.expressionAt(2 * R), "neutral");
    d.setExpression("happy", 3 * R, { fresh: true });
    assert.equal(d.expressionAt(3 * R + 1), "happy");
});

test("thinking lasts as long as the turn, then goes the answer's way", () => {
    const d = feeling("happy");
    d.setThinking(true, 5);
    assert.equal(d.expressionAt(300), "thinking");
    d.setExpression("thinking", 300, { fresh: false });   // the answer, in the same mood
    assert.equal(d.expressionAt(300 + R - 1), "thinking");
    assert.equal(d.expressionAt(300 + R + 1), "neutral");
});

// ---------- mascot packs ----------

const readPack = (file: string) => JSON.parse(fs.readFileSync(path.join(bundled, file), "utf8"));

test("every bundled pack compiles", () => {
    for (const file of fs.readdirSync(bundled).filter((f) => f.endsWith(".json"))) {
        assert.doesNotThrow(() => C.compileMascot(readPack(file), file), file);
    }
});

test("brows that don't hold up are reported, each with where it is", () => {
    const pack = { name: "Owl", colors: { B: "#aabbcc" }, views: { front: { rows: ["BBBB"], eyes: [[2, 0]] } } };
    assert.doesNotThrow(() => C.compileMascot({ ...pack, brows: true }));
    assert.throws(() => C.compileMascot({ ...pack, brows: { above: 40, width: 2.5, color: "black" } }), (err: any) => {
        assert.equal(err.problems.length, 3);
        assert.match(err.problems.join("\n"), /brows\."above"[\s\S]*brows\."width"[\s\S]*brows\."color"/);
        return true;
    });
    assert.throws(() => C.compileMascot({ ...pack, brows: [1, 2] }), /"brows" should be true, or an object/);
});

test("brows move with the mood, and talk for a body without a mouth", () => {
    const clippy = C.compileMascot(readPack("clippy.json"), "clippy");
    const ink = C.pack(clippy.brows.color);
    // the highest row of brow on each side of the face
    const tops = (pose: object) => {
        const f = new C.Frame(80, 64);
        C.useMascot(clippy);
        clippy.draw(f, 40, 57, pose, 0);
        C.useMascot(null);
        const top = [Infinity, Infinity];
        f.data.forEach((v: number, i: number) => { if (v === ink) { const side = i % 80 < 40 ? 0 : 1; top[side] = Math.min(top[side], Math.floor(i / 80)); } });
        return top;
    };
    const rest = tops(C.feel("neutral", 0));
    assert.ok(rest.every(Number.isFinite), "brows are drawn");
    assert.equal(rest[0], rest[1]);
    assert.ok(tops(C.feel("surprised", 0))[0] < rest[0], "raised in surprise");
    const curious = tops(C.feel("curious", 0));
    assert.ok(curious[1] < curious[0], "one raised in curiosity");
    assert.deepEqual(tops({ ...C.feel("neutral", 0), speaking: true }), rest.map((y) => y - 1));
    // a gesture that closes the eyes (a facepalm) takes the brows with it, whatever the mood
    assert.notDeepEqual(tops({ ...C.feel("surprised", 0), eyes: "closed" }), tops(C.feel("surprised", 0)));
});

test("a body of odd width is drawn pixel for pixel", () => {
    for (const row of ["BBB", "BBBBBBBBBBBBBBBBBBBBB"]) {
        // eyes at the top, and the bottom row counted: it stands on the ground point's row
        const m = C.compileMascot({ name: "Odd", colors: { B: "#aabbcc" }, views: { front: { rows: Array(9).fill(row), eyes: [[1.5, 1]] } } });
        const f = new C.Frame(80, 64);
        m.draw(f, 40, 57, { noShadow: true }, 0);
        const bottom = Array.from(f.data.subarray(56 * 80, 57 * 80));
        assert.equal(bottom.filter((v) => v === C.pack("#aabbcc")).length, row.length, `${row.length} wide`);
    }
});
