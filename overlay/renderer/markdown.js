// markdown.js: the little Markdown Euterpe speaks — paragraphs, **bold**, *italic*, `code`,
// fenced code blocks (with a copy button: that's how suggestions travel to the writer),
// links, lists and quotes. Everything is escaped first; only http(s) links are live.
(function () {
    "use strict";

    function escapeHtml(s) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // A bare URL, allowing one level of balanced parentheses (…/Foo_(bar)), trailing punctuation excluded.
    // No "*" either, so **https://…** stays bold around the link.
    const URL_RE = /https?:\/\/(?:[^\s<>()*]|\([^\s<>()*]*\))+(?:[^\s<>().,;:!?'"*]|\([^\s<>()*]*\))/g;

    function inline(s) {
        // Pull out code spans and links first, so emphasis can't reach into them.
        const held = [];
        const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
        s = s.replace(/(`{1,3})([^`\n]+?)\1/g, (_, _t, c) => hold(`<code>${escapeHtml(c)}</code>`));
        s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g, (_, text, url) => hold(`<a data-href="${escapeHtml(url)}">${escapeHtml(text)}</a>`));
        s = s.replace(URL_RE, (url) => hold(`<a data-href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
        s = escapeHtml(s)
            .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
            .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
        return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[+i]);
    }

    function blocks(lines) {
        const out = [];
        let para = [], list = null;
        const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
        const flushList = () => {
            if (!list) return;
            const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
            out.push(`<${list.tag}${start}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
            list = null;
        };
        for (const line of lines) {
            const ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*(\d{1,9})[.)]\s+(.*)$/), q = line.match(/^\s*>\s?(.*)$/);
            if (ul || ol) {
                flushPara();
                const tag = ul ? "ul" : "ol";
                if (!list || list.tag !== tag) { flushList(); list = { tag, items: [], start: ol ? +ol[1] : 1 }; }
                list.items.push(ul ? ul[1] : ol[2]);
            } else if (q) {
                flushPara(); flushList();
                out.push(`<blockquote>${inline(q[1])}</blockquote>`);
            } else if (!line.trim()) {
                flushPara(); flushList();
            } else {
                flushList();
                para.push(line);
            }
        }
        flushPara(); flushList();
        return out.join("");
    }

    const codeBlock = (code) => `<pre data-raw="${escapeHtml(code)}"><button class="copy-btn">copy</button>${escapeHtml(code)}</pre>`;

    // Fences open and close on their own lines; an unterminated fence still makes a block.
    function render(text) {
        const lines = String(text).replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
        let html = "", prose = [], code = null;
        for (const line of lines) {
            if (/^\s*```/.test(line)) {
                if (code === null) { html += blocks(prose); prose = []; code = []; }
                else { html += codeBlock(code.join("\n")); code = null; }
                continue;
            }
            (code === null ? prose : code).push(line);
        }
        if (code !== null) html += codeBlock(code.join("\n"));
        return html + blocks(prose);
    }

    // Wire copy buttons and links inside a rendered element.
    function wire(root, { openExternal, copy }) {
        root.querySelectorAll(".copy-btn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                copy(btn.parentElement.dataset.raw ?? "");
                btn.textContent = "copied!";
                setTimeout(() => (btn.textContent = "copy"), 1400);
            });
        });
        root.querySelectorAll("a[data-href]").forEach((a) => {
            a.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                openExternal(a.dataset.href);
            });
        });
    }

    window.Markdown = { render, wire, escapeHtml };
})();
