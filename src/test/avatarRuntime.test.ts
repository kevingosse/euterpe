import * as assert from "node:assert/strict";
import { test } from "node:test";
import { AvatarRuntime, RuntimeDeps } from "../avatarRuntime";

/** A download the test drives: progress, then done or failed; cancelling it fails it, as a real one does. */
function world(over: Partial<RuntimeDeps> = {}) {
    let installed: string | null = null;
    let downloads = 0;
    let step: ((received: number, total: number | null) => void) | undefined;
    let finish: (() => void) | undefined;
    let fail: ((e: Error) => void) | undefined;
    const deps: RuntimeDeps = {
        find: () => installed,
        unbuildable: () => null,
        download: (hooks) => {
            downloads++;
            step = hooks.progress;
            return new Promise<string>((resolve, reject) => {
                finish = () => { installed = "/storage/electron/electron.exe"; resolve(installed); };
                fail = reject;
                hooks.cancellation?.onCancellationRequested(() => reject(new Error("aborted")));
            });
        },
        log: () => { /* quiet */ },
        ...over,
    };
    return {
        runtime: new AvatarRuntime(deps),
        get downloads() { return downloads; },
        step: (r: number, t: number | null) => step?.(r, t),
        finish: () => finish?.(),
        fail: (m: string) => fail?.(new Error(m)),
    };
}

test("the download starts once, its progress is the status, and whoever waits gets the runtime", async () => {
    const w = world();
    let changes = 0;
    w.runtime.onChange(() => { changes++; });
    assert.deepEqual(w.runtime.status(), { kind: "missing" });
    w.runtime.prepare();
    const a = w.runtime.obtain(), b = w.runtime.obtain();   // a session and Check Setup, say: the same download
    w.runtime.prepare();
    assert.equal(w.downloads, 1);
    w.step(30 * 1_048_576, 120 * 1_048_576);
    w.step(30 * 1_048_576 + 10, 120 * 1_048_576);   // (not a percent further: no news)
    assert.deepEqual(w.runtime.status(), { kind: "downloading", received: 30 * 1_048_576 + 10, total: 120 * 1_048_576 });
    const before = changes;
    w.step(120 * 1_048_576, 120 * 1_048_576);
    assert.equal(w.runtime.status().kind, "unpacking");
    assert.equal(changes, before + 1);
    w.finish();
    assert.equal(await a, "/storage/electron/electron.exe");
    assert.equal(await b, "/storage/electron/electron.exe");
    assert.deepEqual(w.runtime.status(), { kind: "ready" });
    assert.equal(await w.runtime.obtain(), "/storage/electron/electron.exe");
    assert.equal(w.downloads, 1);
});

test("a cancelled download stays cancelled until someone asks again; a failed one says why", async () => {
    const w = world();
    w.runtime.prepare();
    const waiting = w.runtime.obtain();
    w.runtime.cancel();
    assert.equal(await waiting, null);
    assert.deepEqual(w.runtime.status(), { kind: "cancelled" });
    w.runtime.prepare();   // the settings window opening again: no
    assert.equal(w.downloads, 1);
    w.runtime.prepare(true);   // the writer clicks Euterpe, or Download
    assert.equal(w.downloads, 2);
    const again = w.runtime.obtain();
    w.fail("The Electron download stalled.");
    assert.equal(await again, null);
    assert.deepEqual(w.runtime.status(), { kind: "failed", message: "The Electron download stalled." });
    w.runtime.prepare(true);
    assert.equal(w.runtime.status().kind, "downloading");
});

test("no download for what a download can't fix: a setting that points nowhere, a computer Electron has no build for", async () => {
    const broken = world({ find: () => { throw new Error("euterpe.electronPath points to /x, which doesn't exist."); } });
    assert.deepEqual(broken.runtime.status(), { kind: "problem", message: "euterpe.electronPath points to /x, which doesn't exist.", setting: true });
    broken.runtime.prepare(true);
    assert.equal(await broken.runtime.obtain(), null);
    assert.equal(broken.downloads, 0);
    const odd = world({ unbuildable: () => "Electron has no build for win32-ia32." });
    assert.deepEqual(odd.runtime.status(), { kind: "problem", message: "Electron has no build for win32-ia32.", setting: false });
    assert.equal(await odd.runtime.obtain(), null);
    assert.equal(odd.downloads, 0);
});
