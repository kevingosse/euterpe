// child_process for the extension: the programs it runs are stand-ins when they live in the world
// and say so (a JSON note in place of the executable, see world.js). Claude Code becomes
// fake/claude.js, Electron fake/electron-host.js, both real Node processes, so the extension gets
// real pipes, exit codes and errors. Anything else runs for real.
"use strict";

const fs = require("fs");
const path = require("path");
const real = require("child_process");

const FAKES = { claude: path.join(__dirname, "..", "fake", "claude.js"), electron: path.join(__dirname, "..", "fake", "electron-host.js") };

function createChildProcess(world, hooks = {}) {
    const inWorld = (p) => typeof p === "string" && path.resolve(p).toLowerCase().startsWith(world.dir.toLowerCase());

    /** "claude", "electron", or null: what a world executable stands for. */
    function fakeOf(file) {
        if (!inWorld(file)) { return null; }
        try {
            const head = fs.readFileSync(file, "utf8").slice(0, 400);
            if (!head.startsWith("{")) { return null; }
            const note = JSON.parse(fs.readFileSync(file, "utf8"));
            return FAKES[note.bench] ? note.bench : null;
        } catch {
            return null;
        }
    }

    function envFor(opts, file, kind) {
        return { ...(opts?.env || process.env), BENCH_EXE: path.resolve(file), BENCH_KIND: kind, BENCH_PORT: process.env.BENCH_PORT, BENCH_RUN: process.env.BENCH_RUN };
    }

    function spawn(command, args = [], opts = {}) {
        if (!Array.isArray(args)) { opts = args || {}; args = []; }
        const kind = fakeOf(command);
        if (!kind) { return real.spawn(command, args, opts); }
        hooks.spawned?.(kind, command, args);
        if (kind === "claude" && world.claude?.spawnError) {
            // the program vanished between the check and the start: a real ENOENT
            return real.spawn(path.join(world.dir, "missing", "claude.exe"), args, opts);
        }
        return real.spawn(process.execPath, ["--enable-source-maps", FAKES[kind], ...args], { ...opts, env: envFor(opts, command, kind), shell: false, windowsHide: true });
    }

    function execFile(file, args, opts, cb) {
        if (typeof args === "function") { cb = args; args = []; opts = {}; }
        else if (typeof opts === "function") { cb = opts; opts = Array.isArray(args) ? {} : args; args = Array.isArray(args) ? args : []; }
        const kind = fakeOf(file);
        if (!kind) { return real.execFile(file, args, opts, cb); }
        hooks.spawned?.(kind, file, args);
        return real.execFile(process.execPath, [FAKES[kind], ...(args || [])], { ...opts, env: envFor(opts, file, kind), windowsHide: true }, cb);
    }

    return { ...real, spawn, execFile, fakeOf };
}

module.exports = { createChildProcess };
