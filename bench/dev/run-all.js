// Plays scenarios in the bench's page (headless Chrome, see chrome.js), passing each screen after a
// screenshot, and reports what broke: the bench's own test.
//   node bench/dev/run-all.js [<scenario or chapter id>…] [--shots=<dir>] [--settle=<ms>]
"use strict";

const fs = require("fs");
const path = require("path");
const { session } = require("./chrome");

const BENCH = process.env.BENCH_URL || "http://127.0.0.1:7317/";
const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const only = args.filter((a) => !a.startsWith("--"));
const shots = opt("shots");
const settle = Number(opt("settle")) || 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const s = await session();
    const ev = async (expr) => {
        const r = await s.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) { throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); }
        return r.result.value;
    };
    await s.send("Page.enable");
    await s.send("Emulation.setDeviceMetricsOverride", { width: 1720, height: 1000, deviceScaleFactor: 1, mobile: false });
    await s.send("Page.navigate", { url: BENCH });
    await sleep(2500);
    const catalog = await ev("fetch('/api/catalog').then(r => r.json())");
    const all = catalog.chapters.flatMap((c) => c.scenarios.map((x) => ({ ...x, chapter: c.id })));
    const list = all.filter((x) => !only.length || only.some((o) => x.id === o || x.chapter === o || x.id.startsWith(o)));
    if (shots) { fs.mkdirSync(shots, { recursive: true }); }
    const report = [];
    for (const scn of list) {
        const t0 = Date.now();
        await ev(`window.__benchErrors.length = 0; document.querySelector('[data-scenario="${scn.id}"]').click(); true`);
        const seen = [];
        let outcome = "timeout", error = null;
        let lastKey = null, idle = 0;
        while (Date.now() - t0 < 150_000) {
            await sleep(300);
            const st = await ev(`({ state: document.getElementById('run-state').textContent, screen: document.getElementById('where-screen').textContent, key: document.querySelector('.screen-key')?.textContent || null, err: document.querySelector('.error-box')?.innerText || null })`);
            if (st.state === "review" && st.key && st.key !== lastKey) {
                lastKey = st.key;
                await sleep(settle);
                if (shots) {
                    const r = await s.send("Page.captureScreenshot", { format: "png" });
                    const file = path.join(shots, `${st.key.replace(/[^\w.-]+/g, "_")}.png`);
                    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
                }
                seen.push(st.key);
                await ev("document.getElementById('btn-next').click(); true");
                idle = 0;
                continue;
            }
            if (st.state === "done") { outcome = "done"; break; }
            if (st.state === "broken") { outcome = "broken"; error = st.err; break; }
            if (st.state === "stopped") { outcome = "stopped"; break; }
            idle++;
        }
        if (outcome !== "done" && shots) {
            const r = await s.send("Page.captureScreenshot", { format: "png" });
            fs.writeFileSync(path.join(shots, `${scn.id}__${outcome}.png`), Buffer.from(r.data, "base64"));
        }
        const pageErrors = await ev("window.__benchErrors.slice()");
        const line = { id: scn.id, outcome, secs: Math.round((Date.now() - t0) / 1000), screens: seen.length, error: error ? error.slice(0, 600) : undefined, pageErrors: pageErrors.length ? pageErrors.slice(0, 6) : undefined };
        report.push(line);
        console.log(`${outcome === "done" ? "ok  " : "FAIL"} ${scn.id} (${line.screens} screens, ${line.secs} s)${error ? `\n     ${error.split("\n").slice(0, 3).join("\n     ")}` : ""}${pageErrors.length ? `\n     page: ${pageErrors.slice(0, 3).join("\n     page: ")}` : ""}`);
    }
    const bad = report.filter((r) => r.outcome !== "done" || r.pageErrors);
    console.log(`\n${report.length - bad.length}/${report.length} clean`);
    s.close();
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
