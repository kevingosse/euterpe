// glyphs.js: hand-placed pixel art for Clawd's face and the painted reaction marks.
// Each glyph is a list of rows; one character = one pixel:
//   . transparent   i ink   c cream   b blush   r rose   R red   d mouth-dark
//   y ochre   Y yellow   k sky   K sky-dark   v violet   g grey   G grey-dark
// Eyes are drawn as the LEFT eye; asymmetric ones are mirrored for the right eye
// (sym: true keeps the light source — the glint — on the same side for both).

window.Clawd = window.Clawd || {};
(function (C) {
    "use strict";
    const P = C.PAL;
    const KEY = {
        i: P.ink, c: P.cream, b: P.blush, r: P.rose, R: P.red, d: P.mouth,
        y: P.ochre, Y: P.yellow, k: P.sky, K: P.skyDk, v: P.violet, g: P.grey, G: P.greyDk,
    };

    const g = (rows, opts = {}) => ({ rows, w: rows[0].length, h: rows.length, ...opts });

    // ---------- eyes (centred on the eye position) ----------
    const EYES = {
        normal: g(["iii", "cii", "iii", "iii", "iii", "iii"], { sym: true, blink: true }),
        wide: g(["iiii", "icci", "icii", "iiii", "iiii", "iiii", "iiii", "iiii"], { sym: true, blink: true }),
        happy: g([".iii.", "i...i"], { sym: true }),
        closed: g(["i...i", ".iii."], { sym: true }),
        sleepy: g(["iiiii", ".iii."], { sym: true }),
        narrow: g(["iii", "iii"], { sym: true }),
        angry: g(["i...", "iii.", "iiii", "iiii", "iiii"]),
        determined: g(["ii..", "iiii", "icii", "iiii"]),
        sad: g(["...i", ".iii", "icii", "iiii", "iiii"]),
        squeeze: g(["i..", ".i.", "..i", ".i.", "i.."]),
        shine: g([".ii.", "icci", "icii", "iiii", "iiic", ".ii."], { sym: true, blink: true }),
        spark: g(["..y..", ".yYy.", "yYcYy", ".yYy.", "..y.."], { sym: true, ring: true }),
        heart: g(["RR.RR", "RRRRR", ".RRR.", "..R.."], { sym: true, ring: true }),
        x: g(["i..i", ".ii.", ".ii.", "i..i"], { sym: true }),
        swirl: g(["iiii.", "....i", ".ii.i", "i...i", ".iii."]),
        dot: g(["ii", "ii"], { sym: true, blink: true }),
        blank: g([".iii.", "iccci", "icici", "icici", "iccci", ".iii."], { sym: true }),
    };
    // A blinking eye: a short lid line.
    const BLINK = g(["iii"], { sym: true });
    // Squinting (anticipation before a change of face): every eye becomes a line.
    const SQUINT = g(["iiiii"], { sym: true });

    // Sunglasses, drawn once across the whole face: a bar the width of the body, and two
    // lenses centred on the eyes (columns 7 and 22, 15 px apart, like the eyes themselves).
    const SHADES = g([
        "iiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
        "...iiiiiiiii......iiiiiiiii...",
        "...icciiiiii......icciiiiii...",
        "....iiiiiii........iiiiiii....",
        ".....iiiii..........iiiii.....",
    ]);

    // ---------- mouths (centred under the eyes; even widths keep them on the axis) ----------
    const MOUTHS = {
        smile: g(["i..i", ".ii."]),
        smileW: g(["i....i", ".iiii."]),
        frown: g([".ii.", "i..i"]),
        flat: g(["iiii"]),
        o: g(["ii", "ii"]),
        O: g([".ii.", "iddi", "iddi", "iddi", ".ii."]),
        open: g(["iiii", "iddi", "irri", ".ii."]),
        grin: g(["iiiiii", "iddddi", ".iiii."]),
        laugh: g(["iiiiii", "iddddi", "irrrri", ".iiii."]),
        wobble: g([".i..i.", "i.ii.i"]),
        cat: g(["i.ii.i", ".i..i."]),
        smirk: g(["...i", "iii."], { mirrorOnFlip: true }),
        tongue: g(["i....i", ".iiiri", "....r."], { mirrorOnFlip: true }),
        teeth: g(["iiiiii", "icicci", "iiiiii"]),
        pout: g([".ii.", ".ii."]),
        yawn: g([".ii.", "iddi", "iddi", "iddi", "irri", ".ii."]),
        wail: g([".i..i.", "iddddi", "irrrri", ".iiii."]),
    };

    // ---------- blush ----------
    const BLUSH = g(["bbbb"]);
    const BLUSH_HOT = g([".r.r", "r.r."]);

    // ---------- emotes (outlined as their own part) ----------
    const EMOTE = {
        bang: g(["yYy", "yYy", "yyy", ".y.", ".y.", "...", "yyy", "yyy"]),
        quest: g([".kkk.", "kk.kk", "...kk", "..kk.", "..k..", ".....", "..k..", "..k.."]),
        z5: g(["ccccc", "...cc", "..cc.", ".cc..", "ccccc"]),
        z4: g(["cccc", "..cc", ".cc.", "cccc"]),
        z3: g(["ccc", ".c.", "ccc"]),
        heart: g([".RR.RR.", "RRcRRRR", "RRRRRRR", ".RRRRR.", "..RRR..", "...R..."]),
        heartS: g(["RR.RR", "RRRRR", ".RRR.", "..R.."]),
        sweat: g([".k..", ".kk.", "kkkk", "kckk", ".kk."]),
        spark: g(["...y...", "...Y...", "..yYy..", "yYYcYYy", "..yYy..", "...Y...", "...y..."]),
        sparkS: g(["..y..", ".yYy.", "yYcYy", ".yYy.", "..y.."]),
        star: g([".y.", "yYy", ".y."]),
        bulb: g([".YYY.", "YcYYY", "YYYYY", "YYYYY", ".YYY.", ".ggg.", ".GGG.", "..G.."]),
        dot: g(["cc", "cc"]),
        note: g([".vvv", ".v.v", ".v..", "vv..", "vv.."]),
        note2: g(["vvvv", "v..v", "v..v", "v.vv", "vv.."]),
        anger: g([".R.R.", "RR.RR", ".....", "RR.RR", ".R.R."]),
        cloud: g(["..gg.gg...", ".gggggggg.", "gggggggggg", ".GGGGGGGG."]),
        puff: g([".gg.", "gggg", ".gg."]),
        puffS: g(["gg", "gg"]),
    };

    // Draw a glyph with its top-left at (x, y) into anything with px(x, y, hex) or put(x, y, hex).
    function drawGlyph(target, glyph, x, y, mirror = false, recolor = null) {
        const put = target.px ? target.px.bind(target) : target.put.bind(target);
        for (let j = 0; j < glyph.h; j++) {
            const row = glyph.rows[j];
            for (let i = 0; i < glyph.w; i++) {
                const ch = row[mirror ? glyph.w - 1 - i : i];
                if (ch === "." || ch === " ") continue;
                const hex = (recolor && recolor[ch]) || KEY[ch];
                if (hex) put(x + i, y + j, hex);
            }
        }
    }

    Object.assign(C, { GLYPH_KEY: KEY, EYES, BLINK, SQUINT, SHADES, MOUTHS, BLUSH, BLUSH_HOT, EMOTE, drawGlyph });
})(window.Clawd);
