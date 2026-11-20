// emotes.js: painted reaction marks by Clawd's head — never lettering. Each pops in with
// overshoot (k: 0..1) and the looping ones run on their age (seconds since they appeared).
//   ! ? !! !? zzz sweat spark heart hearts anger bulb dots music cloud stars

window.Clawd = window.Clawd || {};
(function (C) {
    "use strict";
    const { EMOTE: E, drawGlyph, backOut, frac, hash, clamp, PAL } = C;

    // Emotes that sit over the head; the rest sit by its upper corner.
    const TOP = new Set(["cloud", "bulb", "stars"]);

    function glyph(frame, gl, cx, cy, mirror = false) {
        frame.part((L) => drawGlyph(L, gl, Math.round(cx - gl.w / 2), Math.round(cy - gl.h / 2), mirror));
    }

    function drawEmote(frame, kind, anchors, k, age, t, flip) {
        if (!kind || k < 0.08) return;
        const top = TOP.has(kind);
        const dir = flip ? -1 : 1;
        const a = top ? { x: anchors.head.x - 0.5, y: anchors.head.y - 9 } : { x: anchors.corner.x + dir * 2, y: anchors.corner.y - 3 };
        const pop = backOut(k);
        const rise = Math.round((1 - pop) * 5);            // pops up into place with overshoot
        const x = a.x, y = a.y + rise;
        const small = k < 0.4;
        switch (kind) {
            case "!": {
                const shake = age < 0.35 ? Math.round(Math.sin(age * 60) * 1) : 0;
                glyph(frame, E.bang, x + shake, y - 2);
                break;
            }
            case "?":
                glyph(frame, E.quest, x, y - 2 + Math.round(Math.sin(age * 3) * 0.6));
                break;
            case "!!":
                glyph(frame, E.bang, x - 3, y - 2);
                glyph(frame, E.bang, x + 3, y - 3);
                break;
            case "!?":
                glyph(frame, E.bang, x - 3, y - 2);
                glyph(frame, E.quest, x + 4, y - 3);
                break;
            case "zzz":
                for (let i = 0; i < 3; i++) {
                    const ph = frac(age * 0.32 + i / 3), vis = Math.sin(ph * Math.PI);
                    if (vis < 0.18) continue;
                    const gl = ph < 0.33 ? E.z3 : ph < 0.66 ? E.z4 : E.z5;
                    glyph(frame, gl, x - dir * 2 + dir * Math.round(ph * 9), y + 4 - Math.round(ph * 14));
                }
                break;
            case "sweat": {
                const slide = Math.round(frac(age * 0.45) * 3);
                glyph(frame, E.sweat, x + dir, y + 2 + slide, flip);
                break;
            }
            case "spark": {
                const tw = Math.floor(age * 5) % 3;
                glyph(frame, tw === 2 || small ? E.sparkS : E.spark, x, y - 1);
                if (!small && age > 0.25) glyph(frame, tw === 0 ? E.sparkS : E.star, x + dir * 6, y + 5);
                break;
            }
            case "heart": {
                const beat = frac(age * 1.2) < 0.18;
                glyph(frame, beat || small ? E.heartS : E.heart, x, y);
                break;
            }
            case "hearts":
                for (let i = 0; i < 3; i++) {
                    const ph = frac(age * 0.45 + i / 3), vis = Math.sin(ph * Math.PI);
                    if (vis < 0.15) continue;
                    const sway = Math.round(Math.sin(ph * 6 + i * 2) * 2);
                    glyph(frame, vis > 0.55 && i !== 1 ? E.heart : E.heartS, x + sway + dir * (i - 1) * 3, y + 4 - Math.round(ph * 16));
                }
                break;
            case "anger": {
                const beat = frac(age * 1.6) < 0.25;   // the vein throbs
                glyph(frame, E.anger, x, y - (beat ? 1 : 0));
                break;
            }
            case "bulb": {
                const on = frac(age * 2.2) < 0.75 || age < 0.5;
                if (on && !small) {
                    // a soft halo of light, then flickering rays
                    for (let dy = -8; dy <= 8; dy++) {
                        for (let dx = -8; dx <= 8; dx++) {
                            const r = Math.hypot(dx, dy * 1.1);
                            if (r < 8.5) frame.blend(Math.round(x + dx), Math.round(y - 1 + dy), PAL.yellow, 48 * (1 - r / 8.5));
                        }
                    }
                    const rays = [[-7, -3], [7, -3], [-5, -8], [5, -8], [0, -10], [-8, 2], [8, 2]];
                    rays.forEach(([rx, ry], i) => {
                        if (hash(i + Math.floor(age * 6) * 7) < 0.25) return;
                        frame.part((L) => { L.px(Math.round(x + rx), Math.round(y + ry), PAL.yellow); L.px(Math.round(x + rx * 1.15), Math.round(y + ry * 1.15), PAL.ochre); }, null);
                    });
                }
                glyph(frame, E.bulb, x, y);
                break;
            }
            case "dots": {
                const n = Math.floor(frac(age / 1.6) * 5);   // 0, 1, 2, 3 dots, then a beat of 3
                for (let i = 0; i < Math.min(3, n); i++) glyph(frame, E.dot, x - dir * 3 + dir * i * 4, y + 3);
                break;
            }
            case "music": {
                const b1 = Math.round(Math.sin(age * 5) * 1.2), b2 = Math.round(Math.sin(age * 5 + 2) * 1.2);
                glyph(frame, E.note, x, y + b1);
                if (!small) glyph(frame, E.note2, x + dir * 7, y + 5 + b2);
                break;
            }
            case "cloud": {
                const bob = Math.round(Math.sin(age * 2) * 0.7);
                for (let i = 0; i < 5; i++) {
                    const ph = frac(age * 1.8 + hash(i)), rx = Math.round(x - 4 + i * 2), ry = Math.round(y + 3 + ph * 7);
                    frame.part((L) => { L.px(rx, ry, PAL.sky); L.px(rx, ry + 1, PAL.skyDk); }, null);
                }
                glyph(frame, E.cloud, x, y + bob);
                break;
            }
            case "stars": {
                for (let i = 0; i < 3; i++) {
                    const ang = age * 4 + (i * C.TAU) / 3;
                    glyph(frame, E.star, x + Math.cos(ang) * 17, y + 7 + Math.sin(ang) * 3);
                }
                break;
            }
        }
    }

    // Small effects that aren't attached to the head: clap bursts, landing dust.
    function drawBurst(frame, x, y, k) {
        if (k <= 0 || k >= 1) return;
        const r = Math.round(2 + k * 4);
        const pts = [[0, -r], [r, 0], [-r, 0], [Math.round(r * 0.7), -Math.round(r * 0.7)], [-Math.round(r * 0.7), -Math.round(r * 0.7)]];
        frame.part((L) => { for (const [dx, dy] of pts) L.px(Math.round(x + dx), Math.round(y + dy), k < 0.5 ? PAL.yellow : PAL.ochre); }, null);
    }
    function drawDust(frame, x, y, k) {
        if (k <= 0 || k >= 1) return;
        const spread = Math.round(4 + k * 12), lift = Math.round(k * 3);
        const gl = k < 0.55 ? E.puff : E.puffS;
        for (const s of [-1, 1]) {
            frame.part((L) => drawGlyph(L, gl, Math.round(x + s * spread - gl.w / 2), Math.round(y - 2 - lift - gl.h / 2)), null);
        }
    }

    Object.assign(C, { drawEmote, drawBurst, drawDust, EMOTE_TOP: TOP });
})(window.Clawd);
