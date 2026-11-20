// Chapter 6: the body Euterpe wears.
"use strict";

const { startSession, chat, SPROUT, NIGHT_OWL, BROKEN } = require("./lib");

const sheetOf = async (t, name) => {
    await t.until(() => t.tabs().some((x) => x.kind === "image"), { what: `${name}'s model sheet`, timeout: 40_000 });
    await t.wait(700);
};

module.exports = {
    id: "mascots",
    title: "6. Mascots",
    intro: "Choosing Euterpe's body, previewing one, installing one someone shared, and having Euterpe draw one.",
    scenarios: [
        {
            id: "choose-mascot",
            title: "Choose Mascot",
            summary: "Euterpe: Choose Mascot, on Claude (Clawd only fronts a mind on Claude).",
            world: {},
            async run(t) {
                t.run("euterpe.chooseMascot");
                await t.quickPick({ title: "Euterpe's Mascot" });
                await t.screen("chooser", "The mascot chooser", "Each mascot with its description, and an eye button to preview it (on the item under the pointer), then what else there is to do.");
            },
        },
        {
            id: "mascot-sheets",
            title: "Each mascot's model sheet",
            summary: "Euterpe: Preview Mascot, for each bundled mascot: the model sheet a writer sees before choosing one (drawn by the overlay's own engine).",
            world: {},
            async run(t) {
                for (const [i, name] of ["Clawd", "Boo", "Clippy", "Inky", "Mochi"].entries()) {
                    t.run("euterpe.previewMascot");
                    const qp = await t.quickPick({ text: /Preview which/ });
                    if (i === 0) { await t.screen("which", "Preview which mascot?", "Preview Mascot asks which one first."); }
                    qp.pick(name);
                    if (i === 0) {
                        await t.progress({ title: /Drawing/ });
                        await t.screen("drawing", "Drawing…", "While the sheet is drawn (it takes a moment: Euterpe's window runtime draws it offscreen).", { settle: 100 });
                    }
                    await sheetOf(t, name);
                    await t.screen(`sheet-${name.toLowerCase()}`, `${name}'s model sheet`, "Every view, the moods, the gestures, walking and being carried, on a dark and a light background. The labels are drawn in the picture (a comment can still point at it).");
                    t.closeTab(/\.png$/);
                }
            },
        },
        {
            id: "install-mascot",
            title: "Install a Mascot",
            summary: "A mascot someone shared: checked, previewed, then kept with the writer's own.",
            world: { files: { "~/Downloads/night-owl.json": NIGHT_OWL, "~/.euterpe/mascots/night-owl.json": NIGHT_OWL }, dialogFiles: { "Install a Mascot": ["~/Downloads/night-owl.json"] } },
            async run(t) {
                t.run("euterpe.installMascot");
                const d = await t.dialog({ title: "Install a Mascot" });
                await t.screen("dialog", "Pick the mascot's file", "The system's Open dialog (the bench's stand-in): its title, and a filter for mascot files.");
                d.choose("~/Downloads/night-owl.json");
                const ask = await t.modal({ text: /Install the mascot/, timeout: 45_000 });
                await t.screen("ask", "Install it?", "Its model sheet opened beside it, and the description Euterpe will hear of its new body, word for word (it becomes part of the mind's instructions).");
                ask.click("Install");
                const replace = await t.notification({ text: /already have/ });
                await t.screen("replace", "Replace the one you have?", "The writer already has a mascot of that name.");
                replace.click("Replace");
                await t.notification({ text: /Installed/ });
                await t.screen("installed", "Installed", "Wear it now, or later from the chooser.");
            },
        },
        {
            id: "install-mascot-bad",
            title: "Mascot files that aren't mascots",
            summary: "What Euterpe says about a file it can't install: not JSON, no name, no front view, too big, not even an object; and one that looks like a mascot but doesn't hold up.",
            world: {
                files: {
                    "~/Downloads/not-json.json": "{ \"name\": \"Oops\", ",
                    "~/Downloads/no-name.json": { format: 1, views: { front: { rows: ["BB"] } } },
                    "~/Downloads/no-front.json": { format: 1, name: "Ghostly", views: { side: { rows: ["BB"] } } },
                    "~/Downloads/huge.json": { format: 1, name: "Huge", description: "x".repeat(140 * 1024), views: { front: { rows: ["BB"] } } },
                    "~/Downloads/list.json": [1, 2, 3],
                    "~/Downloads/smudge.json": BROKEN,
                },
                dialogFiles: { "Install a Mascot": ["~/Downloads/not-json.json", "~/Downloads/no-name.json", "~/Downloads/no-front.json", "~/Downloads/huge.json", "~/Downloads/list.json", "~/Downloads/smudge.json"] },
            },
            async run(t) {
                const tryOne = async (file, key, title, notes, expect) => {
                    t.run("euterpe.installMascot");
                    const d = await t.dialog({ title: "Install a Mascot" });
                    d.choose(file);
                    await t.notification({ text: expect, timeout: 45_000 });
                    await t.screen(key, title, notes);
                };
                await tryOne("~/Downloads/not-json.json", "not-json", "Not JSON", "", /isn't valid JSON/);
                await tryOne("~/Downloads/no-name.json", "no-name", "No name", "", /has no "name"/);
                await tryOne("~/Downloads/no-front.json", "no-front", "No front view", "", /no front view/);
                await tryOne("~/Downloads/huge.json", "too-big", "Too big", "", /at most 128 KB/);
                await tryOne("~/Downloads/list.json", "not-object", "Not an object", "", /isn't a mascot/);
                t.run("euterpe.installMascot");
                const d = await t.dialog({ title: "Install a Mascot" });
                d.choose("~/Downloads/smudge.json");
                const n = await t.notification({ text: /doesn't hold up/, timeout: 45_000 });
                await t.screen("broken", "A mascot that doesn't hold up", "It passes the first look, but the engine that draws it finds problems: the first one here, all of them in the log.");
                n.click("Show All");
                await t.wait(700);
                await t.screen("broken-all", "All of its problems", "Show All opens the log, with every problem the engine found.");
            },
        },
        {
            id: "mascot-guide",
            title: "The mascot guide",
            summary: "Mascot Guide (in the chooser): how a mascot is made, for drawing one (or having an agent draw it).",
            world: {},
            async run(t) {
                t.run("euterpe.chooseMascot");
                const qp = await t.quickPick({ title: "Euterpe's Mascot" });
                qp.pick(/Mascot Guide/);
                await t.until(() => t.tabs().some((x) => /mascots\.md/.test(x.label)), { what: "the guide" });
                await t.screen("guide", "docs/mascots.md", "The guide, as VS Code's Markdown preview shows it.");
            },
        },
        {
            id: "mascots-folder",
            title: "Your mascots folder",
            summary: "Open Your Mascots Folder (in the chooser).",
            world: {},
            async run(t) {
                t.run("euterpe.chooseMascot");
                const qp = await t.quickPick({ title: "Euterpe's Mascot" });
                qp.pick(/Open Your Mascots Folder/);
                await t.browser.next();
                await t.screen("folder", "The folder, in File Explorer", "Made if it isn't there yet, in Euterpe's home.");
            },
        },
        {
            id: "make-mascot-no-session",
            title: "Make One with Euterpe, without a session",
            summary: "Make One with Euterpe… needs Euterpe there.",
            world: {},
            async run(t) {
                t.run("euterpe.chooseMascot");
                const qp = await t.quickPick({ title: "Euterpe's Mascot" });
                qp.pick(/Make One with Euterpe/);
                await t.notification({ text: /draws mascots during a writing session/ });
                await t.screen("info", "Start a session first", "");
            },
        },
        {
            id: "mascot-offer",
            title: "Euterpe draws a mascot",
            summary: "During a session, Make One with Euterpe… asks Euterpe; it draws one with its file tools (the bench's stand-in skips to the end) and offers it.",
            world: { files: { "~/.euterpe/mascots/sprout.json": SPROUT } },
            async run(t) {
                await startSession(t);
                const turn = t.mind.turn({ kind: "chat" });
                t.run("euterpe.chooseMascot");
                const qp = await t.quickPick({ title: "Euterpe's Mascot" });
                qp.pick(/Make One with Euterpe/);
                const tt = await turn;
                await t.overlay.do("openChat");
                await t.screen("asked", "The writer's request, in the chat", "Make One with Euterpe sends this, as the writer.");
                const offered = t.notification({ text: /made you a mascot/, timeout: 45_000 });
                tt.reply({ tools: [{ name: "offer_mascot", args: { file: "mascots/sprout.json" } }], expression: "excited", action: "jump", say: "Meet Sprout: a drop of green ink with legs. Want to try it on?", notes: 0 });
                const offer = await offered;
                await t.overlay.do("closeChat");
                await t.screen("offer", "The offer", "Wear it, see it first, or not now: the writer decides.");
                offer.click("Preview");
                await sheetOf(t, "Sprout");
                const again = await t.notification({ text: /made you a mascot/, timeout: 45_000 });
                await t.screen("preview", "Its model sheet", "Preview shows the sheet, and the offer comes back.");
                again.click("Wear It");
                await t.wait(3500);
                await t.screen("wearing", "Euterpe in its new body", "The old body walks off, the new one walks in.");
            },
        },
        {
            id: "switch-mascot",
            title: "Another body, mid-session",
            summary: "Choose Mascot during a session: the change is at once.",
            world: {},
            async run(t) {
                await startSession(t);
                t.run("euterpe.chooseMascot");
                const qp = await t.quickPick({ title: "Euterpe's Mascot" });
                qp.pick("Boo");
                await t.wait(3500);
                await t.screen("boo", "Boo, now", "Clawd walks off, Boo floats in. (Euterpe's mind hears about its new body at its next look.)");
            },
        },
    ],
};
