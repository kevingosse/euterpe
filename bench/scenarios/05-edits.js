// Chapter 5: the edits Euterpe proposes, when the writer asks for one.
"use strict";

const { startSession, chat } = require("./lib");

/** The mind proposes an edit to the draft (through the extension's propose_edit tool), and says so. */
const propose = (edits, say, extra = {}) => ({ tools: [{ name: "propose_edit", args: { edits, ...extra } }], expression: "proud", say, notes: 0, action: null });
const CUT_ACTUALLY = [
    { old_text: "Actually, it existed", new_text: "It existed" },
    { old_text: "I was actually pretty confident", new_text: "I was pretty confident" },
];

async function proposed(t, edits, say, extra) {
    await startSession(t);
    await t.overlay.do("openChat");
    await chat(t, "Can you cut the actuallys? I've got too many.", propose(edits, say, extra), { open: false });
    await t.until(() => t.tabs().some((x) => /Euterpe's edit/.test(x.label)), { what: "the diff" });
    await t.wait(600);
}

module.exports = {
    id: "edits",
    title: "5. Euterpe's edits",
    intro: "Euterpe changes the writer's text only when asked, and only through a diff the writer accepts. Every way an edit can end.",
    scenarios: [
        {
            id: "edit-accept",
            title: "An edit, accepted",
            summary: "The writer asks; Euterpe proposes; the diff opens in place of the draft; the writer accepts.",
            world: {},
            async run(t) {
                await proposed(t, CUT_ACTUALLY, "Two *actually*s gone. The diff's open: your call.");
                await t.overlay.do("closeChat");
                await t.screen("diff", "The diff", "In place of the draft: its title, and Accept and Reject in the editor's title bar (their tooltips are the commands' titles).");
                await t.overlay.do("openChat");
                await t.screen("row", "The edit, in the chat", "The chat keeps a row for it, with the same Accept and Reject, and a button to bring the diff back.");
                await t.overlay.do("proposal", "accept");
                await t.until(() => !t.tabs().some((x) => /Euterpe's edit/.test(x.label)), { what: "the diff to close" });
                await t.wait(800);
                await t.screen("accepted", "Accepted", "The draft has the change (one undo step), the diff is gone, and the chat's row says what happened.");
            },
        },
        {
            id: "edit-menu",
            title: "An edit waiting: the palette and the menu",
            summary: "While an edit waits for the writer, Accept and Reject join the command palette and the session's menu.",
            world: {},
            async run(t) {
                await proposed(t, CUT_ACTUALLY, "Done: have a look.");
                await t.page.do("palette", "Euterpe");
                await t.screen("palette", "The palette, with an edit waiting", "Accept Euterpe's Edit and Reject Euterpe's Edit show while there's one to decide, and End Writing Session during the session.");
                await t.page.do("close-palette");
                t.run("euterpe.sessionMenu");
                const qp = await t.quickPick({ text: "Euterpe" });
                await t.screen("menu", "The session's menu, with an edit waiting", "");
                qp.pick(/Reject/);
                await t.overlay.do("openChat");
                await t.overlay.chat("rejected");
                await t.screen("rejected", "Rejected", "Rejected from the menu: the diff closes, the draft is as it was, and the chat says so.");
            },
        },
        {
            id: "edit-dismiss",
            title: "An edit, closed without a word",
            summary: "The writer just closes the diff.",
            world: {},
            async run(t) {
                await proposed(t, CUT_ACTUALLY, "There you go.");
                t.closeTab(/Euterpe's edit/);
                await t.overlay.chat("closed without a decision");
                await t.screen("dismissed", "Closed without a decision", "Closing the diff counts as a no (Euterpe hears so at its next look).");
            },
        },
        {
            id: "edit-stale",
            title: "An edit that came too late",
            summary: "The writer keeps writing, and changes the very words the edit was for, before accepting it.",
            world: {},
            async run(t) {
                await proposed(t, CUT_ACTUALLY, "Two cuts, in the diff.");
                t.showTab("draft.md");
                const d = t.vscode.window.activeTextEditor.document;
                const at = d.getText().indexOf("Actually, it existed");
                t.wb.edit(d.uri, at, at + "Actually, it existed".length, "Well, it existed");
                await t.wait(600);
                t.run("euterpe.acceptEdit");
                await t.notification({ text: /changed/ });
                await t.screen("stale", "Nothing applied", "The text the edit was for had changed: Euterpe applies nothing, and says so in VS Code and in the chat.");
            },
        },
        {
            id: "edit-superseded",
            title: "A newer edit",
            summary: "Euterpe proposes again before the writer decided on the first one.",
            world: {},
            async run(t) {
                await proposed(t, CUT_ACTUALLY, "First pass.");
                await chat(t, "Also tighten the title?", propose([{ old_text: "# Why my benchmarks lied to me", new_text: "# My benchmarks lied" }], "Shorter title, in a new diff."), { open: false });
                await t.overlay.chat("replaced by a newer one");
                await t.screen("superseded", "Replaced by a newer one", "One edit at a time: the newer one takes the older one's place.");
            },
        },
        {
            id: "edit-new-file",
            title: "An edit that makes a file",
            summary: "The writer asks for an outline in a new file.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.overlay.do("openChat");
                const outline = "# Outline\n\n1. The 40% that wasn't\n2. Two tools, two stories\n3. Who was lying\n4. What I check now\n";
                await chat(t, "Put an outline in notes/outline.md?", propose([{ old_text: "", new_text: outline }], "An outline, in a new file: accept it to create it.", { file: "notes/outline.md" }), { open: false });
                await t.until(() => t.tabs().some((x) => /Euterpe's edit/.test(x.label)), { what: "the diff" });
                await t.wait(600);
                await t.screen("diff", "A new file's diff", "Nothing on the left: the file doesn't exist yet.");
                t.run("euterpe.acceptEdit");
                await t.until(() => t.tabs().some((x) => x.label === "outline.md"), { what: "the new file" });
                await t.wait(600);
                await t.screen("created", "Created", "Accepting creates the file and opens it (unsaved, for the writer to keep or not).");
            },
        },
        {
            id: "edit-apply-fails",
            title: "An edit VS Code can't apply",
            summary: "VS Code refuses the edit (a read-only file, say).",
            world: { applyEditFails: true },
            async run(t) {
                await proposed(t, CUT_ACTUALLY, "Here.");
                t.run("euterpe.acceptEdit");
                await t.notification({ text: /couldn't apply/ });
                await t.screen("error", "VS Code couldn't apply it", "");
            },
        },
    ],
};
