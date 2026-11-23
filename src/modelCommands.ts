// The model command: which model Euterpe's mind thinks with, on Claude, on an OpenAI-compatible API,
// or on GitHub Copilot.

import * as vscode from "vscode";
import { planDefault, PlanModel } from "./chatgpt";
import { updateSetting } from "./config";
import { copilotDefault, copilotDetail, CopilotModel } from "./copilot";
import { defaultModel, ModelChoice, modelName, modelSetting, modelsFor, sameModel } from "./models";
import { Endpoint, endpointFor, Provider, providerFor } from "./providers";
import { WritingSession } from "./session";

export interface ModelHost {
    session(): WritingSession | null;
    /** The models the writer's ChatGPT plan offers (throws without a sign-in). */
    planModels(): Promise<PlanModel[]>;
    /** The models the writer's GitHub Copilot plan offers in VS Code (none without Copilot). */
    copilotModels(): Promise<CopilotModel[]>;
    /** VS Code's own way to sign in to GitHub Copilot. */
    setUpCopilot(): Promise<void>;
}

type Item = vscode.QuickPickItem & { model?: string; other?: boolean };

/** The provider a model choice is for: the running session's, else the setting's. */
function providerNow(host: ModelHost): Provider {
    return host.session()?.provider ?? providerFor(vscode.workspace.getConfiguration("euterpe").get("provider"));
}

/** The OpenAI-compatible API in the settings: OpenAI's own (Euterpe's picks), the ChatGPT plan (its own models), or another. */
function endpointNow(): Endpoint | null {
    try { return endpointFor(vscode.workspace.getConfiguration("euterpe").get<string>("openaiBaseUrl")); } catch { return null; }
}

/** "Euterpe: Choose Model": for the next sessions, and at once during one. */
export async function chooseModelCommand(host: ModelHost): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("euterpe");
    const provider = providerNow(host);
    const claude = provider === "claude", copilot = provider === "copilot";
    const endpoint = provider === "openai" ? endpointNow() : null;
    const openai = !!endpoint?.openai, plan = !!endpoint?.chatgpt;
    let picks: readonly ModelChoice[] = claude || openai ? modelsFor(provider) : [];
    if (copilot) {
        try {
            const offered = await host.copilotModels();
            const pick = copilotDefault(offered);
            picks = offered.map((m) => ({ id: m.id, name: m.name, detail: copilotDetail(m.id, pick) }));
        } catch (err) {
            void vscode.window.showErrorMessage((err as Error).message);
            return;
        }
        if (!picks.length) {
            const pick = await vscode.window.showErrorMessage("GitHub Copilot offers Euterpe no models: sign in to GitHub Copilot in VS Code first.", "Set Up Copilot");
            if (pick) { await host.setUpCopilot(); }
            return;
        }
    } else if (plan) {
        try {
            picks = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Listing your plan's models" }, () => host.planModels());
        } catch (err) {
            void vscode.window.showErrorMessage((err as Error).message);
            return;
        }
    }
    const live = host.session();
    const current = (live?.provider === provider ? live.model : undefined) ?? (cfg.get<string>(modelSetting(provider)) ?? "").trim();
    const shown = current || (copilot ? copilotDefault(picks) ?? "" : plan ? planDefault(picks) ?? "" : defaultModel(provider, openai));
    const items: Item[] = picks.map((m) => ({ label: m.name, detail: m.detail, model: m.id }));
    if (shown && !items.some((i) => sameModel(i.model!, shown))) {
        items.push({ label: shown, model: shown });
    }
    for (const i of items) { if (sameModel(i.model!, shown)) { i.description = "current"; } }
    const who = claude ? "Claude Code" : plan ? "your ChatGPT plan" : openai ? "OpenAI's API" : "your provider";
    // (Copilot's list is all it offers)
    if (!copilot) {
        items.push(
            ...(items.length ? [{ label: "", kind: vscode.QuickPickItemKind.Separator } as Item] : []),
            { label: "$(edit) Another Model…", detail: `Any model ${who} knows, by name`, other: true },
        );
    }

    const qp = vscode.window.createQuickPick<Item>();
    qp.title = "Euterpe's Model";
    qp.placeholder = `The ${claude ? "Claude " : ""}model Euterpe thinks with: now ${modelName(shown, provider)}`;
    qp.matchOnDetail = true;
    qp.items = items;
    qp.activeItems = items.filter((i) => i.description === "current");
    const picked = await new Promise<Item | undefined>((resolve) => {
        qp.onDidAccept(() => resolve(qp.selectedItems[0]));
        qp.onDidHide(() => resolve(undefined));
        qp.show();
    });
    qp.dispose();
    if (!picked) { return; }
    const model = picked.other
        ? (await vscode.window.showInputBox({
            title: "Euterpe's Model",
            prompt: claude ? "A model name Claude Code knows, as for claude --model" : `A model name ${who} knows, as its API names it`,
            placeHolder: claude ? "claude-opus-5" : openai || plan ? "gpt-5.6-sol" : "the model's id",
            value: picks.some((m) => sameModel(m.id, shown)) ? "" : shown,
            validateInput: (v) => (/\s/.test(v.trim()) ? "A model name is one word, with no spaces." : null),
        }))?.trim()
        : picked.model;
    if (model === undefined || (picked.other && !model) || sameModel(model, shown)) { return; }
    await useModel(host, model);
}

/** Think with `model` from now on: at once during a session (if it's taken), else from the next one. */
export async function useModel(host: ModelHost, model: string, provider = providerNow(host)): Promise<boolean> {
    const s = host.session();
    // A session on the other provider keeps its model: this one is for the next session.
    const live = s && s.provider === provider ? s : null;
    const refused = await live?.changeModel(model);
    if (refused) {
        void vscode.window.showErrorMessage(`Euterpe can't think with ${modelName(model, provider)}: ${refused}`);
        return false;
    }
    await updateSetting(modelSetting(provider), model);
    if (live) { void vscode.window.showInformationMessage(`Euterpe thinks with ${modelName(model, provider)} from now on.`); }
    return true;
}
