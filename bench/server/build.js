// The extension, as the bench runs it: src/extension.ts bundled as `npm run bundle` does, with a
// source map (so a dialog knows its line), and `vscode` left for the host to provide. One
// difference, for the bench's own Electron download: the checksum Euterpe pins for this
// platform's zip is the bench's fake zip's (see fakeElectronZip).
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const CACHE = path.join(REPO, "bench", ".cache");

/** A zip that unpacks to an "Electron" the bench recognizes (see world.js), big enough to watch download. */
async function fakeElectronZip(version) {
    fs.mkdirSync(CACHE, { recursive: true });
    const target = `${process.platform}-${process.arch}`;
    const file = path.join(CACHE, `electron-v${version}-${target}.zip`);
    if (!fs.existsSync(file)) {
        const yazl = require(require.resolve("yazl", { paths: [REPO] }));
        const zip = new yazl.ZipFile();
        const exe = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
        zip.addBuffer(Buffer.from(JSON.stringify({ bench: "electron" }, null, 2)), exe, { compress: false, mode: 0o100755 });
        zip.addBuffer(Buffer.from("The bench's stand-in for Electron. See bench/fake/electron-host.js.\n"), "LICENSE", { compress: false });
        // Some weight, so the download's progress has something to show.
        const pad = Buffer.alloc(24 * 1024 * 1024);
        for (let i = 0; i < pad.length; i += 65536) { crypto.randomFillSync(pad, i, Math.min(65536, pad.length - i)); }
        zip.addBuffer(pad, "resources/app.pak", { compress: false });
        zip.end();
        const chunks = [];
        await new Promise((resolve, reject) => { zip.outputStream.on("data", (c) => chunks.push(c)).on("end", resolve).on("error", reject); });
        fs.writeFileSync(file, Buffer.concat(chunks));
    }
    const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return { file, sha, target };
}

async function buildExtension({ electronVersion, onLog = () => { } }) {
    const esbuild = require(require.resolve("esbuild", { paths: [REPO] }));
    const zip = await fakeElectronZip(electronVersion);
    const outfile = path.join(CACHE, "extension.js");
    const pinOurZip = {
        name: "bench-electron-checksum",
        setup(b) {
            b.onLoad({ filter: /[\\/]src[\\/]electronRuntime\.ts$/ }, async (args) => {
                const text = fs.readFileSync(args.path, "utf8");
                const re = new RegExp(`("${zip.target}":\\s*")([0-9a-f]{64})(")`);
                if (!re.test(text)) { onLog(`bench: couldn't find the pinned checksum for ${zip.target} in electronRuntime.ts`); }
                return { contents: text.replace(re, `$1${zip.sha}$3`), loader: "ts" };
            });
        },
    };
    const started = Date.now();
    const result = await esbuild.build({
        entryPoints: [path.join(REPO, "src", "extension.ts")],
        bundle: true,
        platform: "node",
        target: "node20",
        format: "cjs",
        external: ["vscode", "original-fs", "bufferutil", "utf-8-validate"],
        sourcemap: "linked",
        sourcesContent: false,
        outfile,
        logLevel: "silent",
        plugins: [pinOurZip],
        absWorkingDir: REPO,
    });
    for (const w of result.warnings) { onLog(`esbuild: ${w.text}`); }
    onLog(`built the extension in ${Date.now() - started} ms`);
    return { bundle: outfile, electronZip: zip.file };
}

module.exports = { buildExtension, CACHE, REPO };
