// settings.js: Euterpe's settings window (src/settingsPanel.ts opens it). It shows what the
// extension sends (settingsModel.ts: the settings, the personas, the mascots), and sends back
// what the writer changes; the extension checks and applies it, then sends the new state.
// The mascots are drawn live by the overlay's own engine (overlay/renderer/clawd), so what the
// writer sees here is the body Euterpe will wear, moving as it will.
(function () {
    "use strict";
    const C = window.Clawd, MD = window.Markdown;
    const vscode = acquireVsCodeApi();
    const app = document.getElementById("app");

    // ---------- markup: escaped unless marked raw ----------
    const RAW = Symbol("raw");
    const raw = (s) => ({ [RAW]: String(s) });
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const piece = (v) => (v == null || v === false ? "" : Array.isArray(v) ? v.map(piece).join("") : v[RAW] !== undefined ? v[RAW] : esc(v));
    function h(strings, ...vals) {
        let out = strings[0];
        vals.forEach((v, i) => { out += piece(v) + strings[i + 1]; });
        return raw(out);
    }

    // ---------- what the writer sees ----------
    const SECTIONS = [["persona", "Persona"], ["mascot", "Mascot"], ["mind", "Mind"], ["reading", "Reading along"], ["setup", "Setup"]];
    const SIZES = [[2, "Small"], [3, "Quiet"], [4, "Standard"], [5, "Large"], [6, "Largest"]];
    const EFFORTS = [
        ["low", "Low", "The snappiest replies, and the cheapest looks. Euterpe's default."],
        ["medium", "Medium", "A little more thought, a little slower."],
        ["high", "High", "More deliberate replies: slower, and each look costs more."],
        ["xhigh", "Extra high", "The slowest, most deliberate replies."],
    ];
    const ATTENTION = [
        ["close", "Close", "Reads right behind you: a look at every pause, and at least every 15 s while you type. A typo reaches the notes seconds after you make it."],
        ["relaxed", "Relaxed", "A look when you stop for a few seconds, and at least every minute: roughly a third of the looks, and a shorter memory of the session."],
        ["light", "Light", "A look at longer pauses, and every few minutes: the fewest, cheapest looks. Notes arrive a paragraph later."],
    ];
    const PROVIDERS = [
        ["claude", "Claude", "Claude, through Claude Code, on your Claude login: a subscription or an API key."],
        ["openai", "OpenAI & others", "Your ChatGPT plan, OpenAI's API, or any OpenAI-compatible one (OpenRouter, a local Ollama or LM Studio…)."],
        ["copilot", "GitHub Copilot", "Your GitHub Copilot plan: the models Copilot offers you in VS Code."],
    ];
    // One click to a provider (src/providers.ts PRESETS); any other OpenAI-compatible address works too.
    // The ChatGPT plan is the setting's default (""): it's OpenAI's API too, signed in rather than keyed.
    const PRESETS = [
        ["", "ChatGPT", "Your ChatGPT plan (Plus or Pro): no API key"],
        ["https://api.openai.com/v1", "OpenAI API", "GPT models, billed to your API key"],
        ["https://openrouter.ai/api/v1", "OpenRouter", "Models from many labs, with one key"],
        ["http://localhost:11434/v1", "Ollama", "Models on this computer, no key"],
        ["http://localhost:1234/v1", "LM Studio", "Models on this computer, no key"],
    ];
    // [key, label, description, placeholder, the provider it's for (none: both)]
    const PATHS = [
        ["homeDir", "Euterpe's home", "Its memory, your personas and mascots, and where its mind runs. A synced folder shares them between your computers.", "~/.euterpe"],
        ["claudeConfigDir", "Claude Code config folder", "Which Claude Code setup the mind uses: its login (a subscription or an API key) and its settings. For when you keep several.", "Inherited from VS Code's environment", "claude"],
        ["claudePath", "Claude Code", "The claude executable.", "Found automatically", "claude"],
    ];

    let state = null;
    const saved = vscode.getState() || {};
    const ui = {
        read: new Set(saved.read || []),     // personas whose text is open
        setupOpen: !!saved.setupOpen,
        seen: !!saved.seen,                  // the page was here before: Euterpe is already on stage
    };
    const keep = () => vscode.setState({ read: [...ui.read], setupOpen: ui.setupOpen, seen: true });
    let detected = null;                     // Claude Code as found, for the choice of mind and Setup
    const CLAUDE_PATHS = ["claudePath", "claudeConfigDir"];   // the settings that decide which Claude Code that is
    let listed = null;                       // the models the API lists: { ids } or { problem }, for its model field
    let otherUrl = false;                    // the writer is typing an address of their own
    const send = (msg) => vscode.postMessage(msg);
    const set = (key, value) => {
        state.values[key] = value;           // shown at once; the extension's state follows
        if (key === "persona") state.persona = value;
        if (key === "mascot") state.mascot = value;
        if (key === "provider") state.provider = value;
        if (key === "openaiBaseUrl") listed = null;
        if (CLAUDE_PATHS.includes(key)) detected = null;
        render();
        send({ type: "set", key, value });
    };

    // ---------- the page ----------
    function render() {
        if (!state) return;
        const focus = focused();
        stashPuppets();
        for (const p of ["openai", "copilot"]) document.body.classList.toggle(`provider-${p}`, state.provider === p);   // (the provider's colour)
        app.innerHTML = piece(h`
            ${header()}
            ${runtimeBanner()}
            ${providerSwitch()}
            ${nav()}
            ${state.trusted ? "" : h`<div class="banner" role="status">
                <p><strong>Restricted Mode.</strong> A session waits until you trust this folder: Euterpe's mind reads its files, with its permission prompts off. Everything here works meanwhile.</p>
                <button class="btn" data-run="manageTrust">Trust This Folder…</button>
            </div>`}
            ${personaSection()}
            ${mascotSection()}
            ${mindSection()}
            ${readingSection()}
            ${setupSection()}
            <footer class="foot">
                <p><button class="link" data-run="settingsJson">Open settings.json</button></p>
            </footer>`);
        app.removeAttribute("aria-busy");
        placePuppets();
        restore(focus);
        spy();
    }

    function header() {
        return h`<header class="top">
            <img class="mark" src="${claude() ? app.dataset.icon : onCopilot() ? app.dataset.iconCopilot : app.dataset.iconOpenai}" alt="" width="44" height="44">
            <h1>Euterpe</h1>
        </header>`;
    }

    /**
     * The avatar's runtime (Electron), until it's there: its download, under way in the background
     * from the moment the writer clicked Euterpe or opened this window, or what stands in its way.
     */
    function runtimeBanner() {
        const r = state.runtime;
        if (!r || r.kind === "ready") return "";
        const mb = (n) => Math.round(n / 1048576);
        const body = r.kind === "downloading" ? h`<div class="runtime-text">
                    <p><strong>Getting Euterpe's avatar ready</strong> <span class="muted">· Electron, once${r.total ? `: ${mb(r.received)} of ${mb(r.total)} MB` : `: ${mb(r.received)} MB`}</span></p>
                    <progress max="${r.total || 1}" value="${r.total ? r.received : 0}" aria-label="Downloading Electron"></progress>
                </div>
                <button class="link" data-run="cancelRuntime">Cancel</button>`
            : r.kind === "unpacking" ? h`<div class="runtime-text">
                    <p><strong>Getting Euterpe's avatar ready</strong> <span class="muted">· unpacking Electron…</span></p>
                    <progress max="1" value="1" aria-label="Unpacking Electron"></progress>
                </div>`
            : r.kind === "failed" ? h`<p class="runtime-text"><strong>Euterpe's avatar couldn't be downloaded.</strong> ${r.message}</p>
                <button class="btn btn-primary" data-run="downloadRuntime">Try Again</button>`
            : r.kind === "problem" ? h`<p class="runtime-text">${r.message}</p>
                ${r.setting ? h`<button class="btn" data-run="electronSetting">Open the Setting</button>` : ""}`
            // missing, or cancelled
            : h`<p class="runtime-text"><strong>Euterpe's avatar runs on Electron, which isn't downloaded yet</strong> <span class="muted">(about 150 MB, once).</span></p>
                <button class="btn btn-primary" data-run="downloadRuntime">Download</button>`;
        const trouble = r.kind === "failed" || r.kind === "problem";
        return h`<div id="runtime" class="banner${trouble ? "" : " banner-runtime"}" role="status">${body}</div>`;
    }

    /** The runtime moved on: the banner alone, redrawn in place (the whole page when it comes or goes). */
    function updateRuntime(r) {
        state.runtime = r;
        const el = document.getElementById("runtime");
        const html = piece(runtimeBanner());
        if (el && html) el.outerHTML = html;
        else if (el || html) render();
    }

    /**
     * What the mind runs on: everything below follows it, colours included. Right under it, what it
     * takes: the API and its key, the ChatGPT sign-in, Copilot in VS Code, Claude Code (which has its own login).
     */
    function providerSwitch() {
        const p = PROVIDERS.find(([v]) => v === state.provider) || PROVIDERS[0];
        const other = state.session === "active" && state.liveProvider && state.liveProvider !== state.provider;
        const liveName = other ? (PROVIDERS.find(([v]) => v === state.liveProvider) || PROVIDERS[0])[1] : "";
        const access = state.provider === "openai" ? apiFields() : onCopilot() ? copilotField() : claudeField();
        return h`<div id="provider" class="provider-block">
            <div class="provider" role="group" aria-labelledby="provider-label">
                <span class="provider-label" id="provider-label">Mind</span>
                <div class="segmented segmented-big">
                    ${PROVIDERS.map(([v, name]) => h`<button data-set="provider" data-value="${v}" aria-pressed="${String(v === state.provider)}" data-focus="provider:${v}">${name}</button>`)}
                </div>
                <p class="muted small provider-desc">${p[2]} ${ws("provider")}${other ? h` <strong>This session stays on ${liveName}: the switch is for the next one.</strong>` : ""}</p>
            </div>
            ${access ? h`<div class="access">${access}</div>` : ""}
        </div>`;
    }

    function nav() {
        return h`<nav class="toc" aria-label="Sections">${SECTIONS.map(([id, name]) => h`<a href="#${id}" data-goto="${id}">${name}</a>`)}</nav>`;
    }

    /** A choice the running session doesn't have: it waits for the next one (only a new session takes it on). */
    function later(key) {
        const live = state.session === "active" && state.live;
        if (!live) return "";
        const now = key === "persona" ? state.persona : state.values[key];
        return now === live[key] ? "" : h`<span class="chip chip-next" role="status">Takes effect at the next session</span>`;
    }
    const ws = (key) => (state.workspace.includes(key)
        ? h`<span class="chip chip-ws" title="This workspace's settings set it, so a change here goes there.">Set by this workspace</span>` : "");

    function section(id, eyebrow, title, lede, body, chips = "") {
        return h`<section id="${id}" class="section" aria-labelledby="${id}-title">
            <div class="section-head">
                <div>
                    <p class="eyebrow">${eyebrow}</p>
                    <h2 id="${id}-title">${title}</h2>
                    ${lede ? h`<p class="lede muted">${lede}</p>` : ""}
                </div>
                <div class="chips">${chips}</div>
            </div>
            ${body}
        </section>`;
    }

    // ---------- persona ----------
    function personaSection() {
        const cards = state.personas.map((p) => {
            const current = p.id === state.persona, open = ui.read.has(p.id);
            return h`<div class="card persona${current ? " is-current" : ""}${open ? " is-open" : ""}">
                <button class="card-main" data-set="persona" data-value="${p.id}" aria-pressed="${String(current)}" data-focus="persona:${p.id}">
                    <span class="card-title">${p.name}${p.bundled ? "" : h` <span class="badge">yours</span>`}</span>
                    <span class="card-desc">${p.description || h`<em>No description.</em>`}</span>
                </button>
                <div class="card-actions">
                    <button class="link" data-read="${p.id}" aria-expanded="${String(open)}" data-focus="read:${p.id}">${open ? "Hide" : "Read it"}</button>
                    <button class="link" data-run="editPersona" data-arg="${p.id}">${p.bundled ? "Copy to edit…" : "Edit"}</button>
                </div>
                ${open ? h`<div class="persona-text">${raw(personaHtml(p.text))}</div>` : ""}
            </div>`;
        });
        return section("persona", "Persona", "Who Euterpe is", "",
            h`<div class="grid grid-personas">${cards}</div>
            <div class="actions">
                <button class="btn" data-run="newPersona">New Persona…</button>
                <button class="btn" data-run="installPersona">Install a Persona…</button>
                <button class="link" data-run="personasFolder">Open your personas folder</button>
            </div>`,
            h`${ws("persona")}${later("persona")}`);
    }

    // A persona's words, as Markdown (escaped by markdown.js); headings read as bold lines.
    function personaHtml(text) {
        const html = MD.render(String(text).replace(/^#{1,6}\s+(.*)$/gm, "**$1**"));
        return html.replace(/<button class="copy-btn">copy<\/button>/g, "");
    }

    // ---------- mascot ----------
    function mascotSection() {
        const m = currentMascot();
        const scale = state.values.avatarScale;
        const cards = state.mascots.map((x) => {
            const current = x.id === state.mascot, body = bodyOf(x);
            return h`<div class="card mascot${current ? " is-current" : ""}${body.problem ? " is-broken" : ""}">
                <button class="card-main" data-set="mascot" data-value="${x.id}" aria-pressed="${String(current)}" data-focus="mascot:${x.id}"
                    ${body.problem ? h`aria-disabled="true" title="${x.name} doesn't hold up: ${body.problem}"` : h`title="${x.description || x.name}"`}>
                    ${body.problem ? "" : h`<span class="puppet-slot" data-puppet="${x.id}"></span>`}
                    <span class="card-title">${x.name}${x.bundled ? "" : h` <span class="badge">yours</span>`}</span>
                    ${body.problem ? h`<span class="card-desc problem">Doesn't hold up: ${body.problem}</span>` : ""}
                </button>
            </div>`;
        });
        return section("mascot", "Mascot", "What Euterpe looks like",
            "The body it wears on your screen. Point at one, and it looks at you.",
            h`<div class="stage-row">
                <div class="stage" data-scale="${scale}">
                    <span class="puppet-slot" data-puppet="@stage"></span>
                    <p class="stage-mood muted" aria-live="off" id="mood"></p>
                </div>
                <div class="stage-info">
                    <h3>${m ? m.name : ""}</h3>
                    ${m && m.description ? h`<p>${m.description}</p>` : ""}
                    <div class="field">
                        <div class="field-label">Size on screen ${ws("avatarScale")} ${later("avatarScale")}</div>
                        <div class="segmented" role="group" aria-label="Size on screen">
                            ${SIZES.map(([v, name]) => h`<button data-set="avatarScale" data-value="${v}" data-type="number" aria-pressed="${String(v === scale)}" data-focus="size:${v}" aria-label="${name} (${v})" title="${name}">${v}</button>`)}
                        </div>
                        <p class="muted small">${(SIZES.find(([v]) => v === scale) || SIZES[2])[1]}</p>
                    </div>
                    ${m ? h`<button class="link" data-run="modelSheet" data-arg="${m.id}">See its model sheet</button>` : ""}
                </div>
            </div>
            <div class="grid grid-mascots" role="group" aria-label="Mascots">${cards}</div>
            <div class="actions">
                <button class="btn" data-run="makeMascot">Make One with Euterpe…</button>
                <button class="btn" data-run="installMascot">Install a Mascot…</button>
                <button class="link" data-run="mascotGuide">Mascot guide</button>
                <button class="link" data-run="mascotsFolder">Open your mascots folder</button>
            </div>`,
            ws("mascot"));
    }

    const currentMascot = () => state.mascots.find((x) => x.id === state.mascot) || state.mascots[0];

    // ---------- mind ----------
    const claude = () => state.provider === "claude";
    const onCopilot = () => state.provider === "copilot";
    const modelKey = () => (claude() ? "model" : onCopilot() ? "copilotModel" : "openaiModel");
    const onOpenAI = () => state.provider === "openai" && !!(state.api.endpoint && state.api.endpoint.openai);
    const onPlan = () => state.provider === "openai" && !!(state.api.endpoint && state.api.endpoint.chatgpt);
    /** The model the next turn runs on: the live one, else the setting (empty: the provider's default, if it has one). */
    function currentModel() {
        if (state.liveModel !== undefined) return state.liveModel;
        return state.values[modelKey()] || state.modelDefault;
    }

    function mindSection() {
        const current = currentModel();
        const own = state.provider === "openai" && !onOpenAI() && !onPlan();   // another provider's models: named, or picked from its list
        const models = state.models.map((m) => {
            const on = sameModel(m.id, current);
            return h`<div class="card choice${on ? " is-current" : ""}">
                <button class="card-main" data-set="${modelKey()}" data-value="${m.id}" aria-pressed="${String(on)}" data-focus="model:${m.id}">
                    <span class="card-title">${m.name}</span>
                    <span class="card-desc">${m.detail}</span>
                </button>
            </div>`;
        });
        const effort = state.values.effort;
        const e = EFFORTS.find(([v]) => v === effort) || EFFORTS[0];
        const another = claude() ? "Another model Claude Code knows" : onPlan() ? "Another model your plan offers" : onOpenAI() ? "Another model OpenAI's API knows" : "The model, as your provider names it";
        const ids = own && listed && listed.ids ? listed.ids : null;
        const signedOut = onPlan() && !state.api.account;
        const copilotProblem = onCopilot() && state.copilot && state.copilot.problem;
        return section("mind", "Mind", "How Euterpe thinks", "",
            h`<div class="field">
                <div class="field-label">Model ${ws(modelKey())}</div>
                ${state.modelProblem ? need(state.modelProblem) : ""}
                ${models.length ? h`<div class="grid grid-choices">${models}</div>` : ""}
                ${copilotProblem ? h`<p class="muted small">Copilot's models appear here once you're signed in.</p>` : ""}
                ${onCopilot() ? "" : signedOut ? h`<p class="muted small">Sign in with ChatGPT to see the models your plan offers.</p>` : h`<form class="other-model" data-form="model">
                    <label for="other-model">${another}</label>
                    <input id="other-model" type="text" spellcheck="false" autocomplete="off" placeholder="${claude() ? "model name" : onOpenAI() || onPlan() ? "gpt-5.6-sol" : "model id"}" data-focus="other-model"${ids ? raw(' list="api-models"') : ""}>
                    <button class="btn" type="submit">Use It</button>
                    ${own ? h`<button class="link" type="button" data-run="listModels">${ids ? `${ids.length} models listed: type to search` : "List its models"}</button>` : ""}
                </form>`}
                ${ids ? h`<datalist id="api-models">${ids.map((id) => h`<option value="${id}"></option>`)}</datalist>` : ""}
                ${own && listed && listed.problem ? h`<p class="small problem">${listed.problem}</p>` : ""}
                ${onPlan() && state.api.modelsProblem ? h`<p class="small problem">${state.api.modelsProblem}</p>` : ""}
            </div>
            <div class="field">
                <div class="field-label">Effort ${ws("effort")} ${later("effort")}</div>
                <div class="segmented" role="group" aria-label="Effort">
                    ${EFFORTS.map(([v, name]) => h`<button data-set="effort" data-value="${v}" aria-pressed="${String(v === effort)}" data-focus="effort:${v}">${name}</button>`)}
                </div>
                <p class="muted small">How hard Euterpe thinks before each turn. ${e[2]}${claude() || onCopilot() ? "" : " Not every model takes every level: Euterpe moves to the nearest one it does."}</p>
            </div>`);
    }

    /** Where the API is, and its key (kept by VS Code, never shown here). */
    function apiFields() {
        const api = state.api, ep = api.endpoint;
        const presetOn = (url) => !!ep && (url ? !ep.chatgpt && new URL(url).origin === ep.origin : ep.chatgpt);
        const custom = otherUrl || !!api.problem || (!!ep && !PRESETS.some(([url]) => presetOn(url)));
        const presets = PRESETS.map(([url, name, detail]) => {
            const on = !custom && presetOn(url);
            return h`<div class="card choice${on ? " is-current" : ""}">
                <button class="card-main" data-set="openaiBaseUrl" data-value="${url}" aria-pressed="${String(on)}" data-focus="preset:${name}">
                    <span class="card-title">${name}</span>
                    <span class="card-desc">${detail}</span>
                </button>
            </div>`;
        });
        presets.push(h`<div class="card choice${custom ? " is-current" : ""}">
            <button class="card-main" data-other-url="1" aria-pressed="${String(custom)}" data-focus="preset:other">
                <span class="card-title">Another</span>
                <span class="card-desc">Any OpenAI-compatible API, by its address</span>
            </button>
        </div>`);
        const where = ep ? new URL(ep.origin).host : "";
        const key = api.key === "local" ? h`<p class="key-line"><span class="key-dot key-local" aria-hidden="true"></span>No key needed: ${ep.name} runs on this computer.</p>`
            : api.key === "set" ? h`<p class="key-line"><span class="key-dot key-set" aria-hidden="true"></span>Euterpe has your key for ${where}.
                <button class="link" data-run="setApiKey">Change…</button> <button class="link" data-run="removeApiKey">Forget it</button></p>`
            : ep ? need(`No key yet for ${where}.`, h`<button class="btn btn-primary" data-run="setApiKey">Set API Key…</button>`)
            : h`<p class="key-line"><span class="key-dot key-missing" aria-hidden="true"></span>Set a valid address first.</p>`;   // (the address is the problem: called out above)
        const plan = !!ep && ep.chatgpt;
        const how = !ep ? "" : plan ? " · the Responses API, on your ChatGPT plan, with web search" : ep.openai ? " · the Responses API, with web search" : " · Chat Completions";
        return h`<div class="field">
                <div class="field-label">Provider</div>
                <div class="grid grid-presets">${presets}</div>
                ${custom ? h`<div class="path-input api-url">
                    <input id="api-url" type="text" spellcheck="false" autocomplete="off" value="${api.value}" placeholder="https://api.openai.com/v1" data-url="openaiBaseUrl" data-focus="api-url" aria-label="The API's base URL">
                </div>` : ""}
                ${api.problem ? need(api.problem) : ep ? h`<p class="small muted path-hint">${ep.baseURL}${how}</p>` : ""}
            </div>
            ${plan ? accountField() : h`<div class="field">
                <div class="field-label">API key</div>
                ${key}
                <p class="muted small">${api.key === "local" ? "Your writing stays on this computer, with the model."
                    : "Kept in VS Code's secret storage, and only ever sent to the address it's for. Your writing goes there too: what Euterpe reads, it sends to the model."}</p>
            </div>`}`;
    }

    /** GitHub Copilot, as VS Code has it: its models, or the way to its sign-in. The account is VS Code's: signing out is there. */
    function copilotField() {
        const problem = state.copilot && state.copilot.problem;
        const account = state.copilot && state.copilot.account;
        return h`<div class="field">
                <div class="field-label">GitHub Copilot</div>
                ${problem ? need(problem, h`<button class="btn btn-primary" data-run="setUpCopilot">Set Up Copilot…</button>`)
                    : h`<p class="key-line"><span class="key-dot key-set" aria-hidden="true"></span><span>Signed in${account ? h` as <strong>${account}</strong>` : ""}, in VS Code.</span>
                        <button class="link" data-run="manageAccounts">Manage accounts</button></p>`}
            </div>`;
    }

    /** Claude Code, as a session would find it: there, or what's wrong (with the way to fix it). */
    function claudeField() {
        const folder = state.paths.claudeConfigDir.problem;
        const line = folder ? need(folder, h`<button class="btn btn-primary" data-run="browse" data-arg="claudeConfigDir">Choose a Folder…</button>`)
            : !detected ? h`<p class="key-line"><span class="key-dot" aria-hidden="true"></span>Looking for Claude Code…</p>`
            : detected.ok ? h`<p class="key-line"><span class="key-dot key-set" aria-hidden="true"></span>Claude Code ${detected.version} is installed.</p>`
            : detected.missing ? need("Claude Code isn't installed.", h`<button class="btn btn-primary" data-run="installClaude">Install Claude Code…</button>`)
            // too old, or not what euterpe.claudePath names
            : need(detected.text, state.values.claudePath ? h`<button class="btn btn-primary" data-run="browse" data-arg="claudePath">Choose a File…</button>` : "");
        return h`<div class="field">
                <div class="field-label">Claude Code</div>
                ${line}
            </div>`;
    }

    /** What the chosen mind still needs before a session can start, where nobody can miss it: what's missing, and the way to it. */
    function need(text, button = "") {
        return h`<div class="need">
                <span class="need-mark" aria-hidden="true">!</span>
                <p class="need-text">${text}</p>
                ${button}
            </div>`;
    }

    /** The ChatGPT plan: who's signed in (the tokens stay in VS Code's secret storage). */
    function accountField() {
        const api = state.api, a = api.account;
        const line = api.signingIn ? h`<p class="key-line"><span class="key-dot key-missing" aria-hidden="true"></span>Waiting for you to sign in, in your browser…
                <button class="link" data-run="cancelSignIn">Cancel</button></p>`
            : a ? h`<p class="key-line"><span class="key-dot key-set" aria-hidden="true"></span><span>Signed in${a.email ? h` as <strong>${a.email}</strong>` : ""}. Using ChatGPT plan.</span>
                <button class="link" data-run="manageUsage">Manage usage</button> <button class="link" data-run="signOut">Sign out</button></p>`
            : need(api.ended || "Not signed in yet.", h`<button class="btn btn-primary" data-run="signIn">Continue with ChatGPT…</button>`);
        return h`<div class="field">
                <div class="field-label">ChatGPT account</div>
                ${line}
            </div>`;
    }

    /** Already the choice. */
    function isCurrent(key, value) {
        if (key === "persona") return value === state.persona;
        if (key === "mascot") return value === state.mascot;
        if (key === "model" || key === "openaiModel" || key === "copilotModel") return sameModel(value, currentModel());
        if (key === "openaiBaseUrl") return !otherUrl && value === state.values.openaiBaseUrl;
        return value === state.values[key];
    }

    const sameModel = (a, b) => String(a).trim().toLowerCase().replace(/\[1m\]$/, "") === String(b).trim().toLowerCase().replace(/\[1m\]$/, "");

    // ---------- reading along ----------
    function readingSection() {
        const attention = state.values.attention;
        return section("reading", "Reading along", "How Euterpe reads along", "",
            h`<div class="field">
                <div class="field-label">Attention ${ws("attention")} ${later("attention")}</div>
                <div class="grid grid-choices">${ATTENTION.map(([v, name, desc]) => h`<div class="card choice${v === attention ? " is-current" : ""}">
                    <button class="card-main" data-set="attention" data-value="${v}" aria-pressed="${String(v === attention)}" data-focus="attention:${v}">
                        <span class="card-title">${name}</span>
                        <span class="card-desc">${desc}</span>
                    </button>
                </div>`)}</div>
            </div>
            <div class="field">
                ${toggle("followActiveEditor", "Follow me to other documents", "After a couple of seconds on another file, Euterpe reads that one. Off: it stays with the document the session started on.")}
            </div>`);
    }

    function toggle(key, label, desc) {
        const on = !!state.values[key];
        return h`<label class="switch">
            <input type="checkbox" role="switch" data-toggle="${key}" ${on ? "checked" : ""} data-focus="toggle:${key}">
            <span class="switch-track" aria-hidden="true"></span>
            <span class="switch-text"><span class="switch-label">${label} ${ws(key)} ${later(key)}</span><span class="muted small">${desc}</span></span>
        </label>`;
    }

    // ---------- setup ----------
    function setupSection() {
        const rows = PATHS.filter(([, , , , only]) => !only || only === state.provider).map(([key, label, desc, empty]) => {
            const p = state.paths[key];
            const hint = key === "claudePath" && !p.value && detected ? detected : null;
            return h`<div class="path-row">
                <label class="field-label" for="path-${key}">${label}</label>
                <p class="muted small">${desc}</p>
                <div class="path-input">
                    <input id="path-${key}" type="text" spellcheck="false" autocomplete="off" value="${p.value}" placeholder="${empty}" data-path="${key}" data-focus="path:${key}">
                    <button class="btn" data-run="browse" data-arg="${key}">Browse…</button>
                    ${p.value ? h`<button class="btn" data-clear="${key}" title="Back to the default">Reset</button>` : ""}
                </div>
                ${p.problem ? h`<p class="small problem">${p.problem}</p>`
                    : hint || p.hint ? h`<p class="small muted path-hint">${hint ? (hint.ok ? hint.text : h`<span class="problem">${hint.text}</span>`) : p.hint}</p>` : ""}
            </div>`;
        });
        return h`<section id="setup" class="section" aria-labelledby="setup-title">
            <details class="setup" ${ui.setupOpen ? "open" : ""}>
                <summary>
                    <p class="eyebrow">Setup</p>
                    <h2 id="setup-title">Where things are</h2>
                </summary>
                <div class="setup-body">
                    ${rows}
                    <div class="field">${toggle("debugMind", "Debug the mind", "An Euterpe Mind terminal shows everything Euterpe sees and says, with each turn's token use.")}</div>
                    <div class="actions">
                        <button class="btn" data-run="checkSetup">Check Setup</button>
                        <button class="btn" data-run="showLog">Show Log</button>
                        <button class="btn" data-run="openMemory">Open Euterpe's Memory</button>
                    </div>
                </div>
            </details>
        </section>`;
    }

    // ---------- keeping the writer's place across a redraw ----------
    function focused() {
        const el = document.activeElement;
        if (!el || !el.dataset || !el.dataset.focus) return null;
        return { key: el.dataset.focus, value: el.value, start: el.selectionStart, end: el.selectionEnd };
    }
    function restore(f) {
        // a redraw while the writer is in the editor mustn't pull the keyboard into this page
        if (!f || !document.hasFocus()) return;
        const el = app.querySelector(`[data-focus="${CSS.escape(f.key)}"]`);
        if (!el) return;
        if (f.value !== undefined && el.tagName === "INPUT" && el.type === "text") {
            el.value = f.value;
            try { el.setSelectionRange(f.start, f.end); } catch { /* not a text field */ }
        }
        el.focus({ preventScroll: true });
    }

    // ---------- what the writer does ----------
    app.addEventListener("click", (e) => {
        const t = e.target.closest("button, a");
        if (!t || !app.contains(t)) return;
        if (t.dataset.goto) {
            e.preventDefault();
            goTo(t.dataset.goto);
        } else if (t.dataset.set) {
            if (t.getAttribute("aria-disabled") === "true") return;
            const key = t.dataset.set, value = t.dataset.type === "number" ? +t.dataset.value : t.dataset.value;
            if (isCurrent(key, value)) return;
            if (key === "mascot") cheer(value);
            if (key === "model" || key === "openaiModel" || key === "copilotModel") state.liveModel = undefined;
            if (key === "openaiBaseUrl") otherUrl = false;
            if (key === "provider") { state.liveModel = undefined; listed = null; otherUrl = false; }
            set(key, value);
        } else if (t.dataset.otherUrl) {
            otherUrl = true;
            render();
            const input = document.getElementById("api-url");
            if (input) input.focus();
        } else if (t.dataset.run) {
            send({ type: "run", action: t.dataset.run, arg: t.dataset.arg });
        } else if (t.dataset.read) {
            const id = t.dataset.read;
            ui.read.has(id) ? ui.read.delete(id) : ui.read.add(id);
            keep();
            render();
        } else if (t.dataset.clear) {
            set(t.dataset.clear, "");
        }
    });
    app.addEventListener("change", (e) => {
        const t = e.target;
        if (t.dataset.toggle) set(t.dataset.toggle, t.checked);
        else if (t.dataset.path && t.value.trim() !== state.values[t.dataset.path]) set(t.dataset.path, t.value.trim());
        else if (t.dataset.url && t.value.trim() !== state.values[t.dataset.url]) {
            if (t.value.trim() && !/^https?:\/\/\S+$/i.test(t.value.trim())) { t.setCustomValidity("An http or https address, like https://openrouter.ai/api/v1."); t.reportValidity(); return; }
            set(t.dataset.url, t.value.trim());
        }
    });
    app.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = e.target.querySelector("input");
        const model = input.value.trim();
        if (!model) return;
        if (/\s/.test(model)) { input.setCustomValidity(`A model name is one word, like ${claude() ? "claude-sonnet-5-5" : onOpenAI() ? "gpt-5.6-sol" : "llama3.3"}.`); input.reportValidity(); return; }
        input.value = "";
        state.liveModel = undefined;
        if (!state.models.some((m) => sameModel(m.id, model))) state.models.push({ id: model, name: model, detail: claude() || onOpenAI() ? "A model you named" : "The model you named" });
        set(modelKey(), model);
    });
    app.addEventListener("input", (e) => { if (e.target.id === "other-model" || e.target.id === "api-url") e.target.setCustomValidity(""); });
    // (a redraw with the section open fires this too: only a real change counts)
    app.addEventListener("toggle", (e) => {
        if (!e.target.classList || !e.target.classList.contains("setup") || e.target.open === ui.setupOpen) return;
        ui.setupOpen = e.target.open;
        keep();
        if (ui.setupOpen) send({ type: "detect" });
    }, true);

    function goTo(id) {
        const el = document.getElementById(id);
        if (!el) return;
        if (id === "setup" && !ui.setupOpen) {
            ui.setupOpen = true;
            keep();
            render();
            send({ type: "detect" });
        }
        const target = document.getElementById(id);
        // The choice of mind is at the top: the page's top, so the banner above it (the avatar's download) shows too.
        if (id === "provider") window.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
        else target.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
        target.classList.remove("flash");
        void target.offsetWidth;
        target.classList.add("flash");
    }

    // The nav follows the reading position: the last section whose top is in the upper third.
    // (From the scroll position: in a webview's cross-origin frame, an observer's margins don't apply.)
    function spy() {
        let here = SECTIONS[0][0];
        for (const [id] of SECTIONS) {
            const el = document.getElementById(id);
            if (el && el.getBoundingClientRect().top <= innerHeight / 3) here = id;
        }
        if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) here = SECTIONS[SECTIONS.length - 1][0];
        for (const a of app.querySelectorAll(".toc a")) a.classList.toggle("is-here", a.dataset.goto === here);
    }
    addEventListener("scroll", () => requestAnimationFrame(spy), { passive: true });

    window.addEventListener("message", (e) => {
        const msg = e.data;
        if (msg.type === "state") {
            if (state && CLAUDE_PATHS.some((k) => state.values[k] !== msg.state.values[k])) detected = null;   // another Claude Code, maybe
            state = msg.state;
            render();
            // Claude Code, for the choice of mind and Setup: looked for again while it isn't there (it may have just been installed)
            if (claude() && (!detected || !detected.ok)) send({ type: "detect" });
        } else if (msg.type === "runtime") {
            if (state) updateRuntime(msg.runtime);
        } else if (msg.type === "focus") {
            goTo(msg.section);
        } else if (msg.type === "models") {
            listed = msg.ids ? { ids: msg.ids } : { problem: msg.problem || "No models listed." };
            render();
        } else if (msg.type === "detected") {
            const same = detected && JSON.stringify(detected) === JSON.stringify(msg.claude);
            detected = msg.claude;
            if (!same) render();
        }
    });

    // ---------- the mascots, alive ----------
    // Each one is a little stage of its own: the overlay's 80 × 64 frame, its own director (so
    // they blink and glance at their own moments), drawn with nearest-neighbour scaling. They
    // share one timer, "on twos" like the overlay, and rest while nobody can see them.
    const W = 80, H = 64, GX = 40, GY = 57, FPS = 12;
    const now = () => performance.now() / 1000;
    const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    const bodies = new Map();   // mascot id -> { key, body, problem }

    /** A mascot's body for the engine (Clawd is drawn by hand), compiled once per version of its pack. */
    function bodyOf(m) {
        const key = m.pack ? JSON.stringify(m.pack) : "clawd";
        const known = bodies.get(m.id);
        if (known && known.key === key) return known;
        let body = C.CLAWD, problem = null;
        if (m.pack) {
            try { body = C.compileMascot(m.pack, m.id); }
            catch (err) { problem = String(err.message || err).split("\n")[0]; }
        }
        const b = { key, body, problem };
        bodies.set(m.id, b);
        return b;
    }

    class Puppet {
        /** top: art rows left out above (a gallery card has no use for the emotes' headroom). */
        constructor(scale, seed, top = 0) {
            this.top = top;
            this.canvas = document.createElement("canvas");
            this.canvas.className = "puppet";
            this.canvas.setAttribute("aria-hidden", "true");
            this.frame = new C.Frame(W, H);
            this.buf = document.createElement("canvas");
            this.buf.width = W; this.buf.height = H;
            this.bufCtx = this.buf.getContext("2d");
            this.image = this.bufCtx.createImageData(W, H);
            this.image32 = new Uint32Array(this.image.data.buffer);
            this.seed = seed;
            this.director = new C.Director({ seed });
            this.director.enter(-30);
            this.visible = true;
            this.info = null;
            this.setScale(scale);
        }
        setScale(scale) {
            const dpr = window.devicePixelRatio || 1;
            this.scale = scale;
            this.px = Math.max(1, Math.round(scale * dpr));
            this.canvas.width = W * this.px;
            this.canvas.height = (H - this.top) * this.px;
            // the height follows (height: auto), so a narrow window can shrink the stage whole
            this.canvas.style.width = `${(W * this.px) / dpr}px`;
            this.ctx = this.canvas.getContext("2d");
            this.ctx.imageSmoothingEnabled = false;
        }
        draw(t, body) {
            C.useMascot(body);
            this.frame.clear();
            this.info = this.director.render(this.frame, GX, GY, t);
            this.image32.set(this.frame.data);
            this.bufCtx.putImageData(this.image, 0, 0);
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(this.buf, 0, this.top, W, H - this.top, 0, 0, this.canvas.width, this.canvas.height);
        }
        /** Eyes on the pointer, when it's near enough (the director decides). */
        look(x, y, t, body) {
            const r = this.canvas.getBoundingClientRect();
            if (!r.width) return;
            const k = r.width / W;   // screen pixels per art pixel, as it's shown
            this.director.lookAt((x - r.left) / k - GX, (y - r.top) / k + this.top - (GY + body.eyeY), t);
        }
    }

    // The gallery: one puppet per mascot, kept across redraws (the page is rebuilt, they aren't).
    const gallery = new Map();   // id -> Puppet
    let seedN = 11;
    // The big stage: the mascot Euterpe wears, at the size it will be, going through its moods.
    const stage = { puppet: null, id: null, next: null, beat: 0, at: 0 };

    function stashPuppets() {
        for (const p of gallery.values()) p.canvas.remove();
        if (stage.puppet) stage.puppet.canvas.remove();
    }

    function placePuppets() {
        const ids = new Set(state.mascots.map((m) => m.id));
        for (const id of [...gallery.keys()]) if (!ids.has(id)) gallery.delete(id);
        for (const slot of app.querySelectorAll(".puppet-slot")) {
            const id = slot.dataset.puppet;
            if (id === "@stage") { slot.appendChild(stagePuppet().canvas); continue; }
            let p = gallery.get(id);
            if (!p) { p = new Puppet(2, seedN += 7, 10); gallery.set(id, p); }
            slot.appendChild(p.canvas);
        }
        observe();
        mood();
    }

    function stagePuppet() {
        const scale = state.values.avatarScale;
        const want = state.mascot;
        if (!stage.puppet) {
            stage.puppet = new Puppet(scale, 5);
            stage.id = want;
            const t = now();
            if (!ui.seen && !reduced()) {
                // Euterpe walks on, as it does at a session's start
                stage.puppet.director = new C.Director({ seed: 5 });
                stage.puppet.director.enter(t + 0.2);
                stage.at = t + 0.2 + C.ENTER + 0.6;
            } else {
                stage.at = t + 1.2;
            }
            ui.seen = true;
            keep();
        } else if (stage.puppet.scale !== scale) {
            stage.puppet.setScale(scale);
        }
        if (want !== stage.id && want !== stage.next) {
            // one walks off, the other walks in (reduced motion: they just swap)
            if (reduced()) { stage.id = want; stage.next = null; }
            else { stage.next = want; stage.puppet.director.exit(now()); }
        }
        return stage.puppet;
    }

    /** The moods the big stage goes through: a feel for the mascot, and for Euterpe. */
    const REEL = [
        { expr: "happy", act: "wave", talk: 1.4 },
        { expr: "reading" },
        { expr: "idea", act: "jump" },
        { expr: "laugh", talk: 1.1 },
        { expr: "thinking" },
        { expr: "love", act: "clap" },
        { expr: "curious", act: "peek" },
        { expr: "mischief", act: "facepalm" },
        { expr: "proud", act: "cheer" },
        { expr: "sleepy", act: "yawn" },
        { expr: "surprised", act: "startle" },
        { expr: "cool", act: "dance" },
        { expr: "concerned" },
        { expr: "neutral", act: "nod", talk: 0.9 },
    ];

    function runStage(t) {
        const p = stage.puppet;
        if (!p) return;
        if (stage.next && p.director.exitDone(t)) {
            stage.id = stage.next;
            stage.next = null;
            p.director = new C.Director({ seed: 5 });
            p.director.enter(t);
            stage.at = t + C.ENTER + 0.5;
            stage.mood = "";
            mood();
        }
        if (!stage.next && !reduced() && t >= stage.at) {
            const beat = REEL[stage.beat++ % REEL.length];
            p.director.setExpression(beat.expr, t);
            if (beat.act) p.director.play(beat.act, t);
            if (beat.talk) p.director.talk(t + 0.3, beat.talk);
            stage.at = t + Math.max(3.4, beat.act ? C.ACTIONS[beat.act].dur + 1.8 : 0);
            stage.mood = beat.act ? `${beat.expr} · ${beat.act}` : beat.expr;
            mood();
        }
    }

    function mood() {
        const el = document.getElementById("mood");
        if (el) el.textContent = stage.mood && !stage.next ? stage.mood : "";
    }

    /** The mascot the writer just picked is pleased about it. */
    function cheer(id) {
        const p = gallery.get(id);
        if (!p || reduced()) return;
        const t = now();
        p.director.setExpression("happy", t);
        p.director.play("jump", t);
    }

    const byId = (id) => state && state.mascots.find((m) => m.id === id);

    /** What stands in for a body that doesn't hold up: Clawd, or off Claude the default pack (Clawd stays with Claude). */
    function fallbackBody() {
        const m = state.provider === "claude" ? null : byId(state.defaultMascot);
        const b = m && bodyOf(m);
        return b && !b.problem ? b.body : C.CLAWD;
    }

    let timer = null, lastDrawing = -1;
    function tick() {
        timer = null;
        if (document.hidden || !state) return;
        const t = now(), n = Math.floor(t * FPS);
        if (n !== lastDrawing) {
            lastDrawing = n;
            const tt = n / FPS;
            runStage(tt);
            try {
                for (const [id, p] of gallery) {
                    const m = byId(id);
                    if (!p.visible || !m) continue;
                    const b = bodyOf(m);
                    if (!b.problem) p.draw(tt, b.body);
                }
                const sm = byId(stage.id);
                if (stage.puppet && stage.puppet.visible && sm) {
                    const b = bodyOf(sm);
                    stage.puppet.draw(tt, b.problem ? fallbackBody() : b.body);
                }
            } catch (err) {
                console.error("a frame failed", err);   // skip it, never freeze
            }
        }
        timer = setTimeout(tick, Math.max(4, ((n + 1) / FPS - now()) * 1000 + 1));
    }
    const wake = () => { if (!timer && !document.hidden) tick(); };
    document.addEventListener("visibilitychange", wake);

    // Only the puppets on screen are drawn.
    let seenObserver = null;
    function observe() {
        if (seenObserver) seenObserver.disconnect();
        const all = [...gallery.values(), ...(stage.puppet ? [stage.puppet] : [])];
        const of = new Map(all.map((p) => [p.canvas, p]));
        seenObserver = new IntersectionObserver((entries) => {
            for (const e of entries) { const p = of.get(e.target); if (p) p.visible = e.isIntersecting; }
        });
        for (const p of all) seenObserver.observe(p.canvas);
        wake();
    }

    document.addEventListener("mousemove", (e) => {
        if (!state) return;
        const t = now();
        for (const [id, p] of gallery) { const m = byId(id); if (m && p.visible) p.look(e.clientX, e.clientY, t, bodyOf(m).body); }
        const sm = byId(stage.id);
        if (stage.puppet && sm) stage.puppet.look(e.clientX, e.clientY, t, bodyOf(sm).body);
    });
    document.documentElement.addEventListener("mouseleave", () => {
        for (const p of gallery.values()) p.director.lookClear();
        if (stage.puppet) stage.puppet.director.lookClear();
    });
    // A click on the big stage: a boop, as on the overlay.
    app.addEventListener("pointerdown", (e) => {
        if (stage.puppet && e.target === stage.puppet.canvas) stage.puppet.director.boop(now());
    });

    send({ type: "ready" });
})();
