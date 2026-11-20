import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { renderMascotSheet } from "../sheet";
import { devElectron, needsElectron, root } from "./devElectron";

// These draw offscreen, with the development Electron: nothing appears on screen.
const electronPath = devElectron();
const skip = needsElectron();

test("every bundled mascot holds up, and Clawd's sheet is drawn too", { skip, timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-sheet-"));
    const packs = fs.readdirSync(path.join(root, "mascots")).filter((f) => f.endsWith(".json")).map((f) => path.join(root, "mascots", f));
    for (const packFile of [null, ...packs]) {
        const out = path.join(dir, `${path.basename(packFile ?? "clawd")}.png`);
        const r = await renderMascotSheet({ electronPath: electronPath!, overlayDir: path.join(root, "overlay"), packFile, out, scale: 1 });
        assert.deepEqual(r, { ok: true, png: out }, packFile ?? "clawd");
        assert.equal(fs.readFileSync(out).subarray(1, 4).toString(), "PNG");
    }
});

test("a broken mascot comes back as its list of problems", { skip, timeout: 60_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-sheet-"));
    const pack = path.join(dir, "broken.json");
    fs.writeFileSync(pack, JSON.stringify({ name: "Broken", colors: { B: "#123456" }, views: { front: { rows: ["BZB"], eyes: [[9, 9]] } } }));
    const r = await renderMascotSheet({ electronPath: electronPath!, overlayDir: path.join(root, "overlay"), packFile: pack, out: path.join(dir, "x.png"), scale: 1 });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.problems : "", /rows\[0\] has "Z"[\s\S]*eyes\[0\] \[9,9\] is outside/);
});
