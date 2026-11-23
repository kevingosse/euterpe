import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    ChatGptAuth, ChatGptLogin, EndedLogin, endLogin, fileLock, LoginStore, loginTime, MANAGE_USAGE_URL, newHostId, parseEnded, parseLogin, planDefault, PlanModel, planModels,
    PlanNotAllowed, Registration, revokeLogin, signIn, SignInCancelled, SignInNeeded,
} from "./chatgpt";
import { ClaudeInstall, resolveClaude } from "./claudeCli";
import { COPILOT_VENDOR, copilotApi, copilotDefault, CopilotModel, copilotModelsOf } from "./copilot";
import { downloadElectron, electronTarget, findElectron } from "./electronRuntime";
import { chooseMascotCommand, installMascot, previewMascot } from "./mascotCommands";
import { chooseModelCommand } from "./modelCommands";
import { defaultModel, modelName, rememberCopilotModels, sameModel } from "./models";
import { choosePersonaCommand, installPersona, newPersona } from "./personaCommands";
import { EditProposals } from "./proposals";
import { CHATGPT_SECRET, Endpoint, endpointFor, Provider, providerFor, secretName } from "./providers";
import { isWatchable } from "./sensors";
import { SettingsHost, SettingsPanel } from "./settingsPanel";
import { checkSetup } from "./setupCheck";
import { memoryDir, MindRuntime, SessionEvent, WritingSession } from "./session";

let session: WritingSession | null = null;
let starting = false;
/**
 * A session the writer asked for in Restricted Mode ({ uri, at }, in workspaceState): it starts if
 * they trust the folder within TRUST_WAIT_MS. Kept there rather than in memory: granting trust
 * restarts the extension host when an extension Restricted Mode kept off can't join the running one.
 */
const AWAITING_TRUST = "awaitingTrust";
const TRUST_WAIT_MS = 5 * 60_000;
let trustTimer: NodeJS.Timeout | undefined;
let statusItem: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let root = "";
let storage = "";
let state: vscode.Memento;
let workspaceState: vscode.Memento;
let secrets: vscode.SecretStorage;
/** Whether VS Code lets Euterpe use a language model (GitHub Copilot's). */
let languageModelAccess: vscode.LanguageModelAccessInformation | undefined;
/** A ChatGPT sign-in waiting for the writer in their browser. */
let signingIn: AbortController | null = null;
const events = new vscode.EventEmitter<SessionEvent>();
/** In globalState: this installation's ID to OpenAI, and Euterpe's registration with the writer's ChatGPT account. */
const CHATGPT_HOST = "chatgpt.hostId", CHATGPT_REGISTRATION = "chatgpt.registration";
/**
 * The ChatGPT sign-in, in VS Code's secret storage (every window's), renewed by one window at a time.
 * Once OpenAI won't renew it, what's left of it takes its place (EndedLogin): why, and whose it was.
 */
const loginStore: LoginStore = {
    load: async () => parseLogin(await secrets.get(CHATGPT_SECRET)),
    save: async (login) => {
        await secrets.store(CHATGPT_SECRET, JSON.stringify(login));
        log(`ChatGPT sign-in kept, its token good until ${new Date(login.expires).toLocaleTimeString()}`);
    },
    end: async (login, why) => {
        const since = loginTime(login);
        log(`${why.message}${why.detail ? ` OpenAI answered: ${why.detail}` : ""}${since ? ` (the browser login it was made on: ${new Date(since).toLocaleString()})` : ""}`);
        // Unless the writer signed in again meanwhile, in another window.
        if ((await loginStore.load())?.refresh !== login.refresh) { return; }
        await secrets.store(CHATGPT_SECRET, JSON.stringify(endLogin(login, why)));
    },
    lock: (fn) => fileLock(storage)(fn),
};

/** The ChatGPT sign-in that ended (OpenAI wouldn't renew it), if nobody signed in since. */
async function endedSignIn(): Promise<EndedLogin | undefined> {
    return parseEnded(await secrets.get(CHATGPT_SECRET));
}
/** The default keybinding of "Talk to Euterpe" (package.json). */
const TALK_KEYS = process.platform === "darwin" ? "⌘K ⌘E" : "Ctrl+K Ctrl+E";
/** What the choosers and the settings window work with. */
const host: SettingsHost = {
    get extensionRoot() { return root; },
    get storageDir() { return storage; },
    get output() { return output; },
    obtainElectron: () => obtainElectron(),
    session: () => session,
    sessionRunning: () => session !== null,
    sessionState: () => (starting ? "starting" : session ? "active" : "none"),
    startSession: () => startSession(),
    bundledClaude: () => bundledClaude(),
    apiKey: (e) => apiKey(e),
    setApiKey: (e) => askApiKey(e),
    removeApiKey: (e) => removeApiKey(e),
    chatgptLogin: () => loginStore.load(),
    chatgptEnded: () => endedSignIn(),
    signingIn: () => signingIn !== null,
    signIn: () => signInWithChatGpt(),
    cancelSignIn: () => signingIn?.abort(),
    signOut: () => signOutOfChatGpt(),
    planModels: () => listPlanModels(),
    copilotModels: () => listCopilotModels(),
    setUpCopilot: () => setUpCopilot(),
};

/** Returned from activate(): lets scripts (and tests) observe sessions. */
export interface EuterpeApi {
    readonly active: boolean;
    readonly onEvent: vscode.Event<SessionEvent>;
}

export function activate(context: vscode.ExtensionContext): EuterpeApi {
    root = context.extensionPath;
    storage = context.globalStorageUri.fsPath;
    state = context.globalState;
    workspaceState = context.workspaceState;
    secrets = context.secrets;
    languageModelAccess = context.languageModelAccessInformation;
    output = vscode.window.createOutputChannel("Euterpe");
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

    context.subscriptions.push(
        output,
        statusItem,
        events,
        vscode.commands.registerCommand("euterpe.startSession", () => startSession()),
        vscode.commands.registerCommand("euterpe.endSession", endSession),
        vscode.commands.registerCommand("euterpe.toggleSession", () => (session ? sessionMenu() : startSession())),
        vscode.commands.registerCommand("euterpe.talk", talk),
        vscode.commands.registerCommand("euterpe.sessionMenu", sessionMenu),
        vscode.commands.registerCommand("euterpe.showLog", () => output.show()),
        vscode.commands.registerCommand("euterpe.openMemory", openMemory),
        vscode.commands.registerCommand("euterpe.checkSetup", () => checkSetup({
            output, extensionRoot: root, storageDir: storage, bundledClaude: bundledClaude(), downloadElectron: downloadElectronWithProgress, apiKey,
            chatgptLogin: () => loginStore.load(), chatgptEnded: endedSignIn, planModels: listPlanModels,
            copilotModels: listCopilotModels, copilotAccess,
        })),
        vscode.commands.registerCommand("euterpe.choosePersona", () => choosePersonaCommand(host)),
        vscode.commands.registerCommand("euterpe.newPersona", () => newPersona(host)),
        vscode.commands.registerCommand("euterpe.installPersona", () => installPersona(host)),
        vscode.commands.registerCommand("euterpe.chooseMascot", () => chooseMascotCommand(host)),
        vscode.commands.registerCommand("euterpe.previewMascot", () => previewMascot(host)),
        vscode.commands.registerCommand("euterpe.installMascot", () => installMascot(host)),
        vscode.commands.registerCommand("euterpe.chooseModel", () => chooseModelCommand(host)),
        vscode.commands.registerCommand("euterpe.setApiKey", () => setApiKeyCommand()),
        vscode.commands.registerCommand("euterpe.signIn", () => signInWithChatGpt()),
        vscode.commands.registerCommand("euterpe.signOut", () => signOutOfChatGpt()),
        // The settings window shows whether a key is set: tell it when one changes (a new window, say).
        // A ChatGPT sign-in, here or in another window, lets a session that waits for one go on.
        context.secrets.onDidChange((e) => {
            SettingsPanel.refresh();
            if (e.key === CHATGPT_SECRET && session) {
                void loginStore.load().then((login) => { if (login) { session?.signedIn(); } });
            }
        }),
        // A link can open it at a section: command:euterpe.openSettings?["mascot"]
        vscode.commands.registerCommand("euterpe.openSettings", (section?: unknown) => SettingsPanel.show(host, section)),
        vscode.window.registerWebviewPanelSerializer(SettingsPanel.viewType, {
            deserializeWebviewPanel: async (panel) => SettingsPanel.restore(host, panel),
        }),
        // From the diff's title bar the argument is its resource, which names the proposal.
        vscode.commands.registerCommand("euterpe.acceptEdit", (uri?: unknown) => session?.decideEdit(true, EditProposals.idOf(uri))),
        vscode.commands.registerCommand("euterpe.rejectEdit", (uri?: unknown) => session?.decideEdit(false, EditProposals.idOf(uri))),
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            if (!session && !starting) { setStatus("idle"); }
            // A moment first: a host being restarted for the trust mustn't start what it can't finish.
            clearTimeout(trustTimer);
            trustTimer = setTimeout(() => void startAfterTrust(), 1_000);
        }),
    );
    setStatus("idle");
    statusItem.show();
    // After a restart for the trust, the new host is the one to start the session.
    void startAfterTrust();

    return {
        get active() { return session !== null; },
        onEvent: events.event,
    };
}

export function deactivate(): void {
    clearTimeout(trustTimer);
    session?.dispose();
    session = null;
}

function log(msg: string): void {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function setStatus(state: "idle" | "starting" | "active" | "signed-out" | "leaving"): void {
    void vscode.commands.executeCommand("setContext", "euterpe.sessionActive", state === "active" || state === "signed-out" || state === "starting");
    SettingsPanel.refresh();
    statusItem.backgroundColor = undefined;
    switch (state) {
        case "idle": {
            const tip = vscode.workspace.isTrusted
                ? "Invite Euterpe to write with you"
                : "Euterpe waits until you trust this folder: click to see why";
            statusItem.text = "$(euterpe-idle) Euterpe";
            statusItem.tooltip = withSettingsLink(tip);
            statusItem.accessibilityInformation = { label: `Euterpe: ${tip}` };
            statusItem.command = "euterpe.startSession";
            break;
        }
        case "starting":
            statusItem.text = "$(loading~spin) Euterpe";
            statusItem.tooltip = "Euterpe is on the way…";
            statusItem.accessibilityInformation = { label: "Euterpe is on the way" };
            statusItem.command = undefined;
            break;
        case "active":
            statusItem.text = "$(euterpe-active) Euterpe";
            statusItem.tooltip = withSettingsLink(`Euterpe is with you: click for options (${TALK_KEYS} to talk)`);
            statusItem.accessibilityInformation = { label: `Euterpe is with you: options (${TALK_KEYS} to talk)` };
            statusItem.command = "euterpe.sessionMenu";
            break;
        case "signed-out":
            // Until the writer signs in again: a notice slips into the notification center, this stays.
            statusItem.text = "$(euterpe-active) Euterpe $(sign-in)";
            statusItem.tooltip = withSettingsLink("Euterpe's ChatGPT sign-in has ended: click to continue with ChatGPT. Euterpe waits meanwhile.");
            statusItem.accessibilityInformation = { label: "Euterpe waits for you: continue with ChatGPT" };
            statusItem.command = "euterpe.signIn";
            statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
            break;
        case "leaving":
            statusItem.text = "$(euterpe-idle) Euterpe (leaving…)";
            statusItem.tooltip = "Euterpe is saying goodbye";
            statusItem.accessibilityInformation = { label: "Euterpe is saying goodbye" };
            statusItem.command = undefined;
            break;
    }
}

/** A status bar tooltip, with a way to Euterpe's settings. */
function withSettingsLink(text: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString(`${text}\n\n[$(settings-gear) Settings](command:euterpe.openSettings)`, true);
    md.isTrusted = { enabledCommands: ["euterpe.openSettings"] };
    return md;
}

/** Start a session on `document`, else on the active editor's. */
async function startSession(document?: vscode.TextDocument): Promise<void> {
    if (session || starting) {
        void vscode.window.showInformationMessage(starting ? "Euterpe is on the way." : "A Euterpe session is already running.");
        return;
    }
    // The extension runs on this computer (extensionKind "ui", for the avatar's window);
    // a remote window's files are elsewhere, beyond the mind's reach.
    if (vscode.env.remoteName) {
        void vscode.window.showWarningMessage("Euterpe only supports local folders, not remote windows.");
        return;
    }
    const doc = document ?? vscode.window.activeTextEditor?.document;
    if (!doc || !isWatchable(doc)) {
        void vscode.window.showWarningMessage("Open the document you want to write, then start the session.");
        return;
    }
    if (!vscode.workspace.isTrusted) {
        await askForTrust(doc);
        return;
    }
    starting = true;
    try {
        const provider = providerFor(vscode.workspace.getConfiguration("euterpe").get("provider"));
        setStatus("starting");   // the avatar's runtime may have to download first
        // The mind first: no point downloading Electron for a mind that can't run.
        const mind = await obtainMind(provider);
        if (!mind) { return; }
        const electron = await obtainElectron();
        if (!electron) { return; }
        const s = new WritingSession(doc, root, { electronPath: electron, mind }, {
            log,
            onLeaving: () => { if (session === s) { setStatus("leaving"); } },
            onEnded: () => {
                if (session === s) {
                    session = null;
                    setStatus("idle");
                }
            },
            onEvent: (e) => events.fire(e),
            previewMascot: (m) => previewMascot(host, m),
            signIn: async () => !!(await signInWithChatGpt()),
            onSignInWait: (waiting) => { if (session === s) { setStatus(waiting ? "signed-out" : "active"); } },
        });
        session = s;
        setStatus("starting");
        if (vscode.workspace.getConfiguration("euterpe").get<boolean>("debugMind")) {
            output.show(true);
        }
        try {
            await s.start();
            if (session === s) { setStatus("active"); }
        } catch (err) {
            if (session === s) {
                session = null;
                setStatus("idle");
            }
            output.show(true);
            void vscode.window.showErrorMessage(`Euterpe failed to start: ${(err as Error).message}`, "Check Setup").then((pick) => {
                if (pick) { void vscode.commands.executeCommand("euterpe.checkSetup"); }
            });
        }
    } finally {
        starting = false;
        if (!session) { setStatus("idle"); }
    }
}

/**
 * Restricted Mode: the writer hasn't said they trust these files, and the mind would read them
 * with its permission prompts off, where one could carry instructions meant for an agent. So the
 * session waits for trust, and starts on `document` if it's given soon after (startAfterTrust).
 */
async function askForTrust(document: vscode.TextDocument): Promise<void> {
    const where = vscode.workspace.workspaceFile ? "workspace" : "folder";
    const trust = `Trust This ${where === "folder" ? "Folder" : "Workspace"}…`;
    const pick = await vscode.window.showInformationMessage(`Euterpe waits until you trust this ${where}`, {
        modal: true,
        detail: [
            `Euterpe's mind is an agent that reads what's in this ${where}, and it can change files and run commands without asking. In Restricted Mode, you haven't said you trust these files, and one of them could carry instructions meant for an agent.`,
            `If they're yours, trust the ${where}, and Euterpe joins you.`,
        ].join("\n\n"),
    }, trust);
    if (pick !== trust) { return; }
    await workspaceState.update(AWAITING_TRUST, { uri: document.uri.toString(), at: Date.now() });
    await vscode.commands.executeCommand("workbench.trust.manage");
}

/** The folder is trusted now: the session the writer asked for in Restricted Mode, if they asked just now. */
async function startAfterTrust(): Promise<void> {
    const asked = workspaceState.get<{ uri: string; at: number }>(AWAITING_TRUST);
    if (!asked || !vscode.workspace.isTrusted) { return; }
    await workspaceState.update(AWAITING_TRUST, undefined);
    if (session || starting || !(Date.now() - asked.at < TRUST_WAIT_MS)) { return; }
    let document: vscode.TextDocument;
    try {
        document = await vscode.workspace.openTextDocument(vscode.Uri.parse(asked.uri));
    } catch {
        return;   // it's gone
    }
    await startSession(document);
}

/** What the mind will run on, found (Claude Code) or asked for (an API key); null if there's nothing to run on (and the writer is told why). */
async function obtainMind(provider: Provider): Promise<MindRuntime | null> {
    if (provider === "claude") {
        const claude = await obtainClaude();
        return claude ? { provider, claudePath: claude.path } : null;
    }
    if (provider === "copilot") { return obtainCopilotMind(); }
    const cfg = vscode.workspace.getConfiguration("euterpe");
    let endpoint: Endpoint;
    try {
        endpoint = endpointFor(cfg.get<string>("openaiBaseUrl"));
    } catch (err) {
        void offerSettings((err as Error).message, "provider");
        return null;
    }
    if (endpoint.chatgpt) { return obtainPlanMind(endpoint, (cfg.get<string>("openaiModel") ?? "").trim()); }
    const model = (cfg.get<string>("openaiModel") ?? "").trim() || defaultModel("openai", endpoint.openai);
    if (!model) {
        void offerSettings(`Which model should Euterpe's mind run on ${endpoint.name}? Name one in Euterpe's settings (euterpe.openaiModel).`, "mind");
        return null;
    }
    let key = await apiKey(endpoint);
    if (!key && !endpoint.local) {
        key = await askApiKey(endpoint);
        if (!key) { return null; }
    }
    log(`mind: ${model} on ${endpoint.baseURL}${key ? "" : " (no key)"}`);
    return { provider, endpoint, apiKey: key ?? "", model };
}

/**
 * The mind on the writer's ChatGPT plan: their sign-in (asked for if there's none, or if it ended,
 * before or just now), and the model (Euterpe's pick among the plan's, unless they chose one).
 */
async function obtainPlanMind(endpoint: Endpoint, chosen: string): Promise<MindRuntime | null> {
    for (let attempt = 1; ; attempt++) {
        let login = await loginStore.load();
        if (!login) {
            const ended = await endedSignIn();
            const pick = await vscode.window.showInformationMessage(ended ? `${ended.ended} Continue with ChatGPT to start the session.` : "Euterpe thinks on your ChatGPT plan: continue with ChatGPT first.", {
                modal: true,
                detail: "Your browser opens ChatGPT's sign-in, where you let Euterpe use your plan (ChatGPT Plus or Pro). Its requests then count toward your plan's usage limits, with no API key.",
            }, "Continue with ChatGPT");
            if (pick !== "Continue with ChatGPT") { return null; }
            login = await signInWithChatGpt();
            if (!login) { return null; }
        }
        const chatgpt = new ChatGptAuth(login, loginStore);
        let model = chosen;
        try {
            const models = await planModels(await chatgpt.headers());
            if (!model) {
                model = planDefault(models) ?? "";
                if (!model) { void offerSettings("Your ChatGPT plan offers Euterpe no models.", "mind"); return null; }
            } else if (models.length && !models.some((m) => sameModel(m.id, model))) {
                log(`${model} isn't among your plan's models (${models.map((m) => m.id).join(", ")}): trying it anyway`);
            }
        } catch (err) {
            // It ended just now (OpenAI wouldn't renew it): the writer is asked to sign in again.
            if (err instanceof SignInNeeded && attempt === 1) { continue; }
            // A model chosen already can go without the list; Euterpe's pick among the plan's can't.
            log(`couldn't list your plan's models: ${(err as Error).message}`);
            if (!model) { void offerSettings((err as Error).message, "mind"); return null; }
        }
        log(`mind: ${model} on your ChatGPT plan`);
        return { provider: "openai", endpoint, apiKey: "", model, chatgpt };
    }
}

/**
 * Sign in with ChatGPT, in the writer's browser: the login, or undefined if it didn't happen (and
 * they're told why). The first sign-in registers Euterpe with their account; later ones reuse it.
 */
async function signInWithChatGpt(): Promise<ChatGptLogin | undefined> {
    if (signingIn) {
        void vscode.window.showInformationMessage("Euterpe is waiting for you to sign in to ChatGPT in your browser.");
        return undefined;
    }
    const ctl = new AbortController();
    signingIn = ctl;
    SettingsPanel.refresh();
    let hostId = state.get<string>(CHATGPT_HOST);
    if (!hostId) { hostId = newHostId(); await state.update(CHATGPT_HOST, hostId); }
    const registration = state.get<Registration>(CHATGPT_REGISTRATION);
    // The last sign-in, live or ended: its ID token names the account (id_token_hint).
    const current = await loginStore.load() ?? await endedSignIn();
    // OpenAI wouldn't renew the last one: this one asks the writer to log in again.
    const freshLogin = !!current && "ended" in current && !!current.freshLogin;
    try {
        const login = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Euterpe: continue with ChatGPT in your browser…", cancellable: true }, (_progress, token) => {
            token.onCancellationRequested(() => ctl.abort());
            return signIn({
                open: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
                hostId: hostId!,
                registration,
                idTokenHint: current?.clientId === registration?.clientId ? current?.idToken : undefined,
                freshLogin,
                registered: async (r) => { await state.update(CHATGPT_REGISTRATION, r); },
                signal: ctl.signal,
            });
        });
        await loginStore.save(login);
        await state.update(CHATGPT_REGISTRATION, { clientId: login.clientId, subject: login.subject, email: login.email } satisfies Registration);
        const since = loginTime(login);
        log(`signed in to ChatGPT, with the use of the plan (registration ${login.clientId}${since ? `, on a browser login from ${new Date(since).toLocaleString()}` : ""}${freshLogin ? ", asked for anew" : ""})`);
        return login;
    } catch (err) {
        if (err instanceof SignInCancelled) { return undefined; }
        const message = (err as Error).message;
        log(`ChatGPT sign-in failed: ${message}`);
        if (err instanceof PlanNotAllowed) {
            // Next time, ask for consent again.
            await state.update(CHATGPT_REGISTRATION, err.registration);
            void vscode.window.showWarningMessage(message, "Sign In Again", "Use an API Key").then((pick) => {
                if (pick === "Sign In Again") { void signInWithChatGpt(); }
                else if (pick) { SettingsPanel.show(host, "provider"); }
            });
        } else if (registration && /another chatgpt account|registration|invalid_client|unauthorized_client/i.test(message)) {
            // The saved registration doesn't fit anymore: the next sign-in registers Euterpe anew.
            await state.update(CHATGPT_REGISTRATION, undefined);
            void vscode.window.showErrorMessage(`${message} The next sign-in registers Euterpe with the account you choose.`, "Sign In Again").then((pick) => {
                if (pick) { void signInWithChatGpt(); }
            });
        } else {
            void vscode.window.showErrorMessage(message);
        }
        return undefined;
    } finally {
        signingIn = null;
        SettingsPanel.refresh();
    }
}

async function signOutOfChatGpt(): Promise<void> {
    const login = await loginStore.load();
    if (!login) {
        // What's left of an ended sign-in has nothing to revoke: it's simply forgotten.
        if (await endedSignIn()) { await secrets.delete(CHATGPT_SECRET); }
        void vscode.window.showInformationMessage("Euterpe isn't signed in to ChatGPT.");
        return;
    }
    const pick = await vscode.window.showWarningMessage(`Sign Euterpe out of ChatGPT${login.email ? ` (${login.email})` : ""}?`, {
        modal: true,
        detail: "Euterpe stops using your ChatGPT plan, and forgets its sign-in. ChatGPT, Codex and other apps stay signed in.",
    }, "Sign Out");
    if (pick !== "Sign Out") { return; }
    // Revoked first: the renewable session ends on OpenAI's side too (the registration stays, for the next sign-in).
    const revoked = await revokeLogin(login);
    await secrets.delete(CHATGPT_SECRET);
    log(`signed out of ChatGPT${revoked ? "" : " (revocation not confirmed)"}`);
    if (!revoked) {
        void vscode.window.showWarningMessage("Euterpe forgot its ChatGPT sign-in, but couldn't confirm OpenAI ended it. To be sure, disconnect Euterpe in ChatGPT's settings.", "Open ChatGPT Settings").then((p) => {
            if (p) { void vscode.env.openExternal(vscode.Uri.parse(MANAGE_USAGE_URL)); }
        });
    }
}

/** The models the writer's plan offers (the settings window, Choose Model); throws when there's no sign-in or no answer. */
async function listPlanModels(): Promise<PlanModel[]> {
    const login = await loginStore.load();
    if (!login) { throw new Error("Sign in with ChatGPT to see your plan's models."); }
    return planModels(await new ChatGptAuth(login, loginStore).headers());
}

/**
 * The mind on the writer's GitHub Copilot plan: a model Copilot offers in VS Code (the one they chose,
 * else Euterpe's pick). VS Code asks them, at the first request, whether Euterpe may use it.
 */
async function obtainCopilotMind(): Promise<MindRuntime | null> {
    let models: CopilotModel[];
    try {
        models = await listCopilotModels();
    } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
        return null;
    }
    if (!models.length) {
        void offerCopilotSetup();
        return null;
    }
    const chosen = (vscode.workspace.getConfiguration("euterpe").get<string>("copilotModel") ?? "").trim();
    const model = models.find((m) => sameModel(m.id, chosen || copilotDefault(models) || ""));
    if (!model) {
        void offerSettings(`GitHub Copilot doesn't offer the model ${chosen} here: choose another in Euterpe's settings.`, "mind");
        return null;
    }
    log(`mind: ${model.id} on GitHub Copilot${chosen ? "" : " (Euterpe's pick)"}, of ${models.map((m) => m.id).join(", ")}`);
    const api = copilotApi({
        vs: vscode,
        model: async (id) => (await vscode.lm.selectChatModels({ vendor: COPILOT_VENDOR, id }))[0],
    });
    return { provider: "copilot", model: model.id, context: model.maxInputTokens, api };
}

/** The models the writer's GitHub Copilot plan offers in VS Code (none without Copilot, or signed out of it). */
async function listCopilotModels(): Promise<CopilotModel[]> {
    if (typeof vscode.lm?.selectChatModels !== "function") {
        throw new Error("This VS Code can't lend Euterpe GitHub Copilot's models: update VS Code.");
    }
    const models = copilotModelsOf(await vscode.lm.selectChatModels({ vendor: COPILOT_VENDOR }));
    rememberCopilotModels(models);
    return models;
}

/** Whether VS Code lets Euterpe use a Copilot model: undefined until it has asked the writer. */
async function copilotAccess(id: string): Promise<boolean | undefined> {
    const [chat] = await vscode.lm.selectChatModels({ vendor: COPILOT_VENDOR, id });
    return chat ? languageModelAccess?.canSendRequest(chat) : undefined;
}

/** No Copilot models: the writer isn't signed in to GitHub Copilot in VS Code, or has no Copilot. */
async function offerCopilotSetup(): Promise<void> {
    const message = "GitHub Copilot offers Euterpe no models: sign in to GitHub Copilot in VS Code first.";
    log(message);
    if (await vscode.window.showErrorMessage(message, "Set Up Copilot")) { await setUpCopilot(); }
}

/** VS Code's own way to sign in to GitHub Copilot (its chat, where an older VS Code has no setup command). */
async function setUpCopilot(): Promise<void> {
    try {
        await vscode.commands.executeCommand("workbench.action.chat.triggerSetup");
    } catch {
        await vscode.commands.executeCommand("workbench.action.chat.open");
    }
}

/** A problem the settings window can fix, with a way there. */
async function offerSettings(message: string, section: string): Promise<void> {
    log(message);
    const pick = await vscode.window.showErrorMessage(message, "Open Settings");
    if (pick) { SettingsPanel.show(host, section); }
}

/** The writer's key for an API, from VS Code's secret storage; undefined if there's none. */
async function apiKey(endpoint: Endpoint): Promise<string | undefined> {
    return (await secrets.get(secretName(endpoint.origin)))?.trim() || undefined;
}

/** Ask the writer for their key to an API, and keep it (for that address only); undefined if they didn't give one. */
async function askApiKey(endpoint: Endpoint): Promise<string | undefined> {
    const key = (await vscode.window.showInputBox({
        title: `Euterpe: API Key for ${endpoint.name}`,
        prompt: `Your API key for ${endpoint.origin}. Euterpe keeps it in VS Code's secret storage, and only ever sends it there.`,
        placeHolder: endpoint.openai ? "sk-…" : "Your key",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (/\s/.test(v.trim()) ? "A key is one word, with no spaces." : null),
    }))?.trim();
    if (!key) { return undefined; }
    await secrets.store(secretName(endpoint.origin), key);
    log(`API key kept for ${endpoint.origin}`);
    return key;
}

async function removeApiKey(endpoint: Endpoint): Promise<void> {
    const remove = await vscode.window.showWarningMessage(`Forget your API key for ${endpoint.name} (${endpoint.origin})?`, { modal: true }, "Forget It");
    if (remove !== "Forget It") { return; }
    await secrets.delete(secretName(endpoint.origin));
    log(`API key removed for ${endpoint.origin}`);
}

/** "Euterpe: Set API Key…": the key for the API in euterpe.openaiBaseUrl. */
async function setApiKeyCommand(): Promise<void> {
    let endpoint: Endpoint;
    try {
        endpoint = endpointFor(vscode.workspace.getConfiguration("euterpe").get<string>("openaiBaseUrl"));
    } catch (err) {
        void offerSettings((err as Error).message, "provider");
        return;
    }
    // A plan has a sign-in, not a key.
    if (endpoint.chatgpt) {
        const login = await loginStore.load();
        const pick = await vscode.window.showInformationMessage(login
            ? `Euterpe thinks on your ChatGPT plan, with no API key: it's signed in${login.email ? ` as ${login.email}` : ""}.`
            : "Euterpe thinks on your ChatGPT plan, with no API key: continue with ChatGPT instead.", login ? "Sign Out" : "Continue with ChatGPT");
        if (pick === "Sign Out") { await signOutOfChatGpt(); } else if (pick) { await signInWithChatGpt(); }
        return;
    }
    if (await apiKey(endpoint)) {
        const pick = await vscode.window.showQuickPick([
            { label: "$(key) Replace the Key…", id: "replace" },
            { label: "$(trash) Forget the Key", id: "remove" },
        ], { title: `Euterpe: API Key for ${endpoint.name}`, placeHolder: `Euterpe has your key for ${endpoint.origin}` });
        if (pick?.id === "replace") { await askApiKey(endpoint); }
        else if (pick?.id === "remove") { await removeApiKey(endpoint); }
        return;
    }
    if (await askApiKey(endpoint)) {
        void vscode.window.showInformationMessage(`Euterpe has your key for ${endpoint.name}.`);
    }
}

/** The Claude Code the mind runs on, or null (and the writer is told why). */
async function obtainClaude(): Promise<ClaudeInstall | null> {
    try {
        const setting = vscode.workspace.getConfiguration("euterpe").get<string>("claudePath") || "";
        const claude = await resolveClaude(setting, bundledClaude(), process.env, log);
        log(`claude: ${claude.path} (${claude.version}, from ${claude.source})`);
        return claude;
    } catch (err) {
        const message = (err as Error).message;
        log(message);
        const install = /isn't installed/.test(message) ? ["Install Claude Code"] : [];
        void vscode.window.showErrorMessage(message, ...install).then((pick) => {
            if (pick) { void vscode.env.openExternal(vscode.Uri.parse("https://code.claude.com/docs/en/setup")); }
        });
        return null;
    }
}

/** The CLI inside the Claude Code VS Code extension, when that's installed: a fallback if nothing else is. */
function bundledClaude(): string | null {
    const ext = vscode.extensions.getExtension("anthropic.claude-code");
    return ext ? path.join(ext.extensionPath, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude") : null;
}

/**
 * The Electron build the overlay runs on: one that's already there, or one downloaded now
 * with the writer's go-ahead (once: it's kept across updates). Null if there's none to use.
 */
async function obtainElectron(): Promise<string | null> {
    try {
        const found = findElectron({
            override: vscode.workspace.getConfiguration("euterpe").get<string>("electronPath") || "",
            extensionRoot: root,
            storageDir: storage,
        });
        if (found) { return found; }
    } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
        return null;
    }
    if (!electronTarget()) {
        void vscode.window.showErrorMessage(`Euterpe's avatar runs on Electron, which has no build for ${process.platform}-${process.arch}.`);
        return null;
    }
    // Modal: a notification hides itself after a few seconds, and the session would wait unseen.
    const choice = await vscode.window.showInformationMessage(
        "Euterpe's avatar lives in a little window of its own, which runs on Electron. Download it now? (About 150 MB, once.)",
        { modal: true }, "Download");
    return choice === "Download" ? downloadElectronWithProgress() : null;
}

/** Download the avatar runtime (the writer said yes), with progress; null if it failed or was cancelled. */
function downloadElectronWithProgress(): Thenable<string | null> {
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Downloading Euterpe's avatar runtime", cancellable: true },
        async (progress, token) => {
            let shown = 0;
            try {
                return await downloadElectron(storage, {
                    log,
                    cancellation: token,
                    progress: (received, total) => {
                        const pct = total ? Math.floor((received / total) * 100) : 0;
                        if (total && pct > shown) {
                            progress.report({ increment: pct - shown, message: `${mb(received)} of ${mb(total)} MB` });
                            shown = pct;
                        }
                    },
                });
            } catch (err) {
                log(`electron download failed: ${(err as Error).message}`);
                if (!token.isCancellationRequested) {
                    void vscode.window.showErrorMessage(`${(err as Error).message} (Or point euterpe.electronPath at an Electron you already have.)`);
                }
                return null;
            }
        });
}

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

async function endSession(): Promise<void> {
    if (!session) {
        void vscode.window.showInformationMessage("No Euterpe session is running.");
        return;
    }
    await session.end(true);
}

/**
 * "Talk to Euterpe": ask something without leaving the editor. The keyboard
 * stays in VS Code (Windows won't let a background window take focus anyway);
 * Euterpe sees the document, cursor and selection with the message, and answers
 * in the bubble. The overlay's own chat (click Euterpe) is there for longer exchanges.
 */
async function talk(): Promise<void> {
    if (!session) {
        if (!starting) { await startSession(); }
        return;
    }
    const s = session;
    const text = await vscode.window.showInputBox({
        title: "Talk to Euterpe",
        prompt: "Euterpe sees your document, cursor and selection. Enter to send, Esc to cancel.",
        placeHolder: "Say something…",
    });
    if (text?.trim() && session === s) {
        s.chat(text.trim());
    }
}

async function sessionMenu(): Promise<void> {
    if (!session) {
        await startSession();
        return;
    }
    const s = session;
    const edit = s.pendingEditId;   // the one the writer sees now, even if a newer one arrives meanwhile
    const items: (vscode.QuickPickItem & { id: string })[] = [
        ...(edit ? [
            { id: "accept", label: "$(check) Accept Euterpe's edit" },
            { id: "reject", label: "$(discard) Reject Euterpe's edit" },
        ] : []),
        { id: "talk", label: "$(comment-discussion) Talk to Euterpe", description: TALK_KEYS },
        { id: "end", label: "$(sign-out) End writing session", description: "Euterpe says goodbye first" },
        { id: "memory", label: "$(book) Open Euterpe's memory" },
        { id: "persona", label: "$(person) Choose persona", description: "from the next session" },
        { id: "mascot", label: "$(smiley) Choose mascot" },
        { id: "model", label: "$(sparkle) Choose model", description: modelName(s.model ?? "", s.provider) },
        { id: "settings", label: "$(settings-gear) Settings" },
        { id: "log", label: "$(output) Show log" },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Euterpe" });
    switch (pick?.id) {
        case "accept": s.decideEdit(true, edit); break;
        case "reject": s.decideEdit(false, edit); break;
        case "talk": await talk(); break;
        case "end": await endSession(); break;
        case "memory": await openMemory(); break;
        case "persona": await choosePersonaCommand(host); break;
        case "mascot": await chooseMascotCommand(host); break;
        case "model": await chooseModelCommand(host); break;
        case "settings": SettingsPanel.show(host); break;
        case "log": output.show(); break;
    }
}

/** Euterpe's memory is plain Markdown the writer may read and edit. */
async function openMemory(): Promise<void> {
    const file = path.join(memoryDir(), "memory.md");
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "# Euterpe memory\n", "utf8");
    }
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: false });
}
