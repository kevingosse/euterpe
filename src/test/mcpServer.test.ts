import * as assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "../mcpServer";

/** The JSON body of a response (untyped: these are protocol messages). */
async function json(res: Promise<Response>): Promise<any> {
    return (await res).json();
}

async function withServer(fn: (post: (body: unknown, auth?: string) => Promise<Response>, server: McpServer, calls: unknown[]) => Promise<void>) {
    const calls: unknown[] = [];
    const server = new McpServer("euterpe", [{
        name: "propose_edit",
        description: "Propose an edit.",
        inputSchema: { type: "object" },
        call: async (args) => {
            calls.push(args);
            if (args.fail) { throw new Error("boom"); }
            if (args.picture) { return { text: "Here.", images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }] }; }
            return args.bad ? { text: "old_text isn't there", isError: true } : { text: "Proposed." };
        },
    }], () => { /* no log */ });
    await server.start();
    const cfg = server.config() as any;
    const auth = cfg.mcpServers.euterpe.headers.Authorization;
    const post = (body: unknown, a = auth) => fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: a },
        body: JSON.stringify(body),
    });
    try {
        await fn(post, server, calls);
    } finally {
        server.close();
    }
}

test("the config points claude at the server over HTTP with a bearer token", async () => {
    await withServer(async (_post, server) => {
        const cfg = server.config() as any;
        assert.equal(cfg.mcpServers.euterpe.type, "http");
        assert.match(cfg.mcpServers.euterpe.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        assert.match(cfg.mcpServers.euterpe.headers.Authorization, /^Bearer [0-9a-f]{48}$/);
    });
});

test("initialize, notifications, tools/list and tools/call", async () => {
    await withServer(async (post, _server, calls) => {
        const init = await json(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
        assert.equal(init.result.protocolVersion, "2025-06-18");
        assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
        const unknownVersion = await json(post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }));
        assert.equal(unknownVersion.result.protocolVersion, "2025-11-25");

        const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
        assert.equal(note.status, 202);

        const list = await json(post({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
        assert.deepEqual(list.result.tools.map((t: any) => t.name), ["propose_edit"]);

        const ok = await json(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "propose_edit", arguments: { edits: [] } } }));
        assert.deepEqual(ok.result, { content: [{ type: "text", text: "Proposed." }], isError: false });
        assert.deepEqual(calls, [{ edits: [] }]);

        const refused = await json(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "propose_edit", arguments: { bad: true } } }));
        assert.equal(refused.result.isError, true);
        const threw = await json(post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "propose_edit", arguments: { fail: true } } }));
        assert.deepEqual(threw.result, { content: [{ type: "text", text: "The tool failed: boom" }], isError: true });

        const picture = await json(post({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "propose_edit", arguments: { picture: true } } }));
        assert.deepEqual(picture.result.content, [{ type: "text", text: "Here." }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);

        const unknownTool = await json(post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "rm_rf" } }));
        assert.equal(unknownTool.error.code, -32602);
        const unknownMethod = await json(post({ jsonrpc: "2.0", id: 8, method: "resources/list" }));
        assert.equal(unknownMethod.error.code, -32601);
        const ping = await json(post({ jsonrpc: "2.0", id: 9, method: "ping" }));
        assert.deepEqual(ping.result, {});
    });
});

test("batches get a batch back", async () => {
    await withServer(async (post) => {
        const r = await json(post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]));
        assert.ok(Array.isArray(r));
        assert.deepEqual(r.map((m: any) => m.id), [1, 2]);
    });
});

test("no token, no service; only POST /mcp", async () => {
    await withServer(async (post, server) => {
        assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, "Bearer nope")).status, 401);
        const auth = (server.config() as any).mcpServers.euterpe.headers.Authorization;
        assert.equal((await fetch(server.url, { headers: { Authorization: auth } })).status, 405);
        assert.equal((await fetch(server.url.replace("/mcp", "/other"), { method: "POST", headers: { Authorization: auth }, body: "{}" })).status, 404);
        const garbage = await fetch(server.url, { method: "POST", headers: { Authorization: auth }, body: "{nope" });
        assert.equal(garbage.status, 400);
        assert.equal((await json(Promise.resolve(garbage))).error.code, -32700);
    });
});
