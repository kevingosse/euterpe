// A minimal MCP server over the Streamable HTTP transport (JSON responses, no
// server-initiated streams): how the extension lends the mind tools that act
// in VS Code. Pure node, vscode-free, so it can be unit-tested.

import * as crypto from "crypto";
import * as http from "http";

export interface McpToolResult {
    text: string;
    isError?: boolean;
    /** Pictures for the model to look at, after the text (base64). */
    images?: { data: string; mimeType: string }[];
}

export interface McpTool {
    name: string;
    description: string;
    inputSchema: object;
    /** `signal`: the turn was cancelled (a tool that runs for long should stop). */
    call(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
}

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const MAX_BODY = 8 * 1024 * 1024;

export class McpServer {
    private server: http.Server | null = null;
    private port = 0;
    // Any local process can reach a localhost port; only the mind's config knows this.
    private readonly token = crypto.randomBytes(24).toString("hex");

    constructor(
        private readonly name: string,
        private readonly tools: McpTool[],
        private readonly log: (msg: string) => void,
    ) {}

    get url(): string {
        return `http://127.0.0.1:${this.port}/mcp`;
    }

    /** The --mcp-config document that points claude at this server. */
    config(): object {
        return {
            mcpServers: {
                [this.name]: { type: "http", url: this.url, headers: { Authorization: `Bearer ${this.token}` } },
            },
        };
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                this.handle(req, res).catch((err) => {
                    this.log(`mcp: ${(err as Error).message}`);
                    if (!res.headersSent) { res.writeHead(500); }
                    res.end();
                });
            });
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
                const addr = server.address();
                if (typeof addr === "object" && addr) {
                    this.port = addr.port;
                    this.server = server;
                    resolve();
                } else {
                    reject(new Error("could not bind the MCP port"));
                }
            });
        });
    }

    close(): void {
        this.server?.close();
        this.server?.closeAllConnections?.();
        this.server = null;
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (req.headers.authorization !== `Bearer ${this.token}`) {
            res.writeHead(401).end();
            return;
        }
        if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
            res.writeHead(404).end();
            return;
        }
        // No server-initiated stream (GET) and no sessions to end (DELETE).
        if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" }).end();
            return;
        }
        let body: unknown;
        try {
            body = JSON.parse(await readBody(req));
        } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" })
                .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${(err as Error).message}` } }));
            return;
        }
        const batch = Array.isArray(body);
        const replies: object[] = [];
        for (const msg of (batch ? body : [body]) as any[]) {
            // Notifications and responses get no reply.
            if (msg && typeof msg === "object" && typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) {
                replies.push(await this.dispatch(msg));
            }
        }
        if (replies.length === 0) {
            res.writeHead(202).end();
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify(batch ? replies : replies[0]));
    }

    private async dispatch(msg: { id: string | number; method: string; params?: any }): Promise<object> {
        const result = (r: object) => ({ jsonrpc: "2.0", id: msg.id, result: r });
        const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
        switch (msg.method) {
            case "initialize": {
                const asked = msg.params?.protocolVersion;
                return result({
                    protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: this.name, version: "1.0.0" },
                });
            }
            case "ping":
                return result({});
            case "tools/list":
                return result({ tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
            case "tools/call": {
                const tool = this.tools.find((t) => t.name === msg.params?.name);
                if (!tool) { return error(-32602, `Unknown tool: ${msg.params?.name}`); }
                const args = msg.params?.arguments;
                let r: McpToolResult;
                try {
                    r = await tool.call(args && typeof args === "object" ? args : {});
                } catch (err) {
                    this.log(`mcp tool ${tool.name} failed: ${(err as Error).stack ?? err}`);
                    r = { text: `The tool failed: ${(err as Error).message}`, isError: true };
                }
                const images = (r.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
                return result({ content: [{ type: "text", text: r.text }, ...images], isError: !!r.isError });
            }
            default:
                return error(-32601, `Method not found: ${msg.method}`);
        }
    }
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new Error("request too large"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
