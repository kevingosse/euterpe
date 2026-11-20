import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { applyReplacements, parseEdits, planEdits, TextEdit } from "./edits";
import { McpTool, McpToolResult } from "./mcpServer";
import { ProposalState } from "./protocol";

/** The proposed side of a diff: a virtual document computed from the live one. */
export const PROPOSAL_SCHEME = "euterpe-proposal";

/** How a proposal ended. "stale": accepted too late, the text it targeted had changed. */
export type ProposalOutcome = Exclude<ProposalState, "pending">;
/** The endings the mind didn't cause itself (by proposing again, or by the session ending). */
export type Decision = Exclude<ProposalOutcome, "superseded" | "withdrawn">;

interface Proposal {
    id: string;
    target: vscode.Uri;
    name: string;
    edits: TextEdit[];
    /** false: accepting creates the file. */
    exists: boolean;
    /** Left side: the live document, or an empty virtual one for a new file. */
    original: vscode.Uri;
    /** Right side: the live document with the edits applied. */
    proposed: vscode.Uri;
}

export interface ProposalHooks {
    log(msg: string): void;
    /** The tool's `file` argument as a URI; undefined = the document the writer is on. */
    resolve(file: string | undefined): vscode.Uri;
    /** Name as perceptions show it (path relative to the workspace). */
    displayName(uri: vscode.Uri): string;
    /** Apply the accepted edit (the session keeps it out of the writer's typing trace). */
    apply(edit: vscode.WorkspaceEdit): Thenable<boolean>;
    /** A proposal opened or ended (for the overlay's chat). */
    onState(id: string, name: string, state: ProposalState): void;
    /** The writer decided (or the edit could no longer apply): the mind should hear about it. */
    onDecided(name: string, decision: Decision): void;
}

/**
 * Edits the mind proposes, reviewed by the writer in a diff editor: nothing
 * touches the buffer until they accept, and an accepted edit is one undo step.
 * One proposal is open at a time; a newer one replaces it.
 */
export class EditProposals implements vscode.Disposable, vscode.TextDocumentContentProvider {
    private pending: Proposal | null = null;
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changed.event;
    private readonly subscriptions: vscode.Disposable[];
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor(private readonly hooks: ProposalHooks) {
        this.subscriptions = [
            this.changed,
            vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, this),
            // The writer keeps writing while the diff is open: keep the proposed side
            // in step, so the diff only ever shows Euterpe's change.
            vscode.workspace.onDidChangeTextDocument((e) => {
                const p = this.pending;
                if (!p || e.document.uri.toString() !== p.target.toString()) { return; }
                clearTimeout(this.refreshTimer);
                this.refreshTimer = setTimeout(() => this.changed.fire(p.proposed), 250);
            }),
            // Closing the diff without a decision is a no.
            vscode.window.tabGroups.onDidChangeTabs((e) => {
                const p = this.pending;
                if (p && e.closed.some((t) => this.isTabOf(t, p))) { this.settle("dismissed"); }
            }),
        ];
        setPendingContext(false);
    }

    get pendingId(): string | undefined {
        return this.pending?.id;
    }

    /** The propose_edit tool, as the mind sees it. */
    tool(): McpTool {
        return {
            name: "propose_edit",
            description: [
                "Change the writer's text — only when they have explicitly asked you to.",
                "The change opens as a diff in place of their document in VS Code; nothing is modified until the writer accepts it (they may reject it instead), and an accepted edit is a single undo step in their editor.",
                "Copy each old_text exactly from the document as you last saw it (⟨cursor⟩ and ⟨selection⟩ markers are ignored); it must match exactly once unless replace_all is set.",
                "All the edits of one call are matched against the document as it is now, not one after another, and must not overlap.",
                "An empty old_text fills an empty or not-yet-existing file.",
                "One proposal is open at a time: a new call replaces an unreviewed one.",
            ].join(" "),
            inputSchema: {
                type: "object",
                properties: {
                    file: {
                        type: "string",
                        description: "The file to change: absolute, or relative to the workspace. Omit it for the document the writer is working on.",
                    },
                    edits: {
                        type: "array",
                        minItems: 1,
                        items: {
                            type: "object",
                            properties: {
                                old_text: { type: "string", description: "The exact text to replace, copied from the document." },
                                new_text: { type: "string", description: "What replaces it." },
                                replace_all: { type: "boolean", description: "Replace every occurrence of old_text (default false)." },
                            },
                            required: ["old_text", "new_text"],
                            additionalProperties: false,
                        },
                    },
                },
                required: ["edits"],
                additionalProperties: false,
            },
            call: (args) => this.propose(typeof args.file === "string" ? args.file : undefined, args.edits),
        };
    }

    async propose(file: string | undefined, rawEdits: unknown): Promise<McpToolResult> {
        const edits = parseEdits(rawEdits);
        if (typeof edits === "string") { return { text: edits, isError: true }; }
        let target: vscode.Uri;
        try {
            target = this.hooks.resolve(file?.trim() || undefined);
        } catch (err) {
            return { text: (err as Error).message, isError: true };
        }
        const name = this.hooks.displayName(target);
        const doc = await openIfExists(target);
        if (!doc && target.scheme !== "file") {
            return { text: `${name} isn't open anymore.`, isError: true };
        }
        const plan = planEdits(doc?.getText() ?? "", edits, name);
        if (!plan.ok) { return { text: plan.error, isError: true }; }

        const previous = this.pending;
        if (previous) { this.settle("superseded"); }
        const id = crypto.randomBytes(6).toString("hex");
        const virtual = (side: string) => vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: "/" + name.replace(/\\/g, "/"), query: `id=${id}&side=${side}` });
        const p: Proposal = {
            id, target, name, edits,
            exists: !!doc,
            original: doc ? target : virtual("original"),
            proposed: virtual("proposed"),
        };
        this.pending = p;
        setPendingContext(true);
        const changes = plan.replacements.length;
        this.hooks.log(`edit proposed for ${name} (${changes} change${changes === 1 ? "" : "s"})`);
        // In place of the writer's text: the diff already shows it on its left side,
        // so a copy beside it would only take room. Closing the diff brings the text
        // back, and taking the keyboard means it returns there too.
        await vscode.commands.executeCommand("vscode.diff", p.original, p.proposed, `${path.basename(name)} ↔ Euterpe's edit`,
            { preview: false, viewColumn: writerColumn(target) });
        this.hooks.onState(id, name, "pending");
        return {
            text: `Proposed: ${changes} change${changes === 1 ? "" : "s"} to ${name}${p.exists ? "" : " (a new file)"}. ` +
                "The writer sees a diff in place of their text, with Accept and Reject buttons (in VS Code, and in their chat with you). Nothing has changed yet; " +
                "you'll learn what they decided in a later perception." +
                (previous ? ` This replaces your proposal for ${previous.name}, which they hadn't reviewed.` : ""),
        };
    }

    /** Apply the pending edit to the live document. `id` guards against a stale button. */
    async accept(id?: string): Promise<void> {
        const p = this.pending;
        if (!p || (id && id !== p.id)) { return; }
        const doc = await openIfExists(p.target);
        // A file that vanished, or a new one that appeared meanwhile, changed under the edit too.
        const plan = !!doc === p.exists ? planEdits(doc?.getText() ?? "", p.edits, p.name) : null;
        if (!plan?.ok) {
            void vscode.window.showWarningMessage(`The text Euterpe's edit was meant for has changed in ${p.name} since — nothing was applied.`);
            this.settle("stale");
            return;
        }
        const edit = new vscode.WorkspaceEdit();
        if (doc) {
            for (const r of plan.replacements) {
                edit.replace(p.target, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), r.text);
            }
        } else {
            edit.createFile(p.target, { ignoreIfExists: false });
            edit.insert(p.target, new vscode.Position(0, 0), applyReplacements("", plan.replacements));
        }
        const group = this.tabOf(p)?.group;
        if (!(await this.hooks.apply(edit))) {
            void vscode.window.showErrorMessage(`VS Code couldn't apply Euterpe's edit to ${p.name}.`);
            return;
        }
        this.settle("accepted");
        // Closing the diff brings back what it stood in for. A file with no tab of its own
        // (a new one, one that wasn't open) takes the diff's place instead, or its unsaved
        // change would be out of sight — with the keyboard, if the diff's group had it.
        const hasTab = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) =>
            t.input instanceof vscode.TabInputText && t.input.uri.toString() === p.target.toString()));
        if (!hasTab) {
            void vscode.window.showTextDocument(p.target, {
                preview: false,
                preserveFocus: !(group?.isActive ?? true),
                viewColumn: group?.viewColumn ?? vscode.ViewColumn.Active,
            });
        }
    }

    reject(id?: string): void {
        const p = this.pending;
        if (!p || (id && id !== p.id)) { return; }
        this.settle("rejected");
    }

    /** Bring the diff back into view (the overlay's "diff" button). */
    async show(id?: string): Promise<void> {
        const p = this.pending;
        if (!p || (id && id !== p.id)) { return; }
        await vscode.commands.executeCommand("vscode.diff", p.original, p.proposed, `${path.basename(p.name)} ↔ Euterpe's edit`,
            { preview: false, viewColumn: this.tabOf(p)?.group.viewColumn ?? writerColumn(p.target) });
    }

    /** The proposal id carried by a diff's URI (editor title buttons pass the resource). */
    static idOf(uri: unknown): string | undefined {
        if (!(uri instanceof vscode.Uri) || uri.scheme !== PROPOSAL_SCHEME) { return undefined; }
        return new URLSearchParams(uri.query).get("id") ?? undefined;
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const q = new URLSearchParams(uri.query);
        const p = this.pending;
        if (!p || q.get("id") !== p.id || q.get("side") === "original") { return ""; }
        const text = p.exists ? (await openIfExists(p.target))?.getText() ?? "" : "";
        const plan = planEdits(text, p.edits, p.name);
        // Once the writer has rewritten the targeted text, there's nothing left to propose.
        return plan.ok ? applyReplacements(text, plan.replacements) : text;
    }

    dispose(): void {
        this.settle("withdrawn");
        clearTimeout(this.refreshTimer);
        this.subscriptions.forEach((s) => s.dispose());
    }

    private settle(outcome: ProposalOutcome): void {
        const p = this.pending;
        if (!p) { return; }
        this.pending = null;
        setPendingContext(false);
        this.hooks.log(`edit for ${p.name}: ${outcome}`);
        const tab = this.tabOf(p);
        // Not preserving focus: if the writer was in the diff, the keyboard goes back to
        // their text (VS Code only moves it when the diff's group is the active one).
        if (tab) { void vscode.window.tabGroups.close(tab, false); }
        this.hooks.onState(p.id, p.name, outcome);
        if (outcome !== "superseded" && outcome !== "withdrawn") {
            this.hooks.onDecided(p.name, outcome);
        }
    }

    private tabOf(p: Proposal): vscode.Tab | undefined {
        return vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => this.isTabOf(t, p));
    }

    private isTabOf(tab: vscode.Tab, p: Proposal): boolean {
        return tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === p.proposed.toString();
    }
}

async function openIfExists(uri: vscode.Uri): Promise<vscode.TextDocument | null> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) { return open; }
    if (uri.scheme !== "file") { return null; }
    try {
        await vscode.workspace.fs.stat(uri);
    } catch {
        return null;
    }
    return vscode.workspace.openTextDocument(uri);
}

/** The group where the writer sees `target` (the active editor first), else the active group. */
function writerColumn(target: vscode.Uri): vscode.ViewColumn {
    const shows = (e: vscode.TextEditor | undefined): e is vscode.TextEditor =>
        e?.document.uri.toString() === target.toString() && e.viewColumn !== undefined;
    const active = vscode.window.activeTextEditor;
    const editor = shows(active) ? active : vscode.window.visibleTextEditors.find(shows);
    return editor?.viewColumn ?? vscode.ViewColumn.Active;
}

function setPendingContext(on: boolean): void {
    void vscode.commands.executeCommand("setContext", "euterpe.editPending", on);
}
