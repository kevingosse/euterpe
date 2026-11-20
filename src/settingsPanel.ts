// "Euterpe: Open Settings": a window of Euterpe's own for its settings, since VS Code's settings
// page can't list the writer's own personas and mascots, or show a mascot. The page is
// settings/settings.js, drawing the mascots live with the overlay's engine (overlay/renderer/clawd);
// this side gathers what it shows (settingsModel.ts) and applies what the writer changes, as the
// choosers do. VS Code's settings stay where the values live.

import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ChatGptLogin, EndedLogin, MANAGE_USAGE_URL, planDefault, PlanModel } from "./chatgpt";
import { resolveClaude } from "./claudeCli";
import { UnknownSettingError, updateSetting } from "./config";
import { ELECTRON_VERSION, findElectron } from "./electronRuntime";
import { chooseMascot, defaultMascot, listMascots } from "./mascots";
import {
    installMascot, makeWithEuterpe, MascotHost, mascotDirs, openMascotGuide, openMascotsFolder, previewMascot, wearMascot,
} from "./mascotCommands";
import { buildMindEnv } from "./claudeMind";
import { ModelHost, useModel } from "./modelCommands";
import { defaultModel } from "./models";
import { apiClient } from "./openaiMind";
import { editPersona, installPersona, newPersona, openPersonasFolder, PersonaHost, personaDirs, usePersona } from "./personaCommands";
import { choosePersona, listPersonas, loadPersonaFile } from "./personas";
import { Endpoint, endpointFor, Provider, providerFor } from "./providers";
import { expandHome, memoryDir, resolveConfigDir } from "./session";
import {
    ApiView, checkSetting, MACHINE_SETTINGS, mascotView, ModelView, modelViews, PATH_SETTINGS, PathSetting, PathView, personaView, SETTINGS,
    SettingKey, SettingsState, SettingValue,
} from "./settingsModel";

export interface SettingsHost extends MascotHost, PersonaHost, ModelHost {
    sessionState(): SettingsState["session"];
    /** The CLI inside the Claude Code VS Code extension, if it's installed. */
    bundledClaude(): string | null;
    /** The writer's key for an API (from VS Code's secret storage), if there's one. */
    apiKey(e: Endpoint): Promise<string | undefined>;
    setApiKey(e: Endpoint): Promise<string | undefined>;
    removeApiKey(e: Endpoint): Promise<void>;
    /** The ChatGPT sign-in, if there's one. */
    chatgptLogin(): Promise<ChatGptLogin | undefined>;
    /** The ChatGPT sign-in that ended (OpenAI wouldn't renew it), if nobody signed in since. */
    chatgptEnded(): Promise<EndedLogin | undefined>;
    /** A ChatGPT sign-in is waiting for the writer in their browser. */
    signingIn(): boolean;
    signIn(): Promise<ChatGptLogin | undefined>;
    cancelSignIn(): void;
    signOut(): Promise<void>;
    /** The models the writer's ChatGPT plan offers. */
    planModels(): Promise<PlanModel[]>;
}

/** How long the window trusts the plan's models it listed. */
const PLAN_MODELS_TTL_MS = 10 * 60_000;

/** The window's sections, which a link can open it at (euterpe.openSettings "mascot"). */
const SECTIONS = ["persona", "mascot", "mind", "reading", "setup"];
/** The overlay's engine, in the order the overlay loads it. */
const ENGINE = ["core.js", "glyphs.js", "rig.js", "body.js", "pack.js", "emotes.js", "acting.js", "director.js"];

export class SettingsPanel implements vscode.Disposable {
    static readonly viewType = "euterpe.settings";
    private static current: SettingsPanel | undefined;

    private readonly subscriptions: vscode.Disposable[] = [];
    private refreshTimer: NodeJS.Timeout | undefined;
    /** A section to show once the page is ready. */
    private pendingSection: string | undefined;
    /** Claude Code as found for the Setup section: found once per setting. */
    private detected: { key: string; text: Promise<{ ok: boolean; text: string }> } | undefined;
    /** The models the ChatGPT plan offers, as last listed for its account. */
    private plan: { account: string; at: number; models: Promise<PlanModel[]> } | undefined;

    /** Open the window (or bring it forward), at `section` if one is named. */
    static show(host: SettingsHost, section?: unknown): void {
        const at = typeof section === "string" && SECTIONS.includes(section) ? section : undefined;
        if (SettingsPanel.current) {
            SettingsPanel.current.panel.reveal();
            if (at) { void SettingsPanel.current.panel.webview.postMessage({ type: "focus", section: at }); }
            return;
        }
        const panel = vscode.window.createWebviewPanel(SettingsPanel.viewType, "Euterpe Settings", vscode.ViewColumn.Active,
            SettingsPanel.options(host));
        SettingsPanel.current = new SettingsPanel(panel, host, at);
    }

    /** VS Code brings back the window it had open before it restarted. */
    static restore(host: SettingsHost, panel: vscode.WebviewPanel): void {
        SettingsPanel.current?.dispose();
        panel.webview.options = SettingsPanel.options(host);
        SettingsPanel.current = new SettingsPanel(panel, host);
    }

    /** Something the window shows changed outside it (a session started or ended). */
    static refresh(): void {
        SettingsPanel.current?.scheduleRefresh();
    }

    private static options(host: SettingsHost): vscode.WebviewOptions & vscode.WebviewPanelOptions {
        const root = vscode.Uri.file(host.extensionRoot);
        return {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(root, "settings"), vscode.Uri.joinPath(root, "overlay", "renderer"), vscode.Uri.joinPath(root, "media")],
        };
    }

    private constructor(private readonly panel: vscode.WebviewPanel, private readonly host: SettingsHost, section?: string) {
        this.pendingSection = section;
        panel.iconPath = vscode.Uri.file(path.join(host.extensionRoot, "media", "icon.png"));
        panel.webview.html = this.html();
        this.subscriptions.push(
            panel.onDidDispose(() => this.dispose()),
            panel.webview.onDidReceiveMessage((msg) => void this.receive(msg)),
            panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible) { this.scheduleRefresh(); } }),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (!e.affectsConfiguration("euterpe")) { return; }
                if (e.affectsConfiguration("euterpe.claudePath") || e.affectsConfiguration("euterpe.claudeConfigDir")) { this.detected = undefined; }
                this.scheduleRefresh();
            }),
        );
    }

    dispose(): void {
        if (SettingsPanel.current === this) { SettingsPanel.current = undefined; }
        clearTimeout(this.refreshTimer);
        for (const d of this.subscriptions.splice(0)) { d.dispose(); }
        this.panel.dispose();
    }

    private scheduleRefresh(): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.post(), 60);
    }

    private async post(): Promise<boolean> {
        let state: SettingsState;
        try {
            state = await this.state();
        } catch (err) {
            this.host.output.appendLine(`settings window: ${(err as Error).stack ?? err}`);
            return false;
        }
        // the tab wears the provider's colours too
        this.panel.iconPath = vscode.Uri.file(path.join(this.host.extensionRoot, "media", state.provider === "openai" ? "icon-openai.png" : "icon.png"));
        return this.panel.webview.postMessage({ type: "state", state });
    }

    private async receive(msg: any): Promise<void> {
        try {
            if (msg?.type === "ready") {
                await this.post();
                if (this.pendingSection) {
                    void this.panel.webview.postMessage({ type: "focus", section: this.pendingSection });
                    this.pendingSection = undefined;
                }
                return;
            }
            if (msg?.type === "set") {
                const change = checkSetting(msg.key, msg.value);
                if (change) { await this.set(change.key, change.value); }
                else { this.host.output.appendLine(`settings window: ignored ${JSON.stringify(msg).slice(0, 200)}`); }
            } else if (msg?.type === "run" && typeof msg.action === "string") {
                await this.run(msg.action, msg.arg);
            } else if (msg?.type === "detect") {
                void this.detect();
                return;
            }
        } catch (err) {
            if (err instanceof UnknownSettingError) {
                void vscode.window.showErrorMessage(err.message, "Reload Window").then((pick) => {
                    if (pick) { void vscode.commands.executeCommand("workbench.action.reloadWindow"); }
                });
            } else {
                void vscode.window.showErrorMessage(`Euterpe's settings: ${(err as Error).message}`);
            }
        }
        // What the page shows may not have happened (a refused model, a prompt declined): show what did.
        await this.post();
    }

    /** A value the writer chose in the window, applied as the choosers apply it. */
    private async set(key: SettingKey, value: SettingValue): Promise<void> {
        const host = this.host;
        if (key === "persona") {
            const { bundled, mine } = personaDirs(host);
            const p = listPersonas(bundled, mine).find((x) => x.id === value);
            if (p) { await usePersona(host, p, true); }
        } else if (key === "mascot") {
            const { bundled, mine } = mascotDirs(host);
            const m = listMascots(bundled, mine, this.provider()).find((x) => x.id === value);
            if (m) { await wearMascot(host, m); }
        } else if (key === "model" || key === "openaiModel") {
            await useModel(host, value as string, key === "model" ? "claude" : "openai");
        } else if (key === "openaiBaseUrl") {
            // (the plan is OpenAI's API too, with its own models)
            const which = () => { const e = this.endpoint(); return e?.chatgpt ? "chatgpt" : e?.origin; };
            const before = which();
            await updateSetting(key, value);
            // Model names don't travel between providers: another one starts on its own default.
            if (which() !== before) { await updateSetting("openaiModel", undefined); }
        } else {
            await updateSetting(key, value);
        }
    }

    private async run(action: string, arg: unknown): Promise<void> {
        const host = this.host;
        const persona = () => {
            const { bundled, mine } = personaDirs(host);
            return listPersonas(bundled, mine).find((p) => p.id === arg);
        };
        const mascot = () => {
            const { bundled, mine } = mascotDirs(host);
            return listMascots(bundled, mine, this.provider()).find((m) => m.id === arg);
        };
        switch (action) {
            case "editPersona": { const p = persona(); if (p) { await editPersona(host, p); } break; }
            case "newPersona": await newPersona(host); break;
            case "installPersona": await installPersona(host); break;
            case "personasFolder": await openPersonasFolder(host); break;
            case "clearPersonaFile": await updateSetting("personaFile", undefined); break;
            case "installMascot": await installMascot(host); break;
            case "makeMascot": await makeWithEuterpe(host); break;
            case "mascotGuide": await openMascotGuide(host); break;
            case "mascotsFolder": await openMascotsFolder(host); break;
            case "modelSheet": { const m = mascot(); if (m) { await previewMascot(host, m); } break; }
            case "browse": if ((PATH_SETTINGS as readonly unknown[]).includes(arg)) { await this.browse(arg as PathSetting); } break;
            case "checkSetup": await vscode.commands.executeCommand("euterpe.checkSetup"); break;
            case "showLog": host.output.show(); break;
            case "openMemory": await vscode.commands.executeCommand("euterpe.openMemory"); break;
            case "settingsJson": await vscode.commands.executeCommand("workbench.action.openSettingsJson"); break;
            case "vscodeSettings": await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:kevingosse.euterpe"); break;
            case "manageTrust": await vscode.commands.executeCommand("workbench.trust.manage"); break;
            case "setApiKey": { const e = this.endpoint(); if (e) { await host.setApiKey(e); } break; }
            case "removeApiKey": { const e = this.endpoint(); if (e) { await host.removeApiKey(e); } break; }
            // (not awaited: the window shows the wait meanwhile, with a way to cancel it)
            case "signIn": this.plan = undefined; void host.signIn(); break;
            case "manageUsage": await vscode.env.openExternal(vscode.Uri.parse(MANAGE_USAGE_URL)); break;
            case "cancelSignIn": host.cancelSignIn(); break;
            case "signOut": await host.signOut(); this.plan = undefined; break;
            case "listModels": void this.listModels(); break;
            case "startSession": await host.startSession(); break;
        }
    }

    /** What the window is set up for: the mind of the next session. */
    private provider(): Provider {
        return providerFor(vscode.workspace.getConfiguration("euterpe").get("provider"));
    }

    /** The OpenAI-compatible API in the settings, or undefined when its address isn't one. */
    private endpoint(): Endpoint | undefined {
        try { return endpointFor(vscode.workspace.getConfiguration("euterpe").get<string>("openaiBaseUrl")); } catch { return undefined; }
    }

    /** The models the API lists (GET /models), for the window's model field. */
    private async listModels(): Promise<void> {
        const e = this.endpoint();
        let reply: { ids?: string[]; problem?: string };
        if (!e) {
            reply = { problem: "The API's address isn't a web address." };
        } else {
            try {
                const key = await this.host.apiKey(e);
                if (!key && !e.local) {
                    reply = { problem: `Set your API key for ${e.name} first.` };
                } else {
                    const client = apiClient(e.baseURL, key ?? "", { maxRetries: 1, timeout: 20_000 });
                    const ids: string[] = [];
                    for await (const m of client.models.list()) {
                        if (typeof m?.id === "string") { ids.push(m.id); }
                        if (ids.length >= 2000) { break; }
                    }
                    reply = ids.length ? { ids: ids.sort((a, b) => a.localeCompare(b)) } : { problem: `${e.name} lists no models.` };
                }
            } catch (err) {
                reply = { problem: `${e.name} didn't list its models: ${(err as Error).message.slice(0, 200)}` };
            }
        }
        void this.panel.webview.postMessage({ type: "models", ...reply });
    }

    /** Pick a path setting's file or folder. */
    private async browse(key: PathSetting): Promise<void> {
        const folder = key === "homeDir" || key === "claudeConfigDir";
        const current = vscode.workspace.getConfiguration("euterpe").get<string>(key)?.trim();
        const [uri] = await vscode.window.showOpenDialog({
            title: { homeDir: "Euterpe's Home", claudeConfigDir: "Claude Code Config Folder", claudePath: "The claude Executable", electronPath: "An Electron Executable", personaFile: "A Persona File" }[key],
            canSelectFiles: !folder,
            canSelectFolders: folder,
            canSelectMany: false,
            defaultUri: current ? vscode.Uri.file(expandHome(current)) : undefined,
            filters: key === "personaFile" ? { Persona: ["md"] } : undefined,
        }) ?? [];
        if (uri) { await updateSetting(key, uri.fsPath); }
    }

    /** Claude Code as a session would find it, for the Setup section (it runs `claude --version`). */
    private async detect(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration("euterpe");
        const setting = cfg.get<string>("claudePath") || "";
        const key = `${setting}\n${cfg.get<string>("claudeConfigDir") || ""}`;
        if (this.detected?.key !== key) {
            let configDir = "";
            try { configDir = resolveConfigDir(cfg.get<string>("claudeConfigDir") || ""); } catch { /* shown as the folder's problem */ }
            this.detected = {
                key,
                text: resolveClaude(setting, this.host.bundledClaude(), buildMindEnv(process.env, configDir), () => { /* the result says it */ })
                    .then((c) => ({ ok: true, text: `In use: Claude Code ${c.version}, ${c.path}` }), (err: Error) => ({ ok: false, text: err.message })),
            };
        }
        const claude = await this.detected.text;
        void this.panel.webview.postMessage({ type: "detected", claude });
    }

    // ---------- what the window shows ----------

    private async state(): Promise<SettingsState> {
        const host = this.host;
        const cfg = vscode.workspace.getConfiguration("euterpe");
        const keys = Object.keys(SETTINGS) as SettingKey[];
        const values = Object.fromEntries(keys.map((k) => [k, cfg.get(k)])) as Record<SettingKey, SettingValue>;
        const workspace = keys.filter((k) => cfg.inspect(k)?.workspaceValue !== undefined && !(MACHINE_SETTINGS as readonly string[]).includes(k));
        const provider = providerFor(values.provider);
        const api = await this.api(String(values.openaiBaseUrl ?? ""));

        const pd = personaDirs(host);
        const personas = listPersonas(pd.bundled, pd.mine);
        let persona = String(values.persona ?? "");
        try { persona = choosePersona("", persona, pd.bundled, pd.mine).persona.id; } catch { /* shown as it is */ }
        const personaFile = String(values.personaFile ?? "").trim();
        let personaFileView: SettingsState["personaFile"] = null;
        if (personaFile) {
            try { personaFileView = { path: personaFile, name: loadPersonaFile(expandHome(personaFile)).name }; }
            catch (err) { personaFileView = { path: personaFile, problem: (err as Error).message }; }
        }

        const md = mascotDirs(host);
        const s = host.session();
        const active = host.sessionState() === "active" ? s : null;
        // What the session shows is for its own provider: the other's mind and body are the next session's business.
        const live = active?.provider === provider ? active : null;
        const liveModel = live?.model;
        const modelKey = provider === "claude" ? "model" : "openaiModel";
        // On a ChatGPT plan, its own models (the first is what an empty setting means).
        let listed: ModelView[] | undefined;
        if (provider === "openai" && api.endpoint?.chatgpt && api.account) {
            const plan = await this.planModels(api);
            listed = plan?.map((m) => ({ id: m.id, name: m.name, detail: m.detail })) ?? [];
        }
        return {
            trusted: vscode.workspace.isTrusted,
            session: host.sessionState(),
            provider,
            liveProvider: active?.provider,
            api,
            values,
            workspace,
            personas: personas.map(personaView),
            persona,
            personaFile: personaFileView,
            mascots: listMascots(md.bundled, md.mine, provider).map(mascotView),
            mascot: live?.wearing.id ?? chooseMascot(String(values.mascot ?? ""), md.bundled, md.mine, provider).mascot.id,
            defaultMascot: defaultMascot(provider),
            models: modelViews(liveModel ?? String(values[modelKey] ?? ""), provider, api.endpoint?.openai ?? false, listed),
            modelDefault: listed ? planDefault(listed) ?? "" : defaultModel(provider, api.endpoint?.openai ?? false),
            liveModel,
            paths: this.paths(values),
            home: memoryDir(),
        };
    }

    /** The OpenAI-compatible API as set, and whether Euterpe has its key (or, on a ChatGPT plan, who's signed in). */
    private async api(value: string): Promise<ApiView> {
        let endpoint: Endpoint;
        try {
            endpoint = endpointFor(value);
        } catch (err) {
            return { value, endpoint: null, problem: (err as Error).message, key: "missing" };
        }
        if (endpoint.chatgpt) {
            const login = await this.host.chatgptLogin();
            const ended = login ? undefined : (await this.host.chatgptEnded())?.ended;
            return { value, endpoint, key: "missing", account: login ? { email: login.email } : null, ...(ended ? { ended } : {}), signingIn: this.host.signingIn() };
        }
        const key = endpoint.local ? "local" : (await this.host.apiKey(endpoint)) ? "set" : "missing";
        return { value, endpoint, key };
    }

    /**
     * The models the ChatGPT plan offers, listed once in a while for the account signed in; undefined
     * when nobody is signed in, or they couldn't be listed (`api.modelsProblem` says why).
     */
    private async planModels(api: ApiView): Promise<PlanModel[] | undefined> {
        const login = await this.host.chatgptLogin();
        if (!login) { return undefined; }
        let plan = this.plan;
        if (plan?.account !== login.clientId || Date.now() - plan.at > PLAN_MODELS_TTL_MS) {
            const models = this.host.planModels();
            plan = this.plan = { account: login.clientId, at: Date.now(), models };
            // A failure is shown once, then listed again at the next look.
            models.catch(() => { if (this.plan?.models === models) { this.plan = undefined; } });
        }
        try {
            return await plan.models;
        } catch (err) {
            api.modelsProblem = (err as Error).message;
            return undefined;
        }
    }

    private paths(values: Record<SettingKey, SettingValue>): Record<PathSetting, PathView> {
        const value = (k: PathSetting) => String(values[k] ?? "").trim();
        const at = (k: PathSetting) => expandHome(value(k));
        const out = {} as Record<PathSetting, PathView>;

        const home = memoryDir();
        const made = fs.existsSync(home) ? "" : " (made at the first session)";
        out.homeDir = { value: value("homeDir"), hint: home === value("homeDir") ? made.trim() : `In use: ${home}${made}` };
        if (fs.existsSync(home) && !fs.statSync(home).isDirectory()) { out.homeDir.problem = `${home} is a file, not a folder.`; }

        const configDir = value("claudeConfigDir");
        out.claudeConfigDir = configDir
            ? { value: configDir, hint: at("claudeConfigDir"), problem: fs.existsSync(at("claudeConfigDir")) ? undefined : `${at("claudeConfigDir")} doesn't exist: a session would refuse to start. It should be a Claude Code config folder, like ~/.claude.` }
            : { value: "", hint: `In use: ${process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")}` };

        const claude = value("claudePath");
        out.claudePath = claude
            ? { value: claude, hint: at("claudePath") === claude ? "" : at("claudePath"), problem: fs.existsSync(at("claudePath")) ? undefined : `${at("claudePath")} doesn't exist.` }
            : { value: "", hint: "" };

        const electron = value("electronPath");
        if (electron) {
            out.electronPath = { value: electron, hint: at("electronPath") === electron ? "" : at("electronPath"), problem: fs.existsSync(at("electronPath")) ? undefined : `${at("electronPath")} doesn't exist.` };
        } else {
            let found: string | null = null;
            try { found = findElectron({ override: "", extensionRoot: this.host.extensionRoot, storageDir: this.host.storageDir }); } catch { /* none */ }
            out.electronPath = { value: "", hint: found ? `In use: ${found}` : `Not downloaded yet: the first session offers to (Electron ${ELECTRON_VERSION}, about 150 MB, once)` };
        }

        const persona = value("personaFile");
        if (persona) {
            try { out.personaFile = { value: persona, hint: `The persona in it: ${loadPersonaFile(at("personaFile")).name}` }; }
            catch (err) { out.personaFile = { value: persona, hint: at("personaFile"), problem: (err as Error).message }; }
        } else {
            out.personaFile = { value: "", hint: "" };
        }
        return out;
    }

    private html(): string {
        const webview = this.panel.webview;
        const root = vscode.Uri.file(this.host.extensionRoot);
        const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(root, ...p)).toString();
        const nonce = randomBytes(16).toString("base64");
        const scripts = [
            ...ENGINE.map((f) => uri("overlay", "renderer", "clawd", f)),
            uri("overlay", "renderer", "markdown.js"),
            uri("settings", "settings.js"),
        ];
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${uri("settings", "settings.css")}" />
    <title>Euterpe Settings</title>
</head>
<body>
    <main id="app" data-icon="${uri("media", "icon.png")}" data-icon-openai="${uri("media", "icon-openai.png")}" aria-busy="true"></main>
${scripts.map((s) => `    <script nonce="${nonce}" src="${s}"></script>`).join("\n")}
</body>
</html>`;
    }
}

