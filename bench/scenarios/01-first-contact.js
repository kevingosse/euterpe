// Chapter 1: what a writer meets before any session.
"use strict";

module.exports = {
    id: "first-contact",
    title: "1. First contact",
    intro: "Before any session: Euterpe's page in the Extensions view, its place in the status bar, its commands, and its part of VS Code's Settings.",
    scenarios: [
        {
            id: "marketplace",
            title: "Euterpe's page in the Extensions view",
            summary: "What a writer reads before installing: Euterpe's page (its README), and its Features tab (the commands and settings it contributes, as VS Code lists them).",
            world: {},
            async run(t) {
                t.openPage({ kind: "extension", tab: "details" }, "Extension: Euterpe");
                await t.screen("details", "The extension's page", "The top of Euterpe's page in VS Code's Extensions view (and on the Marketplace): its name, its one-line description, then the README. Scroll through it: every paragraph can take a comment.");
                await t.page.do("extension-tab", "features");
                await t.screen("features", "Features: what Euterpe contributes", "VS Code's Features tab lists the commands (with their titles and keybinding), the settings (with their descriptions and defaults) and the status bar icons, from package.json.");
            },
        },
        {
            id: "status-idle",
            title: "The status bar, before a session",
            summary: "VS Code just started, with a draft open: Euterpe sits in the status bar.",
            world: {},
            async run(t) {
                await t.until(() => t.status(), { what: "Euterpe's status bar item" });
                await t.screen("idle", "Euterpe in the status bar", "Bottom right: Euterpe's item, and the tooltip it shows on hover (with a link to Euterpe's settings). A click starts a session.", { focus: "status-tooltip" });
            },
        },
        {
            id: "palette",
            title: "Euterpe's commands",
            summary: "The command palette, filtered on Euterpe, before a session.",
            world: {},
            async run(t) {
                await t.page.do("palette", "Euterpe");
                await t.screen("palette", "The command palette", "Euterpe's commands, as the palette lists them before a session. End Writing Session only shows during a session, Accept and Reject only while an edit waits for you, and Toggle Writing Session and Session Menu never (they're the status bar item's).");
                await t.page.do("close-palette");
            },
        },
        {
            id: "vscode-settings",
            title: "Euterpe in VS Code's Settings editor",
            summary: "VS Code's own Settings editor, at Euterpe's settings: their labels (which VS Code makes from the setting names), descriptions, dropdowns and the descriptions of their choices.",
            world: {},
            async run(t) {
                t.openPage({ kind: "settings-ui", query: "@ext:kevingosse.euterpe" }, "Settings");
                await t.screen("euterpe", "Settings: Euterpe", "The first section: persona, mascot, size. VS Code builds each label from the setting's name (euterpe.avatarScale → \"Avatar Scale\"); the descriptions and the dropdowns' choices are Euterpe's. Each open list below a dropdown shows its choices as VS Code shows them when it's open, with their descriptions.");
                await t.page.do("scroll-to", "Mind");
                await t.screen("mind", "Settings: Mind", "What the mind runs on, its models, the API's address, the effort.");
                await t.page.do("scroll-to", "Reading Along");
                await t.screen("reading", "Settings: Reading Along", "How closely Euterpe reads along, and whether it follows you to other documents.");
                await t.page.do("scroll-to", "Setup");
                await t.screen("setup", "Settings: Setup", "The paths, and the mind's debug console.");
            },
        },
    ],
};
