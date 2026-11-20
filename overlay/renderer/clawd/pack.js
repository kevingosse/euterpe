// pack.js: bodies made of data. A mascot pack (mascot.json, see docs/mascots.md) draws its body
// from rows of pixels and says where the face, arms and legs go; everything that moves it —
// expressions, gestures, reflexes, emotes — is the engine that moves Clawd. A pack is data,
// never code: one a stranger shared can't run anything.

window.Clawd = window.Clawd || {};
(function (C) {
    "use strict";
    const { clamp, lerp, mix, sround, PAL, GLYPH_KEY, EYES, BLINK, SQUINT, MOUTHS, BLUSH, BLUSH_HOT, makeRamp } = C;
    const { makeXf, Yrow, shear, glyphAt, fillRect, drawArm, legMotion, drawShadow, eyeName, drawTears, drawSmear } = C;

    const MAX_W = 48, MAX_H = 40, MAX_TALL = 46;   // the stage is 80 × 64 art pixels, emotes included
    // The body's own shades: a mood tints them (love goes pink, sadness blue).
    const ROLES = { B: "base", L: "lt", H: "hi", M: "md", D: "dk", F: "far" };
    const FIXED = "icbrRdyYkKvgG";   // the glyphs' colours (glyphs.js), never tinted
    const VIEWS = ["front", "side", "back"];
    // A view the pack doesn't draw borrows the nearest one it does.
    const FALLBACK = { front: ["front"], q: ["front"], side: ["side", "front"], qback: ["back", "side", "front"], back: ["back", "front"] };
    const HEX = /^#[0-9a-f]{6}$/i;
    const BROW_INK = "#5A5068";   // a soft ink: dark on a light editor, still there on a dark one
    // Sunglasses for any face: a lens over each eye, a bar across (Clawd's are drawn as one piece).
    const LENS = { rows: ["iiiiiiiii", "icciiiiii", ".iiiiiii.", "..iiiii.."], w: 9, h: 4 };

    // Brows: how high each column sits (rows, + is down), from the outer end to the inner one.
    const BROW_SHAPES = {
        rest: [1, 0, 0, 0, 1],
        happy: [0, -1, -1, -1, 0],
        up: [-1, -2, -2, -2, -1],
        low: [1, 1, 1, 1, 1],
        worried: [1, 1, 0, -1, -2],
        angry: [-1, -1, 0, 1, 2],
    };
    // What the brows do in each mood, as [left, right] where they differ (a raised eyebrow)...
    const BROWS_BY_MOOD = {
        neutral: "rest", reading: "rest", happy: "happy", laugh: "happy", excited: "up", love: "happy",
        proud: "happy", smug: ["low", "up"], mischief: "angry", playful: ["up", "low"], wink: ["low", "up"],
        thinking: ["rest", "up"], curious: ["rest", "up"], idea: "up", confused: ["low", "up"], surprised: "up",
        concerned: "worried", sad: "worried", shy: "worried", sleepy: "low", bored: "low", determined: "angry",
        cool: "rest", dizzy: "worried",
    };
    // ...and what the eyes say when a gesture or a reflex has changed them (a facepalm, a startle).
    const BROWS_BY_EYES = {
        normal: "rest", dot: "rest", wide: "up", blank: "up", shine: "up", spark: "up", heart: "happy", happy: "happy",
        closed: "happy", sleepy: "low", narrow: "low", squeeze: "angry", angry: "angry", determined: "angry",
        sad: "worried", x: "worried", swirl: "worried",
    };

    class PackError extends Error {
        constructor(problems) {
            super(problems.join("\n"));
            this.problems = problems;
        }
    }

    // ---------- checking and compiling ----------

    // A pack (parsed JSON) -> a body the stage can wear (like C.CLAWD). Throws a PackError listing
    // every problem, each with where it is, so an author (or an agent) can fix them in one go.
    function compileMascot(pack, id = "pack") {
        const problems = [];
        const bad = (msg) => { problems.push(msg); };
        if (!pack || typeof pack !== "object" || Array.isArray(pack)) throw new PackError(["A mascot is a JSON object."]);
        const str = (key, max, required) => {
            const v = pack[key];
            if (v == null || v === "") { if (required) bad(`"${key}" is missing.`); return ""; }
            if (typeof v !== "string") { bad(`"${key}" should be a string.`); return ""; }
            if (v.length > max) bad(`"${key}" is ${v.length} characters; at most ${max}.`);
            return v.slice(0, max);
        };
        if (pack.format != null && pack.format !== 1) bad(`"format" is ${JSON.stringify(pack.format)}; this Euterpe reads format 1.`);
        const name = str("name", 40, true), description = str("description", 200, false), body = str("body", 280, false);

        // colours: the body's shades (B required) and the pack's own (digits)
        const colors = pack.colors && typeof pack.colors === "object" ? pack.colors : (bad(`"colors" is missing: at least "B", the body's main colour.`), {});
        const palette = {};
        for (const [k, v] of Object.entries(colors)) {
            if (!(k in ROLES) && !/^[0-9]$/.test(k)) { bad(`colors."${k}": the keys are B L H M D F (the body's shades) and 0-9 (your own colours).`); continue; }
            if (typeof v !== "string" || !HEX.test(v)) { bad(`colors."${k}" is ${JSON.stringify(v)}; colours are "#RRGGBB".`); continue; }
            palette[k] = v;
        }
        const B = palette.B || "#999999";
        if (pack.colors && colors.B == null) bad(`colors."B" is missing: the body's main colour.`);
        const ramp = {
            base: B,
            lt: palette.L || mix(B, "#FFFFFF", 0.3),
            hi: palette.H || mix(B, "#FFFFFF", 0.55),
            md: palette.M || mix(B, PAL.ink, 0.2),
            dk: palette.D || mix(B, PAL.ink, 0.38),
            far: palette.F || null,
        };
        const outline = pack.outline === false ? null : pack.outline == null ? PAL.ink
            : typeof pack.outline === "string" && HEX.test(pack.outline) ? pack.outline
            : (bad(`"outline" should be a "#RRGGBB" colour, or false for none.`), PAL.ink);

        const legs = limbs(pack.legs, "legs", { width: [1, 6], height: [1, 10] }, bad);
        const arms = limbs(pack.arms, "arms", { y: [0, MAX_H], length: [2, 12], thickness: [1, 4] }, bad);
        const brows = browSpec(pack.brows, bad);
        const float = pack.float === true ? 3 : pack.float == null || pack.float === false ? 0
            : typeof pack.float === "number" && pack.float >= 0 && pack.float <= 8 ? pack.float
            : (bad(`"float" should be true, or a hover height from 0 to 8 pixels.`), 0);

        const views = {};
        const rawViews = pack.views && typeof pack.views === "object" ? pack.views : {};
        if (!rawViews.front) bad(`"views"."front" is missing: every mascot has a front view.`);
        for (const key of Object.keys(rawViews)) {
            if (!VIEWS.includes(key)) { bad(`views."${key}": the views are front, side (facing right) and back.`); continue; }
            const v = compileView(rawViews[key], key, { palette, legs, arms, float }, bad);
            if (v) views[key] = v;
        }
        if (problems.length) throw new PackError(problems);

        const front = views.front;
        const pick = (view) => views[FALLBACK[view].find((k) => views[k]) || "front"];
        const mascot = {
            id, name, description, body, ramp, outline, float, arms, legs, brows,
            top: Math.min(...Object.values(views).map((v) => v.top)),
            eyeY: front.eyes.length ? front.eyes.reduce((s, e) => s + e.y, 0) / front.eyes.length : front.top / 2,
            halfWidth: Math.ceil(front.w / 2),
            draw: (frame, gx, gy, o, t = 0) => drawPack(mascot, pick(o.view || "front"), frame, gx, gy, o, t),
        };
        return mascot;
    }

    // An optional limb spec ({ …numbers, front: [[x, n]…], side, back }), its numbers range-checked.
    function limbs(spec, key, ranges, bad) {
        if (spec == null || spec === false) return null;
        if (typeof spec !== "object") { bad(`"${key}" should be an object.`); return null; }
        const out = { front: spec.front, side: spec.side, back: spec.back };   // checked with each view
        for (const [k, [lo, hi]] of Object.entries(ranges)) {
            const v = spec[k];
            if (v == null) { if (k !== "thickness") bad(`${key}."${k}" is missing.`); continue; }
            if (typeof v !== "number" || v < lo || v > hi) { bad(`${key}."${k}" is ${JSON.stringify(v)}; it should be a number from ${lo} to ${hi}.`); continue; }
            out[k] = v;
        }
        return out;
    }

    // Optional brows: true, or { above, width, color }, each with a default.
    function browSpec(spec, bad) {
        if (spec == null || spec === false) return null;
        if (spec !== true && (typeof spec !== "object" || Array.isArray(spec))) { bad(`"brows" should be true, or an object: { "above": 6, "width": 5, "color": "#5A5068" }.`); return null; }
        const s = spec === true ? {} : spec;
        const num = (k, lo, hi, dflt) => {
            if (s[k] == null) return dflt;
            if (typeof s[k] === "number" && Number.isInteger(s[k]) && s[k] >= lo && s[k] <= hi) return s[k];
            bad(`brows."${k}" is ${JSON.stringify(s[k])}; it should be a whole number from ${lo} to ${hi}.`);
            return dflt;
        };
        const above = num("above", 3, 16, 6), width = num("width", 3, 9, 5);
        const color = s.color == null ? BROW_INK : typeof s.color === "string" && HEX.test(s.color) ? s.color
            : (bad(`brows."color" should be a "#RRGGBB" colour.`), BROW_INK);
        return { above, width, color };
    }

    function point(v, where, bad, shape = "[x, y]") {
        if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n))) return v;
        bad(`${where} should be ${shape}, two numbers.`);
        return null;
    }

    function compileView(raw, key, pk, bad) {
        const at = `views.${key}`;
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.rows)) { bad(`${at}.rows is missing: the body, as rows of pixels.`); return null; }
        const rows = raw.rows;
        if (!rows.length || rows.length > MAX_H) { bad(`${at}.rows has ${rows.length} rows; from 1 to ${MAX_H}.`); return null; }
        if (!rows.every((r) => typeof r === "string")) { bad(`${at}.rows should be strings, one per row.`); return null; }
        const w = Math.max(...rows.map((r) => r.length)), h = rows.length;
        if (w > MAX_W) { bad(`${at}.rows are ${w} pixels wide; at most ${MAX_W}.`); return null; }
        const legH = pk.legs ? pk.legs.height : 0;
        if (h + legH > MAX_TALL) bad(`${at}: ${h} rows of body and ${legH} of legs make ${h + legH}; at most ${MAX_TALL} in all.`);

        // the ground point, in sprite pixels: under the middle of the body, below the legs
        const ground = raw.ground != null ? point(raw.ground, `${at}.ground`, bad) : [w / 2, h + legH];
        if (!ground) return null;
        // on a whole pixel: on a half one (the middle of an odd width), the column over it would be drawn twice
        const [gx, gy] = ground.map(Math.round);

        const cells = [];   // body-space pixels: { x, y, role | hex }
        const colTop = new Map();
        let unknown = null;
        rows.forEach((row, j) => {
            for (let i = 0; i < row.length; i++) {
                const ch = row[i];
                if (ch === "." || ch === " ") continue;
                let role = null, hex = null;
                if (ch in ROLES) role = ROLES[ch];
                else if (FIXED.includes(ch)) hex = GLYPH_KEY[ch];
                else if (/[0-9]/.test(ch) && pk.palette[ch]) hex = pk.palette[ch];
                else { unknown = unknown || { ch, j }; continue; }
                cells.push({ x: i - gx, y: j - gy, role, hex, row: j });
                if (!colTop.has(i) || j < colTop.get(i)) colTop.set(i, j);
            }
        });
        if (unknown) {
            bad(`${at}.rows[${unknown.j}] has "${unknown.ch}", which isn't a colour: . is transparent, B L H M D F are the body's shades, digits your own colours from "colors", and i c b r R d y Y k K v g G the glyph colours (ink, cream, blush…).`);
        }
        if (!cells.length) { bad(`${at}.rows are all transparent.`); return null; }
        const topRow = Math.min(...cells.map((c) => c.row));
        const xs = cells.map((c) => c.x);

        // Face anchors are points measured from the rows' top-left corner (7.5 is the middle of
        // column 7, 12 the line between columns 11 and 12), where the feature is centred.
        const toBody = ([x, y]) => ({ x: x - gx, y: y - gy });
        const inside = (p, where) => {
            if (p && (p[0] < 0 || p[1] < 0 || p[0] > w || p[1] > h)) bad(`${where} [${p}] is outside the ${w} × ${h} rows.`);
            return p;
        };
        const eyesRaw = raw.eyes == null ? [] : Array.isArray(raw.eyes) ? raw.eyes : (bad(`${at}.eyes should be a list of [x, y].`), []);
        if (key !== "back" && !eyesRaw.length) bad(`${at}.eyes is missing: where the eyes go (the back view has none).`);
        if (eyesRaw.length > 2) bad(`${at}.eyes has ${eyesRaw.length}; one or two.`);
        const eyes = eyesRaw.slice(0, 2).map((e, n) => inside(point(e, `${at}.eyes[${n}]`, bad), `${at}.eyes[${n}]`)).filter(Boolean).map(toBody);
        // left and right, as the eye glyphs are drawn: a lone eye (a side view) is the right one
        eyes.sort((a, b) => a.x - b.x).forEach((e, n, all) => { e.side = all.length === 1 ? 1 : n === 0 ? -1 : 1; });
        const mouth = raw.mouth == null ? null : inside(point(raw.mouth, `${at}.mouth`, bad), `${at}.mouth`);
        const blushRaw = raw.blush == null ? [] : Array.isArray(raw.blush) ? raw.blush : (bad(`${at}.blush should be a list of [x, y].`), []);
        const blush = blushRaw.slice(0, 2).map((b, n) => inside(point(b, `${at}.blush[${n}]`, bad), `${at}.blush[${n}]`)).filter(Boolean).map(toBody);

        const place = (spec, where, shape, mapper) => {
            if (!spec) return [];
            const list = spec[key];
            if (list == null) return [];
            if (!Array.isArray(list)) { bad(`${where}.${key} should be a list of [x, n].`); return []; }
            return list.slice(0, 6).map((p, n) => point(p, `${where}.${key}[${n}]`, bad, shape)).filter(Boolean).map(mapper);
        };
        const legs = place(pk.legs, "legs", "[x, far]", ([x, far]) => ({ x: x - gx, far: !!far }));
        const arms = place(pk.arms, "arms", "[x, dir]", ([x, dir]) => {
            const d = Math.sign(dir);
            return { x: x + 0.5 - gx, dir: d, which: key === "back" ? (d < 0 ? "R" : "L") : d > 0 ? "R" : "L" };
        });

        return {
            w, h, cells, eyes, blush, legs, arms,
            mouth: mouth && toBody(mouth),
            top: topRow - gy,
            bottom: h - gy,
            left: Math.min(...xs), right: Math.max(...xs) + 1,
            armY: pk.arms ? pk.arms.y + 0.5 - gy : 0,
            legTop: h - gy,
            // each column's first row, for the gloom's drips
            colTops: [...colTop.entries()].map(([i, j]) => ({ x: i - gx, y: j - gy })).sort((a, b) => a.x - b.x),
        };
    }

    // ---------- drawing ----------

    function drawPack(m, V, frame, gx, gy, o, t) {
        const ramp = o.ramp || makeRamp(m.ramp, o.tint, o.tintK);
        // a floating body hovers above its shadow, bobbing gently
        const hover = m.float ? m.float + Math.sin(t * 2.4) * 0.8 : 0;
        const xf = makeXf(gx, gy - Math.round(hover), o);
        const armSpec = m.arms;
        const arm = armSpec && { y: V.armY, len: armSpec.length, half: (armSpec.thickness ?? 3) / 2 - 0.05 };
        const armAngle = (which) => (which === "L" ? o.aL ?? 0.15 : o.aR ?? 0.15);
        const tips = {};

        if (!o.noShadow) drawShadow(frame, gx, gy, { ...o, dy: (o.dy || 0) - hover }, V.right - V.left);
        if ((o.smear || 0) > 0.15) drawSmear(frame, xf, V.left, V.right, [0.15, 0.4, 0.65].map((k) => Math.round(V.top + (V.bottom - V.top) * k)), o, ramp);
        if (arm) {
            for (const a of V.arms) if (o.front !== a.which) tips[a.which] = drawArm(frame, xf, a.x, a.dir, armAngle(a.which), ramp, false, false, arm);
        }
        if (m.legs && !o.noLegs) {
            V.legs.forEach((l, i) => {
                const { h, sx } = legMotion(o, i, o.view === "side", m.legs.height);
                const x0 = l.x + sx;
                frame.part((L) => fillRect(L, xf, x0, x0 + m.legs.width, V.legTop, V.legTop + Math.round(h),
                    (u, v) => (l.far ? ramp.far : u === 0 && v < 2 ? ramp.md : ramp.dk)), m.outline);
            });
        }
        drawBody(frame, xf, V, ramp, o, m.outline);
        if (m.brows) drawBrows(frame, xf, o, V, m.brows, m.outline);
        drawFace(frame, xf, o, V, t);
        if (arm) {
            for (const a of V.arms) if (o.front === a.which) tips[a.which] = drawArm(frame, xf, a.x, a.dir, armAngle(a.which), ramp, false, true, arm);
        }
        const dirK = xf.flip ? -1 : 1;
        return {
            head: { x: xf.ox, y: Yrow(xf, V.top) },
            corner: { x: xf.ox + dirK * (m.halfWidth + 3) * xf.sx + shear(xf, Yrow(xf, V.top)), y: Yrow(xf, V.top) },
            tips,
            xf,
        };
    }

    // The body's pixels, row by row through the pose's transform (squash, lean, flip), as one
    // outlined part. Gloom darkens the top toward indigo, as it does on Clawd.
    function drawBody(frame, xf, V, ramp, o, outline) {
        const g = o.gloom || 0, gloomRows = g > 0.03 ? Math.round(2 + 5 * g) : 0;
        const topRow = V.top;
        frame.part((L) => {
            for (const c of V.cells) {
                let hex = c.role ? ramp[c.role] : c.hex;
                if (gloomRows && c.role) {
                    const v = c.y - topRow;
                    if (v < gloomRows) hex = mix(hex, PAL.indigo, 0.55 * g * (1 - v / (gloomRows + 1)));
                }
                fillRect(L, xf, c.x, c.x + 1, c.y, c.y + 1, hex);
            }
        }, outline);
        if (gloomRows) {
            // the drips of a cloud of gloom
            for (const top of V.colTops) {
                if ((Math.round(top.x - V.left) - 3) % 4 !== 0 || top.x < V.left + 3 || top.x > V.right - 3) continue;
                const len = Math.round(2 + 4 * g * (0.6 + 0.4 * Math.abs(Math.sin(top.x * 12.9))));
                fillRect(frame, xf, top.x, top.x + 1, top.y, top.y + len, PAL.inkSoft);
            }
        }
    }

    // Brows above the eyes, in the mood's shape, as one outlined part in their own colour. A
    // mascot without a mouth talks with them.
    function drawBrows(frame, xf, o, V, spec, outline) {
        if (!V.eyes.length) return;
        const E = C.EXPR && C.EXPR[o.expr];
        const own = !!E && o.eyes === E.eyes;   // the mood's own eyes, not ones a gesture put on
        const lift = !V.mouth && o.speaking ? 1 : 0;
        frame.part((L) => {
            for (const e of V.eyes) {
                let name = (o.squint || 0) > 0.5 ? "low" : own ? BROWS_BY_MOOD[o.expr] : BROWS_BY_EYES[eyeName(o, e.side)];
                if (Array.isArray(name)) name = name[e.side < 0 ? 0 : 1];
                const shape = BROW_SHAPES[name] || BROW_SHAPES.rest;
                const w = spec.width, left = sround(e.x - w / 2), y0 = e.y - spec.above - lift;
                for (let i = 0; i < w; i++) {
                    const k = (i / (w - 1)) * (shape.length - 1), j = Math.floor(k);
                    const dy = Math.round(lerp(shape[j], shape[Math.min(j + 1, shape.length - 1)], k - j));
                    // the outer end first: left of the left eye, right of the right one
                    const x = e.side < 0 ? left + i : left + w - 1 - i;
                    fillRect(L, xf, x, x + 1, y0 + dy, y0 + dy + 2, spec.color);
                }
            }
        }, outline);
    }

    function drawFace(frame, xf, o, V, t) {
        if (!V.eyes.length) return;
        const flip = xf.flip;
        const b = o.blush || 0;
        if (b > 0.12) {
            for (const p of V.blush) {
                glyphAt(frame, xf, BLUSH, p.x, p.y, false);
                if (b > 0.6) glyphAt(frame, xf, BLUSH_HOT, p.x, p.y - 0.5, flip);
            }
        }
        if (o.eyes === "shades") {
            const y = V.eyes[0].y;
            if (V.eyes.length > 1) {
                const x0 = V.eyes[0].x - 7.5, x1 = V.eyes[V.eyes.length - 1].x + 7.5;
                fillRect(frame, xf, x0, x1, y - 3, y - 2, PAL.ink);
            }
            for (const e of V.eyes) glyphAt(frame, xf, LENS, e.x, y, flip);
        } else {
            const lx = Math.round(clamp(o.lookX || 0, -1, 1) * 1.6), ly = Math.round(clamp(o.lookY || 0, -1, 1) * 1.3);
            for (const e of V.eyes) {
                const name = eyeName(o, e.side);
                let gl = EYES[name] || EYES.normal;
                const moves = gl.blink || name === "blank";
                if ((o.squint || 0) > 0.5) gl = SQUINT;
                else if (o.blink && gl.blink) gl = BLINK;
                const mirror = gl.sym ? false : (e.side > 0) !== flip;
                const dx = moves ? (flip ? -lx : lx) : 0, dy = moves ? ly : 0;
                const cy = gl === BLINK ? e.y + 2 : gl === SQUINT ? e.y + 0.5 : e.y;
                glyphAt(frame, xf, gl, e.x, cy, mirror, dx, dy);
                if (o.tears && gl !== SQUINT) drawTears(frame, xf, e.x, e.side, t, e.y + 3, V.bottom - 1);
            }
        }
        if (o.mouth && MOUTHS[o.mouth] && V.mouth) {
            const m = MOUTHS[o.mouth];
            glyphAt(frame, xf, m, V.mouth.x, V.mouth.y + (m.h > 3 ? 1 : 0), m.mirrorOnFlip ? flip : false);
        }
    }

    Object.assign(C, { compileMascot, PackError, MASCOT_LIMITS: { MAX_W, MAX_H, MAX_TALL } });
})(window.Clawd);
