// Edits Euterpe proposes to the writer's files. Like Claude Code's Edit tool, each
// one is located by exact text rather than by line numbers, so a stale picture of
// the document fails loudly instead of landing in the wrong place.
// Pure and vscode-free, so it can be unit-tested.

import { CURSOR, SEL_CLOSE, SEL_OPEN } from "./perception";

export interface TextEdit {
    oldText: string;
    newText: string;
    replaceAll: boolean;
}

/** A span of the document (character offsets) and what replaces it. */
export interface Replacement {
    start: number;
    end: number;
    text: string;
}

export type EditPlan =
    | { ok: true; replacements: Replacement[] }
    | { ok: false; error: string };

/** The `edits` argument of the propose_edit tool, validated; a string is an error for the mind. */
export function parseEdits(raw: unknown): TextEdit[] | string {
    if (!Array.isArray(raw) || raw.length === 0) {
        return "`edits` must be a non-empty array of {old_text, new_text}.";
    }
    const edits: TextEdit[] = [];
    for (const [i, e] of raw.entries()) {
        if (!e || typeof e !== "object" || typeof e.old_text !== "string" || typeof e.new_text !== "string") {
            return `edit ${i + 1}: needs old_text and new_text, both strings.`;
        }
        edits.push({ oldText: e.old_text, newText: e.new_text, replaceAll: e.replace_all === true });
    }
    return edits;
}

/** Perception markers the mind may have copied along with the text; they're not in the document. */
export function stripMarkers(s: string): string {
    return s.split(CURSOR).join("").split(SEL_OPEN).join("").split(SEL_CLOSE).join("");
}

/**
 * Locate every edit in the document as it is now (not one after another).
 * An empty old_text is only meaningful in an empty document: it fills it.
 */
export function planEdits(text: string, edits: TextEdit[], name: string): EditPlan {
    // VS Code keeps one line ending per document; perceptions show "\n".
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const toDoc = (s: string) => stripMarkers(s).replace(/\r\n?/g, "\n").split("\n").join(eol);
    const out: Replacement[] = [];
    for (const [i, e] of edits.entries()) {
        const label = edits.length > 1 ? `edit ${i + 1}: ` : "";
        const oldText = toDoc(e.oldText);
        const newText = toDoc(e.newText);
        if (oldText === newText) {
            return { ok: false, error: `${label}old_text and new_text are the same — nothing would change.` };
        }
        if (!oldText) {
            if (text.length > 0 || edits.length > 1) {
                return { ok: false, error: `${label}old_text is empty. Quote the exact text to replace; to insert, quote the neighbouring text and repeat it in new_text.` };
            }
            out.push({ start: 0, end: 0, text: newText });
            continue;
        }
        const found: number[] = [];
        for (let at = text.indexOf(oldText); at >= 0; at = text.indexOf(oldText, at + oldText.length)) {
            found.push(at);
        }
        if (found.length === 0) {
            return { ok: false, error: `${label}old_text isn't in ${name}. Copy it exactly from your latest picture of the document (it may have changed since), and keep it short enough to be sure of.` };
        }
        if (found.length > 1 && !e.replaceAll) {
            return { ok: false, error: `${label}old_text appears ${found.length} times in ${name}. Include more of the surrounding text to pick one, or set replace_all to change them all.` };
        }
        for (const at of found) {
            out.push({ start: at, end: at + oldText.length, text: newText });
        }
    }
    out.sort((a, b) => a.start - b.start);
    for (let i = 1; i < out.length; i++) {
        if (out[i].start < out[i - 1].end) {
            return { ok: false, error: "Two of the edits overlap in the document. Merge them into one." };
        }
    }
    return { ok: true, replacements: out };
}

/** The document with the replacements applied (sorted, non-overlapping, as planEdits returns them). */
export function applyReplacements(text: string, replacements: Replacement[]): string {
    let result = "";
    let at = 0;
    for (const r of replacements) {
        result += text.slice(at, r.start) + r.text;
        at = r.end;
    }
    return result + text.slice(at);
}
