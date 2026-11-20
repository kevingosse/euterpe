// body.js: Clawd, the default body, drawn by hand from a pose. Pure: same pose, same pixels.
// (Other bodies are data: pack.js.)
//
// Coordinates are body space (rig.js): the body spans y -24..-6 above the ground point between
// the feet. The body is 10 units wide and 6 tall with u = 3 px (the silhouette of the Claude
// Code mascot); legs 1u wide, eyes 1u × 2u.
//
// Pose fields (all optional):
//   dx, dy (px; dy < 0 is up), sq (squash; < 0 stretches), lean (shear; + leans right),
//   view (front | q | side | qback | back), flip, aL, aR (arm angles: 0 out, + up, 1.5 vertical),
//   front ('L' | 'R': draw that arm over the face), walk (leg phase), noLegs,
//   eyes (name | [left, right]), mouth, lookX, lookY (-1..1), squint (0..1), blink,
//   blush (0..1), gloom (0..1), ramp (body colours) or tint + tintK, tears,
//   emote + emoteK (0..1 pop) + emoteAge, smear (0..1), bursts ([{x, y, k}] in body space)

window.Clawd = window.Clawd || {};
(function (C) {
    "use strict";
    const { clamp, lerp, PAL, mix, bodyRamp, EYES, BLINK, SQUINT, SHADES, MOUTHS, BLUSH, BLUSH_HOT } = C;
    const { makeXf, Yrow, shear, fillRect, glyphAt, drawArm, legMotion, drawShadow, eyeName, drawTears, drawSmear } = C;

    const U = 3;
    const BODY_TOP = -24, BODY_BOT = -6, LEG_TOP = -7;

    // Drawn key views, like a cartoon model sheet — never a rotated 3D box. Every view faces
    // screen-right; flip mirrors it. Numbers in u, as in ClaudeAnimationBase's VIEWS.
    //   L, R: silhouette edges.  strip: the darker side face.  face.eyes: [x, side]; mouth / blush x.
    //   legs: [x, far].  arms: [pivotX, dir, which, layer] (layer 0 behind, 1 in front, 2 behind in shadow).
    const VIEWS = {
        front: { L: -5, R: 5, face: { eyes: [[-2.5, -1], [2.5, 1]], mouth: 0, blush: [-3.6, 3.6] },
                 legs: [[-4, 0], [-2, 0], [1, 0], [3, 0]], arms: [[-5, -1, "L", 0], [5, 1, "R", 0]] },
        q:     { L: -5, R: 5, strip: [-5, -2.4], face: { eyes: [[-0.35, -1], [3.35, 1]], mouth: 1.7, blush: [-1.2, 4.2] },
                 legs: [[-4.3, 1], [-1.8, 0], [0.8, 0], [3.3, 0]], arms: [[5, 1, "R", 2], [-5, -1, "L", 1]] },
        side:  { L: -3, R: 3, face: { eyes: [[2.15, 1]], mouth: 1.5, blush: [1.2] },
                 legs: [[-2.1, 1], [1.3, 1], [-2.6, 0], [0.9, 0]], arms: [[2.6, 0, "L", 0]] },
        qback: { L: -5, R: 5, strip: [2.4, 5], face: null,
                 legs: [[3.3, 1], [0.8, 0], [-1.8, 0], [-4.3, 0]], arms: [[-5, -1, "R", 2], [5, 1, "L", 1]] },
        back:  { L: -5, R: 5, face: null, back: true,
                 legs: [[-4, 0], [-2, 0], [1, 0], [3, 0]], arms: [[-5, -1, "R", 0], [5, 1, "L", 0]] },
    };

    // Heading in turns (0 front, .25 facing right, .5 back, -.25 facing left) -> nearest drawn view.
    function spinView(a) {
        const K = [["front", 0], ["q", 0], ["side", 0], ["qback", 0], ["back", 0], ["qback", 1], ["side", 1], ["q", 1]];
        const [view, f] = K[((Math.round(a * 8) % 8) + 8) % 8];
        return { view, flip: !!f };
    }

    function drawFace(frame, xf, o, V, ramp, t) {
        const F = V.face;
        if (!F) return;
        const flip = xf.flip;
        // blush first, under the eyes
        const b = o.blush || 0;
        if (b > 0.12) {
            for (const bx of F.blush) {
                glyphAt(frame, xf, BLUSH, bx * U, -13.5, false);
                if (b > 0.6) glyphAt(frame, xf, BLUSH_HOT, bx * U, -14, flip);
            }
        }
        if (o.eyes === "shades" && F.eyes.length > 1) {
            const cx = (F.eyes[0][0] + F.eyes[1][0]) / 2 * U;
            glyphAt(frame, xf, SHADES, cx, -18.5, flip);
        } else {
            const lx = Math.round(clamp(o.lookX || 0, -1, 1) * 1.6), ly = Math.round(clamp(o.lookY || 0, -1, 1) * 1.3);
            for (const [ex, side] of F.eyes) {
                const name = eyeName(o, side);
                let gl = EYES[name] || EYES.normal;
                const moves = gl.blink || name === "blank";   // pupils that can look around
                if ((o.squint || 0) > 0.5) gl = SQUINT;
                else if (o.blink && gl.blink) gl = BLINK;
                const mirror = gl.sym ? false : (side > 0) !== flip;
                const dx = moves ? (flip ? -lx : lx) : 0, dy = moves ? ly : 0;
                const cy = gl === BLINK ? -16 : gl === SQUINT ? -17.5 : -18;
                glyphAt(frame, xf, gl, ex * U, cy, mirror, dx, dy);
                if (o.tears && gl !== SQUINT) drawTears(frame, xf, ex * U, side, t);
            }
        }
        if (o.mouth && MOUTHS[o.mouth]) {
            const m = MOUTHS[o.mouth];
            glyphAt(frame, xf, m, F.mouth * U, -12.5 + (m.h > 3 ? 1 : 0), m.mirrorOnFlip ? flip : false);
        }
    }

    function drawGloom(frame, xf, V, g, ramp) {
        const L = V.L * U, R = V.R * U, rows = Math.round(2 + 5 * g);
        fillRect(frame, xf, L, R, BODY_TOP, BODY_TOP + rows, (u, v, W, H) =>
            mix(u === 0 || u === W - 1 ? ramp.md : ramp.base, PAL.indigo, 0.55 * g * (1 - v / (H + 1))));
        for (let x = L + 3; x < R - 2; x += 4) {
            const len = Math.round(2 + 4 * g * (0.6 + 0.4 * Math.abs(Math.sin(x * 12.9))));
            fillRect(frame, xf, x, x + 1, BODY_TOP, BODY_TOP + len, PAL.inkSoft);
        }
    }

    function drawBody(frame, xf, V, ramp, o) {
        const L = V.L * U, R = V.R * U;
        const strip = V.strip ? [V.strip[0] * U, V.strip[1] * U] : null;
        const flip = xf.flip;
        frame.part((layer) => {
            fillRect(layer, xf, L, R, BODY_TOP, BODY_BOT, (u, v, W, H) => {
                // u, v: pixel inside the body rect (u from the screen-left edge)
                const k = (u + 0.5) / W, bx = flip ? lerp(R, L, k) : lerp(L, R, k);   // body-space x of this pixel
                const inStrip = strip && bx >= strip[0] && bx < strip[1];
                const edgeR = u === W - 1, edgeL = u === 0;
                if (inStrip) {
                    if (v >= H - 3) return ramp.dk;
                    return v === 0 ? ramp.base : ramp.md;
                }
                if (v >= H - 3) return (v === H - 3 && (u + v) % 2 === 0) ? ramp.base : ramp.md;   // belly shade, dithered edge
                if (v === 0) return edgeR ? ramp.base : ramp.lt;                                      // rim light on top
                if (edgeR && !V.back) return ramp.md;                                                 // form shadow on the right
                if (V.back) return edgeL ? ramp.lt : ramp.base;
                // a soft highlight up-left
                if (v <= 2 && u >= 2 && u < Math.round(W * 0.42)) return v === 1 && u >= 3 && u < Math.round(W * 0.3) ? ramp.hi : ramp.lt;
                if (edgeL && v < H - 3) return ramp.lt;
                return ramp.base;
            });
        });
        if (strip) {
            // the seam between front and side faces
            const seamX = (V.strip[0] < 0 ? V.strip[1] : V.strip[0]) * U;
            fillRect(frame, xf, seamX - 0.5, seamX + 0.5, BODY_TOP + 1, BODY_BOT, ramp.dk);
        }
    }

    function drawLegs(frame, xf, V, ramp, o) {
        V.legs.forEach(([lx, far], i) => {
            const { h, sx } = legMotion(o, i, o.view === "side", 7);
            const x0 = lx * U + sx;
            frame.part((layer) => fillRect(layer, xf, x0, x0 + U, LEG_TOP, LEG_TOP + Math.round(h),
                (u, v) => (far ? ramp.far : (u === 0 && v < 2 ? ramp.md : ramp.dk))));
        });
    }

    // One frame of Clawd standing at ground point (gx, gy) of the frame, in pose o, at time t.
    function drawClawd(frame, gx, gy, o, t = 0) {
        const V = VIEWS[o.view] || VIEWS.front;
        const ramp = o.ramp || bodyRamp(o.tint, o.tintK);
        const xf = makeXf(gx, gy, o);
        const armAngle = (which) => (which === "L" ? o.aL ?? 0.15 : o.aR ?? 0.15);
        const inFront = (arm) => arm[3] === 1 || o.front === arm[2];
        const tips = {};

        if (!o.noShadow) drawShadow(frame, gx, gy, o, (V.R - V.L) * U);
        if ((o.smear || 0) > 0.15) drawSmear(frame, xf, V.L * U, V.R * U, [-21, -16, -11], o, ramp);
        for (const arm of V.arms) {
            if (!inFront(arm)) tips[arm[2]] = drawArm(frame, xf, arm[0] * U, arm[1], armAngle(arm[2]), ramp, arm[3] === 2);
        }
        if (!o.noLegs) drawLegs(frame, xf, V, ramp, o);
        drawBody(frame, xf, V, ramp, o);
        if ((o.gloom || 0) > 0.03) drawGloom(frame, xf, V, o.gloom, ramp);
        drawFace(frame, xf, o, V, ramp, t);
        for (const arm of V.arms) {
            if (inFront(arm)) tips[arm[2]] = drawArm(frame, xf, arm[0] * U, arm[1], armAngle(arm[2]), ramp, false, true);
        }
        return {
            // where things attach, in frame pixels: the top of the head and the upper corner
            head: { x: xf.ox, y: Yrow(xf, BODY_TOP) },
            corner: { x: xf.ox + (xf.flip ? -1 : 1) * (V.R * U + 3) * xf.sx + shear(xf, Yrow(xf, BODY_TOP)), y: Yrow(xf, BODY_TOP) },
            tips,
            xf,
        };
    }

    // A body the stage can wear (pack.js makes the others): how to draw it, its colours, and where
    // its head and eyes are at rest, for the speech bubble, the notes badge and the gaze.
    const CLAWD = {
        id: "clawd", name: "Clawd", draw: drawClawd, ramp: C.CLAWD_RAMP,
        top: BODY_TOP, eyeY: -18, halfWidth: 15,
    };
    C.mascot = CLAWD;
    function useMascot(m) { C.mascot = m || CLAWD; }

    Object.assign(C, { U, VIEWS, spinView, drawClawd, BODY_TOP, BODY_BOT, CLAWD, useMascot });
})(window.Clawd);
