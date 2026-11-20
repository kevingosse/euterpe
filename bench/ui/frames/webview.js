// Inside a webview: what VS Code gives its page (acquireVsCodeApi, the theme's body class),
// wired to the bench's page around it.
(function () {
    "use strict";
    const panel = new URL(document.currentScript.src).searchParams.get("panel");
    const P = window.parent.benchWebview;
    const report = window.parent.__benchError || (() => { });
    window.addEventListener("error", (e) => report("webview", `${e.message} @ ${e.filename}:${e.lineno}`));
    window.addEventListener("unhandledrejection", (e) => report("webview", `unhandled: ${e.reason && (e.reason.stack || e.reason)}`));
    document.addEventListener("securitypolicyviolation", (e) => report("webview", `CSP blocked ${e.blockedURI} (${e.violatedDirective})`));
    let acquired = false;
    const theme = () => { if (document.body) { document.body.classList.add(P.themeClass()); document.body.dataset.vscodeThemeKind = P.themeClass(); } };
    window.acquireVsCodeApi = function () {
        if (acquired) { throw new Error("An instance of the VS Code API has already been acquired"); }
        acquired = true;
        theme();
        return Object.freeze({
            postMessage: (m) => P.post(panel, m),
            getState: () => P.getState(panel),
            setState: (s) => { P.setState(panel, s); return s; },
        });
    };
    document.addEventListener("DOMContentLoaded", theme);
})();
