// Finding Claude Code, the CLI Euterpe's mind runs on. A bare spawn("claude") isn't
// enough: an npm install puts only a claude.cmd shim on PATH on Windows (Node can't spawn
// one without a shell, which would mangle the arguments), Claude Desktop's Claude.exe can
// shadow it, and GUI-launched editors don't always have the installer's directory on PATH.
// So candidates are gathered from every known install location, and the first that says
// "(Claude Code)" when asked its version, recent enough, wins. Pure node, vscode-free.

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** --permission-prompts (see mind.ts) arrived in 2.1.259; older builds reject it. */
export const MIN_CLAUDE_VERSION = "2.1.259";

/** Where Claude Code's installation is explained. */
export const CLAUDE_SETUP_URL = "https://code.claude.com/docs/en/setup";

/** Claude Code is nowhere Euterpe looks (and no euterpe.claudePath points elsewhere). */
export class ClaudeNotFound extends Error { }

export interface ClaudeCandidate {
    path: string;
    /** Where it was found, for the log and Check Setup. */
    source: string;
}

export interface ClaudeInstall extends ClaudeCandidate {
    version: string;
}

export interface Machine {
    platform: string;
    env: NodeJS.ProcessEnv;
    home: string;
    exists(p: string): boolean;
}

export const THIS_MACHINE: Machine = {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
};

/** The npm package's real executable, behind the shims npm puts on PATH. */
const NPM_BIN = ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"];

/**
 * Every place Claude Code may be, most deliberate first: the writer's setting, PATH, then the
 * installers' usual directories, then the copy inside the Claude Code VS Code extension.
 * Only existing files; deduplicated.
 */
export function claudeCandidates(setting: string, bundled: string | null, m: Machine = THIS_MACHINE): ClaudeCandidate[] {
    const win = m.platform === "win32";
    const pathApi = win ? path.win32 : path.posix;
    const out: ClaudeCandidate[] = [];
    const add = (p: string, source: string) => { if (p && m.exists(p)) { out.push({ path: p, source }); } };

    const wanted = setting.trim();
    if (wanted && wanted !== "claude") {
        // A bare name is looked up on PATH like a shell would; anything else is a path.
        if (!/[\\/]/.test(wanted)) {
            for (const dir of pathDirs(m)) { add(pathApi.join(dir, wanted), "euterpe.claudePath"); }
        } else {
            add(wanted, "euterpe.claudePath");
        }
        return dedupe(out, win);   // an explicit choice isn't second-guessed
    }

    for (const dir of pathDirs(m)) {
        if (win) {
            // Claude Desktop's app alias; running it would open the desktop app.
            if (/\\WindowsApps\\?$/i.test(dir)) { continue; }
            add(pathApi.join(dir, "claude.exe"), "PATH");
            if (m.exists(pathApi.join(dir, "claude.cmd"))) { add(pathApi.join(dir, ...NPM_BIN), "npm (PATH)"); }
        } else {
            add(pathApi.join(dir, "claude"), "PATH");
        }
    }
    if (win) {
        add(pathApi.join(m.home, ".local", "bin", "claude.exe"), "native installer");
        const local = m.env.LOCALAPPDATA || pathApi.join(m.home, "AppData", "Local");
        add(pathApi.join(local, "Microsoft", "WinGet", "Links", "claude.exe"), "WinGet");
        const roaming = m.env.APPDATA || pathApi.join(m.home, "AppData", "Roaming");
        add(pathApi.join(roaming, "npm", ...NPM_BIN), "npm");
    } else {
        add(pathApi.join(m.home, ".local", "bin", "claude"), "native installer");
        add("/opt/homebrew/bin/claude", "Homebrew");
        add("/usr/local/bin/claude", "Homebrew");
        add("/home/linuxbrew/.linuxbrew/bin/claude", "Homebrew");
        add(pathApi.join("/usr/local/lib", ...NPM_BIN), "npm");
        add(pathApi.join(m.home, ".npm-global", "lib", ...NPM_BIN), "npm");
        add(pathApi.join(m.home, ".claude", "local", "claude"), "local install");
    }
    if (bundled) { add(bundled, "Claude Code VS Code extension"); }
    return dedupe(out, win);
}

function pathDirs(m: Machine): string[] {
    const raw = m.env.PATH ?? m.env.Path ?? "";
    return raw.split(m.platform === "win32" ? ";" : ":").map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

function dedupe(list: ClaudeCandidate[], caseInsensitive: boolean): ClaudeCandidate[] {
    const seen = new Set<string>();
    return list.filter((c) => {
        const key = caseInsensitive ? c.path.toLowerCase() : c.path;
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

/** "2.1.283 (Claude Code)" -> "2.1.283"; anything else (another program named claude) -> null. */
export function parseClaudeVersion(output: string): string | null {
    const m = output.match(/(\d+\.\d+\.\d+)\s*\(Claude Code\)/);
    return m ? m[1] : null;
}

/** Numeric comparison of dotted versions. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) { return Math.sign(d); }
    }
    return 0;
}

/** Ask an executable its version. Null when it isn't Claude Code (or doesn't answer). */
export function probeClaude(exe: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(exe, ["--version"], { timeout: 20_000, windowsHide: true, env }, (err, stdout) => {
            resolve(err ? null : parseClaudeVersion(String(stdout)));
        });
    });
}

/**
 * The Claude Code to run the mind with. Throws a message meant for the writer when there's
 * none, or only one that's too old.
 */
export async function resolveClaude(
    setting: string,
    bundled: string | null,
    env: NodeJS.ProcessEnv,
    log: (msg: string) => void,
    m: Machine = THIS_MACHINE,
    probe: (exe: string, env: NodeJS.ProcessEnv) => Promise<string | null> = probeClaude,
): Promise<ClaudeInstall> {
    const candidates = claudeCandidates(setting, bundled, m);
    let tooOld: ClaudeInstall | null = null;
    for (const c of candidates) {
        const version = await probe(c.path, env);
        if (!version) {
            log(`not Claude Code, or it didn't answer: ${c.path}`);
            continue;
        }
        if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
            log(`Claude Code ${version} at ${c.path} is older than ${MIN_CLAUDE_VERSION}`);
            tooOld ??= { ...c, version };
            continue;
        }
        return { ...c, version };
    }
    const explicit = setting.trim() && setting.trim() !== "claude";
    if (tooOld) {
        throw new Error(`Claude Code ${tooOld.version} (${tooOld.path}) is too old for Euterpe, which needs ${MIN_CLAUDE_VERSION} or later. Run \`claude update\`, then try again.`);
    }
    if (explicit) {
        throw new Error(`euterpe.claudePath is set to ${setting.trim()}, which isn't a working Claude Code.`);
    }
    throw new ClaudeNotFound("Euterpe's mind runs on Claude Code, which isn't installed (or can't be found). Install it from https://code.claude.com, log in, then try again — or set euterpe.claudePath.");
}
