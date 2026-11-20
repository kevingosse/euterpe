// acting.js: what Clawd can feel (expressions) and do (actions), and how a face changes.
//
// An expression is a face, a colour and a way of moving. Motion here is deliberately calmer
// than a cartoon's: Clawd sits in the corner of a writer's eye for hours, so idles breathe
// and sway rather than bounce, energetic moods settle by themselves (nobody laughs for ten
// minutes), and every mood relaxes back to neutral when nothing renews it (a face that keeps
// its last reaction for minutes looks stuck). Changes are ACTED, never snapped: a squint and
// a squash just before, the face swaps under the squint, then a take sized to the new mood,
// overshoot, and colours that cross-fade — the approach of ClaudeAnimationBase's emotions().
//
// Keep EXPRESSION_NAMES / ACTION_NAMES in sync with extension/src/protocol.ts.

window.Clawd = window.Clawd || {};
(function (C) {
    "use strict";
    const { TAU, clamp, lerp, seg, frac, ease, easeOut, backOut, spring, jump, take, bodyRamp, mixRamp } = C;

    const br = (t, period, phase = 0) => Math.sin((t / period + phase) * TAU);          // breathe / sway
    const bob = (t, period, amp) => -amp * Math.abs(Math.sin((Math.PI * t) / period));   // a bounce each period
    const pulse = (t, period, k = 6) => Math.exp(-frac(t / period) * k);                 // 1 on each beat, decays

    // eyes / mouth: glyph names (glyphs.js). take: size of the reaction when switching INTO it.
    // settle: [seconds, expression] it relaxes into; without one, it relaxes into neutral after
    // RELAX seconds, unless it's a rest (a state to stay in). emoteLife: seconds before the emote fades.
    // body(t): idle motion, in art pixels (dy < 0 is up) and arm angles (0 out, 1.5 up).
    const RELAX = 30;
    const EXPR = {
        neutral: { eyes: "normal", take: 0.3, rest: true,
            body: (t) => ({ sq: 0.025 * br(t, 3.6), aL: 0.15 + 0.05 * br(t, 3.6), aR: 0.15 - 0.04 * br(t, 3.6, 0.3) }) },
        reading: { eyes: "normal", take: 0.25, reading: true,
            body: (t) => ({ sq: 0.02 * br(t, 4), aL: 0.08 + 0.03 * br(t, 4, 0.5), aR: 0.12 + 0.03 * br(t, 4) }) },
        happy: { eyes: "happy", mouth: "smile", blush: 0.3, take: 0.6,
            body: (t) => ({ dy: bob(t, 1.2, 1.2), sq: 0.04 * pulse(t, 1.2), aL: 0.35 + 0.2 * br(t, 2.4), aR: 0.35 - 0.2 * br(t, 2.4) }) },
        laugh: { eyes: "squeeze", mouth: "laugh", blush: 0.45, take: 0.8, settle: [3.2, "happy"],
            body: (t) => { const c = Math.abs(Math.sin(t * TAU * 4)); return { dy: -1.6 * c, sq: 0.06 * c - 0.03, lean: -0.03 + 0.02 * Math.sin(t * TAU * 4), aL: -0.4 + 0.15 * c, aR: -0.4 + 0.12 * c }; } },
        excited: { eyes: "wide", mouth: "open", emote: "spark", take: 1, settle: [5, "happy"],
            body: (t) => { const h = Math.abs(Math.sin((t * TAU) / 0.9)); return { dy: -4 * h, sq: 0.1 * pulse(t, 0.45) - 0.05 * h, aL: 1 + 0.45 * Math.sin(t * TAU * 2.2), aR: 1 - 0.45 * Math.sin(t * TAU * 2.2) }; } },
        love: { eyes: "heart", mouth: "cat", blush: 0.8, tint: "rosy", tintK: 0.5, emote: "hearts", emoteLife: 6, take: 0.7, settle: [8, "happy"],
            body: (t) => { const s = br(t, 2.4); return { dx: 1.5 * s, lean: 0.04 * s, dy: bob(t, 1.2, 1), aL: -0.1 + 0.15 * s, aR: -0.1 - 0.15 * s }; } },
        proud: { eyes: "closed", mouth: "smile", tint: "gold", tintK: 0.3, emote: "spark", emoteLife: 2.5, take: 0.5,
            body: (t) => ({ sq: -0.08 - 0.02 * Math.abs(br(t, 2)), aL: -0.9, aR: -0.9, lean: 0.01 * br(t, 3) }) },
        smug: { eyes: "narrow", mouth: "smirk", take: 0.4,
            body: (t) => { const s = br(t, 3.2); return { lookX: 0.45, lean: -0.04 + 0.015 * s, aL: -0.5, aR: 0.5 + 0.12 * s }; } },
        mischief: { eyes: "narrow", mouth: "grin", gloom: 0.25, take: 0.5,
            body: (t) => { const r = Math.sin(t * TAU * 3.5); return { lookX: 0.3, sq: 0.05, aL: -0.1 + 0.15 * r, aR: -0.1 - 0.15 * r, dy: -0.6 * Math.abs(r) }; } },
        playful: { eyes: "wink", mouth: "tongue", take: 0.6,
            body: (t) => {
                const period = 0.7, n = Math.floor(t / period), f = frac(t / period), side = n % 2 ? 1 : -1;
                const k = lerp(-side, side, easeOut(clamp(f * 3)));
                return { dx: 1.5 * k, dy: -2 * Math.sin(f * Math.PI), lean: 0.05 * k, aL: 0.6 + 0.5 * k, aR: 0.6 - 0.5 * k };
            } },
        wink: { eyes: "wink", mouth: "grin", take: 0.5,
            body: (t) => ({ lean: 0.03, aL: 0.15, aR: 0.55 + 0.08 * br(t, 2), sq: 0.02 * br(t, 3) }) },
        thinking: { eyes: "normal", mouth: "flat", emote: "dots", take: 0.35,
            body: (t) => ({ lookX: 0.6, lookY: -0.9, lean: 0.03, aR: 0.95 + 0.06 * br(t, 2.2), aL: -0.25 + 0.15 * Math.max(0, br(t, 1.8)), sq: 0.02 * br(t, 3.4) }) },
        curious: { eyes: "normal", mouth: "o", emote: "?", emoteLife: 3, take: 0.5,
            body: (t) => ({ lean: 0.07, lookX: 0.35, lookY: -0.2, aL: 0.1, aR: 0.3 + 0.08 * br(t, 1.6), dy: bob(t, 2.4, 0.6) }) },
        idea: { eyes: "shine", mouth: "grin", emote: "bulb", emoteLife: 4, take: 1.1, settle: [5, "happy"],
            body: (t) => ({ dy: bob(t, 0.8, 1.5), sq: -0.04 + 0.05 * pulse(t, 0.8), aR: 1.55 + 0.08 * br(t, 0.5), aL: 0.2 + 0.15 * br(t, 1.6) }) },
        confused: { eyes: ["narrow", "wide"], mouth: "wobble", emote: "?", take: 0.6,
            body: (t) => ({ lean: 0.06 * br(t, 5), aL: 0.1, aR: 1.45 + 0.12 * Math.sin(t * TAU * 3), dy: bob(t, 2.2, 0.5) }) },
        surprised: { eyes: "wide", mouth: "O", emote: "!", emoteLife: 1.6, take: 1.3, settle: [2.5, "curious"],
            body: (t) => ({ sq: -0.1, dy: -1 - 0.5 * Math.abs(br(t, 1)), aL: 1.1 + 0.05 * br(t, 0.5), aR: 1.1 - 0.05 * br(t, 0.5) }) },
        concerned: { eyes: "sad", mouth: "wobble", emote: "sweat", emoteLife: 4, tint: "pale", tintK: 0.15, take: 0.45,
            body: (t) => ({ sq: 0.03, aL: -0.3 + 0.06 * Math.sin(t * TAU * 1.3), aR: -0.35 - 0.06 * Math.sin(t * TAU * 1.1), lookY: 0.2 }) },
        sad: { eyes: "sad", mouth: "frown", tint: "blue", tintK: 0.35, gloom: 0.35, emote: "cloud", emoteLife: 6, take: 0.3,
            body: (t) => ({ sq: 0.07 + 0.015 * br(t, 4), lean: 0.02 * br(t, 6), aL: -0.8, aR: -0.75, lookY: 0.6 }) },
        shy: { eyes: "normal", mouth: "wobble", blush: 1, take: 0.3,
            body: (t) => ({ lookX: -0.8, lookY: 0.9, sq: 0.05, dx: 0.8 * br(t, 4), lean: -0.03, aL: -0.55 + 0.12 * Math.sin(t * TAU * 0.8), aR: -0.6 - 0.1 * Math.sin(t * TAU * 0.8) }) },
        // a doze lasts until the writer types (director.js wakes it)
        sleepy: { eyes: "sleepy", mouth: "o", emote: "zzz", take: 0.2, rest: true,
            body: (t) => ({ sq: 0.05 + 0.04 * br(t, 4.5), lean: 0.03 * Math.sin(t * 0.7), aL: -0.65, aR: -0.6 }) },
        bored: { eyes: "narrow", mouth: "flat", take: 0.2,
            body: (t) => {
                const f = frac(t / 5.5), sigh = f < 0.25 ? ease(f / 0.25) : 1 - ease((f - 0.25) / 0.75);
                return { lookX: -0.35, lookY: 0.5, sq: 0.07 - 0.12 * sigh, aL: -0.85 + 0.05 * Math.sin(t * 1.9), aR: -0.85 - 0.05 * Math.sin(t * 1.9) };
            } },
        determined: { eyes: "determined", mouth: "flat", take: 0.7,
            body: (t) => { const f = frac(t / 1.1); return { sq: -0.04 + 0.05 * pulse(t, 1.1), lean: 0.02, aL: 0.1 + 0.6 * Math.max(0, Math.sin(f * TAU)), aR: 0.1 + 0.6 * Math.max(0, -Math.sin(f * TAU)) }; } },
        cool: { eyes: "shades", mouth: "smirk", emote: "music", emoteLife: 4, take: 0.4,
            body: (t) => { const p = pulse(t, 0.75); return { dy: -1.2 * p, sq: 0.05 * p, lean: 0.02, aL: -0.4, aR: 0.7 + 0.08 * br(t, 1.5) }; } },
        // Body states the mind never picks directly.
        dizzy: { eyes: "swirl", mouth: "wobble", emote: "stars", take: 0.7,
            body: (t) => ({ lean: 0.08 * Math.sin(t * 5), dx: Math.sin(t * 5) * 1.5, aL: 0.3 + 0.5 * Math.sin(t * 6.5), aR: 0.3 - 0.5 * Math.sin(t * 6.5) }) },
    };
    const EXPRESSION_NAMES = [
        "neutral", "reading", "happy", "laugh", "excited", "love", "proud", "smug", "mischief", "playful", "wink",
        "thinking", "curious", "idea", "confused", "surprised", "concerned", "sad", "shy", "sleepy", "bored", "determined", "cool",
    ];

    // What an expression relaxes into, and after how long: [seconds, expression], or null for a rest.
    function settleOf(name) {
        const E = EXPR[name];
        if (!E) return null;
        return E.settle || (E.rest ? null : [RELAX, "neutral"]);
    }

    // One expression, alive at time t: face, colour and body motion together.
    function feel(name, t, over) {
        const E = EXPR[name] || EXPR.neutral;
        const body = E.body ? E.body(t) : {};
        return {
            expr: name, eyes: E.eyes, mouth: E.mouth || null, blush: E.blush || 0, gloom: E.gloom || 0,
            tint: E.tint, tintK: E.tintK ?? 1, emote: E.emote || null, reading: !!E.reading,
            lookSet: "lookX" in body || "lookY" in body,
            dx: 0, dy: 0, sq: 0, lean: 0, aL: 0.15, aR: 0.15, lookX: 0, lookY: 0,
            ...body, ...(over || {}),
        };
    }

    const NOTAKE = { sq: 0, dy: 0 };
    const BLEND = { dy: 0, sq: 0, aL: 0.15, aR: 0.15, lean: 0, dx: 0, lookX: 0, lookY: 0 };

    // An expression timeline with acted changes. keys: [[t, name], ...] sorted by time.
    function act(t, keys, o = {}) {
        let i = 0;
        while (i + 1 < keys.length && t >= keys[i + 1][0]) i++;
        const [tc, name, over] = keys[i], age = t - tc;
        const cur = feel(name, t, over);
        const tn = i + 1 < keys.length ? keys[i + 1][0] : Infinity;
        const E = EXPR[name] || EXPR.neutral;
        const tk = o.take ?? 1;

        let squint = 0;
        if (tn - t < 0.1) squint = Math.max(squint, 1 - (tn - t) / 0.1);   // anticipation
        if (i > 0 && age < 0.14) squint = Math.max(squint, 1 - age / 0.14); // the swap happens under it
        const prev = i > 0 ? feel(keys[i - 1][1], t, keys[i - 1][2]) : null;
        if (prev && age < 0.5) {
            const k = backOut(seg(age, 0, 0.4)), kc = ease(seg(age, 0, 0.3));
            for (const f in BLEND) cur[f] = lerp(prev[f] ?? BLEND[f], cur[f] ?? BLEND[f], k);
            cur.ramp = mixRamp(bodyRamp(prev.tint, prev.tintK), bodyRamp(cur.tint, cur.tintK), kc);
            cur.blush = lerp(prev.blush || 0, cur.blush || 0, kc);
            cur.gloom = lerp(prev.gloom || 0, cur.gloom || 0, kc);
        }
        const t1 = prev ? take(t, tc, (E.take ?? 0.6) * tk) : NOTAKE;
        const En = i + 1 < keys.length ? EXPR[keys[i + 1][1]] || EXPR.neutral : null;
        const t2 = En ? take(t, tn, (En.take ?? 0.6) * tk) : NOTAKE;
        cur.sq += t1.sq + t2.sq;
        cur.dy += t1.dy + t2.dy;
        cur.squint = squint;

        // the emote pops in after the swap (carries on if unchanged) and one-off emotes fade out
        const same = prev && prev.emote === cur.emote;
        const life = E.emoteLife, fade = life != null ? 1 - seg(age, life, life + 0.35) : 1;
        cur.emoteK = (same ? 1 : seg(age, 0.06, 0.32)) * fade;
        cur.emoteAge = age;
        cur.exprAge = age;
        return cur;
    }

    // ---------- actions: one-shot gestures on top of the expression ----------
    // pose(lt, p, d): lt = seconds into the action, p = the pose so far, d = the director (gaze).
    // Return the fields to override. emote: shown for the length of the action.
    const ACTIONS = {
        wave: { dur: 1.9, pose: (lt, p) => {
            const up = ease(seg(lt, 0, 0.22)) * (1 - ease(seg(lt, 1.6, 1.9)));
            const osc = Math.sin((lt - 0.22) * TAU * 2.6) * 0.45 * seg(lt, 0.22, 0.35) * (1 - seg(lt, 1.4, 1.6));
            return { aR: lerp(p.aR, 1.1 + osc, up), aL: lerp(p.aL, -0.2, up * 0.5), lean: p.lean + 0.04 * up, dy: p.dy + bob(lt, 0.38, 0.8) * up };
        } },
        nod: { dur: 1.0, pose: (lt, p) => {
            const dip = Math.max(0, Math.sin(seg(lt, 0.05, 0.95) * TAU * 2 - 0.3));
            return { dy: p.dy + 1.6 * dip, sq: p.sq + 0.05 * dip, lookY: 0.7 * dip, squint: dip > 0.7 ? 0.6 : p.squint };
        } },
        headshake: { dur: 1.1, pose: (lt, p) => {
            const s = Math.sin(lt * TAU * 3) * (1 - seg(lt, 0.7, 1.1));
            return { dx: p.dx + 1.6 * s, lean: p.lean - 0.05 * s, eyes: lt < 0.95 ? "closed" : p.eyes };
        } },
        jump: { dur: 1.1, dust: 0.7, pose: (lt, p) => {
            const j = jump(lt, 0.2, 0.7, 10), air = seg(lt, 0.15, 0.25) * (1 - seg(lt, 0.65, 0.8));
            return { dy: p.dy + j.dy, sq: p.sq + j.sq, aL: lerp(p.aL, 1.3, air), aR: lerp(p.aR, 1.25, air) };
        } },
        bounce: { dur: 1.3, pose: (lt, p) => {
            const a = jump(lt, 0.15, 0.45, 4), b = jump(lt, 0.62, 0.92, 4);
            return { dy: p.dy + a.dy + b.dy, sq: p.sq + a.sq + b.sq, aL: p.aL + 0.4 * Math.abs(Math.sin(lt * TAU * 1.5)), aR: p.aR + 0.4 * Math.abs(Math.sin(lt * TAU * 1.5 + 0.5)) };
        } },
        clap: { dur: 1.6, pose: (lt, p) => {
            // arms too short to meet, so the paws flap up and each beat sparks at the tips
            const up = ease(seg(lt, 0, 0.2)) * (1 - ease(seg(lt, 1.35, 1.6)));
            const c = Math.sin((lt - 0.2) * TAU * 4);
            const bursts = [];
            for (let n = 0; n < 4; n++) {
                const tp = 0.2 + (n + 0.25) / 4, k = seg(lt, tp, tp + 0.24);
                if (k > 0 && k < 1) bursts.push({ at: "L", k }, { at: "R", k });
            }
            return { aL: lerp(p.aL, 1.3 + 0.42 * c, up), aR: lerp(p.aR, 1.3 + 0.42 * c, up), dy: p.dy + bob(lt, 0.25, 0.8) * up, bursts };
        } },
        cheer: { dur: 1.7, emote: "spark", pose: (lt, p) => {
            const up = ease(seg(lt, 0, 0.15)) * (1 - ease(seg(lt, 1.4, 1.7))), j = jump(lt, 0.25, 0.7, 6);
            return { aL: lerp(p.aL, 1.5 + 0.12 * Math.sin(lt * TAU * 3), up), aR: lerp(p.aR, 1.5 - 0.12 * Math.sin(lt * TAU * 3), up), dy: p.dy + j.dy, sq: p.sq + j.sq, mouth: up > 0.5 ? "open" : p.mouth };
        } },
        shrug: { dur: 1.4, pose: (lt, p) => {
            const k = ease(seg(lt, 0.05, 0.3)) * (1 - ease(seg(lt, 1.05, 1.35)));
            return { aL: lerp(p.aL, 0.75, k), aR: lerp(p.aR, 0.75, k), sq: p.sq - 0.05 * k, dy: p.dy - 1 * k, lookX: lerp(p.lookX, 0.6, k), lookY: lerp(p.lookY, -0.3, k), lean: p.lean + 0.02 * k, mouth: k > 0.5 ? "flat" : p.mouth, lookSet: true };
        } },
        facepalm: { dur: 2.1, pose: (lt, p) => {
            const k = ease(seg(lt, 0.05, 0.35)) * (1 - ease(seg(lt, 1.7, 2.05)));
            const sh = k > 0.9 ? Math.sin(lt * TAU * 2.5) * 0.02 : 0;
            return { aR: lerp(p.aR, 2.45, k), front: k > 0.3 ? "R" : p.front, eyes: k > 0.5 ? "closed" : p.eyes, sq: p.sq + 0.05 * k, gloom: Math.max(p.gloom || 0, 0.3 * k), lean: p.lean + sh };
        } },
        peek: { dur: 2.3, pose: (lt, p, d) => {
            const k = ease(seg(lt, 0.1, 0.5)) * (1 - ease(seg(lt, 1.8, 2.25))), dir = d ? d.gazeDir : -1;
            return { lean: p.lean + 0.1 * dir * k, dx: p.dx + 2 * dir * k, lookX: lerp(p.lookX, dir * 0.9, k), lookY: lerp(p.lookY, 0.35, k), eyes: k > 0.5 ? "narrow" : p.eyes, sq: p.sq + 0.03 * k, lookSet: true };
        } },
        stretch: { dur: 2.4, pose: (lt, p) => {
            const k = ease(seg(lt, 0.1, 0.6)) * (1 - ease(seg(lt, 1.7, 2.1))), sp = spring(lt, 2.1, 7, 22);
            return { aL: lerp(p.aL, 1.5, k), aR: lerp(p.aR, 1.45, k), sq: p.sq - 0.16 * k + 0.12 * sp, eyes: k > 0.4 ? "closed" : p.eyes, mouth: k > 0.6 ? "yawn" : p.mouth };
        } },
        yawn: { dur: 2.2, pose: (lt, p) => {
            const k = ease(seg(lt, 0.1, 0.7)) * (1 - ease(seg(lt, 1.5, 1.9)));
            return { mouth: k > 0.25 ? (k > 0.7 ? "yawn" : "O") : p.mouth, eyes: k > 0.3 ? "closed" : p.eyes, sq: p.sq - 0.06 * k, aL: lerp(p.aL, 0.35, k), aR: lerp(p.aR, 0.3, k) };
        } },
        spin: { dur: 1.3, pose: (lt, p) => {
            const k = ease(seg(lt, 0.1, 1.0)), j = jump(lt, 0.1, 1.0, 6);
            return { ...C.spinView(k), dy: p.dy + j.dy, sq: p.sq + j.sq, smear: lt > 0.15 && lt < 0.95 ? 0.6 : 0, smearDir: 0 };
        } },
        dance: { dur: 3.4, emote: "music", pose: (lt, p) => {
            const beat = 0.42, n = Math.floor(lt / beat), f = frac(lt / beat), side = n % 2 ? 1 : -1;
            const k = lerp(-side, side, easeOut(clamp(f * 2.5))), env = seg(lt, 0, 0.2) * (1 - seg(lt, 3.1, 3.4));
            return { dx: p.dx + 2 * k * env, lean: p.lean + 0.07 * k * env, dy: p.dy - 2.5 * Math.sin(f * Math.PI) * env, aL: lerp(p.aL, 0.9 + 0.6 * k, env), aR: lerp(p.aR, 0.9 - 0.6 * k, env), walk: n % 4 === 3 ? f : p.walk };
        } },
        startle: { dur: 1.2, emote: "!", pose: (lt, p) => {
            const tk = take(lt, 0.08, 1.5), j = jump(lt, 0.08, 0.4, 7), k = 1 - seg(lt, 0.8, 1.2);
            return { dy: p.dy + j.dy + tk.dy, sq: p.sq + tk.sq + j.sq, aL: lerp(p.aL, 1.2, k), aR: lerp(p.aR, 1.3, k), eyes: lt < 0.9 ? "wide" : p.eyes, mouth: lt < 0.9 ? "O" : p.mouth };
        } },
        // Idle fidgets the body does on its own now and then (never while the writer types).
        _look: { dur: 1.8, pose: (lt, p) => {
            const x = lt < 0.7 ? -0.8 * ease(seg(lt, 0, 0.2)) : lt < 1.4 ? lerp(-0.8, 0.8, ease(seg(lt, 0.7, 0.9))) : 0.8 * (1 - ease(seg(lt, 1.4, 1.7)));
            return { lookX: x, lookY: -0.1, lean: p.lean + 0.02 * x, lookSet: true };
        } },
        _shuffle: { dur: 0.9, pose: (lt, p) => ({ walk: seg(lt, 0, 0.9) * 2, dx: p.dx + Math.round(Math.sin(lt * TAU * 1.1)) }) },
        _hop: { dur: 0.8, pose: (lt, p) => { const j = jump(lt, 0.15, 0.4, 2.5); return { dy: p.dy + j.dy, sq: p.sq + j.sq }; } },
    };
    const ACTION_NAMES = Object.keys(ACTIONS).filter((n) => !n.startsWith("_"));

    Object.assign(C, { EXPR, EXPRESSION_NAMES, RELAX, settleOf, ACTIONS, ACTION_NAMES, feel, act, br, bob, pulse });
})(window.Clawd);
