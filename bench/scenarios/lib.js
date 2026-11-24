// What many scenarios do: start a session and get past Euterpe's hello, write in the draft.
"use strict";

const HELLO = { expression: "happy", action: "wave", say: "Hey you. A benchmark post that admits the benchmark lied? I'm already hooked. I'll read along.", notes: 0 };

/**
 * Start a writing session as the writer would (the status bar's item), and get to Euterpe's
 * hello: its first turn answered with `hello`, the overlay up, the bubble written out.
 */
async function startSession(t, { hello = HELLO, command = "euterpe.startSession", wait = true } = {}) {
    const first = t.mind.turn({ kind: "session_start" });
    t.run(command);
    const turn = await first;
    await t.overlay.ready();
    const answered = t.session.response();
    turn.reply(hello);
    await answered;
    if (wait && hello && hello.say) { await t.overlay.bubble(); }
    return turn;
}

/**
 * The writer clicks Euterpe (`command`), but something in the settings stands in the way: Euterpe's
 * settings window opens instead of a session (extension.ts, showSettings). Waits until it has, and
 * shows `selector` (by default, the callout saying what's missing).
 */
async function settingsInstead(t, { command = "euterpe.startSession", selector = ".need" } = {}) {
    const opened = () => (t.output().match(/Euterpe's settings, at /g) || []).length;
    const before = opened();
    t.run(command);
    await t.until(() => opened() > before, { what: "Euterpe's settings to open instead of a session" });
    await t.webview.do("wait", selector);
    await t.wait(700);
}

/** The writer says something to Euterpe in the overlay's chat, and the mind answers `reply`. */
async function chat(t, text, reply, { open = true } = {}) {
    const turn = t.mind.turn({ kind: "chat" });
    if (open) { await t.overlay.do("openChat"); }
    await t.overlay.do("type", text);
    const tt = await turn;
    if (reply !== undefined) {
        // a turn made to fail (an error, a crash, a failed result) gets no answer
        const fails = reply && (reply.error !== undefined || reply.fail || reply.crash !== undefined || reply.network || reply.cutStream || reply.streamFail);
        const answered = fails ? null : t.session.response();
        tt.reply(reply);
        if (answered) { await answered; }
    }
    return tt;
}

const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..", "..");
/** A bundled pack, changed: a mascot of the writer's own (or one Euterpe drew) that holds up. */
function packFrom(base, changes) {
    const p = JSON.parse(fs.readFileSync(path.join(REPO, "mascots", `${base}.json`), "utf8"));
    return { ...p, ...changes };
}

/** The mascot Euterpe draws with the writer: Inky, gone green. */
const SPROUT = packFrom("inky", {
    name: "Sprout",
    description: "A dewdrop of green ink that grew legs. It likes short sentences.",
    body: "a drop of leaf-green ink with a glossy shine, a pointed tip on top and stubby legs",
    colors: { B: "#4FA65A", L: "#7FD08A", H: "#CFF3D3", M: "#3B8746", D: "#2A6634" },
});
/** A mascot someone shared: Boo, gone gold. */
const NIGHT_OWL = packFrom("boo", {
    name: "Night Owl",
    description: "A golden ghost for writing after midnight.",
    body: "a small, pale golden ghost with a scalloped hem and little arm nubs; you float instead of walking",
    colors: { B: "#F2E2A8", L: "#FBF3D6", H: "#FFFFFF", M: "#D9C27A", D: "#BFA35A" },
});

/** A pack that looks like one, but doesn't hold up once the overlay's engine reads it. */
const BROKEN = {
    format: 1,
    name: "Smudge",
    description: "Half-drawn: a test of what Euterpe says about a broken mascot.",
    body: "a grey smudge",
    colors: { B: "grey", Q: "#123456" },
    views: {
        front: { rows: ["..BB..", ".BXXB.", "..BB.."] },
        top: { rows: ["BB"] },
    },
};

/** A persona someone shared with the writer. */
const POET = `---
name: The Poet
description: Speaks in images; notices rhythm, sound and the one word that's almost right.
---
Your name is Euterpe, and you hear writing before you read it. You notice rhythm: a sentence that
limps, a paragraph that runs out of breath, a word whose sound fights its meaning.

You say little, and you say it in images. When a sentence lands, you tell them what it made you see.
When one doesn't, you point at the word that's almost right, and you let them find the right one.
`;

module.exports = { HELLO, startSession, settingsInstead, chat, SPROUT, NIGHT_OWL, BROKEN, POET, packFrom };
