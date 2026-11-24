// "Euterpe: Check Setup": everything a session needs, checked without starting one, in
// the Euterpe log with a one-line verdict. The first thing to try when something's off.

import { execFile } from "child_process";
import * as fs from "fs";
import { APIError } from "openai";
import * as path from "path";
import * as vscode from "vscode";
import { ChatGptLogin, EndedLogin, planDefault, PlanModel, SignInNeeded } from "./chatgpt";
import { resolveClaude } from "./claudeCli";
import { buildMindEnv } from "./claudeMind";
import { COPILOT_SIGNED_OUT, copilotDefault, CopilotModel } from "./copilot";
import type { RuntimeStatus } from "./avatarRuntime";
import { ELECTRON_VERSION, findElectron } from "./electronRuntime";
import { defaultModel, modelName, sameModel } from "./models";
import { apiClient } from "./openaiMind";
import { choosePersona } from "./personas";
import { Endpoint, endpointFor, providerFor } from "./providers";
import { memoryDir, resolveConfigDir } from "./session";

export interface SetupContext {
    output: vscode.OutputChannel;
    extensionRoot: string;
    storageDir: string;
    bundledClaude: string | null;
    /** Download the avatar runtime (the writer asked for it from here), or wait for the download under way. */
    downloadElectron(): Thenable<string | null>;
    /** The avatar runtime: there, downloading, or why not (avatarRuntime.ts). */
    runtime(): RuntimeStatus;
    /** The writer's key for an API, if Euterpe has one. */
    apiKey(e: Endpoint): Promise<string | undefined>;
    /** The ChatGPT sign-in, if there's one (or the one that ended), and the models its plan offers. */
    chatgptLogin(): Promise<ChatGptLogin | undefined>;
    chatgptEnded(): Promise<EndedLogin | undefined>;
    planModels(): Promise<PlanModel[]>;
    /** The models GitHub Copilot offers in VS Code, and whether VS Code lets Euterpe use one (undefined: it hasn't asked yet). */
    copilotModels(): Promise<CopilotModel[]>;
    copilotAccess(id: string): Promise<boolean | undefined>;
}

interface Line { ok: boolean; text: string }

export async function checkSetup(ctx: SetupContext): Promise<void> {
    const lines: Line[] = [];
    const add = (ok: boolean, text: string) => { lines.push({ ok, text }); };
    const cfg = vscode.workspace.getConfiguration("euterpe");
    let missingElectron = false;

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Checking Euterpe's setup" }, async () => {
        if (vscode.env.remoteName) {
            add(false, `This is a remote window (${vscode.env.remoteName}): Euterpe only supports local folders.`);
        }
        if (!vscode.workspace.isTrusted) {
            add(false, "This folder isn't trusted (Restricted Mode): a session waits until you trust it, since Euterpe's mind reads its files with permission prompts off.");
        }

        const provider = providerFor(cfg.get("provider"));
        if (provider === "claude") {
            await checkClaude(cfg, ctx, add);
        } else if (provider === "copilot") {
            await checkCopilot(cfg, ctx, add);
        } else {
            await checkApi(cfg, ctx, add);
        }

        try {
            const electron = findElectron({ override: cfg.get<string>("electronPath") || "", extensionRoot: ctx.extensionRoot, storageDir: ctx.storageDir });
            const run = ctx.runtime();
            if (electron) {
                add(true, `Avatar runtime: ${electron}`);
            } else if (run.kind === "problem") {
                add(false, run.message);
            } else {
                missingElectron = true;
                add(false, run.kind === "downloading" || run.kind === "unpacking"
                    ? `Avatar runtime downloading (Electron ${ELECTRON_VERSION}, once)${run.kind === "downloading" && run.total ? `: ${Math.round(run.received / 1_048_576)} of ${Math.round(run.total / 1_048_576)} MB` : ""}.`
                    : `Avatar runtime not downloaded yet (Electron ${ELECTRON_VERSION}, about 150 MB, once)${run.kind === "failed" ? `: the last download failed (${run.message})` : ""}. Clicking Euterpe downloads it, and so does opening its settings.`);
            }
        } catch (err) {
            add(false, (err as Error).message);
        }

        const home = memoryDir();
        const memory = path.join(home, "memory.md");
        add(true, fs.existsSync(memory) ? `Memory: ${memory}` : `Memory: ${home} (Euterpe starts its memory there at the first session)`);

        try {
            const { persona, missing } = choosePersona(cfg.get<string>("persona") ?? "",
                path.join(ctx.extensionRoot, "mind", "personas"), path.join(home, "personas"));
            if (missing) { add(false, `The persona "${missing}" (euterpe.persona) isn't there: Euterpe will be ${persona.name}.`); }
            else { add(true, `Persona: ${persona.name}${persona.bundled ? "" : ` (${persona.file})`}`); }
        } catch (err) {
            add(false, (err as Error).message);
        }
    });

    const problems = lines.filter((l) => !l.ok);
    ctx.output.appendLine("");
    ctx.output.appendLine(`Euterpe setup check (${new Date().toLocaleString()}):`);
    for (const l of lines) { ctx.output.appendLine(`  ${l.ok ? "✓" : "✗"} ${l.text}`); }

    const actions = ["Show Details", ...(missingElectron && problems.length === 1 ? ["Download Now"] : [])];
    const verdict = problems.length === 0 ? "Euterpe is all set to write with you."
        : missingElectron && problems.length === 1 ? "Euterpe is all set, except for its avatar runtime, which downloads when you click Euterpe."
        : `Euterpe's setup has ${problems.length === 1 ? "a problem" : `${problems.length} problems`}: ${problems[0].text}`;
    const show = problems.length === 0 || (missingElectron && problems.length === 1)
        ? vscode.window.showInformationMessage(verdict, ...actions)
        : vscode.window.showWarningMessage(verdict, ...actions);
    const pick = await show;
    if (pick === "Show Details") { ctx.output.show(true); }
    if (pick === "Download Now") { await ctx.downloadElectron(); }
}

type Add = (ok: boolean, text: string) => void;

/** Claude Code, its sign-in, and the model. */
async function checkClaude(cfg: vscode.WorkspaceConfiguration, ctx: SetupContext, add: Add): Promise<void> {
    let configDir = "";
    try {
        configDir = resolveConfigDir(cfg.get<string>("claudeConfigDir") || "");
    } catch (err) {
        add(false, (err as Error).message);
    }
    const env = buildMindEnv(process.env, configDir);

    let claudePath: string | null = null;
    try {
        const claude = await resolveClaude(cfg.get<string>("claudePath") || "", ctx.bundledClaude, env, () => { /* the report says it */ });
        claudePath = claude.path;
        add(true, `Claude Code ${claude.version}: ${claude.path} (${claude.source})`);
    } catch (err) {
        add(false, (err as Error).message);
    }

    if (claudePath) {
        const where = configDir ? `${configDir} (euterpe.claudeConfigDir)`
            : env.CLAUDE_CONFIG_DIR ? `${env.CLAUDE_CONFIG_DIR} (CLAUDE_CONFIG_DIR)` : "~/.claude";
        const auth = await authStatus(claudePath, env);
        if (auth === null) {
            add(false, `Couldn't ask Claude Code whether it's signed in (config: ${where}).`);
        } else if (auth.loggedIn) {
            add(true, `Signed in: ${auth.summary} (config: ${where})`);
        } else {
            add(false, `Claude Code isn't signed in (config: ${where}). Run \`claude\` in a terminal and /login. (With Bedrock, Vertex or an API key in the environment this check can be wrong; a session will tell.)`);
        }
    }
    const model = cfg.get<string>("model")?.trim() ?? "";
    add(true, `Model: ${modelName(model)}${model && modelName(model) !== model ? ` (${model})` : ""}`);
}

/** The OpenAI-compatible API: its address, the key, and whether it answers and knows the model. */
async function checkApi(cfg: vscode.WorkspaceConfiguration, ctx: SetupContext, add: Add): Promise<void> {
    let endpoint: Endpoint;
    try {
        endpoint = endpointFor(cfg.get<string>("openaiBaseUrl"));
    } catch (err) {
        add(false, (err as Error).message);
        return;
    }
    add(true, `Mind: ${endpoint.chatgpt ? "your ChatGPT plan" : endpoint.name} (${endpoint.baseURL})`);
    if (endpoint.chatgpt) {
        await checkPlan(cfg, ctx, add);
        return;
    }
    const key = await ctx.apiKey(endpoint);
    if (!key && !endpoint.local) {
        add(false, `Euterpe has no API key for ${endpoint.name} yet: run Euterpe: Set API Key, or set it in Euterpe's settings.`);
        return;
    }
    const model = (cfg.get<string>("openaiModel") ?? "").trim() || defaultModel("openai", endpoint.openai);
    if (!model) { add(false, `No model chosen for ${endpoint.name}: name one in Euterpe's settings (euterpe.openaiModel).`); }
    try {
        const client = apiClient(endpoint.baseURL, key ?? "", { maxRetries: 1, timeout: 20_000 });
        const ids: string[] = [];
        for await (const m of client.models.list()) {
            if (typeof m?.id === "string") { ids.push(m.id); }
            if (ids.length >= 5000) { break; }
        }
        add(true, `${endpoint.name} answers${key ? ", and takes your key" : ""} (${ids.length} models listed)`);
        if (model) {
            const listed = ids.some((id) => sameModel(id, model));
            add(listed || !ids.length, listed || !ids.length ? `Model: ${modelName(model, "openai")}${modelName(model, "openai") !== model ? ` (${model})` : ""}`
                : `${endpoint.name} doesn't list the model ${model}: a session would fail on it. Choose another in Euterpe's settings.`);
        }
    } catch (err) {
        const status = err instanceof APIError ? err.status : undefined;
        add(false, status === 401 ? `${endpoint.name} refused your API key: set it again (Euterpe: Set API Key).`
            : `Couldn't reach ${endpoint.name} at ${endpoint.baseURL}: ${(err as Error).message.slice(0, 200)}`);
    }
}

/** The ChatGPT plan: the sign-in, and the models it offers. */
async function checkPlan(cfg: vscode.WorkspaceConfiguration, ctx: SetupContext, add: Add): Promise<void> {
    const again = "Continue with ChatGPT in Euterpe's settings (or Euterpe: Sign In with ChatGPT).";
    const login = await ctx.chatgptLogin();
    if (!login) {
        const ended = await ctx.chatgptEnded();
        add(false, ended ? `${ended.ended} ${again}` : "Euterpe isn't signed in to ChatGPT yet: continue with ChatGPT in Euterpe's settings (or Euterpe: Sign In with ChatGPT).");
        return;
    }
    let models: PlanModel[];
    try {
        models = await ctx.planModels();
    } catch (err) {
        // The sign-in ended as the check renewed it.
        if (err instanceof SignInNeeded) { add(false, `${err.message} ${again}`); return; }
        add(true, `Signed in to ChatGPT${login.email ? ` as ${login.email}` : ""}, with the use of your plan`);
        add(false, (err as Error).message);
        return;
    }
    add(true, `Signed in to ChatGPT${login.email ? ` as ${login.email}` : ""}, with the use of your plan`);
    if (!models.length) {
        add(false, "Your ChatGPT plan offers Euterpe no models.");
        return;
    }
    const chosen = (cfg.get<string>("openaiModel") ?? "").trim();
    const model = models.find((m) => sameModel(m.id, chosen || planDefault(models) || ""));
    add(!!model, model ? `Model: ${model.name}${chosen ? "" : " (Euterpe's pick on your plan)"}`
        : `Your plan doesn't offer the model ${chosen} (it offers ${models.map((m) => m.id).join(", ")}): choose another in Euterpe's settings.`);
}

/** GitHub Copilot: the models it offers in VS Code, the one Euterpe would use, and whether VS Code lets it. */
async function checkCopilot(cfg: vscode.WorkspaceConfiguration, ctx: SetupContext, add: Add): Promise<void> {
    let models: CopilotModel[];
    try {
        models = await ctx.copilotModels();
    } catch (err) {
        add(false, (err as Error).message);
        return;
    }
    if (!models.length) {
        add(false, COPILOT_SIGNED_OUT);
        return;
    }
    add(true, `Mind: GitHub Copilot (${models.length} ${models.length === 1 ? "model" : "models"})`);
    const chosen = (cfg.get<string>("copilotModel") ?? "").trim();
    const model = models.find((m) => sameModel(m.id, chosen || copilotDefault(models) || ""));
    if (!model) {
        add(false, `GitHub Copilot doesn't offer the model ${chosen} here: choose another in Euterpe's settings.`);
        return;
    }
    add(true, `Model: ${model.name}${chosen ? "" : " (Euterpe's pick)"}`);
    if (await ctx.copilotAccess(model.id).catch(() => undefined) === false) {
        add(false, "VS Code doesn't let Euterpe use GitHub Copilot's models: you declined when it asked.");
    }
}

/** `claude auth status` (JSON): null if it couldn't say. */
function authStatus(claudePath: string, env: NodeJS.ProcessEnv): Promise<{ loggedIn: boolean; summary: string } | null> {
    return new Promise((resolve) => {
        // Exit code 1 only means "not logged in", which the JSON says too: read it either way.
        execFile(claudePath, ["auth", "status"], { timeout: 20_000, windowsHide: true, env }, (_err, stdout) => {
            let s: any;
            try { s = JSON.parse(String(stdout)); } catch { resolve(null); return; }
            if (typeof s?.loggedIn !== "boolean") { resolve(null); return; }
            const plan = typeof s.subscriptionType === "string" && s.subscriptionType
                ? `Claude ${s.subscriptionType[0].toUpperCase()}${s.subscriptionType.slice(1)} subscription`
                : typeof s.authMethod === "string" ? s.authMethod : "signed in";
            const provider = typeof s.apiProvider === "string" && s.apiProvider !== "firstParty" ? `, through ${s.apiProvider}` : "";
            resolve({ loggedIn: s.loggedIn, summary: plan + provider });
        });
    });
}
