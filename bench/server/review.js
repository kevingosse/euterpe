// The review: the reviewer's comments (each tied to a screen, an element on it, its text, and where
// that text lives in Euterpe's sources), which screens they've seen, and what each showed then, so
// a screen whose text changed since can be shown again. Kept in bench/review.json, for Claude to
// read and act on later.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "review.json");
const EMPTY = () => ({
    about: "Euterpe's review bench (bench/README.md): the reviewer's comments, and the screens they've seen. Each comment says where the text it's about lives (target.sources: file and line).",
    version: 1, comments: [], screens: {}, scenarios: {},
});

let cache = null;

function load() {
    if (cache) { return cache; }
    try { cache = { ...EMPTY(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { cache = EMPTY(); }
    return cache;
}

function save() {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
    fs.renameSync(tmp, FILE);
}

function apply(m) {
    const data = load();
    const now = new Date().toISOString();
    switch (m.op) {
        case "add-comment": {
            const c = { id: `c-${now.slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex")}`, created: now, status: "open", ...m.comment };
            m.comment.id = c.id;
            data.comments.push(c);
            break;
        }
        case "update-comment": {
            const c = data.comments.find((x) => x.id === m.id);
            if (c) { Object.assign(c, m.patch, { updated: now }); }
            break;
        }
        case "delete-comment":
            data.comments = data.comments.filter((x) => x.id !== m.id);
            break;
        case "screen": {
            const s = data.screens[m.key] || {};
            // the texts of Euterpe's this screen showed, all the times it was shown
            const seenIds = Array.isArray(m.seenIds) ? [...new Set([...(s.seenIds || []), ...m.seenIds])] : s.seenIds;
            // reviewed before, and its text has changed since: to be looked at again
            const changed = m.reviewed ? false : m.fingerprint && s.fingerprint && s.reviewed && m.fingerprint !== s.fingerprint ? true : s.changed;
            data.screens[m.key] = {
                ...s, title: m.title, scenario: m.scenario, seen: now,
                ...(seenIds ? { seenIds } : {}),
                ...(m.reviewed ? { reviewed: now, fingerprint: m.fingerprint, texts: m.texts } : {}),
                ...(changed !== undefined ? { changed } : {}),
            };
            break;
        }
        case "scenario": {
            data.scenarios[m.scenario] = { ...(data.scenarios[m.scenario] || {}), screens: m.screens, finished: now };
            break;
        }
        case "reset-screens":
            data.screens = {};
            data.scenarios = {};
            break;
    }
    save();
    return data;
}

module.exports = { load, apply, FILE };
