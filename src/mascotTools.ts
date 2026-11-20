// The mind's mascot tools: look at a mascot it's drawing (preview_mascot), and offer one to the
// writer to wear (offer_mascot). The drawing itself happens with its file tools; the format is in
// docs/mascots.md, which the prompt points it at. Wearing one is the writer's call, always.

import * as fs from "fs";
import * as path from "path";
import { DEFAULT_MASCOT, loadMascotFile, Mascot, mascotId } from "./mascots";
import { McpTool } from "./mcpServer";
import { renderMascotSheet } from "./sheet";

export interface MascotToolHost {
    electronPath: string;
    overlayDir: string;
    /** Euterpe's home: relative paths start here, and offered mascots are kept in its mascots/. */
    home: string;
    /** Scratch space for the pictures. */
    tmpDir: string;
    /** Ask the writer whether to wear it; returns at once (the answer comes as a session event). */
    offer(m: Mascot): void;
}

const FILE = { type: "string", description: "The pack's path: absolute, or relative to your memory directory." };

export function mascotTools(h: MascotToolHost): McpTool[] {
    const where = (file: unknown) => (typeof file === "string" && file.trim() ? path.resolve(h.home, file.trim()) : null);
    let pictures = 0;
    // Draw the pack: the full check, as the overlay would wear it.
    const draw = async (file: string, scale: number) => {
        const out = path.join(h.tmpDir, `mascot-${++pictures}.png`);
        return renderMascotSheet({ electronPath: h.electronPath, overlayDir: h.overlayDir, packFile: file, out, scale });
    };
    return [
        {
            name: "preview_mascot",
            description: [
                "Look at a mascot pack you're drawing (a body for you; the format is in your mascot guide): its model sheet,",
                "or the list of what doesn't hold up yet. The top half is on a dark background and the bottom half on a light one,",
                "since the writer's editor could be either. Rows: the views (front, q = three-quarter, side, qback, back, side flipped);",
                "twelve moods; six gestures caught mid-way; walking, being dragged, squash and stretch.",
            ].join(" "),
            inputSchema: { type: "object", properties: { file: FILE }, required: ["file"], additionalProperties: false },
            async call(args) {
                const file = where(args.file);
                if (!file) { return { text: "file: the pack's path, please.", isError: true }; }
                let m: Mascot;
                try { m = loadMascotFile(file); } catch (err) { return { text: (err as Error).message, isError: true }; }
                const r = await draw(file, 2);
                if (!r.ok) { return { text: `${m.name} doesn't hold up yet:\n${r.problems}`, isError: true }; }
                const data = fs.readFileSync(r.png).toString("base64");
                fs.rmSync(r.png, { force: true });
                return { text: `${m.name}, as the writer would see it.`, images: [{ data, mimeType: "image/png" }] };
            },
        },
        {
            name: "offer_mascot",
            description: [
                "Offer the writer a mascot you made, to wear as your body from now on: they get a notification to wear it or not.",
                "Only when they asked for one, or said they'd like it. The pack is kept in your mascots folder",
                "(copied there if it's elsewhere). You'll hear what they decided in a later perception.",
            ].join(" "),
            inputSchema: { type: "object", properties: { file: FILE }, required: ["file"], additionalProperties: false },
            async call(args) {
                const file = where(args.file);
                if (!file) { return { text: "file: the pack's path, please.", isError: true }; }
                let m: Mascot;
                try { m = loadMascotFile(file); } catch (err) { return { text: (err as Error).message, isError: true }; }
                const r = await draw(file, 1);
                if (!r.ok) { return { text: `${m.name} doesn't hold up yet, so it wasn't offered:\n${r.problems}`, isError: true }; }
                fs.rmSync(r.png, { force: true });
                const dir = path.join(h.home, "mascots");
                const id = mascotId(m.name);
                const target = path.join(dir, `${id === DEFAULT_MASCOT ? `my-${id}` : id}.json`);   // Clawd's name is taken
                if (path.resolve(file) !== path.resolve(target)) {
                    fs.mkdirSync(dir, { recursive: true });
                    fs.copyFileSync(file, target);
                }
                h.offer(loadMascotFile(target));
                return { text: `Offered ${m.name} to the writer (kept as ${target}). You'll hear what they decided.` };
            },
        },
    ];
}
