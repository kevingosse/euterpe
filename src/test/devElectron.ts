import * as fs from "node:fs";
import * as path from "node:path";

/** The repository's root (the tests run from out/test). */
export const root = path.join(__dirname, "..", "..");

/**
 * The development Electron, if it has been fetched (the electron package fetches it on first use)
 * and there's a display to run it on. Tests that need it skip without it.
 */
export function devElectron(): string | null {
    try {
        const exe = path.join(root, "node_modules", "electron", "dist", fs.readFileSync(path.join(root, "node_modules", "electron", "path.txt"), "utf8"));
        return fs.existsSync(exe) && (process.platform !== "linux" || !!process.env.DISPLAY) ? exe : null;
    } catch {
        return null;
    }
}

/** A test's skip option: false when the development Electron is there, else why not. */
export function needsElectron(): false | string {
    return devElectron() ? false : "needs the development Electron (npm run demo fetches it), and a display on Linux";
}
