// Builds media/euterpe-icons.ttf, the icon font behind Euterpe's status bar item (package.json,
// contributes.icons): the mark drawn as 16×16 pixels, idle (outline) and active (filled), like the
// codicons it sits among.   npm run icons
// TrueType, not WOFF: VS Code serves an extension's fonts from outside its extensions folder (an
// extension installed from a folder, or under development) only if they're .ttf or .otf.
const fs = require("fs");
const path = require("path");
const svg2ttf = require("svg2ttf");

// A speech bubble with eyes: someone beside you who talks, whichever body they wear.
const MARKS = {
    "euterpe-idle": {
        code: 0xe001,
        rows: [
            "................",
            "................",
            "..############..",
            ".#............#.",
            ".#............#.",
            ".#...#....#...#.",
            ".#...#....#...#.",
            ".#...#....#...#.",
            ".#............#.",
            ".#............#.",
            "..#####..######.",
            "......#.#.......",
            "......##........",
            "......#.........",
            "................",
            "................",
        ],
    },
    "euterpe-active": {
        code: 0xe002,
        rows: [
            "................",
            "................",
            "..############..",
            ".##############.",
            ".##############.",
            ".####.####.####.",
            ".####.####.####.",
            ".####.####.####.",
            ".##############.",
            ".##############.",
            "..#############.",
            "......###.......",
            "......##........",
            "......#.........",
            "................",
            "................",
        ],
    },
};

// A 1 em square sitting slightly below the baseline, as the codicons do.
const EM = 1024, PX = EM / 16, DESCENT = 128;

function outline(rows) {
    let d = "";
    rows.forEach((row, y) => [...row].forEach((c, x) => {
        if (c !== "#") return;
        d += `M${x * PX} ${EM - DESCENT - (y + 1) * PX}h${PX}v${PX}h${-PX}z`;   // fonts are y-up
    }));
    return d;
}

const svg = `<?xml version="1.0" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg"><defs><font id="euterpe-icons" horiz-adv-x="${EM}">
<font-face font-family="euterpe-icons" units-per-em="${EM}" ascent="${EM - DESCENT}" descent="${-DESCENT}"/>
<missing-glyph horiz-adv-x="${EM}"/>
${Object.entries(MARKS).map(([name, m]) => `<glyph glyph-name="${name}" unicode="&#x${m.code.toString(16)};" horiz-adv-x="${EM}" d="${outline(m.rows)}"/>`).join("\n")}
</font></defs></svg>`;

const ttf = svg2ttf(svg, { ts: 0, version: "1.0", description: "Euterpe's status bar marks" });
const out = path.join(__dirname, "euterpe-icons.ttf");
fs.writeFileSync(out, Buffer.from(ttf.buffer));
console.log(`wrote ${out}: ${Object.keys(MARKS).map((n) => `${n} \\${MARKS[n].code.toString(16).toUpperCase()}`).join(", ")}`);

// ---------- the extension's icon (media/icon.png, for the Marketplace): the same mark, 32 × 32 pixels at 4× ----------
// The settings window wears it in the mind's provider's colour: media/icon-openai.png in ink blue, media/icon-copilot.png in GitHub's purple.

const PALETTE = { ".": null, t: [0xd9, 0x77, 0x57], T: [0xa8, 0x4d, 0x33], c: [0xff, 0xf5, 0xe2], i: [0x2b, 0x22, 0x33], b: [0xf4, 0x9a, 0xab] };

const BLUE = { ...PALETTE, t: [0x4e, 0x73, 0xd2], T: [0x2e, 0x48, 0x93] };
const PURPLE = { ...PALETTE, t: [0x82, 0x50, 0xdf], T: [0x66, 0x39, 0xba] };

function iconRows() {
    const N = 32, g = Array.from({ length: N }, () => Array(N).fill("."));
    const round = (x, y, x0, y0, x1, y1, r) => {
        const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
        return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.6;
    };
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (round(x, y, 0, 0, 31, 31, 5)) g[y][x] = y >= 29 || (x >= 29 && y > 3) ? "T" : "t";   // a tile, shaded bottom right
    }
    const bubble = (x, y) => round(x, y, 5, 5, 26, 21, 3) || (y >= 21 && y <= 25 && x >= 9 && x <= 9 + (25 - y));
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (!bubble(x, y)) continue;
        const edge = !bubble(x - 1, y) || !bubble(x + 1, y) || !bubble(x, y - 1) || !bubble(x, y + 1);
        g[y][x] = edge ? "i" : "c";
    }
    for (const ex of [11, 19]) {
        for (let y = 10; y <= 15; y++) for (let x = ex; x <= ex + 2; x++) g[y][x] = "i";
        g[11][ex] = "c";   // the glint, as Clawd's eyes have it
    }
    for (const bx of [8, 21]) for (let x = bx; x <= bx + 2; x++) g[17][x] = "b";
    return g.map((r) => r.join(""));
}

function png(rows, scale, palette = PALETTE) {
    const zlib = require("zlib");
    const w = rows[0].length * scale, h = rows.length * scale;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;   // no filter
        for (let x = 0; x < w; x++) {
            const c = palette[rows[Math.floor(y / scale)][Math.floor(x / scale)]];
            const o = y * (w * 4 + 1) + 1 + x * 4;
            if (c) { raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255; }
        }
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
        const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), sum = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        sum.writeUInt32BE(crc(Buffer.concat([t, data])));
        return Buffer.concat([len, t, data, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const [name, palette] of [["icon.png", PALETTE], ["icon-openai.png", BLUE], ["icon-copilot.png", PURPLE]]) {
    const icon = path.join(__dirname, name);
    fs.writeFileSync(icon, png(iconRows(), 4, palette));
    console.log(`wrote ${icon}`);
}
