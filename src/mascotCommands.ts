// The mascot commands: choose Euterpe's body, preview one, install one someone shared.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { updateSetting } from "./config";
import { chooseMascot, CLAWD, DEFAULT_MASCOT, listMascots, loadMascotFile, Mascot, mascotId } from "./mascots";
import { Provider, providerFor } from "./providers";
import { memoryDir, WritingSession } from "./session";
import { renderMascotSheet } from "./sheet";

export interface MascotHost {
    extensionRoot: string;
    /** The extension's storage: previews are drawn there. */
    storageDir: string;
    output: vscode.OutputChannel;
    /** The avatar runtime, downloaded with the writer's go-ahead if need be; null if there's none. */
    obtainElectron(): Promise<string | null>;
    session(): WritingSession | null;
    startSession(): Promise<void>;
}

/** Where mascots are: the bundled ones, and the writer's own (in Euterpe's home). */
export const mascotDirs = (host: { extensionRoot: string }) => ({ bundled: path.join(host.extensionRoot, "mascots"), mine: path.join(memoryDir(), "mascots") });
const dirs = mascotDirs;

/** What the mind runs on: the running session's, else the setting's (Clawd only comes with Claude). */
function providerNow(host: MascotHost): Provider {
    return host.session()?.provider ?? providerFor(vscode.workspace.getConfiguration("euterpe").get("provider"));
}

/** The body Euterpe wears now, or will at the next session. */
function currentMascot(host: MascotHost): Mascot {
    const live = host.session()?.wearing;
    if (live) { return live; }
    const { bundled, mine } = dirs(host);
    return chooseMascot(vscode.workspace.getConfiguration("euterpe").get<string>("mascot") ?? "", bundled, mine, providerNow(host)).mascot;
}

type Item = vscode.QuickPickItem & { mascot?: Mascot; action?: "install" | "make" | "guide" | "folder" };
const PREVIEW = { iconPath: new vscode.ThemeIcon("eye"), tooltip: "Preview" };

/** "Euterpe: Choose Mascot". */
export async function chooseMascotCommand(host: MascotHost): Promise<void> {
    const { bundled, mine } = dirs(host);
    const current = currentMascot(host);
    const items: Item[] = listMascots(bundled, mine, providerNow(host)).map((m) => ({
        label: m.name,
        description: [m.id === current.id ? "current" : "", m.bundled ? "" : "yours"].filter(Boolean).join(" · "),
        detail: m.description || undefined,
        buttons: [PREVIEW],
        mascot: m,
    }));
    items.push(
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(sparkle) Make One with Euterpe…", detail: "Euterpe draws a mascot with you, during a session", action: "make" },
        { label: "$(desktop-download) Install a Mascot…", detail: "A mascot file someone shared with you", action: "install" },
        { label: "$(book) Mascot Guide", detail: "How a mascot is made, to draw your own (or have an agent draw it)", action: "guide" },
        { label: "$(folder-opened) Open Your Mascots Folder", action: "folder" },
    );
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = "Euterpe's Mascot";
    qp.placeholder = `The body Euterpe wears on screen: now ${current.name}`;
    qp.matchOnDetail = true;
    qp.items = items;
    qp.activeItems = items.filter((i) => i.mascot?.id === current.id);
    const picked = await new Promise<Item | { preview: Mascot } | undefined>((resolve) => {
        qp.onDidAccept(() => resolve(qp.selectedItems[0]));
        qp.onDidTriggerItemButton((e) => resolve({ preview: e.item.mascot! }));
        qp.onDidHide(() => resolve(undefined));
        qp.show();
    });
    qp.dispose();
    if (!picked) { return; }
    if ("preview" in picked) { await previewMascot(host, picked.preview); return; }
    if (picked.mascot) { await wearMascot(host, picked.mascot); return; }
    switch (picked.action) {
        case "make": await makeWithEuterpe(host); break;
        case "install": await installMascot(host); break;
        case "guide": await openMascotGuide(host); break;
        case "folder": await openMascotsFolder(host); break;
    }
}

/** Wear `m` from now on: at once during a session (Clawd only on Claude), else from the next one. */
export async function wearMascot(host: MascotHost, m: Mascot): Promise<void> {
    await updateSetting("mascot", m.id);
    const s = host.session();
    if (s && (m.id !== DEFAULT_MASCOT || s.provider === "claude")) { s.changeMascot(m); }
}

/** The guide to making a mascot (docs/mascots.md), rendered. */
export async function openMascotGuide(host: MascotHost): Promise<void> {
    await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(path.join(host.extensionRoot, "docs", "mascots.md")));
}

/** The writer's own mascots, in the system's file browser. */
export async function openMascotsFolder(host: MascotHost): Promise<void> {
    const { mine } = dirs(host);
    fs.mkdirSync(mine, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(mine));
}

export async function makeWithEuterpe(host: MascotHost): Promise<void> {
    const s = host.session();
    if (s) {
        s.chat("I'd like a new mascot for you. Can we design one together?");
        return;
    }
    const pick = await vscode.window.showInformationMessage("Euterpe draws mascots during a writing session: start one, and ask for a new body.", "Start a Session");
    if (pick) { await host.startSession(); }
}

/** "Euterpe: Preview Mascot": a mascot's model sheet, in an editor tab. */
export async function previewMascot(host: MascotHost, m?: Mascot): Promise<void> {
    const mascot = m ?? await pickMascot(host, "Preview which mascot?");
    if (!mascot) { return; }
    const png = await drawSheet(host, mascot.file, mascot.name);
    if (png) { await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(png), { preview: true }); }
}

/** "Euterpe: Install Mascot…": a pack someone shared, checked and previewed, then kept with the writer's own. */
export async function installMascot(host: MascotHost): Promise<void> {
    const [uri] = await vscode.window.showOpenDialog({ title: "Install a Mascot", filters: { Mascot: ["json"] }, canSelectMany: false }) ?? [];
    if (!uri) { return; }
    let m: Mascot;
    try {
        m = loadMascotFile(uri.fsPath);
    } catch (err) {
        void vscode.window.showErrorMessage(`Can't install that mascot: ${(err as Error).message}`);
        return;
    }
    const png = await drawSheet(host, uri.fsPath, m.name);
    if (!png) { return; }
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(png), { preview: true });
    // The description is part of the mind's instructions: the writer sees it, word for word.
    const install = await vscode.window.showInformationMessage(`Install the mascot "${m.name}"?`, {
        modal: true,
        detail: `${m.description ? `${m.description}\n\n` : ""}Euterpe will hear its body described as: "${m.body}"`,
    }, "Install");
    if (install !== "Install") { return; }
    const { mine } = dirs(host);
    const id = mascotId(path.basename(uri.fsPath).replace(/\.json$/i, "") || m.name);
    const target = path.join(mine, `${id === DEFAULT_MASCOT ? `my-${id}` : id}.json`);
    if (fs.existsSync(target) && path.resolve(target) !== path.resolve(uri.fsPath)) {
        const replace = await vscode.window.showWarningMessage(`You already have a mascot in ${path.basename(target)}. Replace it?`, "Replace");
        if (!replace) { return; }
    }
    fs.mkdirSync(mine, { recursive: true });
    if (path.resolve(target) !== path.resolve(uri.fsPath)) { fs.copyFileSync(uri.fsPath, target); }
    const wear = await vscode.window.showInformationMessage(`Installed ${m.name}. Wear it now?`, "Wear It");
    if (wear) { await wearMascot(host, loadMascotFile(target)); }
}

async function pickMascot(host: MascotHost, placeHolder: string): Promise<Mascot | undefined> {
    const { bundled, mine } = dirs(host);
    const pick = await vscode.window.showQuickPick(
        listMascots(bundled, mine, providerNow(host)).map((m) => ({ label: m.name, detail: m.description || undefined, mascot: m })),
        { placeHolder, matchOnDetail: true });
    return pick?.mascot;
}

/** Draw a pack's model sheet (null: Clawd's) into the extension's storage; its path, or null if it failed (and why is shown). */
async function drawSheet(host: MascotHost, packFile: string | null, name: string): Promise<string | null> {
    const electronPath = await host.obtainElectron();
    if (!electronPath) { return null; }
    const dir = path.join(host.storageDir, "previews");
    fs.mkdirSync(dir, { recursive: true });
    // A new name each time: an editor showing an image doesn't notice it was redrawn.
    for (const f of fs.readdirSync(dir)) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* in use */ } }
    const out = path.join(dir, `${mascotId(name)}-${Date.now().toString(36)}.png`);
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Drawing ${name}…` },
        () => renderMascotSheet({ electronPath, overlayDir: path.join(host.extensionRoot, "overlay"), packFile, out, scale: 3 }));
    if (r.ok) { return r.png; }
    host.output.appendLine(`${name} (${packFile ?? CLAWD.name}):\n${r.problems}`);
    const pick = await vscode.window.showErrorMessage(`${name} doesn't hold up: ${r.problems.split("\n")[0]}`, "Show All");
    if (pick) { host.output.show(true); }
    return null;
}
