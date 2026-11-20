// The tour: every scenario, chapter by chapter. A scenario is a world (a writer's machine: see
// bench/host/world.js for what it can hold) and a script that plays it (see bench/host/driver.js
// for what a script can do), stopping at each screen to review with t.screen(key, title, notes).
"use strict";

const chapters = [
    require("./01-first-contact"),
    require("./02-first-session"),
    require("./03-start-problems"),
    require("./04-session"),
    require("./05-edits"),
    require("./06-mascots"),
    require("./07-personas"),
    require("./08-models"),
    require("./09-chatgpt"),
    require("./10-api"),
    require("./11-settings-window"),
    require("./12-check-setup"),
    require("./13-behind-the-curtain"),
    require("./14-contributors"),
];

function byId(id) {
    for (const c of chapters) { for (const s of c.scenarios) { if (s.id === id) { return s; } } }
    return null;
}

function catalog() {
    return {
        chapters: chapters.map((c) => ({
            id: c.id, title: c.title, intro: c.intro,
            scenarios: c.scenarios.map((s) => ({ id: s.id, title: s.title, summary: s.summary })),
        })),
    };
}

module.exports = { chapters, byId, catalog };
