// A scenario's world: a writer's machine in a folder of its own. Their home (where ~/.euterpe and
// ~/.claude are), VS Code's storage for the extension, the extension's own folder, a workspace with
// a draft, Claude Code where its installer would put it (a stand-in: see fake/claude.js), Electron
// where Euterpe downloads it (see fake/electron-host.js), and what VS Code would know: the settings,
// the secrets, the extension's remembered state, whether the folder is trusted.
"use strict";

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const EXT_ID = `${PKG.publisher}.${PKG.name}`;
const ELECTRON_VERSION = (fs.readFileSync(path.join(REPO, "src", "electronRuntime.ts"), "utf8").match(/ELECTRON_VERSION = "([^"]+)"/) || [])[1] || "44.4.5";
const SHIPPED = ["mind", "overlay", "mascots", "media", "docs", "settings"];

/** The draft a writer has open, unless a scenario brings its own. */
const DRAFT = `# Why my benchmarks lied to me

Last week I spent three days chasing a performance regression that didn't exist. Actually, it existed, but not where I thought, and not for the reason I thought.

The benchmark said the new allocator was 40% slower. The profiler said it wasn't. One of them was lying, and it took me an embarrassing amount of time to figure out which one.

## The setup

I was actually pretty confident in my setup. BenchmarkDotNet, a dedicated machine, the CPU governor pinned to performance. What could go wrong?
`;

/** The settings VS Code knows for Euterpe, from package.json: defaults and scopes. */
function registry(unknown = []) {
    const out = {};
    for (const section of PKG.contributes.configuration) {
        for (const [key, p] of Object.entries(section.properties)) {
            if (unknown.includes(key.replace(/^euterpe\./, ""))) { continue; }
            out[key] = { default: p.default, scope: p.scope || "window", type: p.type };
        }
    }
    return out;
}

/** A placeholder executable: a JSON note saying what the bench runs in its place, and how it behaves. */
function writeFake(file, note) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(note, null, 2));
}

/**
 * Build the world a scenario describes (see scenarios/README in index.js for the spec), in `dir`.
 * Returns the world the host and the vscode stand-in work with.
 */
function buildWorld(dir, spec = {}) {
    fs.rmSync(dir, { recursive: true, force: true });
    const home = path.join(dir, "Users", "writer");
    const appData = path.join(home, "AppData", "Roaming");
    const localAppData = path.join(home, "AppData", "Local");
    const temp = path.join(localAppData, "Temp");
    const storage = path.join(appData, "Code", "User", "globalStorage", EXT_ID);
    const userData = path.join(appData, "Code", "User");
    const extRoot = path.join(home, ".vscode", "extensions", `${EXT_ID}-${PKG.version}`);
    const euterpeHome = path.join(home, ".euterpe");
    const claudeDir = path.join(home, ".claude");
    const docs = path.join(home, "Documents");
    for (const d of [home, appData, localAppData, temp, storage, extRoot, claudeDir, docs]) { fs.mkdirSync(d, { recursive: true }); }

    // The extension's own folder: what the .vsix ships, linked from the repository (live: an edit
    // to the overlay or the settings window shows at the next run).
    for (const sub of SHIPPED) { fs.symlinkSync(path.join(REPO, sub), path.join(extRoot, sub), "junction"); }
    for (const f of ["package.json", "README.md", "LICENSE"]) { fs.copyFileSync(path.join(REPO, f), path.join(extRoot, f)); }

    // The workspace.
    const folders = [];
    const ws = spec.workspace === null ? null : path.join(docs, spec.workspace?.name || "my-blog");
    if (ws) {
        fs.mkdirSync(ws, { recursive: true });
        folders.push({ path: ws, name: path.basename(ws) });
        const files = spec.workspace?.files || { "draft.md": DRAFT };
        for (const [rel, text] of Object.entries(files)) {
            const f = path.join(ws, rel);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, text);
        }
    }

    // Files anywhere in the world: "~/…" is the writer's home, "ws/…" the workspace.
    const where = (p) => p.startsWith("~/") ? path.join(home, p.slice(2)) : p.startsWith("ws/") && ws ? path.join(ws, p.slice(3)) : path.join(dir, p);
    // In a setting's value: {home}, {ws} and {world} stand for those folders (written as Windows writes paths).
    const fill = (v) => (typeof v === "string"
        ? v.replace(/\{(home|ws|world|storage)\}([^\s"]*)/g, (_, k, rest) => path.join({ home, ws: ws || home, world: dir, storage }[k], rest))
        : v);
    for (const [p, content] of Object.entries(spec.files || {})) {
        const f = where(p);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }

    // Claude Code: installed by its native installer unless the scenario says otherwise.
    const claude = spec.claude === null ? null : { install: "native", version: "2.1.283", auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }, ...(spec.claude || {}) };
    const claudeNote = (c) => ({ bench: "claude", version: c.version, notClaude: !!c.notClaude, auth: c.auth, permissionMode: c.permissionMode, apiKeySource: c.apiKeySource, noAuthAnswer: !!c.noAuthAnswer });
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const extensions = {};
    if (claude) {
        const installs = Array.isArray(claude.installs) ? claude.installs : [claude];
        for (const c0 of installs) {
            const c = { ...claude, ...c0 };
            if (c.install === "native") { writeFake(path.join(home, ".local", "bin", "claude.exe"), claudeNote(c)); }
            else if (c.install === "path") { writeFake(path.join(bin, "claude.exe"), claudeNote(c)); }
            else if (c.install === "npm") {
                fs.mkdirSync(path.join(appData, "npm"), { recursive: true });
                fs.writeFileSync(path.join(appData, "npm", "claude.cmd"), "@echo off\r\n");
                writeFake(path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), claudeNote(c));
            } else if (c.install === "winget") { writeFake(path.join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"), claudeNote(c)); }
            else if (c.install === "extension") {
                const extDir = path.join(home, ".vscode", "extensions", `anthropic.claude-code-${c.version}-win32-x64`);
                writeFake(path.join(extDir, "resources", "native-binary", "claude.exe"), claudeNote(c));
                extensions["anthropic.claude-code"] = { path: extDir };
            } else if (c.install === "at") { writeFake(where(c.at), claudeNote(c)); }
        }
    }
    if (spec.claudeSettings) { fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify(spec.claudeSettings, null, 2)); }

    // Electron: downloaded before, unless the scenario says otherwise.
    const target = `${process.platform}-${process.arch}`;
    const electronDir = path.join(storage, `electron-v${ELECTRON_VERSION}-${target}`);
    if (spec.electron === undefined || spec.electron === "downloaded") {
        writeFake(path.join(electronDir, "electron.exe"), { bench: "electron" });
        fs.writeFileSync(path.join(electronDir, ".euterpe-ready"), `${ELECTRON_VERSION} ${target}\n`);
    } else if (spec.electron && typeof spec.electron === "object" && spec.electron.at) {
        writeFake(where(spec.electron.at), { bench: "electron" });
    }

    // What VS Code knows.
    const user = {};
    if (spec.provider) { user["euterpe.provider"] = spec.provider; }
    for (const [k, v] of Object.entries(spec.settings || {})) { user[k.startsWith("euterpe.") ? k : `euterpe.${k}`] = fill(v); }
    const workspace = {};
    for (const [k, v] of Object.entries(spec.workspaceSettings || {})) { workspace[k.startsWith("euterpe.") ? k : `euterpe.${k}`] = fill(v); }
    const globalState = { ...(spec.globalState || {}) };
    const secrets = { ...(spec.secrets || {}) };

    const world = {
        dir, home, appData, localAppData, temp, storage, userData, extRoot, euterpeHome, claudeDir, bin, workspaceDir: ws, electronDir,
        repo: REPO, extId: EXT_ID, version: PKG.version, packageJSON: PKG, electronVersion: ELECTRON_VERSION,
        spec,
        config: { registry: registry(spec.unknownSettings || []), user, workspace },
        globalState, workspaceState: { ...(spec.workspaceState || {}) }, secrets,
        trusted: spec.trusted !== false,
        remoteName: spec.remote || "",
        workspaceFile: spec.workspaceFile ? where(spec.workspaceFile) : "",
        folders,
        focused: true,
        extensions,
        applyEditFails: !!spec.applyEditFails,
        openExternalFails: !!spec.openExternalFails,
        claude,
        where,
        fill,
        /** The files an open dialog offers: the scenario's, for that dialog's title. */
        dialogFiles(options) {
            const all = spec.dialogFiles || {};
            const list = all[options.title] || all["*"] || [];
            return list.map((p) => ({ path: where(p), name: path.basename(where(p)) }));
        },
        save() {
            const keep = { config: { user: world.config.user, workspace: world.config.workspace }, globalState: world.globalState, workspaceState: world.workspaceState, secrets: world.secrets, trusted: world.trusted };
            try { fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(keep, null, 2)); } catch { /* the world may be going */ }
        },
        /** After a reload: what VS Code kept (world.json, as it was before the world was built again). */
        restore(k) {
            if (!k) { return; }
            Object.assign(world.config.user, k.config?.user); Object.assign(world.config.workspace, k.config?.workspace);
            Object.assign(world.globalState, k.globalState); Object.assign(world.workspaceState, k.workspaceState); Object.assign(world.secrets, k.secrets);
            world.trusted = k.trusted;
            world.save();
        },
    };

    // The environment the extension host runs with: this world's, nothing of the real machine's.
    world.env = {
        SystemRoot: process.env.SystemRoot || "C:\\WINDOWS", windir: process.env.windir || "C:\\WINDOWS",
        ComSpec: process.env.ComSpec || "C:\\WINDOWS\\system32\\cmd.exe", PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
        OS: "Windows_NT", PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE || "AMD64", NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS || "8",
        PATH: [bin, ...(claude && claude.install === "npm" ? [path.join(appData, "npm")] : []), path.join(process.env.SystemRoot || "C:\\WINDOWS", "System32"), process.env.SystemRoot || "C:\\WINDOWS"].join(";"),
        USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2), USERNAME: "writer", COMPUTERNAME: "WRITERS-PC",
        APPDATA: appData, LOCALAPPDATA: localAppData, TEMP: temp, TMP: temp,
        ...(spec.env || {}),
    };
    world.save();
    return world;
}

module.exports = { buildWorld, REPO, PKG, EXT_ID, ELECTRON_VERSION, DRAFT };
