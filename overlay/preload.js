const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("euterpe", {
    initialMascot: () => ipcRenderer.sendSync("initial-mascot"),
    fallbackMascot: () => ipcRenderer.sendSync("fallback-mascot"),
    setIgnoreMouse: (ignore) => ipcRenderer.send("set-ignore-mouse", ignore),
    dragStart: () => ipcRenderer.send("drag-start"),
    dragEnd: () => ipcRenderer.send("drag-end"),
    onDragMove: (cb) => ipcRenderer.on("drag-move", (_e, v) => cb(v)),
    resizeStart: (edge) => ipcRenderer.send("resize-start", edge),
    resizeEnd: () => ipcRenderer.send("resize-end"),
    onGaze: (cb) => ipcRenderer.on("gaze", (_e, dir) => cb(dir)),
    onPointer: (cb) => ipcRenderer.on("pointer", (_e, at) => cb(at)),
    showContextMenu: () => ipcRenderer.send("show-context-menu"),
    showTextMenu: (selection, editable) => ipcRenderer.send("show-text-menu", { selection, editable }),
    onMenu: (cb) => ipcRenderer.on("menu", (_e, cmd) => cb(cmd)),
    copy: (text) => ipcRenderer.send("copy", text),
    openExternal: (url) => ipcRenderer.send("open-external", url),
    focusWindow: () => ipcRenderer.send("focus-window"),
    setFocusable: (on) => ipcRenderer.send("set-focusable", on),
    blurWindow: () => ipcRenderer.send("blur-window"),
    quit: () => ipcRenderer.send("quit"),
});
