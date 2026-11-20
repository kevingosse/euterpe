# Working on Euterpe

## Layout

- **`src/`**: the VS Code extension (TypeScript; the repo root is the extension). `claudeMind.ts` runs the mind through Claude Code, `openaiMind.ts` through OpenAI-compatible APIs.
- **`mind/`**: the system prompt and the bundled personas.
- **`overlay/`**: the Electron app that draws Euterpe's body, its speech bubble and the chat. `renderer/clawd/` is the animation engine.
- **`settings/`**: the settings window (**Euterpe: Open Settings**), a webview.
- **`mascots/`**: the bundled mascot packs ([docs/mascots.md](docs/mascots.md)).
- **`media/`**: the status bar icon font and the Marketplace icon (`npm run icons`).
- **`bench/`**: the review bench ([bench/README.md](bench/README.md)).

## Working from source

Prerequisites: Node.js 20+, VS Code, and Claude Code signed in.

1. At the repo root: `npm install`, then `npm run compile` (and `npm test` for the unit tests).
2. In VS Code, run **Developer: Install Extension from Location…** and pick the repo's root folder, **once**. VS Code registers the folder in place (nothing is copied), so edits to the prompt, a persona, the overlay or a mascot apply at the next session.
3. Run **Developer: Reload Window**.

After pulling changes, run `npm install && npm run compile`, then reload the window. F5 (**Run Euterpe Extension**) works too.

## Tests and checks

- `npm test` compiles and runs the unit tests with Node's built-in runner; no VS Code needed.
  - The tests that draw with Electron (mascot sheets) run once the development Electron is fetched (`npm run demo` fetches it), and skip before that.
- `npm run package` builds the `.vsix`.
- CI (`.github/workflows/ci.yml`) runs on Windows, macOS and Linux. It runs the tests and packages the extension, renders the overlay, and draws the mascots. On macOS it also checks the window's focus handling on the Electron that Euterpe downloads (`overlay/dev/check-focus.js`).
- In VS Code:
  - **Euterpe: Check Setup** checks a session's requirements;
  - **Euterpe: Show Log** shows the session log;
  - `euterpe.debugMind` shows the full transcript.

## The avatar

From the repo root:

- `npm run demo` is the scripted tour, no VS Code needed. `npm run demo -- --euterpe-mascot=mascots/mochi.json` runs it in another body.
- `npm run sheet -- --sheet=expressions --out=sheet.png` renders model sheets offscreen to PNG, for reviewing the art. The sheets (see `overlay/renderer/sheet.js`) are:
  - `views`, `faces`, `expressions`, `actions`;
  - `expr:<name>`, `action:<name>`, `change:<from>:<to>`;
  - `show:<enter|exit|talk|think|drag|shake|boop|wake>`.

  `--mascot=mascots/boo.json` draws a pack instead of Clawd, and `--sheet=mascot` is a pack's full model sheet (what Preview Mascot shows).
- `npm run screenshot` captures the demo offscreen to `overlay/preview.png`. `electron overlay/dev/readme-shots.js` redraws the README's pictures.
- `EUTERPE_DEV_SCRIPT=<steps.json>` drives a live overlay from a script: type into the chat, resize it, capture the page, probe the focus. `EUTERPE_OVERLAY_OFFSCREEN=1` keeps it off the desktop, which is how to run it on a desktop someone's using.

Keep the art honest with model sheets: every change to the engine should leave Clawd's sheets byte-identical, unless the change is to Clawd.

## Conventions

- **Euterpe is genderless**: never "she" or "he", in strings, prompts, docs or comments. Use the name, or rephrase.
- **Judgment belongs to the model**: no `if (idle > 5 s) say(…)`. Code throttles cost and latency, never behaviour.
- **Euterpe's reach is set by its prompt, not by fences.** The mind has a full agent's tools; where it goes unasked is its instructions' business. That holds for both minds.
- **Personas and mascots are text and data, never code.** A shared one shouldn't be able to run anything; what reaches the mind's instructions is shown to the writer before install.
