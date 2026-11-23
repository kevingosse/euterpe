// app.js: the overlay's view. Renders what the mind says and does, forwards what the writer
// types. The only autonomy here is Clawd's body (clawd/director.js): reflexes, not judgment.
(function () {
    "use strict";
    const C = window.Clawd, E = window.euterpe, MD = window.Markdown;

    const params = new URLSearchParams(location.search);
    const PORT = params.get("port");
    const TOKEN = params.get("token") || "";
    const DEMO = params.get("demo") === "1";
    const SCALE = Math.max(2, Math.min(6, Math.round(+params.get("scale") || 4)));
    const CHARS_PER_SEC = 62;
    const MDX = { openExternal: E.openExternal, copy: E.copy };

    document.documentElement.style.setProperty("--px", `${Math.max(2, Math.round(SCALE * 0.75))}px`);
    // A mind that isn't on Claude wears its own colour rather than Claude's clay: blue, or Copilot's purple.
    if (["openai", "copilot"].includes(params.get("theme"))) document.documentElement.classList.add(`theme-${params.get("theme")}`);

    // The body Euterpe wears: Clawd, or a mascot pack the writer picked (clawd/pack.js). A pack
    // that doesn't hold up leaves the fallback on stage: Clawd, unless the mind isn't on Claude.
    const FALLBACK = (E.fallbackMascot && E.fallbackMascot()) || null;
    function compile(m) {
        try {
            return C.compileMascot(m.pack, m.id);
        } catch (err) {
            console.error(`mascot ${m.id}: ${err.message}`);
            return null;
        }
    }
    function wear(m) {
        const body = m && m.pack ? compile(m) : null;
        if (body || (m && !m.pack && !FALLBACK)) { C.useMascot(body); return; }
        C.useMascot(FALLBACK && FALLBACK.pack ? compile(FALLBACK) : null);
    }
    wear(E.initialMascot() || FALLBACK);

    const director = new C.Director();
    const stage = new C.Stage(document.getElementById("stage"), { scale: SCALE, director });
    const now = () => stage.now();
    stage.start();
    director.enter(now() + 0.3);
    // While the first turn runs (Euterpe is reading memory and the draft), Clawd reads, however
    // long it takes. The first answer replaces this: a new expression supersedes a change still pending.
    if (!DEMO) director.setExpression("reading", now() + C.ENTER + 0.3, { hold: true });

    const $ = (id) => document.getElementById(id);
    const bubble = $("bubble"), bubbleContent = $("bubble-content"), tail = $("bubble-tail");
    const panel = $("chat-panel"), log = $("chat-log"), input = $("chat-input");
    const badge = $("notes-badge"), badgeCount = $("notes-count");

    let ws = null, wsRetries = 0, leaving = false;
    let thinkingRow = null;

    // ---------- layout ----------
    function drawTail() {
        const rows = ["icccci.", ".iccci.", "..icci.", "...ici.", "....ii."];
        const g = tail.getContext("2d");
        g.clearRect(0, 0, 7, 5);
        rows.forEach((row, y) => [...row].forEach((ch, x) => {
            if (ch === ".") return;
            g.fillStyle = ch === "i" ? "#2B2233" : "#FFF5E2";
            g.fillRect(x, y, 1, 1);
        }));
    }
    function layout() {
        const a = stage.anchor();
        panel.style.bottom = `${Math.max(120, window.innerHeight - a.headTop + 30)}px`;
        // by the upper-left corner of Clawd's head: emotes pop up on the right
        badge.style.left = `${Math.round(a.left - badge.offsetWidth - 10)}px`;
        badge.style.top = `${Math.round(a.headTop - 16)}px`;
        if (!bubble.classList.contains("hidden")) positionBubble();
    }
    function cssPx() {
        return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--px")) || 3;
    }
    function positionBubble() {
        const a = stage.anchor(), px = cssPx();
        const bottom = Math.round(window.innerHeight - a.headTop + 10 + 5 * px);
        // long answers scroll inside the bubble rather than run off the top of a short screen
        bubbleContent.style.maxHeight = `${Math.max(80, Math.min(340, window.innerHeight - bottom - 24 - 4 * px))}px`;
        const w = bubble.offsetWidth;
        const right = Math.min(window.innerWidth - 10 - px, a.x + 70);
        const left = Math.max(8 + px, right - w);
        bubble.style.left = `${Math.round(left)}px`;
        bubble.style.bottom = `${bottom}px`;
        tail.style.left = `${Math.round(Math.min(w - 8 * px, Math.max(px, a.x - left - 3 * px)))}px`;
    }
    drawTail();
    window.addEventListener("resize", layout);
    stage.onScale = layout;
    setTimeout(layout, 50);

    // ---------- speech ----------
    const talkDuration = (text) => Math.min(6, 0.35 + text.length / CHARS_PER_SEC);
    // After the bubble has finished writing itself: long enough to be caught with a glance
    // after finishing a sentence, longer for longer words.
    const readingTime = (text) => Math.min(45, Math.max(14, 8 + text.length * 0.06));
    let typer = null, hideTimer = null, bubbleText = "", typingEndsAt = 0;

    function textNodes(root) {
        const out = [], walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement.closest(".copy-btn")) out.push(n);
        return out;
    }
    function stopTyping() {
        if (!typer) return;
        clearInterval(typer.timer);
        for (const s of typer.slots) { s.shown.data = s.full; s.ghost.remove(); }
        typer = null;
        typingEndsAt = Date.now();
    }
    // The bubble writes itself out while Clawd's mouth moves. The untyped rest is kept as
    // invisible text, so the bubble has its final size from the first frame.
    function showBubble(text) {
        clearTimeout(hideTimer);
        stopTyping();
        bubble.classList.remove("hidden", "leaving");
        bubbleContent.innerHTML = MD.render(text);
        MD.wire(bubbleContent, MDX);
        bubbleContent.scrollTop = 0;
        bubbleText = text;
        positionBubble();
        const slots = textNodes(bubbleContent).map((node) => {
            const ghost = document.createElement("span");
            ghost.className = "ghost";
            ghost.textContent = node.data;
            node.after(ghost);
            const full = node.data;
            node.data = "";
            return { shown: node, ghost, full };
        });
        const total = slots.reduce((n, s) => n + s.full.length, 0);
        let shown = 0;
        typer = { slots, timer: null };
        typingEndsAt = Date.now() + (total / CHARS_PER_SEC) * 1000;
        const step = () => {
            shown = Math.min(total, shown + Math.max(1, Math.round(CHARS_PER_SEC / 30)));
            let left = shown;
            for (const s of slots) {
                const k = Math.max(0, Math.min(s.full.length, left));
                s.shown.data = s.full.slice(0, k);
                s.ghost.textContent = s.full.slice(k);
                left -= s.full.length;
            }
            if (shown >= total) stopTyping();
        };
        typer.timer = setInterval(step, 1000 / 30);
        scheduleHide();
    }
    // Hide once the bubble has finished typing plus its reading time, never mid-sentence.
    function scheduleHide(minSeconds = 0) {
        clearTimeout(hideTimer);
        const typingLeft = Math.max(0, typingEndsAt - Date.now()) / 1000;
        const delay = Math.max(minSeconds, typingLeft + readingTime(bubbleText));
        hideTimer = setTimeout(() => hideBubble(), delay * 1000);
    }
    function hideBubble(instant = false) {
        clearTimeout(hideTimer);
        stopTyping();
        if (bubble.classList.contains("hidden")) return;
        if (instant) { bubble.classList.add("hidden"); return; }
        bubble.classList.add("leaving");
        setTimeout(() => { if (bubble.classList.contains("leaving")) bubble.classList.add("hidden"); }, 220);
    }
    bubble.addEventListener("click", (e) => {
        if (e.target.closest("a, .copy-btn") || window.getSelection().toString()) return;
        typer ? stopTyping() : hideBubble();
    });
    bubble.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    // brushing past it shouldn't cut a long message short: at least 5 s more, and never mid-typing
    bubble.addEventListener("mouseleave", () => {
        if (bubble.classList.contains("hidden")) return;
        clearTimeout(hideTimer);
        const typingLeft = Math.max(0, typingEndsAt - Date.now()) / 1000;
        hideTimer = setTimeout(() => hideBubble(), Math.max(5, typingLeft + 5) * 1000);
    });

    function say(text) {
        appendChat("euterpe", text);
        director.talk(now(), talkDuration(text));
        if (!chatOpen()) showBubble(text);
    }

    // ---------- chat log ----------
    const chatOpen = () => !panel.classList.contains("hidden");
    function scrollLog() { log.scrollTop = log.scrollHeight; }
    // A new row goes above the thinking dots, if they're showing.
    function appendRow(div) {
        log.insertBefore(div, thinkingRow && thinkingRow.parentElement === log ? thinkingRow : null);
        scrollLog();
    }
    function appendChat(role, text) {
        const div = document.createElement("div");
        div.className = `msg ${role} pixel-frame`;
        div.innerHTML = MD.render(text);
        MD.wire(div, MDX);
        appendRow(div);
    }
    function appendSystem(text, error = false) {
        const div = document.createElement("div");
        div.className = `msg system${error ? " error" : ""}`;
        div.textContent = text;
        appendRow(div);
    }

    // An edit Euterpe proposed: the diff is in VS Code; the chat keeps a row with the same
    // Accept / Reject, and a button to bring the diff back. The row stays as a record once decided.
    const proposalRows = new Map();
    const PROPOSAL_ENDINGS = {
        accepted: "accepted", rejected: "rejected", dismissed: "closed without a decision",
        stale: "not applied: the text had changed", superseded: "replaced by a newer one", withdrawn: "withdrawn",
    };
    function showProposal(msg) {
        const row = proposalRows.get(msg.id);
        if (!row) {
            if (msg.state !== "pending") return;
            const div = document.createElement("div");
            div.className = "msg proposal pixel-frame";
            div.innerHTML = '<div class="proposal-title"></div><div class="proposal-actions">' +
                '<button data-decision="accept">Accept</button><button data-decision="reject">Reject</button><button data-decision="show">Diff</button></div>';
            div.querySelector(".proposal-title").textContent = `✎ An edit to ${msg.file}, open in VS Code`;
            div.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
                e.stopPropagation();
                const decision = b.dataset.decision;
                if (!send({ type: "proposal", id: msg.id, decision }) && DEMO && decision !== "show") {
                    showProposal({ id: msg.id, file: msg.file, state: decision === "accept" ? "accepted" : "rejected" });
                }
            }));
            proposalRows.set(msg.id, div);
            appendRow(div);
            return;
        }
        if (msg.state === "pending") return;
        proposalRows.delete(msg.id);
        row.classList.add("settled", msg.state);
        row.querySelector(".proposal-title").textContent = `✎ The edit to ${msg.file}: ${PROPOSAL_ENDINGS[msg.state] || msg.state}`;
        row.querySelector(".proposal-actions").remove();
    }
    // While a chat turn is in flight Clawd looks thoughtful; if it ends without an answer
    // (a failed turn), the mood from before comes back.
    let moodBeforeThinking = null;
    function setThinking(on, answered = false) {
        const t = now();
        if (on && moodBeforeThinking === null) {
            moodBeforeThinking = director.expressionAt(t);
            director.setThinking(true, t);
        } else if (!on && moodBeforeThinking !== null) {
            if (!answered && director.expressionAt(t + C.LEAD) === "thinking") director.setExpression(moodBeforeThinking, t);
            moodBeforeThinking = null;
        }
        if (on && !thinkingRow) {
            thinkingRow = document.createElement("div");
            thinkingRow.className = "thinking-row pixel-frame";
            thinkingRow.innerHTML = "<span></span><span></span><span></span>";
            log.appendChild(thinkingRow);
            scrollLog();
        } else if (!on && thinkingRow) {
            thinkingRow.remove();
            thinkingRow = null;
        }
    }
    function setNotes(n) {
        badgeCount.textContent = String(n);
        badge.classList.toggle("hidden", !n);
        layout();
    }

    // The window only takes the keyboard while the chat is open (see main.js).
    function openChat(focus) {
        const wasOpen = chatOpen();
        panel.classList.remove("hidden");
        hideBubble(true);
        layout();
        scrollLog();
        E.setFocusable(true);
        if (focus) {
            E.focusWindow();
            setTimeout(() => input.focus(), 40);
            // Windows can refuse a focus request; one retry, and a click in the box always works
            setTimeout(() => { if (chatOpen() && !document.hasFocus()) { E.focusWindow(); input.focus(); } }, 350);
        }
        if (!wasOpen) refreshIgnore(true);
    }
    function closeChat() {
        if (!chatOpen()) return;
        panel.classList.add("hidden");
        input.blur();
        E.blurWindow();   // the keyboard goes back to the editor
        refreshIgnore(true);
    }
    let lastToggle = 0;
    function toggleChat() {
        if (Date.now() - lastToggle < 400) return;   // a double-click isn't open-then-close
        lastToggle = Date.now();
        chatOpen() ? closeChat() : openChat(true);
    }

    // ---------- the mind ----------
    function onMessage(msg) {
        const t = now();
        switch (msg.type) {
            case "mind":
                setThinking(false, true);
                // a mood repeated in silence is the mind keeping its face steady, not a new feeling
                director.setExpression(msg.expression || "neutral", t, { fresh: !!(msg.say || msg.action) });
                if (msg.action) director.play(msg.action, t);
                setNotes(Math.max(0, msg.notes | 0));
                if (msg.say) say(msg.say);
                break;
            case "status":
                setThinking(msg.state === "thinking");
                break;
            case "user-echo":
                appendChat("user", msg.text);
                break;
            case "activity":
                director.typing(!!msg.typing, t);
                break;
            case "error":
                setThinking(false);
                appendSystem(msg.text || "Something went wrong.", true);
                director.hiccup(t);
                break;
            case "proposal":
                showProposal(msg);
                break;
            case "mascot":
                changeBody(msg);
                break;
            case "shutdown":
                leave();
                break;
        }
    }

    // A new body mid-session: the old one walks off, the new one walks in.
    let bodyChange = 0;
    function changeBody(m) {
        const n = ++bodyChange;
        director.exit(now());
        const swap = () => {
            if (n !== bodyChange || leaving) return;
            if (!director.exitDone(now())) { setTimeout(swap, 100); return; }
            wear(m);
            layout();
            director.enter(now() + 0.2);
        };
        swap();
    }

    function send(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
        return false;
    }
    function sendChat(text) {
        if (send({ type: "chat", text })) return;
        if (DEMO) { appendChat("user", text); demoReply(text); return; }
        appendSystem("Not connected to VS Code — the session may have ended.", true);
    }

    function connect() {
        if (!PORT || PORT === "0") return;
        ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`);
        ws.onopen = () => { wsRetries = 0; };
        ws.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data)); } catch (err) { console.error(err); } };
        ws.onclose = () => {
            if (leaving) return;
            if (++wsRetries > 5) { leave(); return; }
            setTimeout(connect, 1000);
        };
    }

    // Walk off, then quit.
    function leave() {
        if (leaving) return;
        leaving = true;
        const t = now();
        setThinking(false);
        endResize();
        closeChat();
        endClawdDrag();
        director.exit(t);   // the walk-off overrides any gesture: done well inside the extension's 4 s
        setTimeout(() => hideBubble(), 400);
        const wait = () => (director.exitDone(now()) ? setTimeout(() => E.quit(), 150) : setTimeout(wait, 100));
        wait();
    }

    // ---------- input ----------
    function submit() {
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        autogrow();
        sendChat(text);
    }
    function autogrow() {
        input.style.height = "auto";
        input.style.height = `${Math.min(110, input.scrollHeight)}px`;
    }
    input.addEventListener("input", autogrow);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && chatOpen()) { e.preventDefault(); closeChat(); }
    });
    $("chat-send").addEventListener("click", submit);
    $("chat-close").addEventListener("click", closeChat);
    badge.addEventListener("click", () => {
        openChat(false);
        appendSystem("You asked for the notes.");
        if (!send({ type: "notes" }) && DEMO) demoReply("notes");
    });
    // Nothing gets dropped onto the overlay (a dropped file would replace the page).
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());

    // ---------- the window: click-through except over Clawd and the UI ----------
    // #stage has pointer-events: none; everything about Clawd is hit-tested here against the
    // body's own pixels (not the emotes), so the canvas never blocks the bubble, badge or chat.
    let ignoring = true, press = null, dragging = false, resizing = false, lastPointer = null;
    const UI = "#chat-panel:not(.hidden), #bubble:not(.hidden), #notes-badge:not(.hidden)";
    const onUi = (el) => !!(el && el.closest && el.closest(UI));
    const interactiveAt = (x, y) => stage.hit(x, y) || onUi(document.elementFromPoint(x, y));
    // while the window moves or grows under the pointer, it keeps the mouse
    const holding = () => dragging || resizing;
    function setIgnore(v) {
        if (v === ignoring) return;
        ignoring = v;
        E.setIgnoreMouse(v);
    }
    function refreshIgnore(force) {
        if (holding()) return;
        if (force) ignoring = null;
        setIgnore(!lastPointer || !interactiveAt(lastPointer.x, lastPointer.y));
    }
    function pointerAt(x, y) {
        lastPointer = { x, y };
        if (!holding()) setIgnore(!interactiveAt(x, y));
        const a = stage.toArt(x, y);
        director.lookAt(a.x, a.y, now());
    }
    function pointerGone() {
        lastPointer = null;
        if (!holding()) setIgnore(true);
        director.lookClear();
    }
    document.addEventListener("mousemove", (e) => pointerAt(e.clientX, e.clientY));
    document.addEventListener("mouseleave", pointerGone);
    // on macOS and Linux, main.js says where the pointer is too (see trackPointer there)
    E.onPointer((at) => (at ? pointerAt(at.x, at.y) : pointerGone()));
    // re-check as things move under a still mouse (Clawd walks in, a bubble appears...)
    stage.onDraw = () => { if (lastPointer && !holding()) setIgnore(!interactiveAt(lastPointer.x, lastPointer.y)); };

    // Clawd: click = boop + chat, drag = carry Clawd around (dangling).
    function endClawdDrag() {
        press = null;
        if (!dragging) return;
        dragging = false;
        E.dragEnd();
        director.dragEnd(now());
    }
    document.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || onUi(e.target) || !stage.hit(e.clientX, e.clientY)) return;
        press = { x: e.screenX, y: e.screenY };
        document.body.setPointerCapture(e.pointerId);
    });
    document.addEventListener("pointermove", (e) => {
        if (!press || dragging) return;
        if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
            dragging = true;
            E.dragStart();
            director.dragStart(now());
        }
    });
    document.addEventListener("pointerup", () => {
        if (!press) return;
        if (dragging) endClawdDrag();
        else {
            press = null;
            director.boop(now());
            toggleChat();
        }
    });
    // if the button-up never arrives (a menu opened, Alt+Tab), stop carrying Clawd
    document.addEventListener("pointercancel", endClawdDrag);
    document.body.addEventListener("lostpointercapture", () => { if (dragging) endClawdDrag(); });
    window.addEventListener("blur", () => { if (dragging) endClawdDrag(); });

    // the chat header drags the window too, once the pointer really moves
    $("chat-header").addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button")) return;
        const el = e.currentTarget, sx = e.screenX, sy = e.screenY;
        el.setPointerCapture(e.pointerId);
        let moving = false;
        const move = (ev) => {
            if (moving || Math.hypot(ev.screenX - sx, ev.screenY - sy) <= 4) return;
            moving = dragging = true;
            E.dragStart();
            director.dragStart(now());
        };
        const end = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", end);
            el.removeEventListener("pointercancel", end);
            el.removeEventListener("lostpointercapture", end);
            if (moving && dragging) { dragging = false; E.dragEnd(); director.dragEnd(now()); }
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", end);
        el.addEventListener("pointercancel", end);
        el.addEventListener("lostpointercapture", end);
    });
    E.onDragMove((v) => director.dragMove(now(), v.vx, v.vy));
    E.onGaze((dir) => { director.gazeDir = dir; });

    // The chat's top and left edges resize it: main.js grows the window up and to the left
    // while an edge is held, so Clawd stays put (see resize-start there).
    function endResize() {
        if (!resizing) return;
        resizing = false;
        E.resizeEnd();
        refreshIgnore(true);
    }
    panel.querySelectorAll(".resize-edge").forEach((el) => {
        el.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || holding()) return;
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            resizing = true;
            E.resizeStart(el.dataset.edge);
        });
        el.addEventListener("pointerup", endResize);
        el.addEventListener("pointercancel", endResize);
        el.addEventListener("lostpointercapture", endResize);
    });
    window.addEventListener("blur", endResize);

    document.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (onUi(e.target)) {
            const editable = e.target === input;
            const selection = editable ? input.value.slice(input.selectionStart, input.selectionEnd) : window.getSelection().toString();
            E.showTextMenu(selection, editable);
        } else if (stage.hit(e.clientX, e.clientY)) {
            E.showContextMenu();
        }
    });
    E.onMenu((cmd) => {
        if (cmd === "talk") openChat(true);
        else if (cmd === "close") { if (!send({ type: "close" })) leave(); }
    });

    // ---------- demo (npm run demo): a scripted tour, no VS Code needed ----------
    function demoReply(text) {
        setTimeout(() => onMessage({ type: "status", state: "thinking" }), 300);
        setTimeout(() => onMessage(text === "notes"
            ? { type: "mind", expression: "smug", action: "shrug", notes: 0, say: "Two things. You wrote *actually* three times in the intro, and the second heading promises a benchmark the section never delivers." }
            : { type: "mind", expression: "curious", action: null, notes: 2, say: "Mm. What does the reader need to know *before* that sentence lands?" }), 2600);
    }
    function runDemo() {
        const script = [
            [3.2, { type: "mind", expression: "happy", action: "wave", notes: 0, say: "Hey you. Draft's open, I'm reading along — holler if you get stuck." }],
            [9.5, { type: "activity", typing: true }],
            [14, { type: "activity", typing: false }],
            [15, { type: "mind", expression: "reading", action: null, notes: 1, say: null }],
            [21, { type: "mind", expression: "smug", action: null, notes: 2, say: "Third *actually* in this paragraph. I'm counting, just so you know." }],
            [29, { type: "mind", expression: "love", action: "clap", notes: 2, say: "Okay, that last line? **Chef's kiss.** Keep that one." }],
            [37, { type: "mind", expression: "idea", action: null, notes: 2, say: "What if the benchmark came *first*? You'd have them at the numbers." }],
            [45, { type: "mind", expression: "thinking", action: null, notes: 2, say: null }],
            [50, { type: "mind", expression: "laugh", action: "facepalm", notes: 2, say: "You just deleted the whole paragraph. Bold. I respect it." }],
            [58, { type: "mind", expression: "cool", action: "dance", notes: 2, say: "Draft done. Ship it." }],
        ];
        for (const [at, msg] of script) setTimeout(() => onMessage(msg), at * 1000);
    }

    if (DEMO) runDemo();
    else connect();
    // for dev tooling (sheets, the end-to-end test script): type as the writer would
    window.__euterpe = { director, stage, onMessage, openChat, closeChat, type(text) { openChat(true); input.value = text; submit(); } };
})();
