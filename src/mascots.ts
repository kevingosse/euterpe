// Mascots: the body Euterpe wears on screen. Clawd is drawn by hand (overlay/renderer/clawd/body.js);
// every other mascot is a pack, data the overlay draws with the same engine (clawd/pack.js there,
// docs/mascots.md for the format). Some packs come with the extension (mascots/); the writer's own
// live in Euterpe's home (mascots/) and shadow a bundled one of the same name. vscode-free, for the
// tests. The checks here are light (a readable file, a name, a front view): the overlay's are the
// full ones, and a preview shows them.
//
// Clawd is Claude Code's mascot, so Clawd only fronts a mind that runs on Claude: with any other
// (euterpe.provider), the lists leave Clawd out and the default body is Inky.

import * as fs from "fs";
import * as path from "path";
import { isPersonaId as isFileId, personaId as fileId } from "./personas";
import { Provider } from "./providers";

export interface Mascot {
    /** The file's name without .json ("clawd" for Clawd): what euterpe.mascot holds. */
    id: string;
    name: string;
    description: string;
    /** The body as the mind hears it described. */
    body: string;
    /** The pack file; null for Clawd, who isn't one. */
    file: string | null;
    /** Came with the extension (as opposed to the writer's own). */
    bundled: boolean;
    /** The parsed pack; null for Clawd. */
    pack: Record<string, unknown> | null;
}

export const DEFAULT_MASCOT = "clawd";
/** The default body of a mind that isn't on Claude (a bundled pack). */
export const OTHER_DEFAULT_MASCOT = "inky";
export const MAX_MASCOT_BYTES = 128 * 1024;

export const CLAWD: Mascot = {
    id: DEFAULT_MASCOT,
    name: "Clawd",
    description: "The Claude Code mascot: a terracotta box on stubby legs.",
    body: "a terracotta box with stubby legs, little arm nubs and two slit eyes",
    file: null,
    bundled: true,
    pack: null,
};

/** The body Euterpe wears unless the writer picked another. */
export function defaultMascot(provider: Provider): string {
    return provider === "claude" ? DEFAULT_MASCOT : OTHER_DEFAULT_MASCOT;
}

export const isMascotId = isFileId;
/** An id for a mascot called `name` ("Night Owl" → "night-owl"). */
export const mascotId = fileId;

/** A pack file, lightly checked. Throws with the reason when it isn't one. */
export function loadMascotFile(file: string, bundled = false): Mascot {
    const size = fs.statSync(file).size;
    if (size > MAX_MASCOT_BYTES) {
        throw new Error(`${path.basename(file)} is ${Math.round(size / 1024)} KB; a mascot is at most ${MAX_MASCOT_BYTES / 1024} KB.`);
    }
    let pack: unknown;
    try {
        pack = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    } catch (err) {
        throw new Error(`${path.basename(file)} isn't valid JSON: ${(err as Error).message}`);
    }
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) { throw new Error(`${path.basename(file)} isn't a mascot: a mascot is a JSON object.`); }
    const p = pack as Record<string, any>;
    if (typeof p.name !== "string" || !p.name.trim()) { throw new Error(`${path.basename(file)} has no "name".`); }
    if (!Array.isArray(p.views?.front?.rows)) { throw new Error(`${path.basename(file)} has no front view ("views": { "front": { "rows": […] } }).`); }
    const oneLine = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
    const stem = path.basename(file).replace(/\.json$/i, "");
    const name = oneLine(p.name, 40);
    return {
        // the file's own name, as findMascot looks it up (as installing would name it, if it isn't one);
        // Clawd's name is taken
        id: stem.toLowerCase() === DEFAULT_MASCOT ? mascotId(name) : isMascotId(stem) ? stem : mascotId(stem),
        name,
        description: oneLine(p.description, 200),
        body: oneLine(p.body, 280) || `a small pixel creature called ${name}`,
        file,
        bundled,
        pack: p,
    };
}

/** Every mascot there is: Clawd (on Claude), the bundled packs, then the writer's (which win on a shared id). */
export function listMascots(bundledDir: string, userDir: string, provider: Provider = "claude"): Mascot[] {
    const byId = new Map<string, Mascot>(provider === "claude" ? [[CLAWD.id, CLAWD]] : []);
    for (const [dir, bundled] of [[bundledDir, true], [userDir, false]] as const) {
        let names: string[] = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const f of names.sort()) {
            if (!/\.json$/i.test(f) || !isMascotId(f.slice(0, -5)) || f.slice(0, -5).toLowerCase() === DEFAULT_MASCOT) { continue; }
            try {
                const m = loadMascotFile(path.join(dir, f), bundled);
                byId.set(m.id, m);
            } catch { /* not a mascot; the chooser shows the ones that are */ }
        }
    }
    return [...byId.values()];
}

/** The mascot called `id`, the writer's own before a bundled one; null if there's none (or it's Clawd, off Claude). */
export function findMascot(id: string, bundledDir: string, userDir: string, provider: Provider = "claude"): Mascot | null {
    if (id === DEFAULT_MASCOT) { return provider === "claude" ? CLAWD : null; }
    if (!isMascotId(id)) { return null; }
    for (const [dir, bundled] of [[userDir, false], [bundledDir, true]] as const) {
        const file = path.join(dir, `${id}.json`);
        if (!dir || !fs.existsSync(file)) { continue; }
        try { return loadMascotFile(file, bundled); } catch { /* a broken one: try the next */ }
    }
    return null;
}

/**
 * The mascot a session wears: the one euterpe.mascot names, else the default (`missing` says which
 * wasn't found). Off Claude, Clawd (the setting's default) means the other default: it isn't
 * missing, only waiting for Claude.
 */
export function chooseMascot(id: string, bundledDir: string, userDir: string, provider: Provider = "claude"): { mascot: Mascot; missing?: string } {
    const fallback = defaultMascot(provider);
    const wanted = !id || (id === DEFAULT_MASCOT && provider !== "claude") ? fallback : id;
    const mascot = findMascot(wanted, bundledDir, userDir, provider);
    if (mascot) { return { mascot }; }
    const missing = wanted === fallback ? undefined : wanted;
    const other = findMascot(fallback, bundledDir, userDir, provider) ?? listMascots(bundledDir, userDir, provider)[0];
    if (!other) { throw new Error(`Euterpe's bundled mascots are missing from ${bundledDir}.`); }
    return missing ? { mascot: other, missing } : { mascot: other };
}
