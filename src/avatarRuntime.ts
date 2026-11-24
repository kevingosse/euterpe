// Euterpe's avatar runs on Electron, downloaded once (electronRuntime.ts). The download starts in
// the background as soon as a session may need it (the writer clicks Euterpe, or opens its
// settings), so it's usually there by the time the mind is set up, rather than a question asked at
// the session's start. One download at a time, shared by all who wait for it: a session on its way,
// the settings window's banner, Check Setup. vscode-free, for the tests.

import type { DownloadHooks } from "./electronRuntime";

/** Where the avatar's runtime stands (the settings window's banner shows it). */
export type RuntimeStatus =
    | { kind: "ready" }
    /** Not downloaded, and no download under way. */
    | { kind: "missing" }
    | { kind: "downloading"; received: number; total: number | null }
    | { kind: "unpacking" }
    | { kind: "failed"; message: string }
    | { kind: "cancelled" }
    /** None to use, and no download would help: euterpe.electronPath points nowhere (`setting`), or Electron has no build for this computer. */
    | { kind: "problem"; message: string; setting: boolean };

export interface RuntimeDeps {
    /** The Electron that's there; throws when euterpe.electronPath points nowhere. */
    find(): string | null;
    /** Why no Electron can be downloaded for this computer, or null when one can. */
    unbuildable(): string | null;
    /** Download, verify and unpack it (electronRuntime.ts downloadElectron): its executable. */
    download(hooks: Pick<DownloadHooks, "progress" | "cancellation">): Promise<string>;
    log(msg: string): void;
}

interface Run {
    done: Promise<string | null>;
    cancelled: boolean;
    cancel(): void;
}

export class AvatarRuntime {
    private run: Run | null = null;
    private got: { received: number; total: number | null } = { received: 0, total: null };
    /** How the last download ended, when it didn't bring the runtime. */
    private ended: { kind: "failed"; message: string } | { kind: "cancelled" } | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(private readonly deps: RuntimeDeps) { }

    /** Something about the runtime changed: a download began, moved on a percent, ended. */
    onChange(fn: () => void): { dispose(): void } {
        this.listeners.add(fn);
        return { dispose: () => { this.listeners.delete(fn); } };
    }

    status(): RuntimeStatus {
        let found: string | null;
        try {
            found = this.deps.find();
        } catch (err) {
            return { kind: "problem", message: (err as Error).message, setting: true };
        }
        if (found) { return { kind: "ready" }; }
        const unbuildable = this.deps.unbuildable();
        if (unbuildable) { return { kind: "problem", message: unbuildable, setting: false }; }
        if (this.run) {
            const { received, total } = this.got;
            return total && received >= total ? { kind: "unpacking" } : { kind: "downloading", received, total };
        }
        return this.ended ?? { kind: "missing" };
    }

    /**
     * Begin the download when the runtime is missing and none is under way. `again`: even when the
     * last one failed or was cancelled (the writer asked for a session, or clicked Try Again).
     */
    prepare(again = false): void {
        const s = this.status();
        if (s.kind === "missing" || (again && (s.kind === "failed" || s.kind === "cancelled"))) { this.begin(); }
    }

    /** The runtime's executable: there already, or once the download (under way, or begun now) is done. Null when it can't be had: status() says why. */
    obtain(): Promise<string | null> {
        const s = this.status();
        if (s.kind === "ready") {
            try { return Promise.resolve(this.deps.find()); } catch { return Promise.resolve(null); }
        }
        if (s.kind === "problem") { return Promise.resolve(null); }
        if (!this.run) { this.begin(); }
        return this.run!.done;
    }

    /** Stop the download under way (the writer cancelled it). */
    cancel(): void {
        this.run?.cancel();
    }

    private begin(): void {
        const onCancel: (() => void)[] = [];
        const run: Run = {
            done: null!,
            cancelled: false,
            cancel: () => {
                if (run.cancelled) { return; }
                run.cancelled = true;
                for (const f of onCancel.splice(0)) { f(); }
            },
        };
        const cancellation = {
            get isCancellationRequested() { return run.cancelled; },
            onCancellationRequested: (cb: () => void) => {
                onCancel.push(cb);
                return { dispose: () => { const i = onCancel.indexOf(cb); if (i >= 0) { onCancel.splice(i, 1); } } };
            },
        };
        this.run = run;
        this.ended = null;
        this.got = { received: 0, total: null };
        let shown = -1;
        run.done = this.deps.download({
            cancellation,
            progress: (received, total) => {
                this.got = { received, total };
                // A percent at a time (by the megabyte when the size isn't known): enough for a progress bar.
                const step = total ? Math.floor((received / total) * 100) : Math.floor(received / 1_048_576);
                if (step !== shown) { shown = step; this.changed(); }
            },
        }).then(
            (exe): string | null => exe,
            (err: Error): string | null => {
                this.ended = run.cancelled ? { kind: "cancelled" } : { kind: "failed", message: err.message };
                this.deps.log(run.cancelled ? "electron download cancelled" : `electron download failed: ${err.message}`);
                return null;
            },
        ).finally(() => {
            if (this.run === run) { this.run = null; }
            this.changed();
        });
        this.changed();
    }

    private changed(): void {
        for (const fn of [...this.listeners]) {
            try { fn(); } catch { /* a listener's problem */ }
        }
    }
}
