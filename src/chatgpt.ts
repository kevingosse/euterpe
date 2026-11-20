// Euterpe's mind on the writer's ChatGPT plan (Plus or Pro) instead of an API key: OpenAI's "Sign in
// with ChatGPT" for open-source apps. The first sign-in registers Euterpe with the writer's account,
// under its own name (they see it, and cap its usage, in ChatGPT's settings), and grants it the use of
// their plan for Responses API requests; later sign-ins reuse that registration. OAuth with PKCE, the
// browser coming back to a server on 127.0.0.1; access tokens that last an hour, renewed with a
// refresh token that changes each time, so one renewal at a time, across VS Code windows. A sign-in
// OpenAI won't renew ends: its tokens go, and the writer signs in again. The mind then calls the
// public Responses API with the access token (openaiMind.ts). Written from OpenAI's documentation
// (developers.openai.com/siwc). vscode-free, for the tests.

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "crypto";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as path from "path";
import { OPENAI_DEFAULT_MODEL, sameModel } from "./models";

/** OpenAI's sign-in. */
export const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
/** What the tokens are for: the public API, whose Responses API runs on the plan. */
export const RESOURCE = "https://api.openai.com/v1";
/** The first sign-in's client: it registers Euterpe, and the callback brings the issued client ID. */
export const DYNAMIC_CLIENT = "dynamic_agent_client";
/** The name Euterpe registers under, on every installation. */
export const AGENT_NAME = "Euterpe";
/** The permission to use the plan, on top of the identity scopes. */
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** Where the writer reviews their plan's usage, and the limit they set for Euterpe. */
export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";
/** An access token this close to expiring is renewed first. */
const REFRESH_MARGIN_MS = 3 * 60_000;
/**
 * OpenAI's sign-in answers within a second or two: a request that hangs is given up, well before
 * another window would take the renewal's lock for abandoned (fileLock).
 */
const REQUEST_TIMEOUT_MS = 20_000;
const patience = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

/** A ChatGPT sign-in, as Euterpe keeps it (in VS Code's secret storage). */
export interface ChatGptLogin {
    /** Euterpe's registration with this ChatGPT account and workspace: the issued client ID. */
    clientId: string;
    access: string;
    refresh: string;
    /** When `access` expires (ms since the epoch). */
    expires: number;
    /** No renewal before this (ms since the epoch), unless the token has expired. */
    earliestRefresh?: number;
    scopes: string[];
    /** The account, from the validated ID token. */
    subject: string;
    email?: string;
    /** The last ID token: names the account at the next sign-in (id_token_hint). */
    idToken?: string;
}

/** What outlives signing out: Euterpe's registration with an account, for the next sign-in. */
export interface Registration {
    clientId: string;
    subject?: string;
    email?: string;
    /** The writer didn't let Euterpe use their plan last time: ask for consent again. */
    reconsent?: boolean;
}

/**
 * A sign-in that ended (OpenAI wouldn't renew it), kept in its place without its tokens: why, for
 * the writer, and whose it was, for their next sign-in.
 */
export interface EndedLogin {
    clientId: string;
    subject: string;
    email?: string;
    /** Names the account at the next sign-in (id_token_hint). */
    idToken?: string;
    /** Why it ended, in words for the writer. */
    ended: string;
    /** The next sign-in asks the writer to log in to OpenAI again: OpenAI wouldn't renew one made on their browser's login. */
    freshLogin?: boolean;
    /** When (ms since the epoch). */
    at: number;
}

/**
 * Signing in again is the only way on: the sign-in is gone, expired, or was revoked. `detail`: OpenAI's
 * own answer, for the log. `freshLogin`: the next sign-in asks the writer to log in to OpenAI again.
 */
export class SignInNeeded extends Error {
    constructor(message: string, readonly detail?: string, readonly freshLogin = false) { super(message); }
}

/** The writer stopped the sign-in. */
export class SignInCancelled extends Error {
    constructor() { super("The ChatGPT sign-in was cancelled."); }
}

/** Signed in, but without the permission to use the plan (declined, or a plan that can't). */
export class PlanNotAllowed extends Error {
    constructor(readonly registration: Registration) {
        super("ChatGPT didn't give Euterpe the use of your plan: it's for ChatGPT Plus and Pro, and you allow it on the sign-in page. Sign in again to allow it, or use an API key.");
    }
}

/** A login as kept (JSON), or undefined when it isn't one. */
export function parseLogin(text: string | undefined): ChatGptLogin | undefined {
    if (!text) { return undefined; }
    try {
        const l = JSON.parse(text);
        return ["clientId", "access", "refresh", "subject"].every((k) => typeof l?.[k] === "string") && typeof l.expires === "number" && Array.isArray(l.scopes) ? l : undefined;
    } catch {
        return undefined;
    }
}

/** What's kept of a login once it ends. */
export function endLogin(login: ChatGptLogin, why: SignInNeeded): EndedLogin {
    return { clientId: login.clientId, subject: login.subject, email: login.email, idToken: login.idToken, ended: why.message, ...(why.freshLogin ? { freshLogin: true } : {}), at: Date.now() };
}

/** When the writer last logged in to OpenAI in their browser (the ID token's auth_time), as their sign-in says: the log's clue when a renewal is refused. */
export function loginTime(login: { idToken?: string }): number | undefined {
    const t = login.idToken ? jwtClaims(login.idToken).auth_time : undefined;
    return typeof t === "number" && t > 0 ? t * 1000 : undefined;
}

/** An ended sign-in as kept (JSON), or undefined when it isn't one. */
export function parseEnded(text: string | undefined): EndedLogin | undefined {
    if (!text) { return undefined; }
    try {
        const l = JSON.parse(text);
        return typeof l?.ended === "string" && typeof l.clientId === "string" && typeof l.subject === "string" && typeof l.at === "number" ? l : undefined;
    } catch {
        return undefined;
    }
}

/** A stable ID for this installation (an agent host, to OpenAI): made once, then kept. */
export function newHostId(): string {
    return `urn:uuid:${randomUUID()}`;
}

/** A JWT's claims, unverified. */
export function jwtClaims(token: string): Record<string, any> {
    try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
        return claims && typeof claims === "object" ? claims : {};
    } catch {
        return {};
    }
}

// ---------- signing in ----------

export function pkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(64).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * OpenAI's sign-in page, coming back to `redirectUri`: a new registration (Euterpe's name, this
 * host), or the saved one (the account hinted). `freshLogin`: the writer logs in again (OpenID's
 * prompt=login), rather than going on with their browser's login.
 */
export function authorizeUrl(o: { redirectUri: string; challenge: string; state: string; nonce: string; hostId: string; registration?: Registration; idTokenHint?: string; freshLogin?: boolean }): string {
    const r = o.registration;
    const prompt = [o.freshLogin && "login", r?.reconsent && "consent"].filter(Boolean).join(" ");
    const query = new URLSearchParams({
        client_id: r?.clientId ?? DYNAMIC_CLIENT,
        ...(r ? {} : { agent_name_hint: AGENT_NAME }),
        ext_agent_host_id: o.hostId,
        ...(r && o.idTokenHint ? { id_token_hint: o.idTokenHint } : {}),
        ...(r?.email ? { login_hint: r.email } : {}),
        response_type: "code",
        redirect_uri: o.redirectUri,
        scope: SCOPE,
        resource: RESOURCE,
        state: o.state,
        nonce: o.nonce,
        code_challenge_method: "S256",
        code_challenge: o.challenge,
        ...(prompt ? { prompt } : {}),
    });
    return `${AUTHORIZE_URL}?${query.toString().replace(/\+/g, "%20")}`;
}

export interface SignInOptions {
    /** Show the sign-in page in the writer's browser: false if it couldn't. */
    open(url: string): Promise<boolean>;
    /** This installation's ID (newHostId), the same at every sign-in. */
    hostId: string;
    /** Euterpe's registration with the account, from an earlier sign-in: reused. */
    registration?: Registration;
    /** The account's last ID token, if it's still kept: the sign-in skips the account picker. */
    idTokenHint?: string;
    /** The writer logs in to OpenAI again, rather than going on with their browser's login: OpenAI wouldn't renew a sign-in made on it. */
    freshLogin?: boolean;
    /** A new registration, as soon as the callback brings it: kept even if the rest fails. */
    registered?(r: Registration): void | Promise<void>;
    /** The writer gave up. */
    signal?: AbortSignal;
    /** How long to wait for the writer: 10 minutes by default. */
    timeoutMs?: number;
    fetch?: typeof fetch;
}

/**
 * Sign in with ChatGPT: OpenAI's sign-in page in the writer's browser, which comes back to a server
 * on this computer with a code, which becomes the login, once its ID token and the permission to use
 * the plan check out.
 */
export async function signIn(o: SignInOptions): Promise<ChatGptLogin> {
    if (o.signal?.aborted) { throw new SignInCancelled(); }
    const f = o.fetch ?? fetch;
    const { verifier, challenge } = pkce();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    // Any free port: only the port of the address it comes back to may change between sign-ins.
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
        return await new Promise<ChatGptLogin>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("The ChatGPT sign-in wasn't finished in time: try again.")), o.timeoutMs ?? 10 * 60_000);
            onAbort = () => reject(new SignInCancelled());
            o.signal?.addEventListener("abort", onAbort, { once: true });
            let answered = false;
            server.on("request", (req, res) => {
                const url = new URL(req.url ?? "/", redirectUri);
                if (url.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
                if (url.searchParams.get("state") !== state || answered) { res.writeHead(400).end("This sign-in isn't the one Euterpe is waiting for."); return; }
                answered = true;
                const fail = (err: Error) => { page(res, 400, err.message); reject(err); };
                const error = url.searchParams.get("error");
                if (error) {
                    fail(new Error(error === "access_denied"
                        ? "You didn't let Euterpe sign in with ChatGPT, so it can't use your plan. (Sign in again whenever you like.)"
                        : `The ChatGPT sign-in didn't finish: ${url.searchParams.get("error_description")?.trim() || error}`));
                    return;
                }
                const code = url.searchParams.get("code");
                const issued = url.searchParams.get("client_id")?.trim() || undefined;
                const registration = o.registration;
                if (!code) { fail(new Error("The ChatGPT sign-in came back without a code: try again.")); return; }
                if (!registration && !issued) { fail(new Error("ChatGPT didn't finish registering Euterpe (no client ID came back): try again.")); return; }
                if (registration && issued && issued !== registration.clientId) { fail(new Error("The ChatGPT sign-in came back for another registration than Euterpe's: try again.")); return; }
                const clientId = registration?.clientId ?? issued!;
                void (async () => {
                    if (!registration) { await o.registered?.({ clientId }); }
                    const login = await exchangeCode({ code, verifier, redirectUri, clientId, nonce, registration }, f);
                    page(res, 200, `Euterpe is signed in to ChatGPT${login.email ? ` as ${login.email}` : ""}, and can use your plan. You can close this tab and go back to VS Code.`);
                    resolve(login);
                })().catch((err: Error) => {
                    page(res, err instanceof PlanNotAllowed ? 200 : 500, err.message);
                    reject(err);
                });
            });
            void o.open(authorizeUrl({ redirectUri, challenge, state, nonce, hostId: o.hostId, registration: o.registration, idTokenHint: o.idTokenHint, freshLogin: o.freshLogin })).then((opened) => {
                if (!opened) { reject(new Error("Euterpe couldn't open your browser for the ChatGPT sign-in.")); }
            }, reject);
        });
    } finally {
        clearTimeout(timer);
        if (onAbort) { o.signal?.removeEventListener("abort", onAbort); }
        // The last page still has to reach the browser: idle connections go now, the rest soon.
        server.close();
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 5_000).unref();
    }
}

/** The page the browser shows once it's back. */
function page(res: http.ServerResponse, status: number, text: string): void {
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
    res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Euterpe</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34em; margin: 5em auto; line-height: 1.5; padding: 0 1em">
<h1 style="font-weight: 600">Euterpe</h1><p>${esc}</p></body></html>`);
}

interface TokenResponse { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown; scope?: unknown; earliest_refresh_at?: unknown }

async function exchangeCode(o: { code: string; verifier: string; redirectUri: string; clientId: string; nonce: string; registration?: Registration }, f: typeof fetch): Promise<ChatGptLogin> {
    const t = await tokenRequest({ grant_type: "authorization_code", client_id: o.clientId, code: o.code, code_verifier: o.verifier, redirect_uri: o.redirectUri, resource: RESOURCE }, f,
        (status, text) => new Error(`The ChatGPT sign-in didn't finish (${status}): ${errorMessage(text)}`));
    if (typeof t.id_token !== "string" || !t.id_token) { throw new Error("ChatGPT's sign-in didn't say whose account this is (no ID token)."); }
    const claims = await verifyIdToken(t.id_token, o.clientId, o.nonce, f);
    const subject = String(claims.sub);
    if (o.registration?.subject && o.registration.subject !== subject) {
        throw new Error("That's another ChatGPT account than the one Euterpe is registered with: sign out, then sign in with the account you want.");
    }
    const email = typeof claims.email === "string" ? claims.email : undefined;
    const scopes = scopesOf(t.scope);
    if (!scopes.includes(PLAN_SCOPE)) { throw new PlanNotAllowed({ clientId: o.clientId, subject, email, reconsent: true }); }
    return loginFrom(t, { clientId: o.clientId, subject, email, idToken: t.id_token, scopes });
}

/** The login a token response comes to (`base`: what it doesn't say again). */
function loginFrom(t: TokenResponse, base: Pick<ChatGptLogin, "clientId" | "subject" | "scopes"> & Partial<ChatGptLogin>): ChatGptLogin {
    if (typeof t.access_token !== "string" || !t.access_token) { throw new Error("ChatGPT's sign-in gave no access token."); }
    const refresh = typeof t.refresh_token === "string" && t.refresh_token ? t.refresh_token : base.refresh;
    if (!refresh) { throw new Error("ChatGPT's sign-in gave no refresh token."); }
    const expiresIn = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : 3600;
    const earliest = epochMs(t.earliest_refresh_at);
    return {
        ...base,
        access: t.access_token,
        refresh,
        expires: Date.now() + expiresIn * 1000,
        ...(earliest ? { earliestRefresh: earliest } : { earliestRefresh: undefined }),
        scopes: t.scope === undefined ? base.scopes : scopesOf(t.scope),
    };
}

function scopesOf(scope: unknown): string[] {
    return typeof scope === "string" ? scope.trim().split(/\s+/).filter(Boolean) : Array.isArray(scope) ? scope.filter((s): s is string => typeof s === "string") : [];
}

/** A time as the token endpoint gives it (Unix seconds, or a date), in ms. */
function epochMs(v: unknown): number | undefined {
    if (typeof v === "number" && v > 0) { return v > 1e12 ? v : v * 1000; }
    if (typeof v === "string" && v) { const t = Date.parse(v); return Number.isNaN(t) ? undefined : t; }
    return undefined;
}

/**
 * The ID token, checked as OpenID Connect asks: signed by OpenAI (its published keys), for Euterpe's
 * registration, not expired, and from this sign-in (the nonce). Its claims, once it holds up.
 */
export async function verifyIdToken(idToken: string, clientId: string, nonce: string, f: typeof fetch = fetch): Promise<Record<string, any>> {
    const [h, p, s] = idToken.split(".");
    const bad = (why: string) => new Error(`ChatGPT's sign-in came back with an ID token that doesn't hold up (${why}): try again.`);
    let header: any;
    try { header = JSON.parse(Buffer.from(h ?? "", "base64url").toString("utf8")); } catch { throw bad("unreadable"); }
    if (header?.alg !== "RS256" || !p || !s) { throw bad(`signed with ${header?.alg ?? "nothing"}`); }
    const res = await f(JWKS_URL, { headers: { Accept: "application/json" }, signal: patience() });
    if (!res.ok) { throw new Error(`Couldn't get OpenAI's signing keys to check the sign-in (${res.status}): try again.`); }
    const keys: any[] = ((await res.json()) as { keys?: any[] } | null)?.keys ?? [];
    const jwk = keys.find((k) => k?.kid === header.kid && k?.kty === "RSA") ?? (header.kid === undefined && keys.length === 1 ? keys[0] : undefined);
    if (!jwk) { throw bad("signed with a key OpenAI doesn't publish"); }
    const signed = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
    if (!signed) { throw bad("its signature"); }
    const claims = jwtClaims(idToken);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Date.now() / 1000;
    if (claims.iss !== ISSUER) { throw bad(`issuer ${claims.iss}`); }
    if (!audience.includes(clientId)) { throw bad("meant for another app"); }
    if (typeof claims.exp !== "number" || claims.exp < now - 120) { throw bad("expired"); }
    if (claims.nonce !== nonce) { throw bad("from another sign-in"); }
    if (typeof claims.sub !== "string" || !claims.sub) { throw bad("no account"); }
    return claims;
}

// ---------- staying signed in ----------

/**
 * The login's tokens, renewed: the refresh token is used once, and comes back new. A renewal OpenAI
 * refuses for good ends the sign-in (SignInNeeded, with OpenAI's answer for the log).
 */
export async function refreshLogin(login: ChatGptLogin, f: typeof fetch = fetch): Promise<ChatGptLogin> {
    const t = await tokenRequest({ grant_type: "refresh_token", client_id: login.clientId, refresh_token: login.refresh, resource: RESOURCE }, f, (status, text, requestId) => {
        const code = errorCode(text);
        const dead = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_client"];
        if (dead.includes(code) || dead.includes(String(errorBody(text)?.error ?? "")) || status === 401) {
            // Whatever the code says, the writer's way on is the same: a new sign-in.
            const why = code === "refresh_token_reused" ? "its renewal was used elsewhere"
                : code === "invalid_client" ? "its registration with your account is gone"
                : code === "refresh_token_expired" || code === "token_expired" ? "it expired"
                : undefined;
            if (why) { return new SignInNeeded(`Euterpe's ChatGPT sign-in has ended: ${why}.`, answer(status, text, requestId)); }
            // Refused (refresh_token_invalidated: "A fresh sign-in is required"): as of October 2026,
            // OpenAI won't renew a sign-in made on a browser login from before the account's last
            // security change (Advanced Account Security turned on or off), though signing in goes
            // on with that login, unasked. Once the writer logs in again, renewals go through.
            return new SignInNeeded("Euterpe's ChatGPT sign-in has ended: OpenAI didn't renew it, and asks you to log in again.", answer(status, text, requestId), true);
        }
        return new Error(`Euterpe couldn't renew its ChatGPT sign-in (${status}): ${errorMessage(text)}`);
    });
    return loginFrom(t, login);
}

/** Signing out: the refresh token is revoked; false if that couldn't be confirmed (the writer can disconnect Euterpe in ChatGPT's settings). */
export async function revokeLogin(login: ChatGptLogin, f: typeof fetch = fetch): Promise<boolean> {
    try {
        const res = await f(REVOKE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({ token: login.refresh, token_type_hint: "refresh_token", client_id: login.clientId }).toString(),
            signal: patience(),
        });
        return res.ok;
    } catch {
        return false;
    }
}

async function tokenRequest(form: Record<string, string>, f: typeof fetch, failure: (status: number, text: string, requestId: string | null) => Error): Promise<TokenResponse> {
    const res = await f(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: patience(),
    });
    const text = await res.text();
    if (!res.ok) { throw failure(res.status, text, res.headers.get("x-request-id")); }
    const t = errorBody(text);
    if (!t || typeof t !== "object") { throw new Error("ChatGPT's sign-in answered with something that isn't a token."); }
    return t;
}

/** Where the login is kept: VS Code's secret storage, shared by every window. */
export interface LoginStore {
    load(): Promise<ChatGptLogin | undefined>;
    save(login: ChatGptLogin): Promise<void>;
    /** OpenAI won't renew `login`: its tokens go, unless the writer signed in again meanwhile. */
    end(login: ChatGptLogin, why: SignInNeeded): Promise<void>;
    /** Runs `fn` while no other window renews the login (see fileLock). */
    lock<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * One holder at a time across processes (VS Code windows), with a folder as the lock: making one is
 * atomic. A lock older than `staleMs` is taken over (its holder died).
 */
export function fileLock(dir: string, staleMs = 30_000): <T>(fn: () => Promise<T>) => Promise<T> {
    const lock = path.join(dir, "chatgpt-sign-in.lock");
    return async (fn) => {
        fs.mkdirSync(dir, { recursive: true });
        const started = Date.now();
        for (;;) {
            try {
                fs.mkdirSync(lock);
                break;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== "EEXIST") { throw err; }
                try {
                    if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
                } catch { continue; }
                if (Date.now() - started > staleMs + 5_000) { throw new Error("Another VS Code window is renewing Euterpe's ChatGPT sign-in: try again in a moment."); }
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        try { return await fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
    };
}

/**
 * The headers a request on the plan carries, from a login renewed shortly before it expires: one
 * renewal at a time, under the store's lock, and only if no other window renewed it meanwhile (a
 * refresh token works once). A newer login in the store (the writer signed in again) is taken up.
 */
export class ChatGptAuth {
    private renewing: Promise<ChatGptLogin> | null = null;

    constructor(private login: ChatGptLogin, private readonly store: LoginStore, private readonly f: typeof fetch = fetch) {}

    get account(): ChatGptLogin { return this.login; }

    /** `force`: the API just refused the token, fresh as it looked. */
    async headers(force = false): Promise<Record<string, string>> {
        const l = await this.current(force);
        return { Authorization: `Bearer ${l.access}` };
    }

    private async current(force: boolean): Promise<ChatGptLogin> {
        if (!force && !due(this.login)) { return this.login; }
        this.renewing ??= this.store.lock(() => this.renew(force)).finally(() => { this.renewing = null; });
        return this.renewing;
    }

    private async renew(force: boolean): Promise<ChatGptLogin> {
        const stored = await this.store.load();
        if (!stored) { throw new SignInNeeded("Euterpe isn't signed in to ChatGPT anymore."); }
        // Another window renewed it already, or the writer signed in again.
        if (stored.access !== this.login.access && !due(stored)) {
            this.login = stored;
            return stored;
        }
        if (!force && !due(stored)) { return (this.login = stored); }
        // Never before OpenAI says (earliest_refresh_at), as OpenAI's own DevKit: a token refused
        // that early was revoked, not outlived, and a renewal wouldn't bring it back.
        if (stored.earliestRefresh && Date.now() < stored.earliestRefresh) { return (this.login = stored); }
        let fresh: ChatGptLogin;
        try {
            fresh = await refreshLogin(stored, this.f);
        } catch (err) {
            // Its tokens are no use anymore: the writer signs in again (the registration stays).
            if (err instanceof SignInNeeded) { await this.store.end(stored, err); }
            throw err;
        }
        await this.store.save(fresh);
        this.login = fresh;
        return fresh;
    }
}

function due(l: ChatGptLogin): boolean {
    return l.expires - Date.now() < REFRESH_MARGIN_MS;
}

// ---------- the plan's models ----------

export interface PlanModel {
    id: string;
    name: string;
    detail: string;
    /** The efforts it takes, as listed. */
    efforts: string[];
    /** Its context window, in tokens. */
    context?: number;
}

/**
 * The model Euterpe thinks with on a plan when the writer chose none. Not the plan's first, which is
 * its frontier model (the one a plan allows least of), as Euterpe looks at every pause: its default on
 * OpenAI's API if the plan has it, else the plan's newest Sol (OpenAI's workhorse), else its first.
 */
export function planDefault(models: readonly { id: string }[]): string | undefined {
    return (models.find((m) => sameModel(m.id, OPENAI_DEFAULT_MODEL)) ?? models.find((m) => /(^|[-.])sol$/i.test(m.id)) ?? models[0])?.id;
}

/**
 * The models the writer's plan offers, in OpenAI's order: the catalog this account sees, minus models
 * made for a specialty (security work, say) rather than for writing.
 */
export async function planModels(headers: Record<string, string>, f: typeof fetch = fetch): Promise<PlanModel[]> {
    const res = await f(`${RESOURCE}/models`, { headers: { ...headers, Accept: "application/json" }, signal: patience() });
    const text = await res.text();
    if (!res.ok) { throw Object.assign(new Error(`ChatGPT didn't list your plan's models (${res.status}): ${errorMessage(text)}`), { status: res.status }); }
    const body = errorBody(text);
    if (Array.isArray(body?.data) && !Array.isArray(body?.models)) {
        return body.data.filter((m: any) => typeof m?.id === "string").map((m: any) => ({ id: m.id, name: m.id, detail: "", efforts: [] }));
    }
    const models: any[] = Array.isArray(body?.models) ? body.models : [];
    return models
        .filter((m) => typeof m?.slug === "string" && m.slug && (m.visibility === undefined || m.visibility === "list") && !m.model_specialty)
        .map((m) => ({
            id: m.slug,
            name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
            detail: typeof m.description === "string" ? m.description : "",
            efforts: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []).map((l: any) => (typeof l === "string" ? l : l?.effort)).filter((e: unknown) => typeof e === "string"),
            context: typeof m.context_window === "number" ? m.context_window : undefined,
        }));
}

// ---------- errors ----------

function errorBody(text: string): any {
    try { return JSON.parse(text); } catch { return null; }
}

/** An error's code: the precise one OpenAI's sign-in gives (`error_reason`: refresh_token_invalidated), else the OAuth one (invalid_grant). */
function errorCode(text: string): string {
    const b = errorBody(text);
    const code = b?.error_reason ?? b?.error?.code ?? b?.code ?? (typeof b?.error === "string" ? b.error : undefined);
    return typeof code === "string" ? code.toLowerCase() : "";
}

/** OpenAI's answer to a token request, for the log: its status, codes, words and request ID (never a token). */
function answer(status: number, text: string, requestId: string | null): string {
    const b = errorBody(text);
    const codes = [typeof b?.error === "string" ? b.error : b?.error?.code, b?.error_reason].filter((c) => typeof c === "string" && c).join("/");
    const words = b ? b.error_description ?? b.error?.message ?? b.message ?? b.detail : text;
    return [String(status), codes, typeof words === "string" && words ? `"${words.slice(0, 300)}"` : "", requestId ? `request ${requestId}` : ""].filter(Boolean).join(" ");
}

function errorMessage(text: string): string {
    const b = errorBody(text);
    const m = b?.error_description ?? b?.error?.message ?? b?.message ?? b?.detail ?? (typeof b?.error === "string" ? b.error : undefined);
    return (typeof m === "string" && m ? m : text).slice(0, 300);
}
