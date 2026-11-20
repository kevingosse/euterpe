// Chapter 13: what Euterpe's mind reads. Not shown to the writer, but Euterpe's own words all the
// same: its instructions, what it perceives of the writer's work, its tools, and what they answer.
"use strict";

const path = require("path");
const { startSession, chat } = require("./lib");

const REPO = path.resolve(__dirname, "..", "..");

/** Open a text the mind reads, as a page. */
function show(t, title, text, file, kind = "plain") {
    t.openPage({ kind, text, file, title }, title);
}

function toolsDoc(tools, builtin) {
    const out = [];
    if (builtin?.length) { out.push(`Claude Code's own tools, as Euterpe's mind gets them: ${builtin.join(", ")}.`, ""); }
    for (const tool of tools) {
        out.push(`### ${tool.name}`, "", tool.description || "(no description)", "");
        if (tool.parameters) { out.push("```json", JSON.stringify(tool.parameters, null, 2), "```", ""); }
    }
    return out.join("\n");
}

module.exports = {
    id: "behind-the-curtain",
    title: "13. Behind the curtain",
    intro: "What Euterpe's mind reads, which the writer never sees, but which is Euterpe's own text all the same: its instructions, its perceptions of the writer's work, its tools and what they answer.",
    scenarios: [
        {
            id: "mind-instructions",
            title: "Euterpe's instructions",
            summary: "mind/system-prompt.md, the template every session fills in (the persona, Euterpe's home, the platform…), then as a session on Claude writes it.",
            world: {},
            async run(t) {
                t.openPage({ kind: "markdown", path: path.join(REPO, "mind", "system-prompt.md") }, "system-prompt.md");
                await t.screen("template", "The template", "mind/system-prompt.md, as written: the blanks in {{…}} are filled at each session's start. Every paragraph can take a comment.");
                t.showTab("draft.md");
                await startSession(t);
                show(t, "The instructions, as a session on Claude writes them", t.mind.instructions, "mind/system-prompt.md", "doc");
                await t.screen("assembled", "The instructions, filled in", "As Claude Code gets them (--system-prompt-file): the persona (Cheeky) in place, Euterpe's home, the platform, the editor, the cadence, the body it wears, its tools.");
            },
        },
        {
            id: "mind-instructions-openai",
            title: "Euterpe's instructions, on an API",
            summary: "The same template, as a session on OpenAI's API fills it: its file tools and its web are named differently.",
            world: { provider: "openai", settings: { openaiBaseUrl: "http://localhost:11434/v1", openaiModel: "llama3.3:70b" } },
            async run(t) {
                await startSession(t, { hello: { expression: "happy", say: "Hi.", notes: 0, action: null } });
                show(t, "The instructions, as a session on an API writes them", t.mind.instructions, "mind/system-prompt.md", "doc");
                await t.screen("assembled", "The instructions, on an API", "On a local server: no web search, so Euterpe fetches pages; its file tools are write_file and edit_file.");
                show(t, "The tools Euterpe's mind gets, on an API", toolsDoc(t.mind.tools), "src/agentTools.ts", "doc");
                await t.screen("tools", "Its tools, on an API", "Written for Euterpe (src/agentTools.ts): a shell, files, the web; then the extension's own (propose_edit, the mascot tools).");
            },
        },
        {
            id: "mind-tools-claude",
            title: "The extension's tools, on Claude",
            summary: "What the extension lends the mind on Claude, over its MCP server: proposing edits, previewing and offering mascots.",
            world: {},
            async run(t) {
                await startSession(t);
                await t.until(() => t.mind.tools.length, { what: "the tools' list" });
                show(t, "The extension's tools, as Claude Code lists them", toolsDoc(t.mind.tools, t.mind.builtinTools), "src/proposals.ts", "doc");
                await t.screen("tools", "propose_edit, preview_mascot, offer_mascot", "Their descriptions are instructions to the mind: when to use them, and how.");
            },
        },
        {
            id: "mind-perceptions",
            title: "What Euterpe perceives",
            summary: "The perceptions a session sends the mind: the first (the whole draft), a pause (what changed), a chat, a decision on an edit, the goodbye.",
            world: {},
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const start = await first;
                await t.overlay.ready();
                start.reply({ expression: "reading", say: null, notes: 0, action: null });
                show(t, "The first perception (session_start)", start.text, "src/perception.ts");
                await t.screen("start", "The first look", "The whole draft, with the time, the file, the cursor, the writer's activity.");
                const pause = t.mind.turn({ kind: "pause" });
                t.showTab("draft.md");
                await t.type("\n\nThe fix took one line.", { at: "end" });
                const p = await pause;
                p.reply({ expression: "reading", say: null, notes: 1, action: null });
                show(t, "A pause", p.text, "src/perception.ts");
                await t.screen("pause", "A look after a pause", "Only what changed since the last look, as a diff.");
                await t.overlay.do("openChat");
                const c = await chat(t, "Is the last sentence too abrupt?", undefined, { open: false });
                c.reply({ expression: "thinking", say: "A little. Earn it: one sentence on what the line was.", notes: 1, action: null });
                show(t, "A chat", c.text, "src/mind.ts");
                await t.screen("chat", "A chat turn", "A fresh perception, then what the writer said.");
                const edit = await chat(t, "Fix it for me?", undefined, { open: false });
                edit.reply({ tools: [{ name: "propose_edit", args: { edits: [{ old_text: "The fix took one line.", new_text: "The fix took one line: a warm-up I had skipped." }] } }], expression: "proud", say: "In the diff.", notes: 1, action: null });
                await t.until(() => t.tabs().some((x) => /Euterpe's edit/.test(x.label)), { what: "the diff" });
                const review = t.mind.turn({ kind: "edit_review" });
                t.run("euterpe.acceptEdit");
                const r = await review;
                r.reply({ expression: "happy", say: null, notes: 1, action: null });
                show(t, "After the writer decided", r.text, "src/session.ts");
                await t.screen("decision", "The writer's decision, heard", "The next perception says what the writer decided on the edit.");
                const results = t.mind.toolResults;
                if (results.length) {
                    show(t, "What propose_edit answered", results.map((x) => `${x.name}${x.isError ? " (an error)" : ""}:\n${x.content}`).join("\n\n"), "src/proposals.ts");
                    await t.screen("tool-result", "A tool's answer", "What the mind reads back from propose_edit.");
                }
                const last = t.mind.turn({ kind: "session_end" });
                t.run("euterpe.endSession");
                const end = await last;
                show(t, "The last perception (session_end)", end.text, "src/perception.ts");
                end.reply({ expression: "happy", action: "wave", say: "See you.", notes: 0 });
                await t.screen("end", "The goodbye look", "");
            },
        },
        {
            id: "mind-notes-request",
            title: "The notes request",
            summary: "What the mind gets when the writer clicks the notes badge.",
            world: {},
            async run(t) {
                await startSession(t, { hello: { expression: "smug", say: "I've got thoughts already.", notes: 2, action: null } });
                const turn = t.mind.turn({ kind: "chat" });
                await t.overlay.do("badge");
                const n = await turn;
                n.reply({ expression: "smug", say: "Two things…", notes: 0, action: null });
                show(t, "The notes request", n.text, "src/session.ts");
                await t.screen("request", "The badge, as the mind hears it", "At the end of the perception, the request the badge sends.");
            },
        },
    ],
};
