// Webviews (Euterpe's settings window): the extension's own HTML, run as VS Code runs it, in a frame
// with VS Code's theme variables and acquireVsCodeApi (frames/webview.js). Its Content Security
// Policy stays: the bench's scripts carry its nonce.
import { net } from "./net.js";
import { el } from "./util.js";
import { W } from "./workbench.js";

const THEMES = {
    dark: {
        "--vscode-foreground": "#cccccc", "--vscode-descriptionForeground": "#9d9d9d", "--vscode-editor-background": "#1f1f1f", "--vscode-editor-foreground": "#cccccc",
        "--vscode-focusBorder": "#0078d4", "--vscode-errorForeground": "#f85149", "--vscode-editorWarning-foreground": "#cca700", "--vscode-textLink-foreground": "#4daafc",
        "--vscode-textLink-activeForeground": "#4daafc", "--vscode-input-background": "#313131", "--vscode-input-foreground": "#cccccc", "--vscode-input-border": "#3c3c3c",
        "--vscode-input-placeholderForeground": "#989898", "--vscode-button-background": "#0078d4", "--vscode-button-foreground": "#ffffff", "--vscode-button-hoverBackground": "#026ec1",
        "--vscode-button-secondaryBackground": "#313131", "--vscode-button-secondaryForeground": "#cccccc", "--vscode-button-secondaryHoverBackground": "#3c3c3c",
        "--vscode-button-border": "#ffffff12", "--vscode-badge-background": "#616161", "--vscode-badge-foreground": "#f8f8f8", "--vscode-scrollbarSlider-background": "#79797966",
        "--vscode-scrollbarSlider-hoverBackground": "#646464b3", "--vscode-scrollbarSlider-activeBackground": "#bfbfbf66",
        "--vscode-font-family": '"Segoe WPC", "Segoe UI", sans-serif', "--vscode-font-size": "13px", "--vscode-font-weight": "normal",
        "--vscode-editor-font-family": 'Consolas, "Courier New", monospace', "--vscode-editor-font-size": "14px", "--vscode-editor-font-weight": "normal",
    },
    light: {
        "--vscode-foreground": "#3b3b3b", "--vscode-descriptionForeground": "#616161", "--vscode-editor-background": "#ffffff", "--vscode-editor-foreground": "#3b3b3b",
        "--vscode-focusBorder": "#005fb8", "--vscode-errorForeground": "#f85149", "--vscode-editorWarning-foreground": "#bf8803", "--vscode-textLink-foreground": "#005fb8",
        "--vscode-textLink-activeForeground": "#005fb8", "--vscode-input-background": "#ffffff", "--vscode-input-foreground": "#3b3b3b", "--vscode-input-border": "#cecece",
        "--vscode-input-placeholderForeground": "#767676", "--vscode-button-background": "#005fb8", "--vscode-button-foreground": "#ffffff", "--vscode-button-hoverBackground": "#0258a8",
        "--vscode-button-secondaryBackground": "#e5e5e5", "--vscode-button-secondaryForeground": "#3b3b3b", "--vscode-button-secondaryHoverBackground": "#cccccc",
        "--vscode-button-border": "#0000001a", "--vscode-badge-background": "#cccccc", "--vscode-badge-foreground": "#3b3b3b", "--vscode-scrollbarSlider-background": "#64646466",
        "--vscode-scrollbarSlider-hoverBackground": "#646464b3", "--vscode-scrollbarSlider-activeBackground": "#00000099",
        "--vscode-font-family": '"Segoe WPC", "Segoe UI", sans-serif', "--vscode-font-size": "13px", "--vscode-font-weight": "normal",
        "--vscode-editor-font-family": 'Consolas, "Courier New", monospace', "--vscode-editor-font-size": "14px", "--vscode-editor-font-weight": "normal",
    },
};
// What VS Code puts in every webview before the page's own (its default styles).
const DEFAULT_CSS = `html{scrollbar-color:var(--vscode-scrollbarSlider-background) var(--vscode-editor-background)}body{overscroll-behavior-x:none;background-color:transparent;color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-weight:var(--vscode-font-weight);font-size:var(--vscode-font-size);margin:0;padding:0 20px}img,video{max-width:100%;max-height:100%}a,a code{color:var(--vscode-textLink-foreground)}code{font-family:var(--vscode-editor-font-family)}::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background-color:var(--vscode-scrollbarSlider-background)}::-webkit-scrollbar-thumb:hover{background-color:var(--vscode-scrollbarSlider-hoverBackground)}`;

export const panels = new Map();   // id -> { id, holder, frame, queue, loaded, state, viewType, title }

window.benchWebview = {
    post(id, message) { net.host({ type: "webview-message", id, message: JSON.parse(JSON.stringify(message ?? null)) }); },
    getState(id) { const p = panels.get(id); return p?.state === undefined ? undefined : JSON.parse(JSON.stringify(p.state)); },
    setState(id, s) { const p = panels.get(id); if (p) { p.state = JSON.parse(JSON.stringify(s ?? null)); } },
    themeClass() { return W.light ? "vscode-light" : "vscode-dark"; },
    vars() { return THEMES[W.light ? "light" : "dark"]; },
};

W.webviews = { holder: (id) => panels.get(id)?.holder };

function ensure(id, m = {}) {
    let p = panels.get(id);
    if (!p) {
        const frame = el("iframe", { class: "webview-frame", title: m.title || "webview", "data-panel": id });
        const holder = el("div", { class: "webview-holder", "data-panel": id, "data-surface": m.viewType === "euterpe.settings" ? "settings-window" : `webview:${m.viewType || ""}`, data: { site: m.site } }, frame);
        Object.assign(holder.style, { position: "absolute", left: "0", top: "0", width: "10px", height: "10px", visibility: "hidden" });
        p = { id, holder, frame, queue: [], loaded: false, state: undefined, viewType: m.viewType, title: m.title };
        frame.addEventListener("load", () => {
            p.loaded = true;
            for (const msg of p.queue.splice(0)) { frame.contentWindow.postMessage(msg, "*"); }
            // The browser's own bubble for a field that refuses a value isn't part of the page: the
            // bench draws one in its place, so its words can be read (and commented on).
            frame.contentDocument.addEventListener("invalid", (e) => validationBubble(frame, e.target), true);
            window.dispatchEvent(new CustomEvent("bench:frame", { detail: { frame, kind: "webview", id } }));
        });
        frame.addEventListener("bench:theme", () => applyTheme(p));
        panels.set(id, p);
        (W.root?.querySelector("#webview-layer") || document.body).append(holder);
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("bench:place-webviews")));
    }
    return p;
}

function inject(html, id) {
    const nonce = /nonce="([^"]+)"/.exec(html)?.[1] || "";
    const vars = Object.entries(window.benchWebview.vars()).map(([k, v]) => `${k}:${v}`).join(";");
    const head = `<style id="_defaultStyles">:root{${vars}}${DEFAULT_CSS}</style><script nonce="${nonce}" src="${location.origin}/ui/frames/webview.js?panel=${encodeURIComponent(id)}"></script>`;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}${head}`) : head + html;
}

function applyTheme(p) {
    const doc = p.frame.contentDocument;
    if (!doc?.documentElement) { return; }
    for (const [k, v] of Object.entries(window.benchWebview.vars())) { doc.documentElement.style.setProperty(k, v); }
    doc.body?.classList.remove("vscode-dark", "vscode-light");
    doc.body?.classList.add(window.benchWebview.themeClass());
}

net.on("webview", (m) => {
    if (m.op === "create") { ensure(m.id, m); }
    else if (m.op === "html") { const p = ensure(m.id, m); p.loaded = false; p.frame.srcdoc = inject(m.html, m.id); }
    else if (m.op === "post") {
        const p = ensure(m.id);
        if (p.loaded && p.frame.contentWindow) { p.frame.contentWindow.postMessage(m.message, "*"); } else { p.queue.push(m.message); }
    }
    else if (m.op === "dispose") { const p = panels.get(m.id); p?.holder.remove(); panels.delete(m.id); }
});

function validationBubble(frame, field) {
    const msg = field?.validationMessage;
    if (!msg) { return; }
    document.querySelector(".validation-bubble")?.remove();
    const desk = document.getElementById("desktop");
    const d = desk.getBoundingClientRect(), f = frame.getBoundingClientRect(), r = field.getBoundingClientRect();
    const b = el("div", { class: "validation-bubble", "data-surface": "settings-window", "data-role": "validation", text: msg });
    Object.assign(b.style, { position: "absolute", left: `${f.left + r.left - d.left}px`, top: `${f.top + r.bottom + 6 - d.top}px`, zIndex: "9000", background: "#fff", color: "#222", border: "1px solid #999", borderRadius: "4px", padding: "6px 10px", font: "13px 'Segoe UI', sans-serif", boxShadow: "0 4px 14px #0006", maxWidth: "420px" });
    desk.append(b);
    // gone once the field changes, as Chromium's (which also fades after a few seconds: this one
    // stays, to be read and commented on)
    field.addEventListener("input", () => b.remove(), { once: true });
}

export function resetWebviews() {
    document.querySelector(".validation-bubble")?.remove();
    for (const p of panels.values()) { p.holder.remove(); }
    panels.clear();
}

/** The frame of a webview, for the scenario's hands (scroll, click) and for comments. */
export function webviewFrame(which) {
    const list = [...panels.values()];
    const p = which ? list.find((x) => x.id === which || x.viewType === which) : list[0];
    return p?.frame || null;
}
