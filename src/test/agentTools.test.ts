import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { agentTools, commandEnv, findShell, htmlToText } from "../agentTools";
import { McpTool } from "../mcpServer";

function tools(home: string): Record<string, McpTool> {
    return Object.fromEntries(agentTools({ home }).map((t) => [t.name, t]));
}
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-tools-"));

test("the shell: PowerShell on Windows (7 if it's there), bash elsewhere", () => {
    const none = () => false;
    assert.equal(findShell("win32", { PATH: "C:\\bin", SystemRoot: "C:\\Windows" }, none).exe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(findShell("win32", { PATH: "C:\\bin;C:\\pwsh", SystemRoot: "C:\\Windows" }, (p) => p === "C:\\pwsh\\pwsh.exe").name, "PowerShell 7");
    assert.deepEqual(findShell("darwin", {}, (p) => p === "/bin/bash"), { name: "bash", exe: "/bin/bash", posix: true });
    assert.equal(findShell("linux", {}, none).exe, "/bin/sh");
});

test("commands don't inherit what would turn Electron into Node, or let git prompt", () => {
    const env = commandEnv({ PATH: "p", ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.PATH, "p");
});

test("a command runs in Euterpe's home, with its output and exit code", async () => {
    const home = scratch();
    const t = tools(home);
    const ok = await t.run_command.call({ command: "echo hello" });
    assert.match(ok.text, /^exit code 0 \(/);
    assert.match(ok.text, /hello/);
    assert.ok(!ok.isError);
    const where = await t.run_command.call({ command: process.platform === "win32" ? "(Get-Location).Path" : "pwd" });
    // the shell prints the long, resolved path (a Windows temp dir can be an 8.3 short one, macOS's is a link)
    const long = fs.realpathSync.native(home);
    assert.ok([long, home].some((p) => where.text.toLowerCase().includes(p.toLowerCase())), `${where.text} (expected ${long})`);
    const failed = await t.run_command.call({ command: "exit 3" });
    assert.match(failed.text, /^exit code 3/);
    assert.ok(failed.isError);
    assert.match((await t.run_command.call({ command: "echo x", cwd: "nowhere" })).text, /doesn't exist/);
});

test("a command that runs too long, or whose turn is cancelled, is stopped", async () => {
    const t = tools(scratch());
    const sleep = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
    const slow = await t.run_command.call({ command: sleep, timeout_seconds: 1 });
    assert.match(slow.text, /timed out/);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const started = Date.now();
    const cancelled = await t.run_command.call({ command: sleep }, ac.signal);
    assert.match(cancelled.text, /cancelled/);
    assert.ok(Date.now() - started < 10_000);
});

test("files: written, edited by exact text, read with line numbers, folders listed", async () => {
    const home = scratch();
    const t = tools(home);
    assert.match((await t.write_file.call({ path: "notes/a.md", content: "One\nTwo, été\n" })).text, /^Created .*a\.md \(2 lines\)/);
    assert.match((await t.edit_file.call({ path: "notes/a.md", old_text: "Two", new_text: "Deux" })).text, /1 replacement/);
    const missing = await t.edit_file.call({ path: "notes/a.md", old_text: "Three", new_text: "x" });
    assert.ok(missing.isError);
    assert.match(missing.text, /isn't in a\.md.*from the file as it is now/);
    assert.equal((await t.read_file.call({ path: path.join(home, "notes", "a.md") })).text, "1\tOne\n2\tDeux, été");
    assert.equal((await t.read_file.call({ path: "notes/a.md", offset: 2, limit: 1 })).text, "2\tDeux, été\n(lines 2–2 of 2; offset reads on)");
    assert.match((await t.read_file.call({ path: "notes" })).text, /a folder with 1 entry:\na\.md/);
    assert.match((await t.read_file.call({ path: "gone.md" })).text, /doesn't exist/);
    fs.writeFileSync(path.join(home, "crlf.md"), "a\r\nb\r\n");
    await t.edit_file.call({ path: "crlf.md", old_text: "a\nb", new_text: "a\nc" });
    assert.equal(fs.readFileSync(path.join(home, "crlf.md"), "utf8"), "a\r\nc\r\n", "the file keeps its line endings");
    fs.writeFileSync(path.join(home, "bin.dat"), Buffer.from([1, 0, 2]));
    assert.match((await t.read_file.call({ path: "bin.dat" })).text, /binary/);
    fs.writeFileSync(path.join(home, "dot.png"), Buffer.from("89504e47", "hex"));
    assert.deepEqual((await t.read_file.call({ path: "dot.png" })).images, [{ data: Buffer.from("89504e47", "hex").toString("base64"), mimeType: "image/png" }]);
});

test("a web page comes as text, with its links; long ones a page at a time", async () => {
    const long = "word ".repeat(20_000);
    const server = http.createServer((req, res) => {
        if (req.url === "/long") { res.setHeader("content-type", "text/plain"); res.end(long); return; }
        if (req.url === "/pdf") { res.setHeader("content-type", "application/pdf"); res.end("%PDF"); return; }
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<html><head><title>A &amp; B</title><script>evil()</script></head><body><h2>Heap</h2><p>See <a href=\"/doc\">the doc</a>.</p></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
        const t = tools(scratch());
        const page = await t.fetch_url.call({ url: `${base}/` });
        assert.equal(page.text, `200 OK — ${base}/\n\n# A & B\n\n## Heap\n\nSee [the doc](${base}/doc).`);
        const first = await t.fetch_url.call({ url: `${base}/long` });
        assert.match(first.text, /\(characters 0–40,000 of 100,000; start=40000 reads on\)$/);
        assert.match((await t.fetch_url.call({ url: `${base}/long`, start: 80_000 })).text, /\(characters 80,000–100,000 of 100,000\)$/);
        assert.match((await t.fetch_url.call({ url: `${base}/pdf` })).text, /application\/pdf file .* can't read/);
        assert.ok((await t.fetch_url.call({ url: "ftp://example.com" })).isError);
    } finally {
        server.close();
    }
});

test("HTML becomes readable text", () => {
    assert.equal(htmlToText("<ul><li>one<li>two</ul><p>a&nbsp;b &#233; &#x2014;</p>", "https://x.y/"), "- one\n- two\n\na b é —");
    assert.equal(htmlToText("<a href='https://e.com/p'>E</a> <a href='mailto:x@y'>mail</a>", "https://x.y/"), "[E](https://e.com/p) mail");
});
