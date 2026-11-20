// The page's line to the bench server: one WebSocket, reconnected if it drops. Messages come in
// by type; what the page sends goes to the server, the scenario's extension host, or a stand-in.

const handlers = new Map();
let ws = null;
let queue = [];
export const net = {
    run: null,
    on(type, fn) { if (!handlers.has(type)) { handlers.set(type, []); } handlers.get(type).push(fn); },
    /** to: "server", "host", or "proc" (with extra.proc). */
    send(to, msg, extra = {}) {
        const line = JSON.stringify({ to, msg, run: net.run, ...extra });
        if (ws && ws.readyState === 1) { ws.send(line); } else { queue.push(line); }
    },
    host(msg) { net.send("host", msg); },
    server(msg) { net.send("server", msg); },
};

function dispatch(msg) {
    for (const fn of handlers.get(msg.type) || []) {
        try { fn(msg); } catch (err) { console.error(`bench: ${msg.type} handler failed`, err); }
    }
    for (const fn of handlers.get("*") || []) { try { fn(msg); } catch (err) { console.error(err); } }
}

export function connect() {
    ws = new WebSocket(`ws://${location.host}/ws?role=ui`);
    ws.onopen = () => { const q = queue; queue = []; for (const l of q) { ws.send(l); } dispatch({ type: "net-open" }); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } dispatch(m); };
    ws.onclose = () => { dispatch({ type: "net-closed" }); setTimeout(connect, 1200); };
}
