// The persona commands: choose one, write a new one, install one someone shared.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { updateSetting } from "./config";
import { choosePersona, listPersonas, loadPersonaFile, newPersonaText, Persona, personaId } from "./personas";
import { memoryDir } from "./session";

export interface PersonaHost {
    extensionRoot: string;
    /** A session is running: a new persona waits for the next one. */
    sessionRunning(): boolean;
}

/** Where personas are: the bundled ones, and the writer's own (in Euterpe's home). */
export function personaDirs(host: { extensionRoot: string }): { bundled: string; mine: string } {
    return { bundled: path.join(host.extensionRoot, "mind", "personas"), mine: path.join(memoryDir(), "personas") };
}
const dirs = personaDirs;

/** The persona the next session would get. */
function currentPersona(host: PersonaHost): Persona {
    const cfg = vscode.workspace.getConfiguration("euterpe");
    const { bundled, mine } = dirs(host);
    return choosePersona(cfg.get<string>("persona") ?? "", bundled, mine).persona;
}

type Item = vscode.QuickPickItem & { persona?: Persona; action?: "new" | "install" | "folder" };
const EDIT = { iconPath: new vscode.ThemeIcon("edit"), tooltip: "Edit" };
const COPY = { iconPath: new vscode.ThemeIcon("copy"), tooltip: "Make a copy to edit" };

/** "Euterpe: Choose Persona". */
export async function choosePersonaCommand(host: PersonaHost): Promise<void> {
    const { bundled, mine } = dirs(host);
    const current = currentPersona(host);
    const items: Item[] = listPersonas(bundled, mine).map((p) => ({
        label: p.name,
        description: [p.file === current.file ? "current" : "", p.bundled ? "" : "yours"].filter(Boolean).join(" · "),
        detail: p.description || undefined,
        buttons: [p.bundled ? COPY : EDIT],
        persona: p,
    }));
    items.push(
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(add) New Persona…", detail: "Starts as a copy of the current one, for you to rewrite", action: "new" },
        { label: "$(desktop-download) Install a Persona…", detail: "A persona file someone shared with you", action: "install" },
        { label: "$(folder-opened) Open Your Personas Folder", action: "folder" },
    );

    const qp = vscode.window.createQuickPick<Item>();
    qp.title = "Euterpe's Persona";
    qp.placeholder = `Who Euterpe is: now ${current.name}`;
    qp.matchOnDetail = true;
    qp.items = items;
    qp.activeItems = items.filter((i) => i.persona?.file === current.file);
    const picked = await new Promise<Item | { edit: Persona } | undefined>((resolve) => {
        qp.onDidAccept(() => resolve(qp.selectedItems[0]));
        qp.onDidTriggerItemButton((e) => resolve({ edit: e.item.persona! }));
        qp.onDidHide(() => resolve(undefined));
        qp.show();
    });
    qp.dispose();
    if (!picked) { return; }
    if ("edit" in picked) { await editPersona(host, picked.edit); }
    else if (picked.persona) { await usePersona(host, picked.persona); }
    else if (picked.action === "new") { await newPersona(host, current); }
    else if (picked.action === "install") { await installPersona(host); }
    else if (picked.action === "folder") { await openPersonasFolder(host); }
}

/** The writer's own persona opens for writing; a bundled one is copied first, under a new name. */
export async function editPersona(host: PersonaHost, p: Persona): Promise<void> {
    if (p.bundled) { await newPersona(host, p); }
    else { await vscode.window.showTextDocument(vscode.Uri.file(p.file)); }
}

/** The writer's own personas, in the system's file browser. */
export async function openPersonasFolder(host: PersonaHost): Promise<void> {
    const { mine } = dirs(host);
    fs.mkdirSync(mine, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(mine));
}

/** Make `p` the persona of the next sessions. */
export async function usePersona(host: PersonaHost, p: Persona, quiet = false): Promise<void> {
    await updateSetting("persona", p.id);
    if (!quiet && host.sessionRunning()) {
        void vscode.window.showInformationMessage(`Euterpe will be ${p.name} from the next session.`);
    }
}

/** "Euterpe: New Persona": a copy of `from` (or the current persona) under a new name, opened for writing. */
export async function newPersona(host: PersonaHost, from?: Persona): Promise<void> {
    const base = from ?? currentPersona(host);
    const name = (await vscode.window.showInputBox({
        title: "New Persona",
        prompt: `A name for it. It starts as a copy of ${base.name}, for you to rewrite.`,
        value: from?.bundled ? `My ${base.name}` : "",
        validateInput: (v) => (v.trim() ? null : "A name, please"),
    }))?.trim();
    if (!name) { return; }
    const { mine } = dirs(host);
    const file = path.join(mine, `${personaId(name)}.md`);
    if (fs.existsSync(file) && !(await confirm(`You already have a persona in ${path.basename(file)}. Replace it?`, "Replace"))) { return; }
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(file, newPersonaText(name, base), "utf8");
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    await usePersona(host, loadPersonaFile(file), true);
    void vscode.window.showInformationMessage(`Euterpe is ${name} from the next session. Rewrite it as you like, and save.`);
}

/** "Euterpe: Install Persona…": a persona file someone shared, read first, then copied into the writer's personas. */
export async function installPersona(host: PersonaHost): Promise<void> {
    const [uri] = await vscode.window.showOpenDialog({ title: "Install a Persona", filters: { Persona: ["md"] }, canSelectMany: false }) ?? [];
    if (!uri) { return; }
    let p: Persona;
    try {
        p = loadPersonaFile(uri.fsPath);
    } catch (err) {
        void vscode.window.showErrorMessage(`Can't install that persona: ${(err as Error).message}`);
        return;
    }
    await vscode.window.showTextDocument(uri, { preview: true });
    // A persona is instructions to an agent that runs commands and changes files without asking.
    if (!(await confirm(
        `Install the persona "${p.name}"? It becomes part of the instructions of Euterpe's mind, which can run commands and change files without asking you. Read it first: it's open in the editor.`,
        "Install", true))) { return; }
    const { mine } = dirs(host);
    const target = path.join(mine, `${p.id}.md`);
    if (fs.existsSync(target) && !(await confirm(`You already have a persona in ${path.basename(target)}. Replace it?`, "Replace"))) { return; }
    fs.mkdirSync(mine, { recursive: true });
    fs.copyFileSync(uri.fsPath, target);
    if (await confirm(`Installed "${p.name}". Use it now?`, "Use It")) {
        await usePersona(host, loadPersonaFile(target));
    }
}

async function confirm(message: string, action: string, modal = false): Promise<boolean> {
    return (await vscode.window.showInformationMessage(message, { modal }, action)) === action;
}
