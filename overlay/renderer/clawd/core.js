// core.js: the pixel engine under Clawd. Math helpers, the palette, and a tiny
// pixel buffer with per-part outlines. Everything is drawn at logical
// resolution (one array cell = one art pixel) and scaled up with nearest
// neighbour at the very end, so the art stays crisp at any size.
//
// The acting vocabulary (timing helpers, takes, springs) follows the
// principles of JohnHeibel/ClaudeAnimationBase (MIT): faces act instead of
// snapping, anticipation before big moves, overshoot and settle after.

window.Clawd = window.Clawd || {};
(function (C) {
    "use strict";

    // ---------- math ----------
    const TAU = Math.PI * 2;
    const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
    const lerp = (a, b, k) => a + (b - a) * k;
    const seg = (t, a, b) => clamp((t - a) / (b - a));
    const frac = (x) => x - Math.floor(x);
    const ease = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
    const easeIn = (x) => Math.pow(clamp(x), 3);
    const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);
    const backOut = (x) => { x = clamp(x); const s = 1.9; return 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); };
    // Stable pseudo-random in [0, 1) for an integer-ish key: blink schedules, fidgets, sparkles.
    const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    // Symmetric rounding: sround(-2.5) = -3, so mirrored geometry stays mirrored in pixels.
    const sround = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
    // Damped wobble kicked at t0 (settles, follow-through).
    const spring = (t, t0, k = 6, w = 18) => (t < t0 ? 0 : Math.exp(-k * (t - t0)) * Math.sin(w * (t - t0)));
    const wob = (t, period, phase = 0) => Math.sin((t / period + phase) * TAU);

    // A hop that takes off at t0 and lands at t1, h px high: crouch, stretch, arc, squash-land, settle.
    function jump(t, t0, t1, h) {
        if (t < t0 - 0.12) return { dy: 0, sq: 0 };
        if (t < t0) return { dy: 0, sq: 0.18 * ease(seg(t, t0 - 0.12, t0)) };
        if (t < t1) { const k = (t - t0) / (t1 - t0); return { dy: -h * 4 * k * (1 - k), sq: -0.14 * Math.abs(1 - 2 * k) }; }
        const a = t - t1;
        return { dy: 0, sq: 0.22 * Math.exp(-8 * a) * Math.cos(20 * a) };
    }
    // A surprise take peaking at t0: a quick squash, then a stretch up that springs back. amt scales it.
    function take(t, t0, amt = 1) {
        if (t < t0 - 0.1) return { sq: 0, dy: 0 };
        if (t < t0) return { sq: 0.1 * amt * ease(seg(t, t0 - 0.1, t0)), dy: 0 };
        const a = t - t0;
        return { sq: -0.2 * amt * Math.exp(-6 * a) * Math.cos(16 * a), dy: -3.2 * amt * Math.exp(-7 * a) * Math.max(0, Math.cos(9 * a)) };
    }

    // ---------- palette ----------
    // Clawd's terracotta and the soft paint palette of the animation kit; no pure black or white.
    const PAL = {
        ink: "#2B2233", inkSoft: "#4A3D52",
        clay: "#D97757", clayLt: "#E8906E", clayHi: "#F4AE8E", clayMd: "#C4623F", clayDk: "#A84D33",
        cream: "#FFF5E2", paper: "#F3EBDC",
        rose: "#E27A92", blush: "#F49AAB", red: "#E2476E", mouth: "#5A2230",
        ochre: "#E8AA38", yellow: "#FFE27A",
        sky: "#8EC3E6", skyDk: "#5E93C4", indigo: "#2F3C7A", violet: "#9A7BD0",
        grey: "#B4B8CF", greyDk: "#7C809C", sap: "#6E9F58", teal: "#3A9C98",
    };
    const TINT = { pale: "#F6E6D2", flush: "#E23E36", blue: "#6D86BE", rosy: "#EF8EA8", green: "#98B25E", gold: "#F0BE46" };

    function hexToRgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function rgbToHex(r, g, b) {
        return "#" + ((1 << 24) + (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b)).toString(16).slice(1);
    }
    function mix(a, b, k) {
        const A = hexToRgb(a), B = hexToRgb(b), t = clamp(k);
        return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
    }
    // Packed little-endian ABGR, the layout ImageData expects through a Uint32Array view.
    const packCache = new Map();
    function pack(hex, a = 255) {
        const key = hex + a;
        let v = packCache.get(key);
        if (v === undefined) {
            const [r, g, b] = hexToRgb(hex);
            v = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
            if (packCache.size > 4096) packCache.clear();   // colour cross-fades mint new mixes all day
            packCache.set(key, v);
        }
        return v;
    }

    // A body's colours for a mood: base, light, highlight, mid shade, dark (legs), far (legs
    // behind), from the body's own ramp (Clawd's terracotta, or a mascot's) tinted toward the mood.
    function makeRamp(own, tint, tintK) {
        const t = tint && (TINT[tint] || tint), k = t ? clamp(tintK ?? 1) : 0;
        const tinted = (c, w) => (k > 0 ? mix(c, t, w * k) : c);
        const dk = tinted(own.dk, 0.45);
        return {
            base: tinted(own.base, 0.55),
            lt: tinted(own.lt, 0.5),
            hi: tinted(own.hi, 0.45),
            md: tinted(own.md, 0.5),
            dk,
            far: own.far ? tinted(own.far, 0.45) : mix(dk, PAL.ink, 0.25),
        };
    }
    const CLAWD_RAMP = { base: PAL.clay, lt: PAL.clayLt, hi: PAL.clayHi, md: PAL.clayMd, dk: PAL.clayDk };
    // The colours of whichever body is on stage (C.mascot, see body.js and pack.js).
    function bodyRamp(tint, tintK) {
        return makeRamp(C.mascot ? C.mascot.ramp : CLAWD_RAMP, tint, tintK);
    }
    function mixRamp(a, b, k) {
        const out = {};
        for (const key in a) out[key] = mix(a[key], b[key], k);
        return out;
    }

    // ---------- pixel buffers ----------
    // A Layer is one part being drawn (body, an arm, an emote): colours plus a coverage mask,
    // so it can be outlined on its own before it lands on the frame. Parts composite back to
    // front and each brings its own 1px ink outline — a front arm stays readable against the
    // body, legs separate from the belly, like a hand-made sprite.
    class Layer {
        constructor(w, h) {
            this.w = w; this.h = h;
            this.col = new Uint32Array(w * h);
            this.mask = new Uint8Array(w * h);
            this.minX = w; this.minY = h; this.maxX = -1; this.maxY = -1;
        }
        clear() {
            if (this.maxX < 0) return;
            this.mask.fill(0);
            this.minX = this.w; this.minY = this.h; this.maxX = -1; this.maxY = -1;
        }
        px(x, y, hex, a = 255) {
            x |= 0; y |= 0;
            if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
            const i = y * this.w + x;
            this.col[i] = pack(hex, a);
            this.mask[i] = 1;
            if (x < this.minX) this.minX = x;
            if (x > this.maxX) this.maxX = x;
            if (y < this.minY) this.minY = y;
            if (y > this.maxY) this.maxY = y;
        }
        rect(x, y, w, h, hex, a) {
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, hex, a);
        }
        has(x, y) {
            return x >= 0 && y >= 0 && x < this.w && y < this.h && this.mask[y * this.w + x] === 1;
        }
    }

    // The frame: what the stage blits. Keeps the bounding box of opaque content for hit-testing.
    class Frame {
        constructor(w, h) {
            this.w = w; this.h = h;
            this.data = new Uint32Array(w * h);
            this.scratch = new Layer(w, h);
        }
        clear() { this.data.fill(0); }
        put(x, y, hex, a = 255) {
            x |= 0; y |= 0;
            if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
            this.data[y * this.w + x] = pack(hex, a);
        }
        px(x, y, hex, a) { this.put(x, y, hex, a); }
        // Blend a translucent pixel over what's there (soft shadows, glows).
        blend(x, y, hex, a) {
            x |= 0; y |= 0;
            if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
            const i = y * this.w + x, dst = this.data[i], da = dst >>> 24;
            if (da === 0) { this.data[i] = pack(hex, Math.round(a)); return; }
            const [r, g, b] = hexToRgb(hex), k = a / 255;
            const dr = dst & 255, dg = (dst >> 8) & 255, db = (dst >> 16) & 255;
            const oa = Math.min(255, Math.round(da + a * (1 - da / 255)));
            this.data[i] = ((oa << 24) | (Math.round(lerp(db, b, k)) << 16) | (Math.round(lerp(dg, g, k)) << 8) | Math.round(lerp(dr, r, k))) >>> 0;
        }
        // Draw a part: fn paints into a fresh layer, which is then outlined (4-neighbour ring,
        // so corners stay soft) and composited over the frame.
        part(fn, outline = PAL.ink) {
            const L = this.scratch;
            L.clear();
            fn(L);
            if (L.maxX < 0) return;
            const w = this.w, h = this.h;
            if (outline) {
                const o = pack(outline);
                const x0 = Math.max(0, L.minX - 1), x1 = Math.min(w - 1, L.maxX + 1);
                const y0 = Math.max(0, L.minY - 1), y1 = Math.min(h - 1, L.maxY + 1);
                for (let y = y0; y <= y1; y++) {
                    for (let x = x0; x <= x1; x++) {
                        const i = y * w + x;
                        if (L.mask[i]) continue;
                        if ((x > 0 && L.mask[i - 1]) || (x < w - 1 && L.mask[i + 1]) ||
                            (y > 0 && L.mask[i - w]) || (y < h - 1 && L.mask[i + w])) {
                            this.data[i] = o;
                        }
                    }
                }
            }
            for (let y = L.minY; y <= L.maxY; y++) {
                for (let x = L.minX; x <= L.maxX; x++) {
                    const i = y * w + x;
                    if (L.mask[i]) this.data[i] = L.col[i];
                }
            }
        }
        bbox() {
            let minX = this.w, minY = this.h, maxX = -1, maxY = -1;
            const d = this.data, w = this.w;
            for (let y = 0; y < this.h; y++) {
                for (let x = 0; x < w; x++) {
                    if ((d[y * w + x] >>> 24) > 100) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
        }
        alphaAt(x, y) {
            if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
            return this.data[(y | 0) * this.w + (x | 0)] >>> 24;
        }
    }

    Object.assign(C, {
        TAU, clamp, lerp, seg, frac, ease, easeIn, easeOut, backOut, hash, sround, spring, wob, jump, take,
        PAL, TINT, mix, pack, hexToRgb, CLAWD_RAMP, makeRamp, bodyRamp, mixRamp, Layer, Frame,
    });
})(window.Clawd);
