// Personas: who Euterpe is, in Markdown, inserted into the mind's system prompt. Some come with
// the extension (mind/personas/); the writer's own live in Euterpe's home (personas/), and shadow
// a bundled one of the same name. vscode-free, for the tests; the commands are in extension.ts.
//
// A persona file may open with a header naming and describing it, and may hold notes to its author
// in HTML comments (left out of the prompt):
//
//   ---
//   name: Cheeky
//   description: Teasing, playful banter; drops the bit when you're really stuck.
//   ---
//   Your name is Euterpe…

import * as fs from "fs";
import * as path from "path";

export interface Persona {
    /** The file's name without .md: what euterpe.persona holds. */
    id: string;
    name: string;
    description: string;
    /** What goes into the prompt. */
    body: string;
    file: string;
    /** Shipped with the extension (as opposed to the writer's own). */
    bundled: boolean;
}

export const DEFAULT_PERSONA = "cheeky";
/** A persona's text is part of an agent's instructions: keep it to a persona's size. */
export const MAX_PERSONA_BYTES = 32 * 1024;

/** A persona id is a plain file name: no paths, so a setting can't point anywhere else. */
export function isPersonaId(id: string): boolean {
    return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id);
}

/** An id for a persona called `name` ("My Editor!" → "my-editor"). */
export function personaId(name: string): string {
    const id = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    return isPersonaId(id) ? id : "persona";
}

export function parsePersona(text: string, id: string, file: string, bundled: boolean): Persona {
    let body = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
    let name = "", description = "";
    const header = body.match(/^---\n([\s\S]*?)\n---\n?/);
    if (header) {
        body = body.slice(header[0].length);
        for (const line of header[1].split("\n")) {
            const m = line.match(/^\s*(name|description)\s*:\s*(.*?)\s*$/i);
            if (m) { m[1].toLowerCase() === "name" ? (name = m[2]) : (description = m[2]); }
        }
    }
    body = body.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
    return { id, name: name || titleCase(id), description, body, file, bundled };
}

/** Every persona there is: the bundled ones, then the writer's (which win on a shared id). */
export function listPersonas(bundledDir: string, userDir: string): Persona[] {
    const byId = new Map<string, Persona>();
    for (const [dir, bundled] of [[bundledDir, true], [userDir, false]] as const) {
        let names: string[] = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const f of names.sort()) {
            const id = f.endsWith(".md") ? f.slice(0, -3) : "";
            if (!isPersonaId(id)) { continue; }
            const p = readPersona(path.join(dir, f), id, bundled);
            if (p) { byId.set(id, p); }
        }
    }
    return [...byId.values()];
}

/** The persona called `id`, the writer's own before a bundled one; null if there's none. */
export function findPersona(id: string, bundledDir: string, userDir: string): Persona | null {
    if (!isPersonaId(id)) { return null; }
    return readPersona(path.join(userDir, `${id}.md`), id, false) ?? readPersona(path.join(bundledDir, `${id}.md`), id, true);
}

/** A persona file anywhere (one being installed, or just written). Throws if unreadable or too big. */
export function loadPersonaFile(file: string): Persona {
    const size = fs.statSync(file).size;
    if (size > MAX_PERSONA_BYTES) {
        throw new Error(`${path.basename(file)} is ${Math.round(size / 1024)} KB; a persona is at most ${MAX_PERSONA_BYTES / 1024} KB.`);
    }
    const stem = path.basename(file).replace(/\.md$/i, "");
    return parsePersona(fs.readFileSync(file, "utf8"), personaId(stem), file, false);
}

/**
 * The persona a session gets: the one euterpe.persona names, else the default. `missing` is the id
 * that couldn't be found, when it came to that.
 */
export function choosePersona(id: string, bundledDir: string, userDir: string): { persona: Persona; missing?: string } {
    const wanted = id || DEFAULT_PERSONA;
    const persona = findPersona(wanted, bundledDir, userDir);
    if (persona) { return { persona }; }
    const fallback = findPersona(DEFAULT_PERSONA, bundledDir, "");
    if (!fallback) { throw new Error(`The bundled persona ${DEFAULT_PERSONA}.md is missing from ${bundledDir}.`); }
    return { persona: fallback, missing: wanted };
}

function readPersona(file: string, id: string, bundled: boolean): Persona | null {
    try {
        if (fs.statSync(file).size > MAX_PERSONA_BYTES) { return null; }
        return parsePersona(fs.readFileSync(file, "utf8"), id, file, bundled);
    } catch {
        return null;
    }
}

function titleCase(id: string): string {
    return id.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** The file a new persona starts from: the current one's text, under a new name. */
export function newPersonaText(name: string, from: Persona): string {
    return [
        "---",
        `name: ${name}`,
        "description: ",
        "---",
        "<!--",
        "  Who Euterpe is, written to Euterpe. This is only the personality: tone, humour, how blunt or",
        "  gentle, what to celebrate, what to leave alone. The job itself (reading along, when to speak,",
        "  your memory, edits only when asked) is in Euterpe's instructions already. This started as a",
        `  copy of ${from.name}. Changes apply at the next session. Notes in comments like this one`,
        "  aren't part of the persona.",
        "-->",
        "",
        from.body,
        "",
    ].join("\n");
}
