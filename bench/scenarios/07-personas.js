// Chapter 7: who Euterpe is.
"use strict";

const { startSession, POET } = require("./lib");

module.exports = {
    id: "personas",
    title: "7. Personas",
    intro: "Choosing who Euterpe is, writing a persona of one's own, installing one someone shared.",
    scenarios: [
        {
            id: "choose-persona",
            title: "Choose Persona",
            summary: "Euterpe: Choose Persona.",
            world: { files: { "~/.euterpe/personas/my-cheeky.md": "---\nname: My Cheeky\ndescription: \n---\nYour name is Euterpe. You tease, but gently.\n" } },
            async run(t) {
                t.run("euterpe.choosePersona");
                await t.quickPick({ title: "Euterpe's Persona" });
                await t.screen("chooser", "The persona chooser", "The bundled personas and the writer's own (\"yours\", here one with no description yet), each with a button: Copy to edit for a bundled one, Edit for the writer's own.");
            },
        },
        {
            id: "persona-mid-session",
            title: "A new persona, mid-session",
            summary: "Choosing a persona during a session: it's for the next one.",
            world: {},
            async run(t) {
                await startSession(t);
                t.run("euterpe.choosePersona");
                const qp = await t.quickPick({ title: "Euterpe's Persona" });
                qp.pick("Warm");
                await t.notification({ text: /from the next session/ });
                await t.screen("info", "From the next session", "The persona is part of the mind's instructions, set when a session starts.");
            },
        },
        {
            id: "new-persona",
            title: "New Persona",
            summary: "New Persona…: a copy of the current persona, under a new name, opened for writing.",
            world: {},
            async run(t) {
                t.run("euterpe.newPersona");
                const box = await t.input({ title: "New Persona" });
                await t.screen("name", "A name for it", "The input box, empty since it copies the current persona.");
                const v = await box.type("   ");
                await t.screen("empty", "A name, please", `Its validation, for a name that's only spaces: "${v}".`);
                await box.type("Night Editor");
                box.accept();
                await t.notification({ text: /Rewrite it as you like/ });
                await t.wait(600);
                await t.screen("file", "The new persona's file", "Opened for writing: its header (name, description), a note for its author in a comment, then the persona it copies. And a word on when it takes effect.");
            },
        },
        {
            id: "copy-bundled-persona",
            title: "Copy a bundled persona to edit it",
            summary: "The Copy to edit button on a bundled persona: New Persona, from that one, with a name to start from.",
            world: {},
            async run(t) {
                t.run("euterpe.choosePersona");
                const qp = await t.quickPick({ title: "Euterpe's Persona" });
                qp.button("Coach");
                await t.input({ title: "New Persona" });
                await t.screen("name", "My Coach", "From a bundled persona, the name starts as \"My …\".");
            },
        },
        {
            id: "new-persona-replace",
            title: "A new persona with a name that's taken",
            summary: "New Persona… with the name of one the writer already has.",
            world: { files: { "~/.euterpe/personas/night-editor.md": "---\nname: Night Editor\ndescription: The first draft of it.\n---\nYou edit at night.\n" } },
            async run(t) {
                t.run("euterpe.newPersona");
                const box = await t.input({ title: "New Persona" });
                await box.type("Night Editor");
                box.accept();
                await t.notification({ text: /already have a persona/ });
                await t.screen("replace", "Replace it?", "");
            },
        },
        {
            id: "install-persona",
            title: "Install a Persona",
            summary: "A persona someone shared: read first (it's instructions to an agent), then installed.",
            world: { files: { "~/Downloads/the-poet.md": POET }, dialogFiles: { "Install a Persona": ["~/Downloads/the-poet.md"] } },
            async run(t) {
                t.run("euterpe.installPersona");
                const d = await t.dialog({ title: "Install a Persona" });
                await t.screen("dialog", "Pick the persona's file", "The system's Open dialog (the bench's stand-in), for Markdown files.");
                d.choose("~/Downloads/the-poet.md");
                const ask = await t.modal({ text: /Install the persona/ });
                await t.screen("ask", "Install it?", "The file is open beside it, to read first: a persona becomes part of the instructions of an agent that runs commands and changes files without asking.");
                ask.click("Install");
                const use = await t.notification({ text: /Installed/ });
                await t.screen("installed", "Installed", "Use it now, or later from the chooser.");
                use.click("Use It");
                await t.wait(500);
            },
        },
        {
            id: "install-persona-bad",
            title: "A persona too big to install",
            summary: "A persona file bigger than a persona should be.",
            world: { files: { "~/Downloads/novel.md": `---\nname: Novel\n---\n${"Every word matters. ".repeat(2000)}` }, dialogFiles: { "Install a Persona": ["~/Downloads/novel.md"] } },
            async run(t) {
                t.run("euterpe.installPersona");
                const d = await t.dialog({ title: "Install a Persona" });
                d.choose("~/Downloads/novel.md");
                await t.notification({ text: /Can't install that persona/ });
                await t.screen("error", "Can't install it", "A persona is at most 32 KB.");
            },
        },
        {
            id: "persona-file-conflict",
            title: "euterpe.personaFile in the way",
            summary: "The writer set euterpe.personaFile (a persona anywhere on disk), then picks a persona in the chooser.",
            world: { files: { "~/Dropbox/euterpe/me.md": "---\nname: Mine\ndescription: The one I sync.\n---\nYou are blunt.\n" }, settings: { personaFile: "{home}/Dropbox/euterpe/me.md" } },
            async run(t) {
                t.run("euterpe.choosePersona");
                const qp = await t.quickPick({ title: "Euterpe's Persona" });
                await t.screen("chooser", "The chooser, with a persona file", "The current one is the file's (it isn't among these).");
                qp.pick("Warm");
                await t.notification({ text: /personaFile is set/ });
                await t.screen("clear", "Clear it?", "The file wins over the persona picked: clear it, so the pick counts.");
            },
        },
        {
            id: "personas-folder",
            title: "Your personas folder",
            summary: "Open Your Personas Folder (in the chooser).",
            world: {},
            async run(t) {
                t.run("euterpe.choosePersona");
                const qp = await t.quickPick({ title: "Euterpe's Persona" });
                qp.pick(/Open Your Personas Folder/);
                await t.browser.next();
                await t.screen("folder", "The folder, in File Explorer", "");
            },
        },
    ],
};
