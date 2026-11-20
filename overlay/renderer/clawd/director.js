// director.js: turns events (the mind's expressions and actions, speech, the writer's
// typing, the mouse, drags) into Clawd's pose at time t — a pure function of the event
// log, so the live overlay and the model sheets draw the exact same frames.
//
// The body has reflexes, not judgment: it breathes, blinks, glances around, follows the
// writer's typing with its eyes, and now and then fidgets (never while the writer types).
// What it feels and when it gestures is the mind's call.

window.Clawd = window.Clawd || {};
(function (C) {
    "use strict";
    const { TAU, clamp, lerp, seg, frac, ease, easeIn, hash, jump, EXPR, settleOf, ACTIONS, act, spinView, drawEmote, drawBurst, drawDust } = C;

    const has = (table, name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(table, name);
    const LEAD = 0.12;       // live changes are scheduled this far ahead so faces can anticipate them
    const ENTER = 2.4;       // walk in, turn, hop
    const EXIT = 1.6;        // turn, walk off
    const CALM = new Set(["neutral", "reading", "happy", "curious", "bored"]);
    const OPEN_MOUTHS = new Set(["open", "O", "laugh", "yawn", "wail", "grin"]);

    class Director {
        constructor(opts = {}) {
            this.seed = opts.seed ?? Math.floor(Math.random() * 997);
            this.keys = [{ t: -1e9, name: "neutral" }];   // { t, name, hold, renewed: { t, name } }
            this.actions = [];      // { t, name }
            this.talks = [];        // [t0, t1]
            this.boops = [];
            this.hiccups = [];
            this.drags = [];        // { t0, t1, samples: [[t, vx, vy]], maxV }
            this.drag = null;
            this.enterT = null;
            this.exitT = null;
            this.typingT = null;
            this.typingStopT = -1e9;
            this.mouse = null;      // { x, y, t } relative to the head, in art pixels
            this.gazeDir = -1;      // where the writer's text is: -1 left, +1 right
        }

        // ---------- events (t in seconds, same clock as render) ----------
        // A mood relaxes by itself (acting.js, settleOf). Asked for again with words or a gesture
        // (fresh), it lasts a while longer, or comes back; asked for again in silence, nothing
        // changes, so a mind that keeps its face steady doesn't make it flicker back and forth.
        // hold: a stand-in while a turn runs (thinking), kept until the mind's next mood.
        setExpression(name, t, { fresh = true, hold = false } = {}) {
            if (!has(EXPR, name)) name = "neutral";
            const when = t + LEAD;
            // a change still pending in the future gives way to this one
            while (this.keys.length > 1 && this.keys[this.keys.length - 1].t > t) this.keys.pop();
            const last = this.keys[this.keys.length - 1];
            if (this.expressionAt(when) === name) {
                if (fresh || last.hold) last.renewed = { t: when, name };
                last.hold = hold;
                return;
            }
            if (!fresh && !last.hold) {
                // the mood the mind asked for last, or one it has already settled through
                const shown = this.effectiveKeys().filter(([kt]) => kt >= last.t && kt <= when).map(([, n]) => n);
                if (shown.includes(name)) return;
            }
            this.keys.push({ t: when, name, hold });
            if (this.keys.length > 8) this.keys.splice(0, this.keys.length - 8);
        }
        setThinking(on, t) {
            if (on) this.setExpression("thinking", t, { hold: true });
        }
        play(name, t) {
            if (!has(ACTIONS, name)) return;
            let start = t + LEAD;
            const last = this.actions[this.actions.length - 1];
            if (last) start = Math.max(start, last.t + ACTIONS[last.name].dur);
            if (this.enterT != null) start = Math.max(start, this.enterT + ENTER);
            this.actions.push({ t: start, name });
            if (this.actions.length > 8) this.actions.shift();
        }
        talk(t, dur) {
            this.talks.push([t + LEAD, t + LEAD + dur]);
            if (this.talks.length > 8) this.talks.shift();
        }
        boop(t) { this.boops.push(t); if (this.boops.length > 4) this.boops.shift(); }
        hiccup(t) { this.hiccups.push(t); if (this.hiccups.length > 4) this.hiccups.shift(); }
        enter(t) { this.enterT = t; this.exitT = null; }
        exit(t) { this.exitT = t + LEAD; }
        exitDone(t) { return this.exitT != null && t >= this.exitT + EXIT; }
        typing(on, t) {
            if (on) {
                if (this.typingT == null) this.typingT = t;
                // dozing off next to someone who starts typing: you wake up
                if (this.expressionAt(t) === "sleepy") this.setExpression("neutral", t);
            } else if (this.typingT != null) {
                this.typingStopT = t;
                this.typingT = null;
            }
        }
        lookAt(x, y, t) { this.mouse = { x, y, t }; }
        lookClear() { this.mouse = null; }
        dragStart(t) {
            this.drag = { t0: t, t1: null, samples: [[t, 0, 0]], maxV: 0, shakes: 0, lastDir: 0 };
            this.drags.push(this.drag);
            if (this.drags.length > 4) this.drags.shift();
        }
        dragMove(t, vx, vy) {
            const d = this.drag;
            if (!d) return;
            d.samples.push([t, vx, vy]);
            if (d.samples.length > 240) d.samples.splice(0, 120);
            d.maxV = Math.max(d.maxV, Math.hypot(vx, vy));
            // shaking is fast back-and-forth, not one fast fling
            if (Math.abs(vx) > 900) {
                const dir = Math.sign(vx);
                if (d.lastDir && dir !== d.lastDir) d.shakes++;
                d.lastDir = dir;
            }
        }
        dragEnd(t) {
            if (!this.drag) return;
            this.drag.t1 = t;
            this.drag = null;
        }

        // ---------- queries ----------
        effectiveKeys() {
            // expand the settles into keys: laugh relaxes into happy, surprised into curious, and
            // every mood but a rest into neutral
            const out = [], K = this.keys;
            for (let i = 0; i < K.length; i++) {
                const k = K[i];
                out.push([k.t, k.name]);
                if (k.hold) continue;
                const next = i + 1 < K.length ? K[i + 1].t : Infinity;
                let ct = k.t, cur = k.name;
                for (let n = 0; n < 3; n++) {
                    const S = settleOf(cur);
                    if (!S) break;
                    // renewed in this mood: it lasts from then
                    const from = k.renewed && k.renewed.name === cur && k.renewed.t > ct ? k.renewed.t : ct;
                    if (from + S[0] >= next) break;
                    ct = from + S[0];
                    cur = S[1];
                    out.push([ct, cur]);
                }
            }
            return out;
        }
        expressionAt(t) {
            let name = "neutral";
            for (const [kt, n] of this.effectiveKeys()) if (kt <= t) name = n;
            return name;
        }
        actionAt(t) {
            for (let i = this.actions.length - 1; i >= 0; i--) {
                const a = this.actions[i];
                if (t >= a.t && t < a.t + ACTIONS[a.name].dur) return a;
            }
            return null;
        }
        busyUntil(t) {
            const last = this.actions[this.actions.length - 1];
            return last ? Math.max(t, last.t + ACTIONS[last.name].dur) : t;
        }
        talkingAt(t) { return this.talks.some(([a, b]) => t >= a && t < b); }
        isTyping(t) { return this.typingT != null || t - this.typingStopT < 2.5; }
        latest(list, t, win) {
            for (let i = list.length - 1; i >= 0; i--) if (list[i] <= t && t - list[i] < win) return list[i];
            return null;
        }
        dragAt(t) {
            for (let i = this.drags.length - 1; i >= 0; i--) {
                const d = this.drags[i];
                if (t >= d.t0 && (d.t1 == null || t < d.t1)) return d;
            }
            return null;
        }
        dropAt(t) {
            for (let i = this.drags.length - 1; i >= 0; i--) {
                const d = this.drags[i];
                if (d.t1 != null && t >= d.t1 && t < d.t1 + 2.4) return d;
            }
            return null;
        }
        velAt(d, t) {
            // average of the last 150 ms of samples: the pendulum swing follows the drag
            let n = 0, vx = 0, vy = 0;
            for (let i = d.samples.length - 1; i >= 0; i--) {
                const s = d.samples[i];
                if (s[0] > t) continue;
                if (t - s[0] > 0.15) break;
                vx += s[1]; vy += s[2]; n++;
            }
            return n ? [vx / n, vy / n] : [0, 0];
        }

        // Blinks at irregular intervals, sometimes twice.
        blinkAt(t) {
            const W = 4.2, n = Math.floor(t / W), off = 0.5 + hash(n * 7.13 + this.seed) * (W - 1.1);
            const lt = t - n * W - off;
            if (lt >= 0 && lt < 0.12) return true;
            return hash(n * 3.7 + this.seed * 1.3) > 0.78 && lt >= 0.28 && lt < 0.4;
        }
        // A glance around now and then.
        glanceAt(t) {
            const W = 9, n = Math.floor(t / W);
            if (hash(n * 5.3 + this.seed) > 0.6) return null;
            const off = 1 + hash(n * 2.1 + this.seed) * (W - 3), lt = t - n * W - off, dur = 0.9 + hash(n * 8.8) * 0.8;
            if (lt < 0 || lt > dur) return null;
            const side = hash(n * 1.9 + this.seed) > 0.5 ? 1 : -1;
            const k = ease(seg(lt, 0, 0.12)) * (1 - ease(seg(lt, dur - 0.15, dur)));
            return { x: side * (0.55 + 0.4 * hash(n * 4.4)) * k, y: (hash(n * 6.6) - 0.6) * 0.6 * k };
        }
        // Eyes reading along a line of text: a few saccades, then the sweep back.
        readingGaze(t) {
            const period = 2.6, n = Math.floor(t / period), f = frac(t / period);
            const step = Math.min(3, Math.floor(f * 4.2));
            return { x: clamp(this.gazeDir * 0.35 + (step / 3 - 0.5) * 1.1, -1, 1), y: 0.25 + ((n % 3) - 1) * 0.25 };
        }
        // Rare idle fidgets, on a schedule that is a pure function of time.
        fidgetAt(t) {
            const W = 38, n = Math.floor((t + this.seed * 3.1) / W);
            if (hash(n * 2.9 + this.seed) > 0.55) return null;
            const name = ["_look", "_shuffle", "_hop", "_look"][Math.floor(hash(n * 4.3 + this.seed) * 4)];
            const start = n * W - this.seed * 3.1 + 8 + hash(n * 1.7 + this.seed) * 20;
            const lt = t - start;
            return lt >= 0 && lt < ACTIONS[name].dur ? { name, lt } : null;
        }

        // ---------- the pose ----------
        pose(t) {
            if (this.enterT != null && t < this.enterT) return { hidden: true };
            if (this.exitDone(t)) return { hidden: true };

            let p = act(t, this.effectiveKeys());
            const expr = p.expr;

            const a = this.actionAt(t);
            if (a) {
                const A = ACTIONS[a.name], lt = t - a.t;
                p = { ...p, ...A.pose(lt, p, this) };
                if (A.emote) {
                    p.emote = A.emote;
                    p.emoteK = seg(lt, 0.05, 0.25) * (1 - seg(lt, A.dur - 0.3, A.dur));
                    p.emoteAge = lt;
                }
                if (A.dust != null) {
                    const k = seg(lt, A.dust, A.dust + 0.45);
                    if (k > 0 && k < 1) p.dust = k;
                }
            }
            const talking = this.talkingAt(t), typing = this.isTyping(t), drag = this.dragAt(t);

            if (!a && !talking && !typing && !drag && CALM.has(expr)) {
                const f = this.fidgetAt(t);
                if (f) p = { ...p, ...ACTIONS[f.name].pose(f.lt, p, this) };
            }

            // an error: a moment of dizziness
            const th = this.latest(this.hiccups, t, 2.2);
            if (th != null) {
                const age = t - th, k = seg(age, 0, 0.15) * (1 - seg(age, 1.9, 2.2));
                if (k > 0.5) { p.eyes = "swirl"; p.mouth = "wobble"; }
                p.emote = "stars"; p.emoteK = k; p.emoteAge = age;
                p.lean += 0.06 * Math.sin(age * 6) * k;
                p.lookSet = true;
            }

            // speech: the mouth flaps while the bubble writes itself out
            if (talking) {
                const n = Math.floor(t * 9), open = n % 2 === 0 || hash(n * 3.1 + this.seed) > 0.75;
                p.mouth = open ? (hash(n * 1.7 + this.seed) > 0.45 ? "open" : "o")
                               : (p.mouth && !OPEN_MOUTHS.has(p.mouth) ? p.mouth : null);
                p.speaking = open;   // for a body without a mouth, which talks with its brows
                if (open && hash(n * 5.9) > 0.5) p.dy -= 1;
            }

            // where the eyes go, unless the mood or the gesture already decided
            if (!p.lookSet) {
                const m = this.mouse;
                let look = null;
                // (frames are drawn at the start of their 1/12 s slot: accept a sample from within the slot)
                if (m && t - m.t < 3 && t >= m.t - 0.1 && Math.hypot(m.x, m.y) < 90) look = { x: clamp(m.x / 22, -1, 1), y: clamp(m.y / 22, -1, 1) };
                else if (typing || p.reading) look = this.readingGaze(t);
                else look = this.glanceAt(t);
                if (look) { p.lookX = look.x; p.lookY = look.y; }
            }
            p.blink = this.blinkAt(t);

            // a boop: squash, squeeze the eyes, a tiny hop
            const tb = this.latest(this.boops, t, 0.6);
            if (tb != null) {
                const age = t - tb;
                p.sq += 0.2 * Math.exp(-9 * age) * Math.cos(22 * age);
                if (age < 0.28) p.eyes = "squeeze";
                p.dy -= 2 * Math.exp(-8 * age) * Math.max(0, Math.sin(age * 12));
            }

            if (drag) {
                // dangling from the cursor: stretched by gravity, legs swinging with the drag
                const lt = t - drag.t0, k = ease(seg(lt, 0, 0.15)), [vx] = this.velAt(drag, t);
                const fast = Math.abs(vx) > 250;
                p.dy -= 3 * k;
                p.sq -= 0.1 * k;
                p.lean = lerp(p.lean, clamp(-vx / 1100, -0.2, 0.2), k);
                p.aL = lerp(p.aL, 1.2 + 0.2 * Math.sin(t * TAU * 1.7), k);
                p.aR = lerp(p.aR, 1.15 - 0.2 * Math.sin(t * TAU * 1.9), k);
                p.dangle = t * 1.3;
                p.swing = clamp(0.4 + Math.abs(vx) / 500, 0.4, 2);
                p.walk = null;
                p.eyes = lt < 0.5 ? "wide" : fast ? "happy" : p.eyes;
                p.mouth = lt < 0.5 ? "O" : fast ? "open" : "wobble";
                p.noShadow = true;
                p.lookX = clamp(vx / 600, -1, 1) * 0.8;
                p.lookY = 0.5;
            }
            const drop = drag ? null : this.dropAt(t);
            if (drop) {
                const age = t - drop.t1;
                if (age < 0.1) p.dy -= 3 * (1 - easeIn(age / 0.1));
                else {
                    const b = age - 0.1;
                    p.sq += 0.24 * Math.exp(-8 * b) * Math.cos(20 * b);
                    if (b < 0.45) p.dust = seg(b, 0, 0.45);
                }
                if (drop.shakes >= 3 && age > 0.2 && age < 2.3) {   // shaken, not stirred
                    const k = seg(age, 0.2, 0.35) * (1 - seg(age, 2, 2.3));
                    if (k > 0.5) p.eyes = "swirl";
                    p.emote = "stars"; p.emoteK = k; p.emoteAge = age;
                    p.lean += 0.05 * Math.sin(age * 7) * k;
                }
            }

            // stacked leaps and stretches (an excited bounce + a startle + a take) mustn't carry the
            // emotes off the canvas, or stretch Clawd past recognition
            p.dy = Math.max(p.dy || 0, -13);
            p.sq = clamp(p.sq || 0, -0.28, 0.35);
            if (this.enterT != null && t < this.enterT + ENTER) p = this.enterPose(t - this.enterT, p);
            if (this.exitT != null && t >= this.exitT) p = this.exitPose(t - this.exitT, p);
            return p;
        }

        enterPose(lt, p) {
            const W = 1.5;
            if (lt < W) {   // walk in from the right edge, facing the writer's text
                const s = seg(lt, 0, W), dx = 44 * (1 - s) * (1 - s);
                const step = (44 - dx) / 11;
                return { ...p, dx: p.dx + dx, view: "side", flip: true, walk: step, dy: -Math.round(Math.abs(Math.sin(step * Math.PI))),
                         lean: 0, lookX: 0, lookY: 0, lookSet: true, aL: -0.35 + 0.3 * Math.sin(step * Math.PI), emote: null, front: null };
            }
            if (lt < W + 0.3) {   // turn to face the writer: side, 3/4, front
                return { ...p, ...spinView(lerp(-0.25, 0, ease(seg(lt, W, W + 0.3)))), emote: null };
            }
            const j = jump(lt, W + 0.42, W + 0.72, 3);   // a little hop: here I am
            return { ...p, dy: p.dy + j.dy, sq: p.sq + j.sq };
        }
        exitPose(lt, p) {
            if (lt < 0.3) return { ...p, ...spinView(lerp(0, 0.25, ease(seg(lt, 0, 0.3)))), emote: null };
            const s = seg(lt, 0.3, EXIT), dx = 52 * s * s, step = dx / 11;
            return { ...p, dx: p.dx + dx, view: "side", flip: false, walk: step, dy: -Math.round(Math.abs(Math.sin(step * Math.PI))),
                     emote: null, lookSet: true, lookX: 0, lookY: 0, lean: 0.03, front: null, aL: -0.35 + 0.3 * Math.sin(step * Math.PI) };
        }

        // Draw the body on stage (C.mascot), with emotes and effects, with the ground point at (gx, gy).
        render(frame, gx, gy, t) {
            const p = this.pose(t);
            if (p.hidden) return null;
            const info = C.mascot.draw(frame, gx, gy, p, t);
            info.box = frame.bbox();   // the body, before emotes: what the mouse can grab
            if (p.emote && (p.emoteK ?? 1) > 0.05) drawEmote(frame, p.emote, info, p.emoteK ?? 1, p.emoteAge ?? 1, t, p.flip);
            if (p.bursts) {
                for (const b of p.bursts) {
                    const at = b.at ? info.tips[b.at] : null;
                    if (b.at && !at) continue;
                    drawBurst(frame, at ? at.x : info.head.x + b.x, at ? at.y : info.head.y + b.y, b.k);
                }
            }
            if (p.dust != null) drawDust(frame, gx + Math.round(p.dx || 0), gy, p.dust);
            info.pose = p;
            return info;
        }
    }

    Object.assign(C, { Director, LEAD, ENTER, EXIT });
})(window.Clawd);
