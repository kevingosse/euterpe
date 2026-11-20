// The working tools of a mind that runs on an API (openaiMind.ts): what Claude Code builds in for
// the Claude mind (a shell, files, the web), written for Euterpe. Like Claude Code's tools in
// bypass mode they reach the whole computer: where the mind may go unasked is its prompt's
// business (the workspace, its own memory), not these tools'. Pure node, vscode-free.

import { spawn, spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyReplacements, planEdits } from "./edits";
import { McpTool, McpToolResult } from "./mcpServer";

export interface AgentToolsOptions {
    /** Euterpe's home: relative paths start there, and so do commands. */
    home: string;
    /** Where a command's script file can go for a moment (Windows). */
    tmpDir?: string;
    platform?: NodeJS.Platform;
    /** The shell for commands (default: findShell's). */
    shell?: Shell;
}

/** How much of a command's output, a file or a page reaches the model in one go. */
const MAX_OUTPUT = 30_000;
const MAX_READ_LINES = 2_000;
const MAX_LINE = 2_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const PAGE_CHARS = 40_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** The shell commands run in: PowerShell on Windows (7 when it's there), bash elsewhere. */
export interface Shell {
    name: string;
    exe: string;
    posix: boolean;
}

export function findShell(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists = isFile): Shell {
    if (platform === "win32") {
        const dirs = (env.PATH ?? env.Path ?? "").split(";").map((d) => d.trim()).filter(Boolean);
        const programs = env.ProgramFiles || "C:\\Program Files";
        for (const p of [...dirs.map((d) => path.win32.join(d, "pwsh.exe")), path.win32.join(programs, "PowerShell", "7", "pwsh.exe")]) {
            if (exists(p)) { return { name: "PowerShell 7", exe: p, posix: false }; }
        }
        const root = env.SystemRoot || env.windir || "C:\\Windows";
        return { name: "Windows PowerShell 5.1", exe: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), posix: false };
    }
    return exists("/bin/bash") ? { name: "bash", exe: "/bin/bash", posix: true } : { name: "sh", exe: "/bin/sh", posix: true };
}

function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const fail = (text: string): McpToolResult => ({ text, isError: true });

export function agentTools(o: AgentToolsOptions): McpTool[] {
    const platform = o.platform ?? process.platform;
    const shell = o.shell ?? findShell(platform);
    /** A path as the mind gives it: ~ expanded, relative to Euterpe's home. */
    const where = (p: string) => path.resolve(o.home, p.replace(/^~(?=$|[\\/])/, os.homedir()));
    const pathParam = (what: string) => ({ type: "string", description: `${what}: absolute, or relative to your memory directory.` });

    return [
        {
            name: "run_command",
            description: [
                `Run a command in ${shell.name} on the writer's computer (${platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux"}), and get its output (stdout and stderr, as they came) and exit code.`,
                "It runs in your memory directory unless you give a cwd. There's no terminal and no input: interactive programs get end-of-file.",
                "Long outputs are cut in the middle. Prefer read_file, write_file and edit_file for files.",
            ].join(" "),
            inputSchema: {
                type: "object",
                properties: {
                    command: { type: "string", description: `The command, or a script of several lines, in ${shell.name} syntax.` },
                    cwd: pathParam("The folder to run it in"),
                    timeout_seconds: { type: "number", description: `Give up (and stop it) after this long; default ${DEFAULT_TIMEOUT_S}, at most ${MAX_TIMEOUT_S}.` },
                },
                required: ["command"],
                additionalProperties: false,
            },
            call: (args, signal) => runCommand(shell, str(args.command), args.cwd ? where(str(args.cwd)) : o.home,
                Math.min(MAX_TIMEOUT_S, Math.max(1, Number(args.timeout_seconds) || DEFAULT_TIMEOUT_S)), o.tmpDir ?? os.tmpdir(), signal),
        },
        {
            name: "read_file",
            description: [
                "Read a text file, with its line numbers (`N<tab>line`; the numbers aren't part of the file).",
                `Up to ${MAX_READ_LINES} lines at a time: offset and limit read on. An image file (PNG, JPEG, GIF, WebP) comes back as a picture; a folder, as the list of what's in it.`,
            ].join(" "),
            inputSchema: {
                type: "object",
                properties: {
                    path: pathParam("The file"),
                    offset: { type: "number", description: "The first line to read (1 = the start)." },
                    limit: { type: "number", description: `How many lines (default ${MAX_READ_LINES}).` },
                },
                required: ["path"],
                additionalProperties: false,
            },
            call: async (args) => readFile(where(str(args.path)), Number(args.offset) || 1, Number(args.limit) || MAX_READ_LINES),
        },
        {
            name: "write_file",
            description: "Write a whole text file (UTF-8), replacing it if it exists; its folders are made as needed.",
            inputSchema: {
                type: "object",
                properties: {
                    path: pathParam("The file"),
                    content: { type: "string", description: "Everything the file should hold." },
                },
                required: ["path", "content"],
                additionalProperties: false,
            },
            call: async (args) => {
                const file = where(str(args.path));
                if (typeof args.content !== "string") { return fail("content: the file's text, please."); }
                try {
                    const existed = fs.existsSync(file);
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(file, args.content, "utf8");
                    return { text: `${existed ? "Replaced" : "Created"} ${file} (${lineCount(args.content)} lines).` };
                } catch (err) {
                    return fail(`Couldn't write ${file}: ${(err as Error).message}`);
                }
            },
        },
        {
            name: "edit_file",
            description: [
                "Replace exact text in a file: old_text must appear exactly once (copy it from the file, without line numbers), unless replace_all is set.",
                "For the writer's own documents, use propose_edit instead: it goes through their review.",
            ].join(" "),
            inputSchema: {
                type: "object",
                properties: {
                    path: pathParam("The file"),
                    old_text: { type: "string", description: "The exact text to replace." },
                    new_text: { type: "string", description: "What replaces it." },
                    replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
                },
                required: ["path", "old_text", "new_text"],
                additionalProperties: false,
            },
            call: async (args) => {
                const file = where(str(args.path));
                if (typeof args.old_text !== "string" || typeof args.new_text !== "string") { return fail("old_text and new_text: both strings, please."); }
                let text: string;
                try { text = fs.readFileSync(file, "utf8"); } catch (err) { return fail(`Couldn't read ${file}: ${(err as Error).message}`); }
                const plan = planEdits(text, [{ oldText: args.old_text, newText: args.new_text, replaceAll: args.replace_all === true }], path.basename(file));
                if (!plan.ok) { return fail(plan.error.replace(" from your latest picture of the document (it may have changed since)", " from the file as it is now")); }
                try { fs.writeFileSync(file, applyReplacements(text, plan.replacements), "utf8"); } catch (err) { return fail(`Couldn't write ${file}: ${(err as Error).message}`); }
                return { text: `Edited ${file} (${plan.replacements.length} ${plan.replacements.length === 1 ? "replacement" : "replacements"}).` };
            },
        },
        {
            name: "fetch_url",
            description: [
                "Fetch a web page (as readable text, with its links), a text or JSON file, or an image (as a picture) by its http(s) URL.",
                `Long pages come ${PAGE_CHARS.toLocaleString("en")} characters at a time: start reads on.`,
            ].join(" "),
            inputSchema: {
                type: "object",
                properties: {
                    url: { type: "string", description: "The http or https URL." },
                    start: { type: "number", description: "The character to start at, to read on (default 0)." },
                },
                required: ["url"],
                additionalProperties: false,
            },
            call: (args, signal) => fetchUrl(str(args.url), Math.max(0, Number(args.start) || 0), signal),
        },
    ];
}

const lineCount = (s: string) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

// ---------- run_command ----------

/** The environment commands get: the editor's, without what would turn an Electron app into Node or make git ask. */
export function commandEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
}

function runCommand(shell: Shell, command: string, cwd: string, timeoutS: number, tmpDir: string, signal?: AbortSignal): Promise<McpToolResult> {
    if (!command.trim()) { return Promise.resolve(fail("command: what to run, please.")); }
    try {
        if (!fs.statSync(cwd).isDirectory()) { return Promise.resolve(fail(`${cwd} isn't a folder.`)); }
    } catch {
        return Promise.resolve(fail(`${cwd} doesn't exist.`));
    }
    let script = "";
    let args: string[];
    if (shell.posix) {
        args = ["-c", command];
    } else {
        // A script file, so no quoting can break the command; with a BOM, so Windows PowerShell
        // reads it as UTF-8. The output is UTF-8 too (it'd be the console's code page), and the
        // exit code is the last command's.
        script = path.join(tmpDir, `euterpe-${crypto.randomBytes(6).toString("hex")}.ps1`);
        fs.writeFileSync(script, "\uFEFF" + [
            "$ErrorActionPreference = 'Continue'",
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
            "$OutputEncoding = [System.Text.Encoding]::UTF8",
            command,
            "if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }",
        ].join("\r\n"), "utf8");
        args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
    }
    const started = Date.now();
    return new Promise((resolve) => {
        let out = "";
        let dropped = 0;
        let stopped: "timeout" | "cancelled" | null = null;
        const keep = (chunk: string) => {
            // the start and the end are what matter; the middle of a huge output is dropped
            out += chunk;
            if (out.length > 4 * MAX_OUTPUT) { dropped += out.length - 3 * MAX_OUTPUT; out = out.slice(0, MAX_OUTPUT) + out.slice(-2 * MAX_OUTPUT); }
        };
        const proc = spawn(shell.exe, args, {
            cwd, env: commandEnv(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
            // its own process group, to stop everything it started
            detached: shell.posix,
        });
        const stop = (why: "timeout" | "cancelled") => {
            if (stopped || proc.exitCode !== null) { return; }
            stopped = why;
            killTree(proc.pid, shell.posix);
        };
        const timer = setTimeout(() => stop("timeout"), timeoutS * 1000);
        const onAbort = () => stop("cancelled");
        signal?.addEventListener("abort", onAbort);
        proc.stdout!.setEncoding("utf8");
        proc.stderr!.setEncoding("utf8");
        proc.stdout!.on("data", keep);
        proc.stderr!.on("data", keep);
        const done = (r: McpToolResult) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (script) { fs.rm(script, { force: true }, () => { /* gone */ }); }
            resolve(r);
        };
        proc.on("error", (err) => done(fail(`Couldn't run ${shell.name}: ${err.message}`)));
        proc.on("close", (code) => {
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            const status = stopped === "timeout" ? `stopped after ${timeoutS} s (timed out)`
                : stopped === "cancelled" ? "stopped (the turn was cancelled)"
                : `exit code ${code ?? "?"} (${secs} s)`;
            const body = clip(out.replace(/\r\n/g, "\n"), dropped);
            done({ text: `${status}\n${body.trim() ? body : "(no output)"}`, isError: stopped !== null || code !== 0 });
        });
    });
}

function killTree(pid: number | undefined, posix: boolean): void {
    if (!pid) { return; }
    try {
        if (posix) { process.kill(-pid, "SIGKILL"); }
        else { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
    } catch { /* already gone */ }
}

/** Long text cut in the middle, saying how much went. */
function clip(text: string, alreadyDropped = 0): string {
    if (text.length <= MAX_OUTPUT && !alreadyDropped) { return text; }
    const head = Math.floor(MAX_OUTPUT / 3), tail = MAX_OUTPUT - head;
    if (text.length <= MAX_OUTPUT) {
        return `${text.slice(0, head)}\n[… ${alreadyDropped.toLocaleString("en")} characters cut …]\n${text.slice(head)}`;
    }
    return `${text.slice(0, head)}\n[… ${(text.length - MAX_OUTPUT + alreadyDropped).toLocaleString("en")} characters cut …]\n${text.slice(-tail)}`;
}

// ---------- read_file ----------

function readFile(file: string, offset: number, limit: number): McpToolResult {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return fail(`${file} doesn't exist.`); }
    if (stat.isDirectory()) {
        let names: fs.Dirent[];
        try { names = fs.readdirSync(file, { withFileTypes: true }); } catch (err) { return fail(`Couldn't list ${file}: ${(err as Error).message}`); }
        const list = names.map((d) => d.name + (d.isDirectory() ? "/" : "")).sort((a, b) => a.localeCompare(b));
        return { text: `${file} is a folder with ${list.length} ${list.length === 1 ? "entry" : "entries"}:\n${list.slice(0, 1000).join("\n")}${list.length > 1000 ? "\n[…]" : ""}` };
    }
    const image = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (image && stat.size <= MAX_IMAGE_BYTES) {
        return { text: `${file}, a picture:`, images: [{ data: fs.readFileSync(file).toString("base64"), mimeType: image }] };
    }
    if (stat.size > MAX_FILE_BYTES) { return fail(`${file} is ${Math.round(stat.size / 1048576)} MB: search it with run_command instead.`); }
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) { return fail(`${file} is a binary file (${stat.size.toLocaleString("en")} bytes): read_file shows text.`); }
    const lines = buf.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") { lines.pop(); }
    const first = Math.max(1, Math.floor(offset));
    const count = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(limit)));
    if (first > lines.length && lines.length > 0) { return fail(`${file} has ${lines.length} lines: there's no line ${first}.`); }
    const shown = lines.slice(first - 1, first - 1 + count);
    const body = shown.map((l, i) => `${first + i}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + " […]" : l}`).join("\n");
    const last = first + shown.length - 1;
    const partial = first > 1 || last < lines.length;
    return { text: partial ? `${body}\n(lines ${first}–${last} of ${lines.length}; offset reads on)` : body || "(empty file)" };
}

// ---------- fetch_url ----------

async function fetchUrl(raw: string, start: number, signal?: AbortSignal): Promise<McpToolResult> {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { return fail("url: a full http(s) address, please."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") { return fail("fetch_url reads http and https addresses."); }
    const signals = [AbortSignal.timeout(30_000), ...(signal ? [signal] : [])];
    let res: Response;
    try {
        res = await fetch(url, {
            redirect: "follow",
            signal: AbortSignal.any(signals),
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; Euterpe; +https://github.com/kevingosse/euterpe)",
                Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,image/*;q=0.8,*/*;q=0.5",
            },
        });
    } catch (err) {
        return fail(`Couldn't fetch ${url.href}: ${(err as Error).message}`);
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    let body: Buffer;
    try { body = await readCapped(res, MAX_PAGE_BYTES); } catch (err) { return fail(`Couldn't read ${url.href}: ${(err as Error).message}`); }
    const head = `${res.status} ${res.statusText} — ${res.url || url.href}`;
    const image = /^image\/(png|jpeg|gif|webp)/.exec(type);
    if (image) {
        return body.length <= MAX_IMAGE_BYTES
            ? { text: `${head}: a picture.`, images: [{ data: body.toString("base64"), mimeType: `image/${image[1]}` }] }
            : fail(`${head}: a picture too big to look at (${body.length.toLocaleString("en")} bytes).`);
    }
    const textual = !type || /^text\/|json|xml|javascript|csv|markdown|yaml/.test(type);
    if (!textual) { return fail(`${head}: a ${type.split(";")[0]} file (${body.length.toLocaleString("en")} bytes), which fetch_url can't read.`); }
    let text = body.toString("utf8");
    if (/html/.test(type) || (!type && /^\s*<(!doctype html|html)/i.test(text))) { text = htmlToText(text, res.url || url.href); }
    const page = text.slice(start, start + PAGE_CHARS);
    const more = start + PAGE_CHARS < text.length;
    const range = start > 0 || more ? `\n(characters ${start.toLocaleString("en")}–${(start + page.length).toLocaleString("en")} of ${text.length.toLocaleString("en")}${more ? `; start=${start + page.length} reads on` : ""})` : "";
    return { text: `${head}\n\n${page}${range}`, isError: !res.ok };
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
    if (!res.body) { return Buffer.alloc(0); }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        chunks.push(Buffer.from(value));
        size += value.length;
        if (size >= max) { await reader.cancel().catch(() => { /* done with it */ }); break; }
    }
    return Buffer.concat(chunks).subarray(0, max);
}

const ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç",
};

function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
            const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** A web page as readable text: headings, paragraphs and list items on their own lines, links kept. */
export function htmlToText(html: string, base: string): string {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    let s = html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(script|style|noscript|svg|template|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, d: string, sgl: string, inner: string) => {
            const label = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
            let href = decodeEntities(d ?? sgl ?? "");
            try { href = new URL(href, base).href; } catch { return label; }
            return label && /^https?:/.test(href) ? `[${label}](${href})` : label;
        })
        .replace(/<(br|hr)\b[^>]*>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
        .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|table|tr|blockquote|pre|figure|dl|dt|dd)\s*>/gi, "\n\n")
        .replace(/<\/(td|th)\s*>/gi, " | ")
        .replace(/<[^>]+>/g, "");
    s = decodeEntities(s).replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return title ? `# ${decodeEntities(title.replace(/\s+/g, " ").trim())}\n\n${s}` : s;
}
