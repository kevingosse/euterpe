// rig.js: the kit every body is drawn with. The pose's transform (squash, lean, flip, all
// pivoting at the ground point between the feet), rects and glyphs placed through it, and the
// parts most bodies share: arms, legs, the shadow, tears, speed lines. Clawd (body.js) and the
// mascots made of data (pack.js) are both built from these.
//
// Body space: continuous "art pixels" relative to the ground point, x right, y DOWN (a body
// stands at y < 0). A pixel p covers [p, p+1), which keeps mirrored geometry mirrored.

window.Clawd = window.Clawd || {};
(function (C) {
    "use strict";
    const { sround, clamp, mix, PAL, drawGlyph } = C;

    // The transform from body space to frame pixels for one pose.
    function makeXf(gx, gy, o) {
        const sq = o.sq || 0;
        return {
            ox: gx + Math.round(o.dx || 0),
            oy: gy + Math.round(o.dy || 0),
            sx: 1 + sq * 0.6,
            sy: 1 - sq,
            lean: o.lean || 0,
            flip: !!o.flip,
        };
    }
    const Yrow = (xf, y) => Math.round(xf.oy + sround(y * xf.sy));
    // Horizontal shear for a frame row (a lean pivots at the feet).
    const shear = (xf, row) => sround(-(row + 0.5 - xf.oy) * xf.lean);
    const Xcol = (xf, x) => (xf.flip ? -x : x) * xf.sx;

    // Fill a body-space rect [x0, x1) × [y0, y1) with a colour function (px, py, u, v) -> hex|null
    // where u, v are the row/column indexes inside the rect (0-based, in pixels).
    function fillRect(target, xf, x0, x1, y0, y1, color) {
        const Y0 = Yrow(xf, y0), Y1 = Yrow(xf, y1);
        let a = sround(Xcol(xf, x0)), b = sround(Xcol(xf, x1));
        if (a > b) [a, b] = [b, a];
        const W = b - a, H = Y1 - Y0;
        for (let py = Y0; py < Y1; py++) {
            const off = shear(xf, py);
            for (let px = a; px < b; px++) {
                const hex = typeof color === "function" ? color(px - a, py - Y0, W, H) : color;
                if (hex) target.px(Math.round(xf.ox) + px + off, py, hex);
            }
        }
        return { a, b, Y0, Y1 };
    }

    // Place a glyph centred on body-space (cx, cy) — features ride the squash without resampling.
    function glyphAt(frame, xf, glyph, cx, cy, mirror, dxPx = 0, dyPx = 0) {
        const X = Xcol(xf, cx), top = Yrow(xf, cy) - Math.floor(glyph.h / 2) + dyPx;
        const left = Math.round(xf.ox) + sround(X - glyph.w / 2) + shear(xf, top + glyph.h / 2) + dxPx;
        if (glyph.ring) frame.part((L) => drawGlyph(L, glyph, left, top, mirror));
        else drawGlyph(frame, glyph, left, top, mirror);
    }

    // Clawd's arms; a mascot brings its own measurements.
    const ARM = { y: -14, len: 7, half: 1.45 };

    // An arm as a thick rotated bar from its pivot (pivotX, arm.y), angle 0 straight out and 1.5
    // straight up. Rasterised in frame space, so it doesn't squash.
    function drawArm(frame, xf, pivotX, dir, angle, ramp, shadow, over, arm = ARM) {
        const flipK = xf.flip ? -1 : 1;
        const lift = clamp((Math.abs(angle) - 0.7) / 0.9);   // raised arms stand beside the body
        const px0 = Xcol(xf, pivotX + dir * 1.6 * lift) , py0 = sround(arm.y * xf.sy) + 0.5;
        const pxf = xf.ox + px0 + shear(xf, xf.oy + py0);
        const pyf = xf.oy + py0;
        let dxv, dyv;
        if (dir === 0) {   // side view: the near arm reaches forward, a raises it
            const a = 0.55 - angle;
            dxv = Math.cos(a) * flipK; dyv = Math.sin(a);
        } else {
            dxv = Math.cos(angle) * dir * flipK; dyv = -Math.sin(angle);
        }
        const sx = pxf - dxv * 1.2, sy = pyf - dyv * 1.2;   // root tucked into the body
        const len = arm.len + 1.2;
        const nx = -dyv, ny = dxv;
        const out = (dir || 1) * flipK;   // screen direction of "outward"
        // an arm crossing in front of the body is lit, so it reads as a limb and not a scribble
        const col = shadow ? mix(ramp.base, ramp.md, 0.55) : over ? ramp.lt : ramp.base;
        const shade = shadow ? ramp.dk : over ? ramp.base : ramp.md;
        frame.part((L) => {
            const x0 = Math.floor(Math.min(sx, sx + dxv * len) - 3), x1 = Math.ceil(Math.max(sx, sx + dxv * len) + 3);
            const y0 = Math.floor(Math.min(sy, sy + dyv * len) - 3), y1 = Math.ceil(Math.max(sy, sy + dyv * len) + 3);
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const rx = x + 0.5 - sx, ry = y + 0.5 - sy;
                    const t = rx * dxv + ry * dyv, s = rx * nx + ry * ny;
                    if (t < 0 || t > len || Math.abs(s) > arm.half) continue;
                    // shade the half facing down (or outward, for a raised arm)
                    const lower = s * ny + 0.35 * s * nx * out;
                    L.px(x, y, lower > 0.5 ? shade : col);
                }
            }
        });
        return { x: sx + dxv * len, y: sy + dyv * len };
    }

    // How leg i moves in this pose: its height (h0 standing) and sideways swing, walking or dangling.
    function legMotion(o, i, sideView, h0) {
        let h = h0, sx = 0;
        if (o.walk != null) {
            if (sideView) {
                const ph = (o.walk + [0, 0.5, 0.5, 0][i % 4]) * C.TAU;
                sx = Math.sin(ph) * 1.7;
                h = h0 - Math.max(0, Math.cos(ph)) * 2.4;
            } else {
                const ph = Math.sin((o.walk + (i % 2 ? 0.5 : 0)) * C.TAU);
                if (ph > 0) h = h0 - ph * 2.6;
            }
        }
        if (o.dangle) {   // hanging from the cursor: legs swing and stretch
            const ph = Math.sin(o.dangle * C.TAU + i * 1.3);
            sx = ph * 0.9 * (o.swing || 1);
            h = h0 + 1;
        }
        return { h: Math.max(1, h), sx };
    }

    // A soft shadow under a body `width` pixels wide; it shrinks and fades as the body lifts off.
    function drawShadow(frame, gx, gy, o, width) {
        const lift = clamp(-(o.dy || 0) / 18);
        const w = (width + 6) * (1 + (o.sq || 0) * 0.6) * (1 - lift * 0.45);
        const cx = gx + (o.dx || 0), a = 70 * (1 - lift * 0.6);
        for (let row = 0; row < 3; row++) {
            const half = (w / 2) * (row === 1 ? 1 : 0.78);
            for (let x = Math.round(cx - half); x < Math.round(cx + half); x++) frame.blend(x, gy - 1 + row, PAL.ink, a);
        }
    }

    // The eye glyph for one side: a name, a pair, or the wink.
    function eyeName(o, side) {
        const e = o.eyes;
        if (Array.isArray(e)) return e[side < 0 ? 0 : 1];
        if (e === "wink") return side < 0 ? "happy" : "normal";
        return e || "normal";
    }

    // A stream of tears from under an eye at ex, from row y0 down to row y1.
    function drawTears(frame, xf, ex, side, t, y0 = -15, y1 = -7) {
        const X = Math.round(xf.ox) + sround(Xcol(xf, ex + side * 0.5)) - 1;
        const Y0 = Yrow(xf, y0), Y1 = Yrow(xf, y1);
        for (let y = Y0; y < Y1; y++) {
            const wig = Math.round(Math.sin(t * 9 + y * 0.9 + side) * 0.6);
            frame.put(X + wig, y, PAL.sky);
            frame.put(X + 1 + wig, y, PAL.sky);
        }
        const k = (t * 1.6 + (side > 0 ? 0.5 : 0)) % 1;   // a drop running down the stream
        frame.put(X, Math.round(C.lerp(Y0, Y1, k)), PAL.cream);
    }

    // Speed lines beside a body spanning [left, right), on the given rows (a spin, a dash).
    function drawSmear(frame, xf, left, right, rows, o, ramp) {
        const k = clamp(o.smear || 0), dir = o.smearDir ?? (o.flip ? -1 : 1);
        const sides = dir === 0 ? [-1, 1] : [-dir];
        for (const s of sides) {
            rows.forEach((y, i) => {
                const len = Math.round((4 + 4 * C.hash(i + 7 * s)) * k);
                const x0 = s > 0 ? right + 1 : left - 1 - len;
                fillRect(frame, { ...xf, flip: false }, x0, x0 + len, y, y + 1, i === 1 ? PAL.ink : ramp.base);
            });
        }
    }

    Object.assign(C, { makeXf, Yrow, shear, Xcol, fillRect, glyphAt, ARM, drawArm, legMotion, drawShadow, eyeName, drawTears, drawSmear });
})(window.Clawd);
