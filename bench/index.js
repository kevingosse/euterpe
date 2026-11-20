// Euterpe's review bench: `node bench` (or `node bench --port=7400 --no-open`).
// See bench/README.md.
"use strict";

const { startServer } = require("./server/server");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const port = Number(arg("port")) || 7317;
void startServer({ port, open: !process.argv.includes("--no-open") });
