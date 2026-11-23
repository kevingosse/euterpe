// The network, as the extension's world sees it: OpenAI's sign-in (Sign in with ChatGPT), OpenAI's
// API and the ChatGPT plan's catalog, OpenAI-compatible providers, and Electron's download. Nothing
// leaves the machine: every request is answered here, as the scenario's world says, and the mind's
// turns go to the host's turn router (the scenario, or the reviewer at the mind's controls). GitHub
// Copilot's models (through VS Code, vscode.js) answer their turns here too, in Chat Completions.
"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const realHttps = require("https");

const ISSUER = "https://auth.openai.com";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

/** The plan's catalog, in the shape the ChatGPT backend lists it. */
const PLAN_MODELS = [
    { slug: "gpt-6.1", display_name: "GPT-6.1", description: "Our smartest model for writing and reasoning", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }], context_window: 400000 },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", description: "Fast and capable for everyday work", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }], context_window: 272000 },
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", description: "The previous everyday model", visibility: "list", supported_reasoning_levels: [{ effort: "minimal" }, { effort: "low" }, { effort: "medium" }, { effort: "high" }], context_window: 272000 },
    { slug: "gpt-6.1-sentinel", display_name: "GPT-6.1 Sentinel", description: "For security research", visibility: "list", model_specialty: "security", supported_reasoning_levels: [{ effort: "high" }] },
];

const API_MODELS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-4.1-mini", "o5-mini", "text-embedding-4-large"];

function b64url(x) { return Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url"); }

function json(status, body, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": `req_${crypto.randomBytes(6).toString("hex")}`, ...headers } });
}

function createNetwork(world, router, log) {
    const net = world.spec.network || {};
    // read at each request: a scenario can make the next sign-in, or the next renewal, go another way
    const plan = () => ({ account: { sub: "user-8Qm2fK", email: "writer@example.com" }, ...(world.spec.chatgpt || {}) });
    const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "bench-key-1";
    const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
    /** What the browser's sign-in page sends back, by OAuth state: the client, the nonce. */
    const pendingAuth = new Map();
    let issued = 0;

    /** `forged`: signed over something else than what it says (its signature doesn't hold). */
    function idToken(clientId, nonce, extra = {}, forged = false) {
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: ISSUER, aud: clientId, sub: plan().account.sub, email: plan().account.email, iat: now, exp: now + 3600, auth_time: plan().authTime ?? now - 86400 * 20, nonce, ...extra };
        const head = b64url({ alg: "RS256", kid, typ: "JWT" }), body = b64url(claims);
        const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}${forged ? "x" : ""}`), keys.privateKey).toString("base64url");
        return `${head}.${body}.${sig}`;
    }

    // ---------- OpenAI's sign-in ----------

    async function token(form) {
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
            const code = form.get("code");
            const a = [...pendingAuth.values()].find((x) => x.code === code);
            const t = plan().token || {};
            if (t.status) { return json(t.status, t.body || { error: "server_error", error_description: "The token service is unavailable." }); }
            const scope = a?.planScope === false ? "openid profile email offline_access resource.invoke" : SCOPE;
            if (t.garbage) { return new Response("<html>Bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } }); }
            return json(200, {
                access_token: t.noAccess ? undefined : `plan-access-${++issued}`, refresh_token: t.noRefresh ? undefined : `plan-refresh-${issued}`, token_type: "Bearer", expires_in: plan().expiresIn ?? 3600, scope,
                id_token: t.noIdToken ? undefined : idToken(form.get("client_id"), t.badNonce ? "another" : a?.nonce, t.claims, t.forged),
            });
        }
        if (grant === "refresh_token") {
            const r = plan().refresh || "ok";
            log(`network: the ChatGPT sign-in renewed (${r})`);
            if (r === "ok") { return json(200, { access_token: `plan-access-${++issued}`, refresh_token: `plan-refresh-${issued}`, token_type: "Bearer", expires_in: 3600, scope: SCOPE }); }
            const errors = {
                invalidated: [401, { error: "invalid_grant", error_reason: "refresh_token_invalidated", error_description: "A fresh sign-in is required." }],
                reused: [400, { error: "invalid_grant", error_reason: "refresh_token_reused", error_description: "The refresh token was already used." }],
                expired: [400, { error: "invalid_grant", error_reason: "refresh_token_expired", error_description: "The refresh token has expired." }],
                client: [401, { error: "invalid_client", error_description: "Unknown client." }],
                down: [503, { error: "temporarily_unavailable", error_description: "The service is temporarily unavailable." }],
            };
            const [status, body] = errors[r] || errors.invalidated;
            return json(status, body);
        }
        return json(400, { error: "unsupported_grant_type" });
    }

    /** The writer's answer on OpenAI's sign-in page (the bench's stand-in for it): where the browser goes next. */
    function authorize(url, answer) {
        const q = new URL(url).searchParams;
        const state = q.get("state");
        const redirect = new URL(q.get("redirect_uri"));
        const dynamic = q.get("client_id") === "dynamic_agent_client";
        const clientId = dynamic ? plan().clientId || "app_euterpe_7Hk2Lm9Q" : q.get("client_id");
        const code = `code-${crypto.randomBytes(8).toString("hex")}`;
        pendingAuth.set(state, { code, nonce: q.get("nonce"), clientId, planScope: answer !== "no-plan" });
        const back = new URLSearchParams();
        if (answer === "deny") { back.set("error", "access_denied"); back.set("error_description", "The user denied the request."); }
        else if (answer === "error") { back.set("error", "server_error"); back.set("error_description", "Something went wrong on our side. Please try again."); }
        else {
            if (answer !== "no-code") { back.set("code", code); }
            if (dynamic && answer !== "no-client") { back.set("client_id", answer === "other-client" ? "app_someone_else" : clientId); }
            else if (answer === "other-client") { back.set("client_id", "app_someone_else"); }
        }
        back.set("state", answer === "wrong-state" ? "not-the-state" : state);
        return `${redirect.origin}${redirect.pathname}?${back.toString()}`;
    }

    // ---------- the mind's turns, as an API ----------

    // The SDK tries a request again on its own (a 429, a 5xx, no network): the same request gets the
    // same failure, as a real API would give it, rather than a new turn.
    const sticky = new Map();
    async function once(bodyText, turn) {
        const key = crypto.createHash("sha1").update(bodyText).digest("hex");
        const known = sticky.get(key);
        if (known && Date.now() - known.at < 60_000) { return known.reply; }
        const reply = await turn();
        if (reply && (reply.error || reply.network)) { sticky.set(key, { at: Date.now(), reply }); }
        return reply;
    }

    async function responses(req, body, auth, bodyText) {
        const onPlan = auth.startsWith("Bearer plan-");
        const fail = net.responses?.error;
        if (fail) { return errorResponse(fail); }
        const text = inputText(body.input);
        // (the tools as the mind is given them, for the scenarios that show them)
        router.lastTools = (body.tools || []).map((t) => ({ name: t.name || t.type, description: t.description, parameters: t.parameters }));
        router.lastInstructions = body.instructions;
        const reply = await once(bodyText, () => router.turn({ api: "responses", plan: onPlan, model: body.model, text, effort: body.reasoning?.effort, tools: (body.tools || []).map((t) => t.name || t.type) }));
        if (reply.error) { return errorResponse(reply.error, body.stream); }
        if (reply.network) { throw new TypeError("fetch failed", { cause: new Error(reply.network) }); }
        if ((reply.cutStream || reply.streamFail) && !body.stream) { return errorResponse({ status: 500, message: "The answer failed." }); }
        const out = reply.raw !== undefined ? reply.raw : JSON.stringify({ expression: reply.expression || "neutral", say: reply.say ?? null, notes: reply.notes ?? 0, action: reply.action ?? null });
        const id = `resp_${crypto.randomBytes(8).toString("hex")}`;
        const message = { type: "message", id: `msg_${crypto.randomBytes(6).toString("hex")}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: out, annotations: [] }] };
        const usage = { input_tokens: 9800 + text.length / 4 | 0, input_tokens_details: { cached_tokens: 9000 }, output_tokens: 60, total_tokens: 9860 };
        const response = { id, object: "response", status: "completed", model: body.model, output: [message], output_text: out, usage };
        if (!body.stream) { return json(200, response); }
        // The plan's backend answers in a stream only, its last event without the output.
        const events = [
            { type: "response.created", response: { id, status: "in_progress", model: body.model, output: [] } },
            { type: "response.output_item.done", output_index: 0, item: message },
            { type: "response.completed", response: { ...response, output: onPlan ? [] : response.output } },
        ];
        if (reply.cutStream) { events.pop(); }
        if (reply.streamFail) { events.splice(1, 2, { type: "response.failed", response: { status: "failed", error: { code: "server_error" } } }); }
        return sse(events);
    }

    async function chatCompletions(req, body, bodyText) {
        const fail = net.chat?.error;
        if (fail) { return errorResponse(fail); }
        const r = await chatTurn(body, bodyText, "chat");
        if (r.failed?.error) { return errorResponse(r.failed.error); }
        if (r.failed?.network) { throw new TypeError("fetch failed", { cause: new Error(r.failed.network) }); }
        return json(200, {
            id: `chatcmpl-${crypto.randomBytes(6).toString("hex")}`, object: "chat.completion", model: body.model,
            choices: [{ index: 0, finish_reason: r.finish, message: r.message }],
            usage: { prompt_tokens: 9800, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 9000 } },
        });
    }

    // A reply's tool calls (reply.tools: [{ name, args }], as for Claude Code) are the model's first
    // answer; the rest of the reply answers the request that brings their results back.
    const pendingCalls = new Map();   // call id -> { name, args, rest }
    const contentText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text || "").join("") : "");

    /**
     * One turn in Chat Completions, whoever asks: OpenAI-compatible APIs over HTTP (`api` "chat"),
     * or GitHub Copilot's models through VS Code (`api` "copilot", vscode.js). The router answers it;
     * what comes back is the model's message ({ message, finish }), or the failure the reply asks
     * for ({ failed: { error } or { network } }). `key`: the request, for once().
     */
    async function chatTurn(body, key, api) {
        const messages = body.messages || [];
        // (what the mind is given, for the scenarios that show it)
        router.lastInstructions = contentText(messages.find((m) => m.role === "system")?.content) || router.lastInstructions;
        if (Array.isArray(body.tools)) { router.lastTools = body.tools.map((t) => ({ name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters })); }
        // The results of calls a reply made (and any pictures they came with): what's left of that reply answers.
        let lastAnswer = messages.length - 1;
        while (lastAnswer >= 0 && messages[lastAnswer].role !== "assistant") { lastAnswer--; }
        const results = messages.slice(lastAnswer + 1).filter((m) => m.role === "tool");
        const made = lastAnswer >= 0 && results.length ? pendingCalls.get(results[0].tool_call_id) : null;
        if (made) {
            for (const r of results) {
                const call = pendingCalls.get(r.tool_call_id);
                pendingCalls.delete(r.tool_call_id);
                const content = contentText(r.content);
                if (call) { router.info({ toolResult: { name: call.name, args: call.args, content: content.replace(/^Error: /, ""), isError: /^Error: /.test(content) } }); }
            }
            return answer(made.rest);
        }
        const text = messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).pop() || "";
        const reply = await once(key, () => router.turn({ api, model: body.model, text, effort: body.reasoning_effort }));
        if (reply.error || reply.network) { return { failed: reply }; }
        if (reply.tools?.length && body.tool_choice !== "none") {
            const { tools, ...rest } = reply;
            const calls = tools.map((t) => {
                const id = `call_${crypto.randomBytes(6).toString("hex")}`;
                pendingCalls.set(id, { name: t.name, args: t.args || {}, rest });
                return { id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args || {}) } };
            });
            return { message: { role: "assistant", content: null, tool_calls: calls }, finish: "tool_calls" };
        }
        return answer(reply);
    }
    function answer(reply) {
        const out = reply.raw !== undefined ? reply.raw : JSON.stringify({ expression: reply.expression || "neutral", say: reply.say ?? null, notes: reply.notes ?? 0, action: reply.action ?? null });
        return { message: { role: "assistant", content: out }, finish: "stop" };
    }

    /** An API error: { status, code, type, message, param } (an OpenAI-style body), in a stream when asked. */
    function errorResponse(e, stream) {
        const err = typeof e === "string" ? { status: 500, message: e } : e;
        if (stream && err.inStream) {
            return sse([{ type: "response.failed", response: { status: "failed", error: { code: err.code, message: err.message } } }]);
        }
        return json(err.status || 500, { error: { message: err.message || "Something went wrong.", type: err.type || null, code: err.code || null, param: err.param || null } });
    }

    function sse(events) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
            start(c) {
                for (const e of events) { c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)); }
                c.close();
            },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }

    function inputText(input) {
        if (typeof input === "string") { return input; }
        const users = (input || []).filter((i) => i && i.role === "user");
        const last = users[users.length - 1];
        if (!last) { return ""; }
        return typeof last.content === "string" ? last.content : (last.content || []).map((c) => c.text || "").join("");
    }

    // ---------- model lists ----------

    function models(req, url, auth) {
        if (auth.startsWith("Bearer plan-")) {
            const m = plan().models;
            if (m && m.status) { return json(m.status, m.body || { detail: "Internal server error" }); }
            return json(200, { models: Array.isArray(m) ? m : PLAN_MODELS });
        }
        const host = url.host;
        const p = net.models?.[host];
        if (p && p.status) { return json(p.status, p.body || { error: { message: "Invalid API key provided.", code: "invalid_api_key" } }); }
        if (url.origin === "https://api.openai.com" && world.spec.openaiKeyRefused) { return json(401, { error: { message: "Incorrect API key provided: sk-…1234.", type: "invalid_request_error", code: "invalid_api_key" } }); }
        const ids = Array.isArray(p) ? p : url.origin === "https://api.openai.com" ? API_MODELS
            : host === "openrouter.ai" ? ["anthropic/claude-sonnet-5.5", "deepseek/deepseek-v4", "google/gemini-3.5-pro", "meta-llama/llama-3.3-70b-instruct", "mistralai/mistral-large-3", "qwen/qwen3-coder"]
                : ["llama3.3:70b", "qwen3-coder:30b", "gemma3:27b"];
        return json(200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "bench" })) });
    }

    // ---------- the fetch the extension gets ----------

    const realFetch = globalThis.fetch;
    async function fetch(input, init = {}) {
        const req = input instanceof Request ? input : null;
        const url = new URL(req ? req.url : String(input));
        const method = (init.method || req?.method || "GET").toUpperCase();
        const headers = new Headers(init.headers || req?.headers || {});
        const auth = headers.get("authorization") || "";
        let bodyText = "";
        if (init.body !== undefined && init.body !== null) { bodyText = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : await new Response(init.body).text(); }
        else if (req) { bodyText = await req.clone().text(); }
        const where = `${url.origin}${url.pathname}`;
        const routed = net.routes?.[`${method} ${where}`];
        if (typeof routed === "function") { return routed({ url, method, headers, body: bodyText }); }

        // a server on this machine (the sign-in's own callback) is reached for real
        if (/^(127\.0\.0\.1|localhost)$/.test(url.hostname) && world.spec.network?.local !== "fake" && !/\/v1(\/|$)/.test(url.pathname)) { return realFetch(input, init); }

        if (where === `${ISSUER}/api/accounts/oauth/token`) { return token(new URLSearchParams(bodyText)); }
        if (where === `${ISSUER}/.well-known/jwks.json`) {
            if (plan().jwks?.status) { return json(plan().jwks.status, {}); }
            return json(200, { keys: [plan().jwks?.otherKey ? { ...jwk, kid: "someone-else" } : jwk] });
        }
        if (where === `${ISSUER}/api/accounts/oauth/revoke`) {
            if (plan().revoke === "fail") { return json(500, { error: "server_error" }); }
            if (plan().revoke === "offline") { throw new TypeError("fetch failed"); }
            return json(200, {});
        }
        const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
        if (local && net.offline?.includes(url.host)) { throw new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ECONNREFUSED ${url.hostname === "localhost" ? "::1" : url.hostname}:${url.port}`), { code: "ECONNREFUSED" }) }); }
        if (net.unreachable?.includes(url.host)) { throw new TypeError("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url.hostname}`), { code: "ENOTFOUND" }) }); }
        // (hold: an API request waits there until the scenario lets it go, t.release("network"), so
        // a screen can show what Euterpe shows meanwhile)
        if ((world.spec.network || {}).hold?.some((h) => url.pathname.endsWith(h))) {
            await new Promise((resolve) => { const tick = setInterval(() => { if (world.gates?.network) { clearInterval(tick); resolve(); } }, 100); });
        }
        if (/\/models$/.test(url.pathname) && method === "GET") { return models(req, url, auth); }
        if (/\/responses$/.test(url.pathname) && method === "POST") { return responses(req, JSON.parse(bodyText || "{}"), auth, bodyText); }
        if (/\/chat\/completions$/.test(url.pathname) && method === "POST") { return chatCompletions(req, JSON.parse(bodyText || "{}"), bodyText); }
        log(`network: nothing answers ${method} ${url.href} in this world`);
        throw new TypeError("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url.hostname}`), { code: "ENOTFOUND" }) });
    }

    // ---------- https, for Electron's download ----------

    function createHttps(electronZip) {
        function get(url, opts, cb) {
            if (typeof opts === "function") { cb = opts; opts = {}; }
            // read at each request: a scenario can make the next download go another way
            const dl = { status: 200, ...(world.spec.electronDownload || {}) };
            const href = String(url);
            if (!/github\.com\/electron\/electron\/releases\/download\//.test(href) && !/objects\.githubusercontent/.test(href)) { return realHttps.get(url, opts, cb); }
            const req = new EventEmitter();
            let destroyed = false, stallTimer = null, timer = null;
            req.setTimeout = (ms, fn) => {
                // A stall is the bench's to decide, in a couple of seconds rather than a minute.
                if (dl.stall) { stallTimer = setTimeout(fn, 2500); }
                return req;
            };
            req.destroy = (err) => {
                if (destroyed) { return req; }
                destroyed = true;
                clearTimeout(stallTimer); clearInterval(timer);
                setImmediate(() => req.emit("error", err || new Error("socket hang up")));
                return req;
            };
            req.end = () => req;
            setTimeout(() => {
                if (destroyed) { return; }
                const res = new PassThrough();
                if (dl.redirectLoop) {
                    res.statusCode = 302; res.headers = { location: `https://github.com/electron/electron/releases/download/loop-${Math.random().toString(36).slice(2, 8)}/electron.zip` };
                    cb(res); res.end();
                    return;
                }
                if (/github\.com/.test(href) && !dl.noRedirect) {
                    res.statusCode = 302; res.headers = { location: "https://objects.githubusercontent.com/github-production-release-asset/electron.zip" };
                    cb(res); res.end();
                    return;
                }
                res.statusCode = dl.status;
                const data = dl.corrupt ? Buffer.concat([electronZip, Buffer.from("x")]) : electronZip;
                const declared = dl.cutShort ? data.length * 2 : data.length;
                res.headers = { "content-length": String(declared), "content-type": "application/zip" };
                cb(res);
                if (dl.status !== 200) { res.end(); return; }
                if (dl.stall) { res.write(data.subarray(0, Math.floor(data.length / 5))); return; }
                // At a pace a writer would see: a few seconds for the lot. (pauseAt: it waits there,
                // a fraction of the way, until the scenario lets it go on: t.release("download").)
                const chunk = Math.ceil(data.length / 40);
                let at = 0;
                timer = setInterval(() => {
                    if (destroyed) { clearInterval(timer); return; }
                    if (dl.pauseAt && at / data.length >= dl.pauseAt && !world.gates?.download) { return; }
                    const next = Math.min(data.length, at + chunk);
                    res.write(data.subarray(at, next));
                    at = next;
                    if (at >= data.length) { clearInterval(timer); res.end(); }
                }, dl.slow ? 400 : 90);
            }, 150);
            return req;
        }
        return { ...realHttps, get, request: realHttps.request };
    }

    return { fetch, realFetch, authorize, createHttps, chatTurn, PLAN_MODELS, idToken };
}

module.exports = { createNetwork, PLAN_MODELS, API_MODELS };
