# Euterpe's review bench

A guided tour of everything Euterpe shows: every screen, notification, dialog, menu, page and error. You review each screen and comment on any element; Claude implements the comments. It's an end-to-end test, with a human as the judge.

```
node bench            # opens http://127.0.0.1:7317/ in your browser
node bench --no-open --port=7400
```

## Reviewing

- **The tour** (left) is Euterpe's scenarios, chapter by chapter. Click one to play it. It stops at each screen worth reviewing: the right side says what you're looking at and when a writer meets it.
- **Next** (N or Enter) marks the screen reviewed and plays on. **R** restarts the scenario. **T** hides the tour.
- **Comment** (C, or Alt+click at any time): point at anything on the desktop (the VS Code window, Euterpe's overlay, the settings window, a browser page), click it, and say what should change. *About the whole screen instead* comments on the screen as a whole. Tags (Wording, Remove, Bug…) are optional.
- **Comments** lists every comment, and lets you edit, reclassify or delete one. Claude marks each comment it acts on as done, with a word on what it did.
- **Coverage** lists every text in Euterpe's sources (found by reading them, see `server/extract.js`), and whether a screen you reviewed showed it. "Never on screen" texts are the ones no scenario reaches (most can't be reached: a broken install, a mascot file with a mistake in it, another platform). Each row has a comment button: comment on those texts right there.
- **Play freely** lets go of the scenario: the world is yours. Click buttons, run commands (the title bar's search box opens the command palette), type in the draft, talk to Euterpe. Euterpe's mind answers from its panel on the right (*Euterpe's mind*), or stays silent on its own.
- A tour scenario marked **changed since** showed different text the last time it played (after a change to Euterpe): it's worth another look.

Everything is kept in `bench/review.json`: the comments (each with the element's text, the screen, and where that text is in Euterpe's sources), and which screens you've reviewed.

## What's real

Nothing on screen is a copy of Euterpe's text: the bench runs the real extension, overlay and settings window, against stand-ins for VS Code (`host/vscode.js`), Electron (`fake/electron.js`), Claude Code (`fake/claude.js`) and the network (`host/network.js`). Each scenario runs in a writer's machine of its own, in a folder (`bench/.worlds/<scenario>`, see `host/world.js`). Nothing leaves the machine.

### Where it isn't quite the real thing

- VS Code's own parts (its dialogs' Cancel button, the Settings editor, Workspace Trust, the Extensions view) are the bench's drawings of them, marked as VS Code's: a comment on them says so.
- Euterpe's window sits a little above the bottom of the desktop, and VS Code's notifications and pickers stay in front of it, so both can be read. On a real screen, Euterpe floats above everything, and its corner is where VS Code shows its notifications.
- While a screen is under review, Euterpe's bubble stays up (as when the pointer rests on it), and so does the browser's bubble for a value a field refuses (Chromium's fades after a few seconds).
- To show what's on screen while Euterpe waits on the network (Choose Model listing a plan's models, Check Setup), the bench holds the answer at that screen.
- The mind's words are the scenario's (or yours, from its panel), not a model's. Euterpe's own words around them are real.
- Electron's download is smaller (24 MB) and faster than the real one; minutes Euterpe would wait for (a stalled download, a stuck turn) pass in seconds.
- Reloading the bench's page during a scenario loses the overlay's window: restart the scenario (R).

## Writing a scenario

Scenarios are in `scenarios/`, a file per chapter (`scenarios/index.js` lists them). A scenario is a world and a script:

```js
{
    id: "claude-too-old",
    title: "Claude Code is too old",
    summary: "Shown in the tour, under the title.",
    world: { claude: { version: "2.1.204" } },            // see host/world.js
    async run(t) {                                       // see host/driver.js
        t.run("euterpe.startSession");                   // a command, as the writer runs it
        await t.notification({ text: /too old/ });       // what Euterpe shows…
        await t.screen("error", "Claude Code is too old", "Where and when a writer meets this.");
    },
}
```

`t.screen()` stops for review. Other waits (`t.modal`, `t.quickPick`, `t.input`, `t.progress`, `t.dialog`, `t.mind.turn`, `t.browser.next`, `t.session.started`…) give handles to act with (`click`, `pick`, `type`, `accept`, `reply`, `answer`…). `scenarios/lib.js` has the common steps (start a session, chat). Things that happen on their own while a screen is reviewed (a download, a sign-in) can be held: see `pauseAt` and `t.release()`; an API request, with `network: { hold: ["/models"] }` in the world and `t.release("network")`.

`node bench/dev/run-all.js [chapter or scenario ids] --shots=<dir>` plays scenarios in a headless Chrome (`dev/chrome.js`), passing every screen and saving a screenshot of each, and reports what broke. (It marks the screens it passes as reviewed: delete `bench/review.json` afterwards, or keep a copy.)
