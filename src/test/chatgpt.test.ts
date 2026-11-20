import * as assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
    AGENT_NAME, authorizeUrl, ChatGptAuth, ChatGptLogin, DYNAMIC_CLIENT, EndedLogin, endLogin, fileLock, LoginStore, loginTime, newHostId, parseEnded, parseLogin, PLAN_SCOPE,
    planModels, PlanNotAllowed, refreshLogin, Registration, RESOURCE, revokeLogin, signIn, SignInCancelled, SignInNeeded, verifyIdToken,
} from "../chatgpt";

// ---------- a fake OpenAI: its signing key, its token endpoint ----------

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(claims: object, kid = "k1"): string {
    const head = b64({ alg: "RS256", kid, typ: "JWT" }), body = b64(claims);
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
    return `${head}.${body}.${sig}`;
}
const now = () => Math.floor(Date.now() / 1000);
const ALL_SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

interface Call { url: string; init: RequestInit; form: URLSearchParams }

/** OpenAI's endpoints as the sign-in sees them: keys, tokens (from `token`), revocation, models. */
function fakeOpenAI(token: (form: URLSearchParams) => { status?: number; body: unknown; headers?: Record<string, string> }) {
    const calls: Call[] = [];
    const f = (async (url: string | URL, init: RequestInit = {}) => {
        const u = String(url);
        const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
        calls.push({ url: u, init, form });
        const reply = (status: number, body: unknown, headers?: Record<string, string>) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
        if (u.endsWith("/.well-known/jwks.json")) { return reply(200, { keys: [JWK] }); }
        if (u.endsWith("/api/accounts/oauth/token")) { const r = token(form); return reply(r.status ?? 200, r.body, r.headers); }
        if (u.endsWith("/api/accounts/oauth/revoke")) { return reply(200, ""); }
        return reply(404, { detail: "Not found" });
    }) as typeof fetch;
    return { f, calls };
}

/** A token endpoint that grants: an ID token for `sub`, with the nonce of the code's sign-in. */
function grants(o: { sub?: string; scope?: string; nonce: () => string; clientId?: () => string }) {
    return (form: URLSearchParams) => ({
        body: {
            access_token: `at-${form.get("grant_type")}`, refresh_token: "rt-1", token_type: "Bearer", expires_in: 3600, scope: o.scope ?? ALL_SCOPES,
            id_token: idToken({ iss: "https://auth.openai.com", aud: o.clientId?.() ?? form.get("client_id"), sub: o.sub ?? "user-1", email: "writer@example.com", exp: now() + 3600, nonce: o.nonce() }),
        },
    });
}

/** The writer's browser: back from the sign-in page with `params` (the state, unless given). `done`: once it has the page. */
function browser(params: (q: URLSearchParams) => Record<string, string>) {
    const pages: { status: number; text: string }[] = [];
    let opened: URLSearchParams | undefined;
    let shown!: () => void;
    const done = new Promise<void>((resolve) => { shown = resolve; });
    const open = async (url: string) => {
        const q = new URL(url).searchParams;
        opened = q;
        const back = new URL(q.get("redirect_uri")!);
        for (const [k, v] of Object.entries({ state: q.get("state")!, ...params(q) })) { back.searchParams.set(k, v); }
        void fetch(back).then(async (r) => { pages.push({ status: r.status, text: await r.text() }); }).finally(shown);
        return true;
    };
    return { open, pages, done: () => done, get query() { return opened!; } };
}

const HOST = "urn:uuid:00000000-0000-4000-8000-000000000000";

// ---------- signing in ----------

test("the first sign-in registers Euterpe, under its own name, for this host, with the plan's scope", () => {
    const url = new URL(authorizeUrl({ redirectUri: "http://127.0.0.1:5555/auth/callback", challenge: "ch", state: "st", nonce: "nn", hostId: HOST }));
    assert.equal(url.origin + url.pathname, "https://auth.openai.com/api/accounts/authorize");
    const q = url.searchParams;
    assert.equal(q.get("client_id"), DYNAMIC_CLIENT);
    assert.equal(q.get("agent_name_hint"), AGENT_NAME);
    assert.equal(q.get("ext_agent_host_id"), HOST);
    assert.equal(q.get("redirect_uri"), "http://127.0.0.1:5555/auth/callback");
    assert.equal(q.get("scope"), ALL_SCOPES);
    assert.equal(q.get("resource"), RESOURCE);
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.deepEqual([q.get("code_challenge"), q.get("state"), q.get("nonce")], ["ch", "st", "nn"]);
    assert.equal(q.get("login_hint"), null);
    assert.match(url.search, /scope=openid%20profile/, "spaces as %20");
    assert.match(newHostId(), /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a later sign-in reuses the registration: its client, the account hinted, no name, consent asked again if it was declined", () => {
    const reg: Registration = { clientId: "oaiapp_1", subject: "user-1", email: "writer@example.com", reconsent: true };
    const q = new URL(authorizeUrl({ redirectUri: "http://127.0.0.1:5555/auth/callback", challenge: "c", state: "s", nonce: "n", hostId: HOST, registration: reg, idTokenHint: "the.id.token" })).searchParams;
    assert.equal(q.get("client_id"), "oaiapp_1");
    assert.equal(q.get("agent_name_hint"), null);
    assert.equal(q.get("ext_agent_host_id"), HOST);
    assert.equal(q.get("login_hint"), "writer@example.com");
    assert.equal(q.get("id_token_hint"), "the.id.token");
    assert.equal(q.get("prompt"), "consent");
    assert.equal(new URL(authorizeUrl({ redirectUri: "http://127.0.0.1:5555/auth/callback", challenge: "c", state: "s", nonce: "n", hostId: HOST, registration: { clientId: "oaiapp_1" } })).searchParams.get("prompt"), null, "nothing asked otherwise");
});

test("after a renewal OpenAI refused, the next sign-in has the writer log in again (with consent, if it was declined)", async () => {
    const prompt = (o: { registration?: Registration; freshLogin?: boolean }) =>
        new URL(authorizeUrl({ redirectUri: "http://127.0.0.1:5555/auth/callback", challenge: "c", state: "s", nonce: "n", hostId: HOST, ...o })).searchParams.get("prompt");
    assert.equal(prompt({ freshLogin: true }), "login");
    assert.equal(prompt({ freshLogin: true, registration: { clientId: "oaiapp_1", reconsent: true } }), "login consent");
    let nonce = "";
    const b = browser((q) => { nonce = q.get("nonce")!; return { code: "c" }; });
    const { f } = fakeOpenAI(grants({ nonce: () => nonce }));
    const l = await signIn({ open: b.open, hostId: HOST, registration: { clientId: "oaiapp_1", subject: "user-1" }, freshLogin: true, fetch: f });
    await b.done();
    assert.equal(b.query.get("prompt"), "login");
    assert.equal(l.clientId, "oaiapp_1");
});

test("signing in: the browser comes back with a code and the issued client, which become a checked login", async () => {
    let nonce = "";
    const b = browser((q) => { nonce = q.get("nonce")!; return { code: "the-code", client_id: "oaiapp_new", scope: ALL_SCOPES.replace(/ /g, "+") }; });
    const { f, calls } = fakeOpenAI(grants({ nonce: () => nonce }));
    const registered: Registration[] = [];
    const login = await signIn({ open: b.open, hostId: HOST, fetch: f, registered: (r) => { registered.push(r); } });
    await b.done();
    assert.deepEqual(registered, [{ clientId: "oaiapp_new" }], "kept before the code is exchanged");
    assert.equal(login.clientId, "oaiapp_new");
    assert.equal(login.subject, "user-1");
    assert.equal(login.email, "writer@example.com");
    assert.equal(login.refresh, "rt-1");
    assert.ok(login.scopes.includes(PLAN_SCOPE));
    assert.ok(Math.abs(login.expires - (Date.now() + 3600_000)) < 5_000);
    assert.match(b.query.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    const exchange = calls.find((c) => c.url.endsWith("/oauth/token"))!;
    assert.equal(exchange.form.get("grant_type"), "authorization_code");
    assert.equal(exchange.form.get("client_id"), "oaiapp_new", "the issued client, not the registration's entry point");
    assert.equal(exchange.form.get("code"), "the-code");
    assert.equal(exchange.form.get("redirect_uri"), b.query.get("redirect_uri"));
    assert.equal(exchange.form.get("resource"), RESOURCE);
    assert.equal(createHash("sha256").update(exchange.form.get("code_verifier")!).digest("base64url"), b.query.get("code_challenge"));
    assert.equal(b.pages[0].status, 200);
    assert.match(b.pages[0].text, /signed in to ChatGPT as writer@example\.com, and can use your plan/);
});

test("a sign-in without the plan's permission keeps the registration, to ask for consent next time", async () => {
    let nonce = "";
    const b = browser((q) => { nonce = q.get("nonce")!; return { code: "c", client_id: "oaiapp_2" }; });
    const { f } = fakeOpenAI(grants({ nonce: () => nonce, scope: "openid profile email offline_access" }));
    const err = await signIn({ open: b.open, hostId: HOST, fetch: f }).catch((e) => e);
    assert.ok(err instanceof PlanNotAllowed, String(err));
    assert.deepEqual(err.registration, { clientId: "oaiapp_2", subject: "user-1", email: "writer@example.com", reconsent: true });
    assert.match(err.message, /Plus and Pro/);
});

test("an ID token that doesn't hold up is refused: wrong nonce, wrong app, unknown key, or forged", async () => {
    const { f } = fakeOpenAI(() => ({ body: {} }));
    const claims = { iss: "https://auth.openai.com", aud: "oaiapp_1", sub: "u", exp: now() + 600, nonce: "n" };
    assert.equal((await verifyIdToken(idToken(claims), "oaiapp_1", "n", f)).sub, "u");
    await assert.rejects(verifyIdToken(idToken(claims), "oaiapp_1", "other", f), /from another sign-in/);
    await assert.rejects(verifyIdToken(idToken(claims), "oaiapp_2", "n", f), /meant for another app/);
    await assert.rejects(verifyIdToken(idToken({ ...claims, exp: now() - 3600 }), "oaiapp_1", "n", f), /expired/);
    await assert.rejects(verifyIdToken(idToken(claims, "k2"), "oaiapp_1", "n", f), /a key OpenAI doesn't publish/);
    const [h, , s] = idToken(claims).split(".");
    await assert.rejects(verifyIdToken(`${h}.${b64({ ...claims, sub: "someone-else" })}.${s}`, "oaiapp_1", "n", f), /signature/);
    await assert.rejects(verifyIdToken(`${b64({ alg: "none" })}.${b64(claims)}.`, "oaiapp_1", "n", f), /signed with none/);
});

test("a returning sign-in must come back for Euterpe's registration, and for the same account", async () => {
    const reg: Registration = { clientId: "oaiapp_1", subject: "user-1", email: "writer@example.com" };
    const other = browser(() => ({ code: "c", client_id: "oaiapp_other" }));
    await assert.rejects(signIn({ open: other.open, hostId: HOST, registration: reg, fetch: fakeOpenAI(() => ({ body: {} })).f }), /another registration/);
    let nonce = "";
    const b = browser((q) => { nonce = q.get("nonce")!; return { code: "c" }; });   // a reauthorization may leave the client out
    const { f, calls } = fakeOpenAI(grants({ nonce: () => nonce, sub: "user-2" }));
    await assert.rejects(signIn({ open: b.open, hostId: HOST, registration: reg, fetch: f }), /another ChatGPT account/);
    assert.equal(calls.find((c) => c.url.endsWith("/oauth/token"))!.form.get("client_id"), "oaiapp_1");
});

test("a refused or broken sign-in says why; a stranger's callback is turned away; the writer can give up", async () => {
    const denied = browser(() => ({ error: "access_denied" }));
    await assert.rejects(signIn({ open: denied.open, hostId: HOST, fetch: fakeOpenAI(() => ({ body: {} })).f }), /didn't let Euterpe sign in/);
    await denied.done();
    assert.equal(denied.pages[0].status, 400);
    const noClient = browser(() => ({ code: "c" }));
    await assert.rejects(signIn({ open: noClient.open, hostId: HOST, fetch: fakeOpenAI(() => ({ body: {} })).f }), /no client ID came back/);
    const expired = browser(() => ({ code: "c", client_id: "oaiapp_3" }));
    await assert.rejects(signIn({ open: expired.open, hostId: HOST, fetch: fakeOpenAI(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Code expired" } })).f }), /didn't finish \(400\): Code expired/);

    const ac = new AbortController();
    const stranger = browser(() => ({ state: "not-ours", code: "c", client_id: "x" }));
    const signing = signIn({ open: stranger.open, hostId: HOST, fetch: fakeOpenAI(() => ({ body: {} })).f, signal: ac.signal });
    await stranger.done();
    assert.equal(stranger.pages[0].status, 400);
    ac.abort();
    await assert.rejects(signing, SignInCancelled);
    await assert.rejects(signIn({ open: async () => false, hostId: HOST }), /couldn't open your browser/);
});

// ---------- staying signed in ----------

const login = (o: Partial<ChatGptLogin> = {}): ChatGptLogin =>
    ({ clientId: "oaiapp_1", access: "at-1", refresh: "rt-1", expires: Date.now() + 3600_000, scopes: [PLAN_SCOPE], subject: "user-1", email: "writer@example.com", ...o });

test("renewing: form-encoded, with the issued client and the resource; the refresh token comes back new", async () => {
    const { f, calls } = fakeOpenAI(() => ({ body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600, earliest_refresh_at: now() + 600 } }));
    const fresh = await refreshLogin(login(), f);
    assert.deepEqual([fresh.access, fresh.refresh, fresh.clientId, fresh.subject], ["at-2", "rt-2", "oaiapp_1", "user-1"]);
    assert.ok(fresh.earliestRefresh! > Date.now());
    assert.deepEqual(Object.fromEntries(calls[0].form), { grant_type: "refresh_token", client_id: "oaiapp_1", refresh_token: "rt-1", resource: RESOURCE });
    // dead for good: a new sign-in, with a new login only when OpenAI refused the renewal itself
    for (const [code, freshLogin] of [["refresh_token_reused", false], ["invalid_grant", true], ["refresh_token_invalidated", true], ["refresh_token_expired", false], ["invalid_client", false]] as const) {
        const dead = fakeOpenAI(() => ({ status: 400, body: { error: code, error_description: "No." } }));
        await assert.rejects(refreshLogin(login(), dead.f), (e: Error) => e instanceof SignInNeeded && e.freshLogin === freshLogin, code);
    }
    // as OpenAI answers a renewal it refuses (one made on a login from before a security change): the
    // precise reason under the OAuth error, kept for the log with the request's ID; the writer hears
    // it has ended, and that they'll log in again
    const invalidated = fakeOpenAI(() => ({
        status: 400, headers: { "x-request-id": "req_1" },
        body: { error: "invalid_grant", error_reason: "refresh_token_invalidated", error_description: "The refresh token has been invalidated. A fresh sign-in is required." },
    }));
    const ended = await refreshLogin(login(), invalidated.f).catch((e) => e);
    assert.ok(ended instanceof SignInNeeded);
    assert.equal(ended.message, "Euterpe's ChatGPT sign-in has ended: OpenAI didn't renew it, and asks you to log in again.");
    assert.equal(ended.detail, '400 invalid_grant/refresh_token_invalidated "The refresh token has been invalidated. A fresh sign-in is required." request req_1');
    assert.equal(ended.freshLogin, true);
    const bare = await refreshLogin(login(), fakeOpenAI(() => ({ status: 400, body: { error: "invalid_grant" } })).f).catch((e) => e);
    assert.deepEqual([bare.message, bare.detail, bare.freshLogin], ["Euterpe's ChatGPT sign-in has ended: OpenAI didn't renew it, and asks you to log in again.", "400 invalid_grant", true]);
    const unknown = await refreshLogin(login(), fakeOpenAI(() => ({ status: 400, body: { error: "invalid_grant", error_reason: "something_new", error_description: "Nope." } })).f).catch((e) => e);
    assert.deepEqual([unknown instanceof SignInNeeded, unknown.detail, unknown.freshLogin], [true, '400 invalid_grant/something_new "Nope."', true]);
    // Codex's spelling of a reused token
    const reused = await refreshLogin(login(), fakeOpenAI(() => ({ status: 401, body: { error: { code: "refresh_token_reused", message: "Already used." } } })).f).catch((e) => e);
    assert.deepEqual([reused.message, reused.detail, reused.freshLogin], ["Euterpe's ChatGPT sign-in has ended: its renewal was used elsewhere.", '401 refresh_token_reused "Already used."', false]);
    const down = fakeOpenAI(() => ({ status: 503, body: "Service Unavailable" }));
    await assert.rejects(refreshLogin(login(), down.f), (e: Error) => !(e instanceof SignInNeeded) && /couldn't renew/.test(e.message));
});

test("the browser login a sign-in was made on (its ID token's auth_time), for the log", () => {
    assert.equal(loginTime({ idToken: idToken({ auth_time: 1_788_453_986 }) }), 1_788_453_986_000);
    assert.equal(loginTime({ idToken: idToken({ sub: "u" }) }), undefined);
    assert.equal(loginTime({}), undefined);
});

function memoryStore(initial?: ChatGptLogin): LoginStore & { kept?: ChatGptLogin; ended?: EndedLogin } {
    const s: LoginStore & { kept?: ChatGptLogin; ended?: EndedLogin } = {
        kept: initial,
        load: async () => s.kept,
        save: async (l) => { s.kept = l; s.ended = undefined; },
        end: async (l, why) => { if (s.kept?.refresh === l.refresh) { s.kept = undefined; s.ended = endLogin(l, why); } },
        lock: (fn) => fn(),
    };
    return s;
}

test("a request's headers: the token while it's fresh, renewed once (and kept) when it ends or is refused", async () => {
    const { f, calls } = fakeOpenAI(() => ({ body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 } }));
    const store = memoryStore(login());
    const auth = new ChatGptAuth(login(), store, f);
    assert.deepEqual(await auth.headers(), { Authorization: "Bearer at-1" });
    assert.equal(calls.length, 0);
    const [a, b] = await Promise.all([auth.headers(true), auth.headers(true)]);
    assert.equal(calls.length, 1, "one renewal, however many ask");
    assert.deepEqual(a, { Authorization: "Bearer at-2" });
    assert.deepEqual(b, a);
    assert.equal(store.kept?.refresh, "rt-2");
    const ending = login({ expires: Date.now() + 60_000 });
    const auth2 = new ChatGptAuth(ending, memoryStore(ending), f);
    assert.deepEqual(await auth2.headers(), { Authorization: "Bearer at-2" });
    assert.equal(calls.length, 2);
});

test("another window renewed the login first: its tokens are taken; too early to renew: never, even refused; signed out: sign in again", async () => {
    const { f, calls } = fakeOpenAI(() => ({ body: {} }));
    const ending = login({ expires: Date.now() + 60_000 });
    const auth = new ChatGptAuth(ending, memoryStore(login({ access: "at-other", refresh: "rt-other" })), f);
    assert.deepEqual(await auth.headers(), { Authorization: "Bearer at-other" });
    // never before earliest_refresh_at (as OpenAI's DevKit): the token goes on as it is
    const early = login({ expires: Date.now() + 60_000, earliestRefresh: Date.now() + 30_000 });
    assert.deepEqual(await new ChatGptAuth(early, memoryStore(early), f).headers(), { Authorization: "Bearer at-1" });
    const refusedEarly = login({ earliestRefresh: Date.now() + 30 * 60_000 });
    assert.deepEqual(await new ChatGptAuth(refusedEarly, memoryStore(refusedEarly), f).headers(true), { Authorization: "Bearer at-1" });
    assert.equal(calls.length, 0);
    await assert.rejects(new ChatGptAuth(ending, memoryStore(undefined), f).headers(), SignInNeeded);
    // signed in again, even with another account: that sign-in is the one Euterpe has now
    const again = login({ clientId: "oaiapp_other", access: "at-again", refresh: "rt-again" });
    assert.deepEqual(await new ChatGptAuth(ending, memoryStore(again), f).headers(), { Authorization: "Bearer at-again" });
});

test("a renewal OpenAI refuses ends the sign-in: its tokens go, why and whose it was stay, and a new sign-in is taken up", async () => {
    const { f, calls } = fakeOpenAI(() => ({ status: 400, body: { error: "invalid_grant", error_reason: "refresh_token_invalidated" } }));
    const ending = login({ expires: Date.now() + 60_000, idToken: "id-1" });
    const store = memoryStore(ending);
    const auth = new ChatGptAuth(ending, store, f);
    const err = await auth.headers().catch((e) => e);
    assert.ok(err instanceof SignInNeeded);
    assert.equal(err.message, "Euterpe's ChatGPT sign-in has ended: OpenAI didn't renew it, and asks you to log in again.");
    assert.equal(store.kept, undefined);
    // the next sign-in has the writer log in again (freshLogin)
    assert.deepEqual({ ...store.ended, at: 0 }, { clientId: "oaiapp_1", subject: "user-1", email: "writer@example.com", idToken: "id-1", ended: err.message, freshLogin: true, at: 0 });
    // what's kept reads back as an ended sign-in, never as a login (and a login never as one)
    assert.deepEqual(parseEnded(JSON.stringify(store.ended)), store.ended);
    assert.equal(parseLogin(JSON.stringify(store.ended)), undefined);
    assert.equal(parseEnded(JSON.stringify(ending)), undefined);
    // OpenAI isn't asked again: there's no sign-in to renew
    await assert.rejects(auth.headers(), SignInNeeded);
    assert.equal(calls.length, 1);
    // the writer signs in again: the requests go on with it
    await store.save(login({ access: "at-new", refresh: "rt-new" }));
    assert.deepEqual(await auth.headers(), { Authorization: "Bearer at-new" });
    // a renewal that fails for now (OpenAI unreachable) keeps the sign-in, to try again
    const down = fakeOpenAI(() => ({ status: 503, body: "Service Unavailable" }));
    const kept = memoryStore(ending);
    await assert.rejects(new ChatGptAuth(ending, kept, down.f).headers(), /couldn't renew/);
    assert.equal(kept.kept, ending);
});

test("one holder of the lock at a time; a dead holder's lock is taken over", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "euterpe-lock-"));
    const lock = fileLock(dir, 1_000);
    const order: string[] = [];
    const slow = (name: string) => lock(async () => { order.push(`${name} in`); await new Promise((r) => setTimeout(r, 50)); order.push(`${name} out`); });
    await Promise.all([slow("a"), slow("b")]);
    assert.deepEqual(order, ["a in", "a out", "b in", "b out"]);
    fs.mkdirSync(path.join(dir, "chatgpt-sign-in.lock"));
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(path.join(dir, "chatgpt-sign-in.lock"), old, old);
    assert.equal(await lock(async () => "taken over"), "taken over");
    assert.ok(!fs.existsSync(path.join(dir, "chatgpt-sign-in.lock")));
});

test("signing out revokes the refresh token, as a form; an unconfirmed revocation says so", async () => {
    const { f, calls } = fakeOpenAI(() => ({ body: {} }));
    assert.equal(await revokeLogin(login(), f), true);
    assert.deepEqual(Object.fromEntries(calls[0].form), { token: "rt-1", token_type_hint: "refresh_token", client_id: "oaiapp_1" });
    assert.equal(await revokeLogin(login(), (async () => { throw new Error("offline"); }) as typeof fetch), false);
    const kept = login();
    assert.deepEqual(parseLogin(JSON.stringify(kept)), kept);
    assert.equal(parseLogin("{\"access\": 1}"), undefined);
});

test("the plan's models: OpenAI's catalog for this account, listed ones in its order", async () => {
    const calls: string[] = [];
    const f = (async (url: string | URL, init: RequestInit = {}) => {
        calls.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
        return new Response(JSON.stringify({
            models: [
                { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }], context_window: 400000 },
                { slug: "gpt-reserve", display_name: "Reserve", visibility: "hide" },
                { slug: "gpt-6-luna", display_name: "GPT-6 Luna", description: "Quick", visibility: "list" },
            ],
        }));
    }) as typeof fetch;
    const models = await planModels({ Authorization: "Bearer at-1" }, f);
    assert.deepEqual(models.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-luna"]);
    assert.deepEqual(models[0], { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", detail: "", efforts: ["low", "max"], context: 400000 });
    assert.deepEqual(calls, ["https://api.openai.com/v1/models Bearer at-1"]);
    const refused = (async () => new Response(JSON.stringify({ detail: "Direct routing is unavailable" }), { status: 503 })) as typeof fetch;
    await assert.rejects(planModels({}, refused), /didn't list your plan's models \(503\): Direct routing is unavailable/);
});
