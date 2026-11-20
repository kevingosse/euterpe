// Chapter 14: the repository's documents for people who work on Euterpe.
"use strict";

const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");

module.exports = {
    id: "contributors",
    title: "14. For contributors",
    intro: "What the repository says to someone who'd work on Euterpe (the README and the mascot guide are in earlier chapters).",
    scenarios: [
        {
            id: "contributing",
            title: "CONTRIBUTING.md",
            summary: "How to build, test and change Euterpe.",
            world: {},
            async run(t) {
                t.openPage({ kind: "markdown", path: path.join(REPO, "CONTRIBUTING.md") }, "Preview CONTRIBUTING.md");
                await t.screen("contributing", "CONTRIBUTING.md", "As a Markdown preview: every paragraph can take a comment.");
            },
        },
    ],
};
