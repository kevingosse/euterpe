// The bench's server: the reviewer's page, Euterpe's files (for the overlay and the settings
// window, which the page runs for real), one extension host per scenario run, and the line between
// them all (WebSocket: the page, the host, and the stand-ins for Claude Code and Electron). It keeps
// the review — the comments and which screens were seen — in bench/review.json.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { fork, execFile } = require("child_process");
const { buildExtension, REPO } = require("./build");
const { extractAll } = require("./extract");
const review = require("./review");

const WS = require(require.resolve("ws", { paths: [REPO] }));
const BENCH = path.join(REPO, "bench");
const UI = path.join(BENCH, "ui");
const WORLDS = path.join(BENCH, ".worlds");
const HOST = path.join(BENCH, "host", "host.js");

const TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".gif": "image/gif", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".map": "application/json",
};

function startServer({ port = 7317, open = false } = {}) {
    const ELECTRON_VERSION = (fs.readFileSync(path.join(REPO, "src", "electronRuntime.ts"), "utf8").match(/ELECTRON_VERSION = "([^"]+)"/) || [])[1] || "44.4.5";
    let build = null, buildError = null, building = null;
    let strings = null;
    const uis = new Set();
    let run = null;   // { id, scenario, host, hostSocket, procs: Map, worldDir, free }
    let procSeq = 0;

    const broadcast = (msg) => { const line = JSON.stringify(msg); for (const s of uis) { if (s.readyState === 1) { s.send(line); } } };
    const benchLog = (text) => { console.log(text); broadcast({ type: "bench-log", text }); };

    async function rebuild() {
        if (building) { return building; }
        building = (async () => {
            try {
                build = await buildExtension({ electronVersion: ELECTRON_VERSION, onLog: benchLog });
                buildError = null;
            } catch (err) {
                buildError = err.message;
                benchLog(`the extension doesn't build: ${err.message}`);
            }
            broadcast({ type: "build", ok: !buildError, error: buildError, at: Date.now() });
        })().finally(() => { building = null; });
        return building;
    }
    function refreshStrings() {
        try { strings = extractAll(); } catch (err) { benchLog(`couldn't read Euterpe's texts: ${err.stack}`); strings = strings || []; }
        broadcast({ type: "strings-changed", count: strings.length });
    }

    // ---------- runs ----------
    function killTree(pid) {
        if (!pid) { return; }
        if (process.platform === "win32") { execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => { }); }
        else { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
    async function stopRun() {
        const r = run;
        if (!r) { return; }
        run = null;
        try { r.hostSocket?.send(JSON.stringify({ msg: { type: "stop" } })); } catch { /* gone */ }
        for (const p of r.procs.values()) { try { p.socket.send(JSON.stringify({ msg: { type: "exit" } })); } catch { /* gone */ } }
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 2500);
            r.host.once("exit", () => { clearTimeout(t); resolve(); });
        });
        killTree(r.host.pid);
        for (const p of r.procs.values()) { killTree(p.pid); }
        broadcast({ type: "run", op: "stopped", run: r.id, scenario: r.scenario });
    }
    async function startRun(scenario, opts = {}) {
        await stopRun();
        if (building) { await building; }
        if (!build) { await rebuild(); }
        if (!build) { broadcast({ type: "run", op: "failed", scenario, error: buildError }); return; }
        const id = `r${Date.now().toString(36)}`;
        let worldDir = path.join(WORLDS, scenario.replace(/[^\w.-]+/g, "_"));
        if (!opts.reload) {
            for (let i = 0; i < 6; i++) {
                try { fs.rmSync(worldDir, { recursive: true, force: true }); break; }
                catch { await new Promise((r) => setTimeout(r, 300)); }
            }
            if (fs.existsSync(worldDir)) { worldDir = `${worldDir}-${id}`; }
        } else if (opts.worldDir) { worldDir = opts.worldDir; }
        const host = fork(HOST, [], {
            env: { SystemRoot: process.env.SystemRoot, windir: process.env.windir, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, BENCH_PORT: String(port), BENCH_RUN: id },
            execArgv: ["--enable-source-maps"],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const r = { id, scenario, host, hostSocket: null, procs: new Map(), worldDir, opts };
        run = r;
        host.stdout.on("data", (d) => broadcast({ type: "bench-log", text: `[host] ${String(d).trimEnd()}` }));
        host.stderr.on("data", (d) => broadcast({ type: "bench-log", text: `[host] ${String(d).trimEnd()}` }));
        host.on("exit", (code) => {
            broadcast({ type: "bench-log", text: `the extension host of ${scenario} exited (${code})` });
            if (run === r) { run = null; broadcast({ type: "run", op: "stopped", run: id, scenario, code }); }
        });
        broadcast({ type: "run", op: "started", run: id, scenario, free: !!opts.free, reload: !!opts.reload });
    }

    // ---------- http ----------
    function serveFile(res, file, transform) {
        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404, { "Content-Type": "text/plain" }).end(`not found: ${file}`); return; }
            const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
            const body = transform ? transform(data.toString("utf8")) : data;
            res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
        });
    }
    const allowed = (file) => { const f = path.resolve(file).toLowerCase(); return f.startsWith(REPO.toLowerCase() + path.sep) || f === REPO.toLowerCase(); };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const p = decodeURIComponent(url.pathname);
        try {
            if (p === "/" || p === "/index.html") { serveFile(res, path.join(UI, "index.html")); return; }
            if (p.startsWith("/ui/")) {
                const f = path.join(UI, p.slice(4));
                if (!path.resolve(f).startsWith(UI)) { res.writeHead(403).end(); return; }
                serveFile(res, f);
                return;
            }
            if (p.startsWith("/repo/")) {
                const f = path.resolve(REPO, p.slice(6));
                if (!allowed(f)) { res.writeHead(403).end(); return; }
                serveFile(res, f);
                return;
            }
            if (p.startsWith("/fs/")) {
                const f = path.resolve(p.slice(4).replace(/^\/+/, ""));
                if (!allowed(f)) { res.writeHead(403).end("outside the repository"); return; }
                const win = url.searchParams.get("bench-win");
                if (win && /\.html$/i.test(f)) {
                    const preload = url.searchParams.get("bench-preload");
                    const inject = `<script src="/ui/frames/electron-renderer.js"></script>${preload && allowed(preload) ? `<script src="/fs/${preload.replace(/\\/g, "/")}"></script>` : ""}`;
                    serveFile(res, f, (html) => html.replace(/<head>/i, `<head>${inject}`));
                    return;
                }
                serveFile(res, f);
                return;
            }
            if (p === "/api/catalog") {
                const scenarios = freshScenarios();
                res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(scenarios.catalog()));
                return;
            }
            if (p === "/api/strings") {
                if (!strings) { refreshStrings(); }
                res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(strings));
                return;
            }
            if (p === "/api/review") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(review.load())); return; }
            if (p === "/api/source") {
                const file = path.resolve(REPO, url.searchParams.get("file") || "");
                if (!allowed(file)) { res.writeHead(403).end(); return; }
                const line = Number(url.searchParams.get("line")) || 1;
                const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
                const from = Math.max(1, line - 6), to = Math.min(lines.length, line + 6);
                res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ file: url.searchParams.get("file"), line, from, lines: lines.slice(from - 1, to) }));
                return;
            }
            if (p === "/api/file") {
                const file = path.resolve(REPO, url.searchParams.get("path") || "");
                if (!allowed(file)) { res.writeHead(403).end(); return; }
                serveFile(res, file);
                return;
            }
            res.writeHead(404).end("not found");
        } catch (err) {
            res.writeHead(500, { "Content-Type": "text/plain" }).end(String(err.stack || err));
        }
    });

    function freshScenarios() {
        for (const k of Object.keys(require.cache)) { if (k.startsWith(path.join(BENCH, "scenarios"))) { delete require.cache[k]; } }
        return require(path.join(BENCH, "scenarios"));
    }

    // ---------- websockets ----------
    const wss = new WS.WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== "/ws") { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => connected(ws, url.searchParams));
    });

    function connected(ws, q) {
        const role = q.get("role");
        if (role === "ui") {
            uis.add(ws);
            ws.on("close", () => uis.delete(ws));
            ws.send(JSON.stringify({ type: "hello", run: run ? { id: run.id, scenario: run.scenario, free: !!run.opts.free } : null, build: { ok: !buildError, error: buildError } }));
            ws.on("message", (data) => fromUi(ws, data));
            return;
        }
        const r = run && run.id === q.get("run") ? run : null;
        if (!r) { ws.close(); return; }
        if (role === "host") {
            r.hostSocket = ws;
            ws.on("message", (data) => fromRunSocket(r, ws, "host", data));
            ws.on("close", () => { if (r.hostSocket === ws) { r.hostSocket = null; } });
            ws.send(JSON.stringify({ msg: { type: "init", scenario: r.scenario, worldDir: r.worldDir, bundle: build.bundle, electronZip: build.electronZip, free: !!r.opts.free, reload: !!r.opts.reload } }));
            return;
        }
        if (role === "proc") {
            const id = `proc-${++procSeq}`;
            const entry = { id, socket: ws, kind: q.get("kind"), pid: Number(q.get("pid")) || 0 };
            r.procs.set(id, entry);
            ws.on("message", (data) => fromRunSocket(r, ws, id, data));
            ws.on("close", () => {
                r.procs.delete(id);
                r.hostSocket?.send(JSON.stringify({ msg: { type: "proc-bye" }, from: id }));
                broadcast({ type: "proc", op: "gone", proc: id, kind: entry.kind, run: r.id });
            });
            broadcast({ type: "proc", op: "connected", proc: id, kind: entry.kind, run: r.id });
        }
    }

    function fromRunSocket(r, ws, from, data) {
        let env;
        try { env = JSON.parse(String(data)); } catch { return; }
        if (run !== r) { return; }
        if (env.msg?.type === "proc-hello" && env.msg.pid) { const p = r.procs.get(from); if (p) { p.pid = env.msg.pid; } }
        route(r, { ...env, from });
    }

    function route(r, env) {
        const { to } = env;
        if (to === "ui") { broadcast({ ...env.msg, run: r.id, from: env.from }); return; }
        if (to === "host") { r.hostSocket?.send(JSON.stringify({ msg: env.msg, from: env.from })); return; }
        if (to === "proc") { r.procs.get(env.proc)?.socket.send(JSON.stringify({ msg: env.msg, from: env.from })); return; }
        if (to === "server") { serverMessage(env.msg, env.from); }
    }

    function serverMessage(msg, from) {
        if (msg.type === "reload" && run) {
            const r = run;
            benchLog(`VS Code reloads the window (${r.scenario})`);
            void startRun(r.scenario, { reload: true, worldDir: r.worldDir, free: true });
        }
        if (msg.type === "host-ready") { /* the host waits for init, sent on connection */ }
    }

    function fromUi(ws, data) {
        let env;
        try { env = JSON.parse(String(data)); } catch { return; }
        const m = env.msg || {};
        if (env.to === "server") {
            if (m.type === "start") { void startRun(m.scenario, { free: !!m.free }); }
            else if (m.type === "stop") { void stopRun(); }
            else if (m.type === "rebuild") { void rebuild(); }
            else if (m.type === "review") {
                const data = review.apply(m);
                broadcast({ type: "review", data, op: m.op, id: m.comment?.id || m.id });
            }
            return;
        }
        if (!run || (env.run && env.run !== run.id)) { return; }
        route(run, { ...env, from: "ui" });
    }

    // ---------- watching Euterpe's files ----------
    let codeTimer = null, textTimer = null;
    const watch = (dir, onChange) => {
        try { fs.watch(path.join(REPO, dir), { recursive: true }, (_e, f) => { if (f && !/node_modules|\.cache|\.worlds|review\.json/.test(String(f))) { onChange(String(f)); } }); } catch { /* not there */ }
    };
    watch("src", (f) => {
        if (/test[\\/]/.test(f)) { return; }
        clearTimeout(codeTimer); codeTimer = setTimeout(() => void rebuild(), 300);
        clearTimeout(textTimer); textTimer = setTimeout(refreshStrings, 500);
    });
    for (const d of ["overlay", "settings", "mind", "mascots", "docs"]) { watch(d, () => { clearTimeout(textTimer); textTimer = setTimeout(refreshStrings, 500); broadcast({ type: "files-changed", dir: d }); }); }
    for (const f of ["package.json", "README.md"]) {
        try { fs.watch(path.join(REPO, f), () => { clearTimeout(textTimer); textTimer = setTimeout(refreshStrings, 500); broadcast({ type: "files-changed", file: f }); }); } catch { /* not there */ }
    }
    watch(path.join("bench", "scenarios"), () => broadcast({ type: "catalog-changed" }));

    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", async () => {
            const at = `http://127.0.0.1:${port}/`;
            console.log(`Euterpe's review bench: ${at}`);
            void rebuild();
            setTimeout(refreshStrings, 50);
            if (open) { execFile(process.platform === "win32" ? "explorer" : "open", [at], () => { }); }
            const shutdown = async () => { await stopRun(); process.exit(0); };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
            resolve({ port, url: at });
        });
    });
}

module.exports = { startServer };
