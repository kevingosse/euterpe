/** The blanks in mind/system-prompt.md. */
export interface PromptFill {
    /** The persona's Markdown. */
    persona: string;
    /** Euterpe's home: memory and working directory. */
    memoryDir: string;
    /** The writer's OS, as the mind should hear it (platformName). */
    platform: string;
    /** The editor's name (vscode.env.appName). */
    editor: string;
    /** How often the mind looks (Attention.cadence). */
    cadence: string;
    /** The body it wears on screen, described (Mascot.body). */
    body: string;
    /** docs/mascots.md in the extension: how to draw a mascot. */
    mascotGuide: string;
    /** What the mind can do on the web ("search and fetch the web"). */
    web: string;
    /** Its own tools that write files, which the writer's text doesn't go through ("Write or Edit"). */
    fileTools: string;
}

/** The mind's system prompt: the template with its blanks filled in. */
export function assemblePrompt(template: string, fill: PromptFill): string {
    // Replacement functions, so a `$&` or `$1` in a persona stays as written.
    return template
        .replaceAll("{{MEMORY_DIR}}", () => fill.memoryDir.replace(/\\/g, "/"))
        .replaceAll("{{PLATFORM}}", () => fill.platform)
        .replaceAll("{{EDITOR}}", () => fill.editor)
        .replaceAll("{{CADENCE}}", () => fill.cadence)
        .replaceAll("{{BODY}}", () => fill.body)
        .replaceAll("{{WEB}}", () => fill.web)
        .replaceAll("{{FILE_TOOLS}}", () => fill.fileTools)
        .replaceAll("{{MASCOT_GUIDE}}", () => fill.mascotGuide.replace(/\\/g, "/"))
        .replaceAll("{{PERSONA}}", () => fill.persona);
}

/** "macOS (Apple silicon)", "Windows (x64)", "Linux (arm64)"… */
export function platformName(platform: string = process.platform, arch: string = process.arch): string {
    if (platform === "darwin") { return `macOS (${arch === "arm64" ? "Apple silicon" : "Intel"})`; }
    const os = platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
    return `${os} (${arch})`;
}
