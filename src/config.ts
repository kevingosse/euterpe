// Changing Euterpe's settings from its own UI: the choosers, the settings window, an offer
// from the mind.

import * as vscode from "vscode";
import { MACHINE_SETTINGS } from "./settingsModel";

/**
 * A setting VS Code doesn't know yet: it read Euterpe's settings from an older version (one
 * updated in place, like a copy in development), and won't write the new ones until a reload.
 */
export class UnknownSettingError extends Error {
    constructor(readonly key: string) {
        super(`VS Code doesn't know the setting euterpe.${key} yet: it still has an older version of Euterpe's settings. Reload the window, then try again.`);
    }
}

/**
 * Set euterpe.<key> where it takes effect: in this workspace's settings when they set it already
 * (they would win over the writer's own), else in the writer's own settings, where a default
 * value is removed rather than written. Paths and the API's address are machine settings, which
 * only the writer's own settings hold.
 */
export async function updateSetting(key: string, value: unknown): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("euterpe");
    const seen = cfg.inspect(key);
    // Every Euterpe setting has a default: none means VS Code hasn't registered it.
    if (seen?.defaultValue === undefined) { throw new UnknownSettingError(key); }
    if (seen?.workspaceValue !== undefined && !(MACHINE_SETTINGS as readonly string[]).includes(key)) {
        await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
        return;
    }
    const isDefault = value === undefined || JSON.stringify(value) === JSON.stringify(seen?.defaultValue);
    await cfg.update(key, isDefault ? undefined : value, vscode.ConfigurationTarget.Global);
}
