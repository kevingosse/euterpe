// The tour: Euterpe's scenarios, chapter by chapter, with where the review stands on each.
import { el } from "./util.js";

export function renderTour(box, catalog, review, current, { start, options }) {
    box.innerHTML = "";
    const all = catalog.chapters.flatMap((c) => c.scenarios);
    const status = (s) => scenarioStatus(s, review);
    const done = all.filter((s) => status(s).state === "done").length;
    const head = el("div", { class: "tour-head" },
        el("div", {}, el("b", { text: "The tour" }), el("span", { class: "muted", text: ` · ${done}/${all.length} scenarios reviewed` })),
        el("div", { class: "progress" }, el("div", { style: { width: `${all.length ? (100 * done) / all.length : 0}%` } })),
        el("div", { class: "tour-tools" },
            el("label", { title: "Pass every screen on its own after a moment: to see a whole scenario play (it doesn't count as reviewed)" }, el("input", { type: "checkbox", checked: options.autoPlay, onchange: (e) => options.setAutoPlay(e.target.checked) }), "Auto-play"),
            el("label", { title: "When a scenario ends, start the next one" }, el("input", { type: "checkbox", checked: options.chain, onchange: (e) => options.setChain(e.target.checked) }), "Chain scenarios")));
    box.append(head);
    for (const ch of catalog.chapters) {
        const d = el("details", { class: "chapter", open: ch.scenarios.some((s) => s.id === current) || !review.screens || ch === catalog.chapters[0] || options.openAll });
        d.append(el("summary", {}, el("i", { class: "codicon codicon-chevron-right" }), el("span", { text: ch.title }), el("span", { class: "muted small", style: { marginLeft: "auto" }, text: `${ch.scenarios.filter((s) => status(s).state === "done").length}/${ch.scenarios.length}` })));
        if (ch.intro) { d.append(el("div", { class: "chapter-intro", text: ch.intro })); }
        for (const s of ch.scenarios) {
            const st = status(s);
            const icon = { done: "pass-filled", part: "circle-large-filled", changed: "issues", none: "circle-large-outline" }[st.state];
            const row = el("div", { class: `scn${s.id === current ? " current" : ""}`, title: s.summary || "", "data-scenario": s.id },
                el("span", { class: `st ${st.state}`, html: `<i class="codicon codicon-${icon}"></i>` }),
                el("div", { class: "name" }, el("div", { text: s.title }),
                    el("div", { class: "meta" }, st.screens ? `${st.reviewed}/${st.screens} screens` : "not played yet", st.changed ? " · changed since" : "", st.comments ? el("span", { class: "ncom", text: ` · ${st.comments} comment${st.comments > 1 ? "s" : ""}` }) : null)));
            row.addEventListener("click", () => start(s.id));
            d.append(row);
        }
        box.append(d);
    }
}

export function scenarioStatus(s, review) {
    const prefix = `${s.id}/`;
    const keys = Object.keys(review.screens || {}).filter((k) => k.startsWith(prefix));
    const known = review.scenarios?.[s.id]?.screens || keys;
    const reviewed = known.filter((k) => review.screens?.[k]?.reviewed).length;
    const changed = known.some((k) => review.screens?.[k]?.changed);
    const comments = (review.comments || []).filter((c) => c.scenario === s.id && c.status === "open").length;
    const finished = !!review.scenarios?.[s.id]?.finished;
    const state = changed ? "changed" : known.length && reviewed === known.length && finished ? "done" : reviewed ? "part" : "none";
    return { state, screens: known.length, reviewed, changed, comments };
}
