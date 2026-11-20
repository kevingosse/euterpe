// What the bench runs in place of Electron: the overlay's own main process (overlay/main.js, and
// render-sheet.js through it), with fake/electron.js as its `electron`. Run as Electron would run
// the app: `electron <overlay dir> --euterpe-…`.
"use strict";

const Module = require("module");
const path = require("path");

const electron = require("./electron");
const load = Module._load;
Module._load = function (request) {
    if (request === "electron") { return electron; }
    return load.apply(this, arguments);
};

const appDir = process.argv[2];
// Electron's own argv: the executable, the app, then the app's arguments.
process.argv = [process.env.BENCH_EXE || process.execPath, appDir, ...process.argv.slice(3)];
process.on("uncaughtException", (err) => {
    console.error(`overlay main process: ${err.stack || err}`);
    try { require("fs").appendFileSync(path.join(__dirname, "..", ".cache", "electron-errors.log"), `${new Date().toISOString()} ${err.stack || err}\n`); } catch { /* no log */ }
    process.exit(1);
});
require(path.join(appDir, "main.js"));
