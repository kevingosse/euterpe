// Inside an Electron window's page, before its scripts: `require("electron")` as a preload sees it
// (contextBridge, ipcRenderer), wired to the bench's page around it, so overlay/preload.js runs as
// it is and the page gets its window.euterpe.
(function () {
    "use strict";
    const id = new URLSearchParams(location.search).get("bench-win");
    const E = window.parent.benchElectron;
    const report = window.parent.__benchError || (() => { });
    const where = /sheet\.html/.test(location.pathname) ? "sheet" : "overlay";
    window.addEventListener("error", (e) => report(where, `${e.message} @ ${e.filename}:${e.lineno}`));
    window.addEventListener("unhandledrejection", (e) => report(where, `unhandled: ${e.reason && (e.reason.stack || e.reason)}`));
    const ce = console.error;
    console.error = (...a) => { report(where, a.map((x) => (x && x.stack) || String(x)).join(" ")); ce.apply(console, a); };
    // The page's line to the extension, kept within reach: the bench can cut it (VS Code going away).
    const NativeWS = window.WebSocket;
    window.__benchSockets = [];
    window.WebSocket = function (...a) { const s = new NativeWS(...a); window.__benchSockets.push(s); if (window.__benchNoReconnect) { setTimeout(() => s.close(), 0); } return s; };
    window.WebSocket.prototype = NativeWS.prototype;
    window.WebSocket.OPEN = NativeWS.OPEN; window.WebSocket.CLOSED = NativeWS.CLOSED; window.WebSocket.CONNECTING = NativeWS.CONNECTING; window.WebSocket.CLOSING = NativeWS.CLOSING;
    const ipcRenderer = {
        send: (channel, ...args) => E.send(id, channel, JSON.stringify(args)),
        sendSync: (channel) => JSON.parse(E.sync(id, channel)),
        on: (channel, cb) => { E.on(id, channel, (event, ...args) => cb(event, ...JSON.parse(JSON.stringify(args)))); return ipcRenderer; },
        once: (channel, cb) => ipcRenderer.on(channel, cb),
        removeListener: () => ipcRenderer,
        invoke: async () => undefined,
    };
    const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api; } };
    window.require = (m) => {
        if (m === "electron") { return { contextBridge, ipcRenderer }; }
        throw new Error(`Cannot find module '${m}'`);
    };
})();
