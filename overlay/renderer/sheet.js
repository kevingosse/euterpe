// Dev model sheets: grids of Clawd frames with labels, rendered by dev/render-sheet.js.
// sheet.html?sheet=<name>[:<arg>]&scale=4
//   views            the five key views + arms + walk
//   faces            every eye and mouth glyph
//   expressions      every expression, settled (t = 2.2 s after the change)
//   expr:<name>      one expression over 2 s, frame by frame
//   action:<name>    one action, frame by frame at 12 fps
//   change:<a>:<b>   an acted change from a to b, frame by frame
//   show:<name>      a director scenario (enter, exit, talk, drag, think...), frame by frame
(function () {
    "use strict";
    const C = window.Clawd;
    const params = new URLSearchParams(location.search);
    const [kind, ...rest] = (params.get("sheet") || "views").split(":");
    const S = +(params.get("scale") || 4);
    const canvas = document.getElementById("sheet");
    const ctx = canvas.getContext("2d");
    const BG = ["#1e1c22", "#e9e4dc"];

    function grid(cells, cols, cw, ch, { gx = cw / 2, gy = ch - 6, bgs = BG } = {}) {
        const rows = Math.ceil(cells.length / cols);
        const bandH = rows * (ch * S + 18);
        canvas.width = cols * cw * S;
        canvas.height = bandH * bgs.length;
        ctx.imageSmoothingEnabled = false;
        bgs.forEach((bg, b) => {
            ctx.fillStyle = bg;
            ctx.fillRect(0, b * bandH, canvas.width, bandH);
            cells.forEach((cell, i) => {
                const frame = new C.Frame(cw, ch);
                cell.draw(frame, gx, gy);
                const img = new ImageData(new Uint8ClampedArray(frame.data.buffer.slice(0)), cw, ch);
                const tmp = document.createElement("canvas");
                tmp.width = cw; tmp.height = ch;
                tmp.getContext("2d").putImageData(img, 0, 0);
                const x = (i % cols) * cw * S, y = b * bandH + Math.floor(i / cols) * (ch * S + 18);
                ctx.drawImage(tmp, x, y, cw * S, ch * S);
                ctx.fillStyle = b === 0 ? "#b9b0c6" : "#5a5064";
                ctx.font = "12px Consolas, monospace";
                ctx.fillText(cell.label || "", x + 4, y + ch * S + 13);
            });
        });
    }

    const pose = (o) => ({ eyes: "normal", aL: 0.15, aR: 0.15, ...o });

    const SHEETS = {
        views() {
            const cells = [];
            for (const view of ["front", "q", "side", "qback", "back"]) cells.push({ label: view, draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ view })) });
            for (const view of ["q", "side"]) cells.push({ label: view + " flip", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ view, flip: true })) });
            for (const a of [-1.5, -0.75, 0, 0.75, 1.5, 2.3]) cells.push({ label: "arms " + a, draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ aL: a, aR: a })) });
            for (const sq of [0.2, -0.15]) cells.push({ label: "sq " + sq, draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ sq })) });
            for (const lean of [0.12, -0.12]) cells.push({ label: "lean " + lean, draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ lean })) });
            for (let w = 0; w < 4; w++) cells.push({ label: "walk " + w / 4, draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ view: "side", walk: w / 4 })) });
            cells.push({ label: "facepalm R", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ aR: 2.45, front: "R", eyes: "closed" })) });
            cells.push({ label: "tint blue+gloom", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ tint: "blue", tintK: 0.4, gloom: 0.4, eyes: "sad", mouth: "frown" })) });
            cells.push({ label: "tint rosy", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ tint: "rosy", tintK: 0.5, eyes: "heart", mouth: "cat", blush: 0.8 })) });
            grid(cells, 6, 64, 48, { gy: 42 });
        },
        faces() {
            const cells = [];
            for (const e of Object.keys(C.EYES)) cells.push({ label: e, draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ eyes: e, noLegs: false })) });
            cells.push({ label: "wink", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ eyes: "wink", mouth: "grin" })) });
            cells.push({ label: "shades", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ eyes: "shades", mouth: "smirk" })) });
            for (const m of Object.keys(C.MOUTHS)) cells.push({ label: "m:" + m, draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ mouth: m })) });
            cells.push({ label: "blush .4", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ blush: 0.4, eyes: "happy", mouth: "smile" })) });
            cells.push({ label: "blush 1", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ blush: 1, eyes: "look", lookX: -0.8, lookY: 0.8, mouth: "wobble" })) });
            cells.push({ label: "tears", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ eyes: "squeeze", mouth: "wail", tears: true })) });
            grid(cells, 8, 48, 36, { gy: 32 });
        },
    };

    function director(fn) {
        if (!C.Director) throw new Error("Director not loaded");
        return fn;
    }

    // Frame-by-frame strip of a scripted director between t0 and t1.
    function strip(script, t0, t1, fps = 12, cols = 8, label = (t) => t.toFixed(2), bgs = BG) {
        const d = new C.Director({ seed: 3 });
        script(d);
        const cells = [];
        for (let t = t0; t <= t1 + 1e-6; t += 1 / fps) {
            const tt = t;
            cells.push({ label: label(tt), draw: (f, x, y) => d.render(f, x, y, tt) });
        }
        grid(cells, cols, 80, 64, { gy: 57, bgs });
    }

    const SCENARIOS = {
        enter: (d) => d.enter(0),
        exit: (d) => { d.enter(-10); d.exit(0.2); },
        talk: (d) => { d.enter(-10); d.setExpression("happy", -5); d.talk(0.1, 1.6); },
        think: (d) => { d.enter(-10); d.setThinking(true, 0.1); d.setThinking(false, 1.7); d.setExpression("idea", 1.7); },
        drag: (d) => { d.enter(-10); d.dragStart(0.2); for (let i = 0; i < 16; i++) d.dragMove(0.25 + i * 0.06, (i < 8 ? 1 : -1) * 700, -60); d.dragEnd(1.3); },
        shake: (d) => { d.enter(-10); d.dragStart(0.1); for (let i = 0; i < 16; i++) d.dragMove(0.12 + i * 0.05, (i % 2 ? 1 : -1) * 2400, 0); d.dragEnd(0.95); },
        boop: (d) => { d.enter(-10); d.boop(0.2); },
        wake: (d) => { d.enter(-10); d.setExpression("sleepy", -5); d.typing(true, 0.3); },
        // the README showreel (frames are cut into a GIF by dev/make-reel.py)
        reel: (d) => {
            d.enter(0);
            d.setExpression("happy", 2.6); d.play("wave", 2.6); d.talk(2.8, 1.4);
            d.setExpression("reading", 5.2); d.typing(true, 5.4); d.typing(false, 7.6);
            d.setExpression("love", 8.2); d.play("clap", 8.3);
            d.setExpression("idea", 10.8);
            d.setExpression("mischief", 12.6); d.play("facepalm", 12.8);
            d.setExpression("cool", 15.4); d.play("dance", 15.5);
            d.setExpression("sleepy", 19.4);
        },
    };

    // A mascot's model sheet (Preview Mascot, and the mind's preview_mascot tool): every view,
    // a dozen moods, gestures caught mid-way, walking, dangling, squash and stretch.
    SHEETS.mascot = () => {
        const settled = (name) => { const d = new C.Director({ seed: 1 }); d.enter(-20); d.setExpression(name, -2.2); return (f, x, y) => d.render(f, x, y, 0); };
        const acting = (name, k, expr = "happy") => {
            const d = new C.Director({ seed: 5 });
            d.enter(-20); d.setExpression(expr, -3); d.play(name, 0.1);
            const t = 0.1 + C.LEAD + C.ACTIONS[name].dur * k;
            return (f, x, y) => d.render(f, x, y, t);
        };
        const dragged = () => { const d = new C.Director({ seed: 2 }); d.enter(-20); d.dragStart(0); d.dragMove(0.3, 600, 0); return (f, x, y) => d.render(f, x, y, 0.8); };
        const cells = [
            ...["front", "q", "side", "qback", "back"].map((view) => ({ label: view, draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ view })) })),
            { label: "side, flipped", draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ view: "side", flip: true })) },
            ...["neutral", "happy", "laugh", "love", "proud", "smug", "thinking", "curious", "surprised", "sad", "sleepy", "cool"]
                .map((name) => ({ label: name, draw: settled(name) })),
            { label: "wave", draw: acting("wave", 0.45) },
            { label: "clap", draw: acting("clap", 0.4) },
            { label: "facepalm", draw: acting("facepalm", 0.5, "mischief") },
            { label: "shrug", draw: acting("shrug", 0.5) },
            { label: "jump", draw: acting("jump", 0.4) },
            { label: "cheer", draw: acting("cheer", 0.35) },
            ...[0, 0.25, 0.5, 0.75].map((w) => ({ label: `walk ${w}`, draw: (f, x, y) => C.mascot.draw(f, x, y, pose({ view: "side", walk: w })) })),
            { label: "dragged", draw: dragged() },
            { label: "squash, stretch", draw: (f, x, y) => { C.mascot.draw(f, x - 16, y, pose({ sq: 0.25 })); C.mascot.draw(f, x + 16, y, pose({ sq: -0.2 })); } },
        ];
        grid(cells, 6, 80, 64, { gy: 57 });
    };

    try {
        // a mascot pack to draw instead of Clawd, as JSON in the query
        if (params.get("mascot")) C.useMascot(C.compileMascot(JSON.parse(params.get("mascot")), "preview"));
        if (SHEETS[kind]) SHEETS[kind]();
        else if (kind === "expressions") director(() => {
            const cells = C.EXPRESSION_NAMES.map((name) => {
                const d = new C.Director({ seed: 1 });
                d.enter(-20);
                d.setExpression(name, -2.2);
                return { label: name, draw: (f, x, y) => d.render(f, x, y, 0) };
            });
            grid(cells, 6, 80, 64, { gy: 57 });
        })();
        else if (kind === "actions") director(() => {
            // every action, one row each: six moments across its duration
            const names = rest.length ? rest : C.ACTION_NAMES, cells = [];
            for (const name of names) {
                const dur = C.ACTIONS[name].dur;
                for (let i = 0; i < 6; i++) {
                    const t = 0.1 + C.LEAD + (dur * (i + 0.5)) / 6;
                    const d = new C.Director({ seed: 5 });
                    d.enter(-20);
                    d.setExpression(name === "yawn" || name === "stretch" ? "sleepy" : "happy", -3);
                    d.play(name, 0.1);
                    cells.push({ label: i === 0 ? name : (t - 0.1 - C.LEAD).toFixed(2), draw: (f, x, y) => d.render(f, x, y, t) });
                }
            }
            grid(cells, 6, 80, 64, { gy: 57, bgs: [BG[0]] });
        })();
        else if (kind === "expr") strip((d) => { d.enter(-20); d.setExpression(rest[0], 0); }, 0, 2);
        else if (kind === "action") strip((d) => { d.enter(-20); d.setExpression(rest[1] || "happy", -3); d.play(rest[0], 0.1); }, 0, (C.ACTIONS[rest[0]] || { dur: 2 }).dur + 0.3);
        else if (kind === "change") strip((d) => { d.enter(-20); d.setExpression(rest[0], -3); d.setExpression(rest[1], 0.3); }, 0, 1.2);
        else if (kind === "show") strip(SCENARIOS[rest[0]], 0, +(rest[1] || 2.4));
        else if (kind === "frames") strip(SCENARIOS[rest[0]], 0, +(rest[1] || 2.4), 12, 12, () => "", [params.get("bg") || BG[0]]);
        else if (kind === "portrait") {
            // one settled expression, no label: for pictures of the mascots (overlay/dev/readme-shots.js)
            const d = new C.Director({ seed: 4 });
            d.enter(-20); d.setExpression(rest[0] || "happy", -2.2);
            grid([{ label: "", draw: (f, x, y) => d.render(f, x, y, +(rest[1] || 0)) }], 1, 64, 52, { gy: 47, bgs: [params.get("bg") || "transparent"] });
        }
        else throw new Error("unknown sheet " + kind);
        window.sheetState = "ready";
    } catch (err) {
        window.sheetState = err instanceof C.PackError ? "invalid: " + err.message : "error: " + err.stack;
    }
})();
