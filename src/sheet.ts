// Model sheets, drawn offscreen by the overlay's own renderer (overlay/render-sheet.js): a mascot's
// preview for the writer (Preview Mascot, Install Mascot) and for the mind (preview_mascot). The
// renderer checks the pack as it draws it, so a preview is also the full check.

import { spawn } from "child_process";
import * as fs from "fs";
import { linuxSwitches, needsNoSandbox } from "./electronRuntime";

export type SheetResult = { ok: true; png: string } | { ok: false; problems: string };

export interface SheetRequest {
    /** The Electron executable (electronRuntime.ts). */
    electronPath: string;
    overlayDir: string;
    /** A mascot pack to draw; null draws Clawd. */
    packFile: string | null;
    /** Where the PNG goes. */
    out: string;
    /** Screen pixels per art pixel. */
    scale?: number;
    timeoutMs?: number;
}

export async function renderMascotSheet(r: SheetRequest): Promise<SheetResult> {
    const first = await draw(r, false);
    // Chromium's sandbox may be unusable for a downloaded Electron on Linux (see overlayBridge.ts)
    return !first.ok && first.sandbox ? draw(r, true) : first;
}

function draw(r: SheetRequest, noSandbox: boolean): Promise<SheetResult & { sandbox?: boolean }> {
    return new Promise((resolve) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;   // set in the extension host; Electron would run as plain Node
        const args = [
            r.overlayDir, "--euterpe-sheet=mascot", `--scale=${r.scale ?? 3}`, `--out=${r.out}`,
            ...(r.packFile ? [`--mascot=${r.packFile}`] : []),
            ...linuxSwitches(noSandbox),
        ];
        try { fs.rmSync(r.out, { force: true }); } catch { /* drawn over below */ }
        let stderr = "";
        const proc = spawn(r.electronPath, args, { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        proc.stderr!.on("data", (d) => { stderr += String(d); });
        const timer = setTimeout(() => proc.kill(), r.timeoutMs ?? 30_000);
        proc.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, problems: `The preview couldn't be drawn: ${err.message}` }); });
        proc.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(r.out)) { resolve({ ok: true, png: r.out }); return; }
            resolve({ ok: false, problems: sheetProblems(stderr, code), sandbox: !noSandbox && needsNoSandbox(stderr) });
        });
    });
}

/** What went wrong, from the renderer's error output: the pack's problems, or the failure. */
export function sheetProblems(stderr: string, code: number | null): string {
    // Chromium's own log lines ("[1234:0927/…:ERROR:…]") aren't about the pack.
    const lines = stderr.split(/\r?\n/).filter((l) => l.trim() && !/^\[\d+:\d+\/[\d.]+:[A-Z]+:/.test(l));
    const at = lines.findIndex((l) => l.startsWith("invalid: "));
    if (at >= 0) { return [lines[at].slice("invalid: ".length), ...lines.slice(at + 1)].join("\n"); }
    const tail = lines.slice(-4).join(" · ");
    return `The preview couldn't be drawn (exit ${code ?? "killed"})${tail ? `: ${tail.slice(0, 500)}` : "."}`;
}
