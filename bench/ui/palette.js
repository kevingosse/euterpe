// The command palette, for Euterpe's commands: their titles as package.json gives them, the ones
// its `when` clauses hide left out, and Euterpe's keybinding beside its command.
import { el, esc } from "./util.js";
import { net } from "./net.js";
import { W } from "./workbench.js";

let pkg = null;
fetch("/repo/package.json").then((r) => r.json()).then((p) => { pkg = p; });

function visible(cmd) {
    const rule = (pkg.contributes.menus?.commandPalette || []).find((m) => m.command === cmd.command);
    if (!rule?.when) { return true; }
    if (rule.when === "false") { return false; }
    return rule.when.split("||").some((alt) => alt.split("&&").every((t) => { const m = /^(!)?([\w.]+)$/.exec(t.trim()); if (!m) { return false; } const v = !!W.context[m[2]]; return m[1] ? !v : v; }));
}

export function openPalette({ interactive = true, filter = "Euterpe" } = {}) {
    if (!pkg || !W.root) { return; }
    closePalette();
    const layer = W.root.querySelector("#vsc-layer");
    const node = el("div", { class: "qi", id: "palette", "data-surface": "command-palette" });
    const input = el("input", { type: "text", spellcheck: "false", placeholder: "", value: `>${filter ? ` ${filter}` : ""}` });
    node.append(el("div", { class: "qinput" }, input));
    const list = el("div", { class: "qlist" });
    node.append(list);
    const draw = () => {
        list.innerHTML = "";
        const q = input.value.replace(/^>\s*/, "").toLowerCase();
        const cmds = pkg.contributes.commands.filter(visible).filter((c) => `${c.category}: ${c.title}`.toLowerCase().includes(q));
        let first = true;
        for (const c of cmds) {
            const kb = (pkg.contributes.keybindings || []).find((k) => k.command === c.command);
            const keys = kb ? kb.key.split(" ").map((k) => k.split("+").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("+")).join(" ") : "";
            const row = el("div", { class: `qitem${first ? " active" : ""}`, "data-role": "item", "data-manifest": `command ${c.command}` },
                el("div", { class: "main" }, el("div", { class: "l1" }, el("span", { class: "lbl", html: `${esc(c.category)}: ${esc(c.title)}` }))),
                keys ? el("span", { class: "desc", "data-vscode": "1", style: { marginLeft: "auto" }, text: keys }) : null);
            first = false;
            row.addEventListener("click", () => { if (interactive && W.interactive()) { closePalette(); net.host({ type: "command", command: c.command, args: [] }); } });
            list.append(row);
        }
        if (!cmds.length) { list.append(el("div", { class: "qempty", text: "No matching commands" })); }
    };
    input.addEventListener("input", draw);
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePalette(); } if (e.key === "Enter") { list.querySelector(".qitem.active")?.click(); } });
    draw();
    layer.append(node);
    if (interactive) { setTimeout(() => input.focus(), 20); }
}
export function closePalette() { document.getElementById("palette")?.remove(); }
window.addEventListener("bench:palette", () => openPalette());
