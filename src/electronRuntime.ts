// The Electron build the overlay runs on. A .vsix can't reasonably carry it (117–151 MiB
// per platform, and every update would carry it again), so it is downloaded once from
// Electron's GitHub release, checked against the checksums pinned below, and kept in the
// extension's global storage across updates. Pure node, vscode-free, so it can be
// unit-tested; the prompts and progress live in extension.ts.

import * as crypto from "crypto";
import * as nodeFs from "fs";
import * as https from "https";
import * as path from "path";
import { pipeline } from "stream/promises";
import * as yauzl from "yauzl";

/**
 * fs without Electron's asar support. VS Code's extension host runs on Electron, whose fs takes a
 * path ending in .asar for an archive to look into: Electron's own zip carries
 * resources/default_app.asar, which can't be written through it (unpacking hung there for good),
 * and stats as a directory, so a build can't be removed through it either. Plain Node (tests, CI)
 * has no original-fs, and needs none.
 */
const fs: typeof nodeFs = (() => {
    try { return require("original-fs"); } catch { return nodeFs; }
})();

export const ELECTRON_VERSION = "44.4.5";

/** SHA-256 of the official zips, from the release's SHASUMS256.txt. */
const SHA256: Record<string, string> = {
    "darwin-arm64": "a212eee63ba2f45fd83bd28f77a3e3313a336ad17a4c25adf617942eef5e0e2c",
    "darwin-x64": "778350cc572c36484dd56c130cae96ad1a9a5b695ba22dd06abd23ba0a46c9de",
    "linux-arm64": "3bf0acab49c4ea3c9283cdb86bf3dd7204bd52a6fba6c8ae51101bdba2adae0e",
    "linux-x64": "04586a0ec46c3283fbdaef85530f561f71f0b5e136ad0cb9ef63683615609780",
    "win32-arm64": "92c19d550a80a8bd62fc801325b8135d4c45733a7d7fac2b5d6b95f2eed71b5f",
    "win32-x64": "11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d",
};

/** Written last into an install directory: its presence means the build is complete. */
const READY = ".euterpe-ready";
const MAX_REDIRECTS = 5;
const STALL_MS = 60_000;

/** The release asset suffix for this machine ("darwin-arm64"…), or null if Electron has no build for it. */
export function electronTarget(platform: string = process.platform, arch: string = process.arch): string | null {
    const target = `${platform}-${arch}`;
    return target in SHA256 ? target : null;
}

export function downloadUrl(target: string, version = ELECTRON_VERSION): string {
    return `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${target}.zip`;
}

/** The executable inside an extracted Electron zip (or a dev checkout's node_modules/electron/dist). */
export function executableIn(dir: string, platform: string = process.platform): string {
    if (platform === "win32") { return path.join(dir, "electron.exe"); }
    if (platform === "darwin") { return path.join(dir, "Electron.app", "Contents", "MacOS", "Electron"); }
    return path.join(dir, "electron");
}

/** Where a downloaded build lives in the extension's storage. */
export function installDir(storageDir: string, target: string, version = ELECTRON_VERSION): string {
    return path.join(storageDir, `electron-v${version}-${target}`);
}

export interface ElectronSources {
    /** euterpe.electronPath: an Electron executable the writer points at ("" = none). */
    override: string;
    /** The extension's directory: a development checkout has Electron in node_modules. */
    extensionRoot: string;
    /** The extension's global storage, where downloaded builds live. */
    storageDir: string;
    platform?: string;
    arch?: string;
}

/**
 * An Electron that is already there: the writer's own, a development checkout's, or one
 * downloaded before. Null when one has to be downloaded.
 */
export function findElectron(s: ElectronSources): string | null {
    const platform = s.platform ?? process.platform;
    if (s.override.trim()) {
        const exe = s.override.trim();
        if (!fs.existsSync(exe)) {
            throw new Error(`euterpe.electronPath points to ${exe}, which doesn't exist.`);
        }
        return exe;
    }
    const dev = executableIn(path.join(s.extensionRoot, "node_modules", "electron", "dist"), platform);
    if (fs.existsSync(dev)) { return dev; }
    const target = electronTarget(platform, s.arch ?? process.arch);
    if (target) {
        const dir = installDir(s.storageDir, target);
        if (fs.existsSync(path.join(dir, READY))) { return executableIn(dir, platform); }
    }
    return null;
}

export interface DownloadHooks {
    log(msg: string): void;
    /** Bytes received so far, and the total when the server says it. */
    progress?(received: number, total: number | null): void;
    /** Aborts the download when it fires (a vscode.CancellationToken fits). */
    cancellation?: { isCancellationRequested: boolean; onCancellationRequested(cb: () => void): { dispose(): void } };
}

/**
 * Download, verify and unpack the pinned Electron build into storageDir; returns its
 * executable. Safe against two windows doing it at once: each works in its own temp
 * files, and whoever finishes second keeps the first one's build.
 */
export async function downloadElectron(storageDir: string, hooks: DownloadHooks): Promise<string> {
    const target = electronTarget();
    if (!target) {
        throw new Error(`Electron has no build for ${process.platform}-${process.arch}.`);
    }
    fs.mkdirSync(storageDir, { recursive: true });
    const tag = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    const zip = path.join(storageDir, `download-${tag}.zip`);
    const staging = path.join(storageDir, `unpack-${tag}`);
    const dir = installDir(storageDir, target);
    try {
        const url = downloadUrl(target);
        hooks.log(`downloading ${url}`);
        const sha = await fetchTo(url, zip, hooks);
        if (sha !== SHA256[target]) {
            throw new Error(`The Electron download is corrupt (its checksum doesn't match). Try again.`);
        }
        hooks.log(`checksum ok, unpacking into ${dir}`);
        await unzip(zip, staging);
        fs.writeFileSync(path.join(staging, READY), `${ELECTRON_VERSION} ${target}\n`);
        if (!fs.existsSync(path.join(dir, READY))) {
            fs.rmSync(dir, { recursive: true, force: true });
            await renameWithRetry(staging, dir);
        }
        removeOtherBuilds(storageDir, path.basename(dir));
        return executableIn(dir);
    } finally {
        // A handle still closing can hold these on Windows; removeOtherBuilds sweeps them later.
        try { fs.rmSync(zip, { force: true }); } catch { /* next time */ }
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* next time */ }
    }
}

/** Stream url (following redirects) into file; resolves with the content's SHA-256. */
function fetchTo(url: string, file: string, hooks: DownloadHooks, redirects = 0): Promise<string> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let out: nodeFs.WriteStream | null = null;
        const settle = () => { settled = true; sub.dispose(); };
        const fail = (err: Error) => {
            if (settled) { return; }
            settle();
            out?.destroy();   // release the file, so the caller can delete it
            reject(err);
        };
        const req = https.get(url, { headers: { "User-Agent": "euterpe-vscode" } }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirects >= MAX_REDIRECTS) { fail(new Error("Too many redirects downloading Electron.")); return; }
                settle();
                fetchTo(new URL(res.headers.location, url).toString(), file, hooks, redirects + 1).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                res.resume();
                fail(new Error(`Downloading Electron failed: HTTP ${status}.`));
                return;
            }
            const total = Number(res.headers["content-length"]) || null;
            const hash = crypto.createHash("sha256");
            const stream = fs.createWriteStream(file);
            out = stream;
            let received = 0;
            res.on("data", (chunk: Buffer) => {
                hash.update(chunk);
                received += chunk.length;
                hooks.progress?.(received, total);
            });
            res.on("error", fail);
            stream.on("error", fail);
            stream.on("finish", () => {
                if (settled) { return; }
                if (total !== null && received !== total) { fail(new Error("The Electron download was cut short. Try again.")); return; }
                settle();
                resolve(hash.digest("hex"));
            });
            res.pipe(stream);
        });
        req.setTimeout(STALL_MS, () => req.destroy(new Error("The Electron download stalled. Check your connection and try again.")));
        req.on("error", fail);
        const sub = hooks.cancellation?.onCancellationRequested(() => req.destroy(new Error("Download cancelled.")))
            ?? { dispose() { /* nothing to cancel */ } };
        if (hooks.cancellation?.isCancellationRequested) { req.destroy(new Error("Download cancelled.")); }
    });
}

/**
 * Unpack zip into dir, through the fs above: files with their modes, directories, and the
 * symlinks macOS's Electron.app is made of. (yauzl refuses entries that would land outside dir.)
 */
export function unzip(zip: string, dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        yauzl.open(zip, { lazyEntries: true }, (err, zipfile) => {
            if (err) { reject(err); return; }
            const fail = (e: Error) => { zipfile.close(); reject(e); };
            zipfile.on("error", fail);
            zipfile.on("end", () => resolve());
            zipfile.on("entry", (entry: yauzl.Entry) => {
                const dest = path.join(dir, entry.fileName);
                const mode = entry.externalFileAttributes >>> 16;
                const type = mode & 0o170000;
                const dosDirectory = entry.versionMadeBy >> 8 === 0 && (entry.externalFileAttributes & 0x10) !== 0;
                if (entry.fileName.endsWith("/") || type === 0o040000 || dosDirectory) {
                    fs.mkdirSync(dest, { recursive: true });
                    zipfile.readEntry();
                    return;
                }
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                zipfile.openReadStream(entry, (err, stream) => {
                    if (err) { fail(err); return; }
                    const written = type === 0o120000
                        ? readAll(stream).then((target) => fs.symlinkSync(target.toString("utf8"), dest))
                        : pipeline(stream, fs.createWriteStream(dest, { mode: (mode & 0o777) || 0o644, fs }));
                    written.then(() => zipfile.readEntry(), fail);
                });
            });
            zipfile.readEntry();
        });
    });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) { chunks.push(chunk as Buffer); }
    return Buffer.concat(chunks);
}

/** Antivirus scanners briefly hold freshly unpacked files on Windows; a rename can fail meanwhile. */
async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (attempt >= 10 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) { throw err; }
            await new Promise((r) => setTimeout(r, 300));
        }
    }
}

/**
 * Earlier Electron builds, and leftovers of interrupted downloads. A download or unpack
 * less than an hour old may be another window's, still running.
 */
function removeOtherBuilds(storageDir: string, keep: string): void {
    const now = Date.now();
    for (const name of fs.readdirSync(storageDir)) {
        const full = path.join(storageDir, name);
        try {
            const stale = /^electron-v/.test(name) ? name !== keep
                : /^(download|unpack)-/.test(name) && now - fs.statSync(full).mtimeMs > 3_600_000;
            if (stale) { fs.rmSync(full, { recursive: true, force: true }); }
        } catch { /* in use: next time */ }
    }
}

/**
 * Linux-only Electron switches. Under Wayland (Electron's default there) a window can't stay on
 * top, place itself or know where the pointer is; X11, through XWayland if need be, can.
 */
export function linuxSwitches(noSandbox: boolean, platform = process.platform): string[] {
    if (platform !== "linux") { return []; }
    return ["--ozone-platform=x11", ...(noSandbox ? ["--no-sandbox"] : [])];
}

/**
 * Electron refused to start because Chromium's sandbox isn't usable: a downloaded Electron's
 * chrome-sandbox helper isn't setuid root (only root can make it so), and the distribution
 * restricts the user namespaces that would stand in for it (Ubuntu 24.04 and later).
 */
export function needsNoSandbox(stderr: string): boolean {
    return /SUID sandbox helper binary|No usable sandbox/i.test(stderr);
}
