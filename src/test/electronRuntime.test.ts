import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { downloadUrl, ELECTRON_VERSION, electronTarget, executableIn, findElectron, installDir, linuxSwitches, needsNoSandbox, unzip } from "../electronRuntime";
import { devElectron, needsElectron } from "./devElectron";

test("Electron builds exist for the desktop platforms, not the rest", () => {
    for (const t of ["win32-x64", "win32-arm64", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
        const [platform, arch] = t.split("-");
        assert.equal(electronTarget(platform, arch), t);
    }
    assert.equal(electronTarget("win32", "ia32"), null);
    assert.equal(electronTarget("freebsd", "x64"), null);
});

test("the executable's place inside an Electron zip, per platform", () => {
    assert.equal(executableIn("d", "win32"), path.join("d", "electron.exe"));
    assert.equal(executableIn("d", "darwin"), path.join("d", "Electron.app", "Contents", "MacOS", "Electron"));
    assert.equal(executableIn("d", "linux"), path.join("d", "electron"));
});

test("the download URL is the pinned GitHub release asset", () => {
    assert.equal(downloadUrl("darwin-arm64"),
        `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-darwin-arm64.zip`);
});

function scratch(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-electron-test-"));
}

test("findElectron: the writer's override wins, and a missing one is an error", () => {
    const dir = scratch();
    const exe = path.join(dir, "my-electron");
    fs.writeFileSync(exe, "");
    assert.equal(findElectron({ override: exe, extensionRoot: dir, storageDir: dir }), exe);
    assert.throws(() => findElectron({ override: path.join(dir, "nope"), extensionRoot: dir, storageDir: dir }), /doesn't exist/);
});

test("findElectron: a development checkout's node_modules, then a complete download, else null", () => {
    const root = scratch(), storage = scratch();
    const sources = { override: "", extensionRoot: root, storageDir: storage, platform: "linux", arch: "x64" };
    assert.equal(findElectron(sources), null);

    // A download that never finished (no ready marker) doesn't count.
    const dir = installDir(storage, "linux-x64");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "electron"), "");
    assert.equal(findElectron(sources), null);
    fs.writeFileSync(path.join(dir, ".euterpe-ready"), "");
    assert.equal(findElectron(sources), path.join(dir, "electron"));

    const dev = path.join(root, "node_modules", "electron", "dist");
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, "electron"), "");
    assert.equal(findElectron(sources), path.join(dev, "electron"));
});

/** A zip of stored entries, made on Unix: each with its mode (a symlink's data is its target). */
function makeZip(file: string, entries: { name: string; mode: number; data?: string }[]): void {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name);
        const data = Buffer.from(e.data ?? "");
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(10, 4);                          // version needed: stored
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x031e, 4);                    // made by: Unix
        central.writeUInt16LE(10, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE((e.mode << 16) >>> 0, 38);     // external attributes: the mode
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, data);
        centrals.push(central, name);
        offset += local.length + name.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeFileSync(file, Buffer.concat([...locals, directory, end]));
}

test("unzip: files with their modes, directories, and symlinks", async () => {
    const dir = scratch();
    const zip = path.join(dir, "electron.zip");
    const unix = process.platform !== "win32";   // a symlink takes privileges on Windows
    makeZip(zip, [
        { name: "electron", mode: 0o100755, data: "exe" },
        { name: "locales/", mode: 0o040755 },
        { name: "locales/en-US.pak", mode: 0o100644, data: "pak" },
        { name: "resources/default_app.asar", mode: 0o100644, data: "asar" },
        ...(unix ? [{ name: "Current", mode: 0o120777, data: "resources" }] : []),
    ]);
    const out = path.join(dir, "out");
    await unzip(zip, out);
    assert.equal(fs.readFileSync(path.join(out, "electron"), "utf8"), "exe");
    assert.equal(fs.readFileSync(path.join(out, "locales", "en-US.pak"), "utf8"), "pak");
    assert.equal(fs.readFileSync(path.join(out, "resources", "default_app.asar"), "utf8"), "asar");
    if (unix) {
        assert.equal(fs.statSync(path.join(out, "electron")).mode & 0o111, 0o111);
        assert.equal(fs.readlinkSync(path.join(out, "Current")), "resources");
    }
});

// Inside Electron, as in VS Code's extension host, fs takes a path ending in .asar for an archive
// to look into: unpacking Electron's own zip there hung on resources/default_app.asar for good.
test("unzip: inside Electron too, default_app.asar unpacks like any file", { skip: needsElectron(), timeout: 60_000 }, async () => {
    const dir = scratch();
    const zip = path.join(dir, "electron.zip");
    makeZip(zip, [
        { name: "resources/default_app.asar", mode: 0o100644, data: "asar" },
        { name: "resources/after.txt", mode: 0o100644, data: "after" },
    ]);
    const out = path.join(dir, "out");
    const main = path.join(dir, "main.js");
    fs.writeFileSync(main, [
        `const { app } = require("electron");`,
        `const { unzip } = require(${JSON.stringify(path.join(__dirname, "..", "electronRuntime.js"))});`,
        `app.whenReady().then(() => unzip(${JSON.stringify(zip)}, ${JSON.stringify(out)}))`,
        `    .then(() => app.exit(0), (err) => { console.error(err); app.exit(1); });`,
    ].join("\n"));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(devElectron()!, [...linuxSwitches(false), main], { env, timeout: 30_000 });
    assert.equal(fs.readFileSync(path.join(out, "resources", "default_app.asar"), "utf8"), "asar");
    assert.equal(fs.readFileSync(path.join(out, "resources", "after.txt"), "utf8"), "after");
});

test("Linux gets X11, and gives up Chromium's sandbox only when told to", () => {
    assert.deepEqual(linuxSwitches(false, "win32"), []);
    assert.deepEqual(linuxSwitches(true, "darwin"), []);
    assert.deepEqual(linuxSwitches(false, "linux"), ["--ozone-platform=x11"]);
    assert.deepEqual(linuxSwitches(true, "linux"), ["--ozone-platform=x11", "--no-sandbox"]);
});

test("an unusable sandbox is recognized from Electron's complaint, and nothing else is", () => {
    assert.ok(needsNoSandbox("[1:2:FATAL:setuid_sandbox_host.cc(163)] The SUID sandbox helper binary was found, but is not configured correctly."));
    assert.ok(needsNoSandbox("No usable sandbox! Update your kernel or see https://chromium.googlesource.com/..."));
    assert.ok(!needsNoSandbox("renderer crashed"));
});
