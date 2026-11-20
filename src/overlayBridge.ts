import { ChildProcess, spawn } from "child_process";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import { WebSocket, WebSocketServer } from "ws";
import { linuxSwitches, needsNoSandbox } from "./electronRuntime";
import { FromOverlay, ToOverlay } from "./protocol";

export interface OverlayOptions {
    overlayDir: string;
    /** The Electron executable that runs it (see electronRuntime.ts). */
    electronPath: string;
    /** Avatar pixel scale (2..6), passed through to the overlay. */
    scale: number;
    /** The mascot pack to wear (mascots.ts); null wears Clawd. */
    mascotFile?: string | null;
    /** The pack to wear when the chosen one doesn't hold up; null: Clawd. */
    fallbackMascotFile?: string | null;
    /** The colours of the chat and its buttons: Claude's clay, or blue for a mind on another provider. */
    theme?: "claude" | "openai";
    log: (msg: string) => void;
}

/**
 * Hosts a localhost WebSocket server and spawns the Electron overlay that
 * connects to it. Pure plumbing: forwards messages both ways.
 *
 * Events: "message" (FromOverlay), "died" (the overlay is gone, unasked; with the reason when it
 * couldn't be started at all).
 */
export class OverlayBridge extends EventEmitter {
    private server: WebSocketServer | null = null;
    private socket: WebSocket | null = null;
    private proc: ChildProcess | null = null;
    private exited: Promise<void> = Promise.resolve();
    private pending: ToOverlay[] = [];
    private closing = false;
    // Any local process can reach a localhost port; only the overlay we
    // spawned knows this.
    private readonly token = crypto.randomBytes(24).toString("hex");

    constructor(private readonly opts: OverlayOptions) {
        super();
    }

    async start(): Promise<void> {
        const port = await new Promise<number>((resolve, reject) => {
            this.server = new WebSocketServer({
                host: "127.0.0.1",
                port: 0,
                verifyClient: (info: { req: { url?: string } }) => this.authorized(info.req.url),
            }, () => {
                const addr = this.server!.address();
                if (typeof addr === "object" && addr) {
                    resolve(addr.port);
                } else {
                    reject(new Error("could not bind overlay port"));
                }
            });
            this.server.on("error", reject);
        });

        this.server!.on("connection", (socket) => {
            this.opts.log("overlay connected");
            this.socket = socket;
            for (const msg of this.pending.splice(0)) {
                socket.send(JSON.stringify(msg));
            }
            socket.on("message", (data) => {
                try {
                    const msg = JSON.parse(data.toString()) as FromOverlay;
                    this.emit("message", msg);
                } catch {
                    this.opts.log(`bad overlay message: ${data.toString().slice(0, 100)}`);
                }
            });
            socket.on("close", () => {
                if (this.socket === socket) { this.socket = null; }
            });
        });

        this.spawnOverlay(this.opts.electronPath, port);
    }

    send(msg: ToOverlay): void {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(msg));
        } else {
            this.pending.push(msg);
        }
    }

    /** Ask the overlay to play its exit and quit; kill it if it lingers. */
    async shutdown(timeoutMs = 4000): Promise<void> {
        this.closing = true;
        const proc = this.proc;
        if (proc) {
            this.send({ type: "shutdown" });
            await Promise.race([this.exited, new Promise((r) => setTimeout(r, timeoutMs))]);
            if (this.proc === proc) {
                this.opts.log("overlay didn't quit in time — killing it");
                try { proc.kill(); } catch { /* ignore */ }
            }
        }
        this.proc = null;
        this.server?.close();
        this.server = null;
    }

    /** Immediate teardown (VS Code is shutting down). */
    dispose(): void {
        this.closing = true;
        try { this.proc?.kill(); } catch { /* ignore */ }
        this.proc = null;
        this.server?.close();
        this.server = null;
    }

    private authorized(url: string | undefined): boolean {
        try {
            return new URL(url ?? "/", "http://127.0.0.1").searchParams.get("token") === this.token;
        } catch {
            return false;
        }
    }

    /** spawn, saying what couldn't be run: a file that isn't a program fails there and then on Windows ("spawn UNKNOWN"). */
    private run(bin: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
        try {
            return spawn(bin, args, options);
        } catch (err) {
            throw new Error(`${bin} can't be run as Euterpe's window (${(err as Error).message}). Is it an Electron executable? (euterpe.electronPath)`);
        }
    }

    private spawnOverlay(bin: string, port: number, noSandbox = false): void {
        this.opts.log(`spawning overlay: ${bin} (port ${port})`);
        // The extension host sets ELECTRON_RUN_AS_NODE; if inherited, the
        // overlay binary runs as plain Node and require("electron") breaks.
        // The token travels in the environment, not on the command line: on macOS and Linux
        // every user of the computer can read the command lines of the others' processes, and
        // whoever holds the token can talk to the mind as the writer.
        const env: NodeJS.ProcessEnv = { ...process.env, EUTERPE_OVERLAY_TOKEN: this.token };
        delete env.ELECTRON_RUN_AS_NODE;
        const proc = this.run(bin, [
            this.opts.overlayDir,
            `--euterpe-port=${port}`,
            `--euterpe-scale=${this.opts.scale}`,
            ...(this.opts.mascotFile ? [`--euterpe-mascot=${this.opts.mascotFile}`] : []),
            ...(this.opts.fallbackMascotFile ? [`--euterpe-fallback-mascot=${this.opts.fallbackMascotFile}`] : []),
            ...(this.opts.theme && this.opts.theme !== "claude" ? [`--euterpe-theme=${this.opts.theme}`] : []),
            ...linuxSwitches(noSandbox),
        ], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: false,
            env,
        });
        this.proc = proc;
        // (one that never started has no exit, only an error)
        const started = () => proc.pid !== undefined;
        this.exited = new Promise((resolve) => { proc.on("exit", () => resolve()); proc.on("error", () => { if (!started()) { resolve(); } }); });
        let errors = "";
        proc.stdout!.on("data", (d) => this.opts.log(`[overlay] ${String(d).trim()}`));
        proc.stderr!.on("data", (d) => {
            if (errors.length < 8192) { errors += String(d); }
            this.opts.log(`[overlay err] ${String(d).trim()}`);
        });
        // An executable that can't be run (not one, or gone) never exits: without this the session
        // would go on with a mind and no body.
        proc.on("error", (err) => {
            this.opts.log(`overlay ${started() ? "" : "spawn "}error: ${err.message}`);
            if (started() || this.proc !== proc) { return; }
            this.proc = null;
            if (!this.closing) { this.emit("died", err.message); }
        });
        proc.on("exit", (code) => {
            this.opts.log(`overlay exited (${code})`);
            if (this.proc === proc) { this.proc = null; }
            if (this.closing) { return; }
            if (!noSandbox && needsNoSandbox(errors)) {
                this.opts.log("Chromium's sandbox isn't available here (its helper isn't setuid root, and user namespaces are restricted): starting the avatar's window without it. It only ever shows Euterpe's own page.");
                this.spawnOverlay(bin, port, true);
                return;
            }
            this.emit("died");
        });
    }
}

