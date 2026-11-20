// The writer's browser, where Euterpe sends them (vscode.env.openExternal): OpenAI's sign-in page
// (the bench's stand-in: it lets you pick how the sign-in goes), then the page Euterpe's own sign-in
// server answers with; any other page, named; a folder, named.
import { net } from "./net.js";
import { el } from "./util.js";
import { W } from "./workbench.js";

const pages = new Map();
let z = 3000;

export function openBrowser(m) {
    const desktop = document.getElementById("desktop");
    const folder = m.kind === "folder";
    const win = el("div", { class: "oswin", "data-surface": folder ? "file-explorer" : "browser", data: { site: m.site }, style: { left: `${18 + pages.size * 3}%`, top: `${8 + pages.size * 3}%`, width: "58%", height: "70%", zIndex: String(++z) } });
    const title = el("span", { class: "t", text: folder ? "File Explorer" : m.kind === "chatgpt-signin" ? "Sign in - OpenAI" : "Your browser" });
    const close = el("span", { class: "x", text: "✕" });
    const bar = el("div", { class: "ostitle" }, el("i", { class: `codicon codicon-${folder ? "folder-opened" : "globe"}` }), title, close);
    const url = el("div", { class: "url", title: m.url, "data-role": "url", text: m.url });
    const addr = el("div", { class: "addr" }, el("i", { class: "codicon codicon-lock" }), url);
    const body = el("div", { class: "osbody" });
    win.append(bar, folder ? null : addr, body);
    desktop.append(win);
    win.addEventListener("pointerdown", () => { win.style.zIndex = String(++z); });
    close.addEventListener("click", () => { win.remove(); pages.delete(m.id); net.host({ type: "browser-close", id: m.id }); });
    drag(win, bar);
    const page = { id: m.id, win, body, url, title, kind: m.kind, raw: m.url };
    pages.set(m.id, page);
    if (m.kind === "chatgpt-signin") { signInStandIn(page); }
    else if (folder) {
        body.style.background = "#191919"; body.style.color = "#e8e8e8"; body.style.padding = "18px";
        body.append(el("p", { text: "Windows opens this folder in File Explorer:" }), el("p", { class: "mono", style: { color: "#9ad1ff" }, "data-role": "path", text: m.url }));
    } else {
        body.append(el("div", { class: "standin" }, el("div", { class: "note", text: "The bench doesn't browse: this is where your browser would open the page Euterpe sends you to." }), el("h2", { text: "Euterpe opens:" }), el("p", { style: { wordBreak: "break-all" } }, el("a", { href: m.url, target: "_blank", rel: "noopener", text: m.url })), el("p", { style: { fontSize: "13px", color: "#666" }, text: m.from === "overlay" ? "(a link in Euterpe's bubble or chat)" : "(vscode.env.openExternal)" })));
    }
    return page;
}

function signInStandIn(page) {
    const q = new URL(page.raw).searchParams;
    const fresh = (q.get("prompt") || "").includes("login");
    const consent = (q.get("prompt") || "").includes("consent");
    const answer = (a) => { net.host({ type: "browser-answer", id: page.id, answer: a }); page.body.innerHTML = "<div class='standin'><p>…</p></div>"; };
    const opts = el("div", { class: "opts" });
    const b = (label, a, go) => { const x = el("button", { class: go ? "go" : "", text: label }); x.addEventListener("click", () => { if (W.interactive() || true) { answer(a); } }); return x; };
    opts.append(b("Continue (let Euterpe use my plan)", "allow", true), b("Continue, but don't let it use my plan", "no-plan"), b("Cancel", "deny"));
    const more = el("details", { style: { marginTop: "12px", fontSize: "13px" } }, el("summary", { text: "Other ways it can go" }),
        el("div", { class: "opts" }, b("OpenAI's sign-in fails", "error"), b("…comes back without a code", "no-code"), b("…without a client ID (first sign-in)", "no-client"), b("…for another app's registration", "other-client"), b("…for another sign-in (wrong state)", "wrong-state")));
    page.body.append(el("div", { class: "standin" },
        el("div", { class: "note", text: "The bench's stand-in for OpenAI's sign-in page (OpenAI's own words aren't Euterpe's to review). Choose how the sign-in goes." }),
        el("h2", { text: q.get("client_id") === "dynamic_agent_client" ? `Sign in to ChatGPT, for ${q.get("agent_name_hint") || "an app"}` : "Sign in to ChatGPT" }),
        el("p", { style: { color: "#555", fontSize: "13px" }, text: `${fresh ? "You're asked to log in again (prompt=login). " : ""}${consent ? "You're asked to allow the plan's use again (prompt=consent). " : ""}${q.get("login_hint") ? `Account: ${q.get("login_hint")}. ` : ""}Scopes: ${q.get("scope")}` }),
        opts, more));
}

function drag(win, handle) {
    handle.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".x")) { return; }
        const r = win.getBoundingClientRect(), d = document.getElementById("desktop").getBoundingClientRect();
        const ox = e.clientX - r.left, oy = e.clientY - r.top;
        const move = (ev) => { win.style.left = `${ev.clientX - d.left - ox}px`; win.style.top = `${ev.clientY - d.top - oy}px`; };
        const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
    });
}

net.on("browser", (m) => {
    if (m.op === "open") { openBrowser(m); return; }
    const page = pages.get(m.id);
    if (!page) { return; }
    if (m.op === "navigate") { page.url.textContent = m.url; page.url.title = m.url; }
    if (m.op === "page") {
        page.body.innerHTML = "";
        page.title.textContent = "Euterpe";
        const frame = el("iframe", { title: "the page Euterpe's sign-in server answered with", "data-surface": "signin-callback" });
        frame.srcdoc = m.html;
        page.body.append(frame);
        page.win.dataset.surface = "signin-callback";
        frame.addEventListener("load", () => window.dispatchEvent(new CustomEvent("bench:frame", { detail: { frame, kind: "browser", id: m.id } })));
    }
});

export function resetBrowser() { for (const p of pages.values()) { p.win.remove(); } pages.clear(); }
export function browserPage(which) { const list = [...pages.values()]; return which ? list.find((p) => p.kind === which) : list[list.length - 1]; }
