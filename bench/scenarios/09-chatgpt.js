// Chapter 9: Euterpe's mind on the writer's ChatGPT plan (Sign in with ChatGPT).
"use strict";

const fs = require("fs");
const { HELLO, startSession, chat } = require("./lib");

const ACCOUNT = { clientId: "app_euterpe_7Hk2Lm9Q", subject: "user-8Qm2fK", email: "writer@example.com" };
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const LOGIN = "euterpe.chatgpt.login";
/** A sign-in made earlier, good for an hour. */
const login = () => JSON.stringify({ ...ACCOUNT, access: "plan-access-0", refresh: "plan-refresh-0", expires: Date.now() + 3600_000, scopes: SCOPES });
/** The plan, set up: the provider, the registration with the account, and (unless `signedIn` is false) a sign-in. */
const plan = ({ signedIn = true, ...extra } = {}) => () => ({
    provider: "openai",
    globalState: { "chatgpt.hostId": "urn:uuid:5c1f0b1e-bench", "chatgpt.registration": { ...ACCOUNT } },
    ...(signedIn ? { secrets: { [LOGIN]: login() } } : {}),
    ...extra,
});
const BLUE_HELLO = { ...HELLO, say: "Hey you. Inky here, on your ChatGPT plan today. A benchmark post that admits the benchmark lied? I'm hooked." };

/** The writer goes through OpenAI's sign-in page (the bench's stand-in), answering it so. */
async function signInPage(t, answer = "allow") {
    const page = await t.browser.next({ url: /auth\.openai\.com/ });
    return { page, answer: () => page.answer(answer) };
}

module.exports = {
    id: "chatgpt",
    title: "9. On a ChatGPT plan",
    intro: "Euterpe's mind on the writer's ChatGPT Plus or Pro plan: signing in with ChatGPT, a session on the plan, what happens when the sign-in ends or the plan says no.",
    scenarios: [
        {
            id: "plan-first-session",
            title: "The first session on a ChatGPT plan",
            summary: "A writer who chose OpenAI and others, with the plan (the default), starts their first session: the sign-in, the session.",
            world: () => ({ provider: "openai" }),
            async run(t) {
                const first = t.mind.turn({ kind: "session_start" });
                t.run("euterpe.startSession");
                const ask = await t.modal({ text: /continue with ChatGPT first/ });
                await t.screen("sign-in-first", "Continue with ChatGPT first", "");
                ask.click("Continue with ChatGPT");
                const { answer } = await signInPage(t);
                await t.progress({ title: /continue with ChatGPT/ });
                await t.screen("waiting", "Waiting for the sign-in", "The browser opens OpenAI's sign-in page (the bench's stand-in: pick how it goes), and VS Code waits, with a way to cancel.");
                answer();
                await t.wait(1500);
                await t.screen("signed-in", "Signed in", "The page Euterpe's own sign-in server shows once the browser comes back.");
                const turn = await first;
                await t.overlay.ready();
                const answered = t.session.response();
                turn.reply(BLUE_HELLO);
                await answered;
                await t.overlay.bubble();
                await t.screen("session", "A session on the plan", "In blue rather than Claude's clay, and in Inky rather than Clawd (who stays with Claude).", { focus: "status-tooltip" });
            },
        },
        {
            id: "plan-sign-in-outcomes",
            title: "Sign-ins that don't work out",
            summary: "Sign In with ChatGPT, every way it can fail on OpenAI's side.",
            world: plan({ signedIn: false, globalState: { "chatgpt.hostId": "urn:uuid:5c1f0b1e-bench" } }),
            async run(t) {
                const attempt = async (answer, key, title, notes, expect) => {
                    t.run("euterpe.signIn");
                    const { answer: go } = await signInPage(t, answer);
                    go();
                    await t.notification({ text: expect, timeout: 20_000 });
                    await t.wait(800);
                    await t.screen(key, title, notes);
                };
                // (the first sign-in registers Euterpe: before any does, one can come back without the registration)
                await attempt("no-client", "no-client", "No registration came back", "A first sign-in registers Euterpe with the account; this one came back without it.", /registering Euterpe/);
                await attempt("deny", "denied", "The writer says no", "In VS Code, and on the page the browser comes back to.", /didn't let Euterpe sign in/);
                await attempt("error", "error", "OpenAI's sign-in fails", "", /didn't finish/);
                await attempt("no-code", "no-code", "No code came back", "", /without a code/);
                await attempt("no-plan", "no-plan", "Signed in, but not the plan's use", "The writer didn't allow the plan's use (or their plan can't): sign in again, or use an API key instead.", /didn't give Euterpe the use of your plan/);
                const n = await t.notification({ text: /didn't give Euterpe the use/, timeout: 2000 }).catch(() => null);
                void n;
            },
        },
        {
            id: "plan-sign-in-odd",
            title: "Sign-ins gone odd",
            summary: "The browser won't open; OpenAI answers without a token, or without a renewal, or with something else entirely; a callback for another sign-in.",
            world: plan({ signedIn: false, openExternalFails: true }),
            async run(t) {
                t.run("euterpe.signIn");
                await t.notification({ text: /couldn't open your browser/ });
                await t.screen("no-browser", "The browser didn't open", "");
                t.world.openExternalFails = false;
                const attempt = async (spec, key, title, expect) => {
                    t.world.spec.chatgpt = spec;
                    t.run("euterpe.signIn");
                    const p = await signInPage(t);
                    p.answer();
                    await t.notification({ text: expect, timeout: 20_000 });
                    await t.screen(key, title, "");
                };
                await attempt({ token: { noAccess: true } }, "no-access", "No access token", /no access token/);
                await attempt({ token: { noRefresh: true } }, "no-refresh", "No refresh token", /no refresh token/);
                await attempt({ token: { garbage: true } }, "garbage", "Not a token", /isn't a token/);
                t.world.spec.chatgpt = {};
                t.run("euterpe.signIn");
                const p = await signInPage(t, "wrong-state");
                p.answer();
                await t.wait(1500);
                await t.screen("wrong-state", "A callback for another sign-in", "The page the browser lands on when it comes back for a sign-in Euterpe isn't waiting for (an old tab, say). This one goes on waiting.");
                const progress = await t.progress({ title: /continue with ChatGPT/ });
                progress.cancel();
            },
        },
        {
            id: "plan-renewal-fails",
            title: "Renewals OpenAI refuses",
            summary: "Each reason a renewal of the sign-in fails, as the next session hears it; and another window that holds on to the renewal.",
            world: plan({ signedIn: false }),
            async run(t) {
                const soon = () => JSON.stringify({ ...ACCOUNT, access: "plan-access-0", refresh: "plan-refresh-0", expires: Date.now() + 60_000, scopes: SCOPES });
                for (const [mode, key, title] of [["reused", "reused", "Its renewal was used elsewhere"], ["expired", "expired", "It expired"], ["client", "client", "Its registration is gone"]]) {
                    t.world.spec.chatgpt = { refresh: mode };
                    await t.secret(LOGIN, soon());
                    t.run("euterpe.startSession");
                    const m = await t.modal({ text: /has ended/ });
                    await t.screen(key, title, "Renewing the sign-in as the session starts, OpenAI refuses: the session asks for a new one.");
                    m.close();
                    await t.wait(600);
                }
                t.world.spec.chatgpt = { refresh: "down" };
                await t.secret(LOGIN, soon());
                t.run("euterpe.startSession");
                const down = await t.notification({ text: /couldn't renew/ });
                await t.screen("down", "OpenAI's sign-in is down", "A renewal that fails for now (not for good): with no model chosen, the session can't start.");
                down.close();
                // Another VS Code window is renewing it, and doesn't let go (its lock stays fresh):
                // this one waits half a minute, then gives up. (The bench makes the half minute pass.)
                t.world.spec.chatgpt = {};
                await t.secret(LOGIN, soon());
                const lock = t.world.where("~/AppData/Roaming/Code/User/globalStorage/kevingosse.euterpe/chatgpt-sign-in.lock");
                fs.mkdirSync(lock, { recursive: true });
                const later = new Date(Date.now() + 3600_000);
                fs.utimesSync(lock, later, later);
                t.run("euterpe.startSession");
                await t.wait(1500);
                t.warp(40_000);
                await t.notification({ text: /Another VS Code window is renewing/, timeout: 20_000 });
                await t.screen("busy", "Another window is renewing it", "Two VS Code windows renewing the same sign-in at once: one waits for the other (a renewal works once), and gives up if it takes too long.");
                fs.rmSync(lock, { recursive: true, force: true });
            },
        },
        {
            id: "plan-sign-in-registration",
            title: "A sign-in for another registration, or another account",
            summary: "Euterpe is registered with the writer's account; the sign-in comes back for another app's registration, then for another account.",
            world: plan({ signedIn: false }),
            async run(t) {
                t.run("euterpe.signIn");
                const a = await signInPage(t, "other-client");
                a.answer();
                const n = await t.notification({ text: /another registration/, timeout: 20_000 });
                await t.screen("other-registration", "Another registration", "Euterpe forgets the registration that doesn't fit: the next sign-in registers it anew.");
                n.close();
                // registered with the writer's account again, and the next sign-in comes back for someone else's
                t.world.globalState["chatgpt.registration"] = { ...ACCOUNT };
                t.world.spec.chatgpt = { account: { sub: "user-someone-else", email: "partner@example.com" } };
                t.run("euterpe.signIn");
                const b = await signInPage(t);
                b.answer();
                await t.notification({ text: /another ChatGPT account/, timeout: 20_000 });
                await t.screen("other-account", "Another account", "The sign-in came back for an account Euterpe isn't registered with.");
            },
        },
        {
            id: "plan-id-token",
            title: "A sign-in that doesn't check out",
            summary: "The ID token OpenAI gives back doesn't hold up (expired, from another sign-in, signed with an unknown key, not signed by OpenAI, for another app, without an account), or can't be checked.",
            world: plan({ signedIn: false }),
            async run(t) {
                const attempt = async (spec, key, title, expect) => {
                    t.world.spec.chatgpt = spec;
                    t.run("euterpe.signIn");
                    const p = await signInPage(t);
                    p.answer();
                    await t.notification({ text: expect, timeout: 20_000 });
                    await t.screen(key, title, "");
                };
                await attempt({ token: { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } } }, "expired", "An expired ID token", /doesn't hold up \(expired\)/);
                await attempt({ token: { badNonce: true } }, "nonce", "An ID token from another sign-in", /from another sign-in/);
                await attempt({ jwks: { otherKey: true } }, "key", "Signed with a key OpenAI doesn't publish", /doesn't publish/);
                await attempt({ token: { forged: true } }, "forged", "A signature that doesn't hold", /its signature/);
                await attempt({ token: { claims: { aud: "app_someone_else" } } }, "another-app", "An ID token for another app", /meant for another app/);
                await attempt({ token: { claims: { sub: "" } } }, "no-account", "An ID token without an account", /no account/);
                await attempt({ jwks: { status: 503 } }, "no-keys", "OpenAI's keys can't be fetched", /signing keys/);
                await attempt({ token: { noIdToken: true } }, "no-id", "No ID token", /whose account/);
                await attempt({ token: { status: 400, body: { error: "invalid_grant", error_description: "The authorization code has expired." } } }, "code-expired", "The code is refused", /didn't finish \(400\)/);
            },
        },
        {
            id: "plan-sign-in-twice",
            title: "Signing in twice, and cancelling",
            summary: "Sign In with ChatGPT while a sign-in already waits in the browser; then the writer cancels it.",
            world: plan({ signedIn: false }),
            async run(t) {
                t.run("euterpe.signIn");
                await signInPage(t);
                const p = await t.progress({ title: /continue with ChatGPT/ });
                t.run("euterpe.signIn");
                await t.notification({ text: /waiting for you to sign in/ });
                await t.screen("waiting", "Already waiting", "");
                p.cancel();
                await p.done;
                await t.wait(600);
                await t.screen("cancelled", "Cancelled", "The writer cancels: nothing more is said.");
            },
        },
        {
            id: "plan-session",
            title: "A session on the plan",
            summary: "Signed in: a session, and Choose Model with the plan's own models.",
            world: plan(),
            async run(t) {
                await startSession(t, { hello: BLUE_HELLO });
                await t.screen("session", "On the plan", "The status bar, the overlay in blue, Inky.", { focus: "status-tooltip" });
                t.world.spec.network = { ...(t.world.spec.network || {}), hold: ["/models"] };
                t.run("euterpe.chooseModel");
                await t.wait(800);
                await t.screen("listing", "Listing the plan's models", "While Choose Model asks the plan for its models, the status bar says so (the bench holds the answer here).");
                t.release("network");
                const qp = await t.quickPick({ title: "Euterpe's Model" });
                await t.screen("models", "The plan's models", "Listed from the plan (the bench's catalog), with OpenAI's names and descriptions; models made for a specialty are left out.");
                qp.hide();
            },
        },
        {
            id: "plan-no-models",
            title: "A plan with no models, or none listed",
            summary: "The plan offers Euterpe no models; then the plan's models can't be listed.",
            world: plan({ chatgpt: { models: [] } }),
            async run(t) {
                t.run("euterpe.startSession");
                const n = await t.notification({ text: /offers Euterpe no models/ });
                await t.screen("none", "No models", "With a way to Euterpe's settings.");
                n.close();
                t.world.spec.chatgpt = { models: { status: 500, body: { detail: "Internal server error" } } };
                t.run("euterpe.startSession");
                await t.notification({ text: /didn't list your plan's models/ });
                await t.screen("unlisted", "The models can't be listed", "Without a model chosen, Euterpe can't pick one.");
            },
        },
        {
            id: "plan-usage-limit",
            title: "The plan's usage limit",
            summary: "The plan's usage limit (or the one the writer set for Euterpe) is reached mid-session.",
            world: plan(),
            async run(t) {
                await startSession(t, { hello: BLUE_HELLO });
                await t.overlay.do("openChat");
                await chat(t, "Read the last paragraph again?", { error: { status: 429, code: "subscription_sharing_usage_limit_exceeded", message: "You've reached your usage limit." } }, { open: false });
                const n = await t.notification({ text: /usage limit/ });
                await t.screen("limit", "A usage limit", "In the chat, and once a session in VS Code, with the way to ChatGPT's usage settings.");
                n.click("Manage Usage");
                await t.browser.next();
                await t.screen("manage", "Manage Usage", "ChatGPT's usage settings, in the browser.");
            },
        },
        {
            id: "plan-signed-out",
            title: "The sign-in ends mid-session",
            summary: "OpenAI won't renew the sign-in (as of October 2026, one made on a browser login from before a change to the account's security): the session waits for a new one.",
            world: plan(),
            async run(t) {
                await startSession(t, { hello: BLUE_HELLO });
                t.world.spec.chatgpt = { refresh: "invalidated" };
                t.warp(3600_000);
                await t.type(" One more sentence.", { at: "end" });
                const n = await t.notification({ text: /Continue with ChatGPT to go on/, timeout: 30_000 });
                await t.wait(800);
                await t.screen("ended", "The sign-in has ended", "A notice in VS Code (it slips into the notification center), the status bar item asking for a sign-in, and a line in the chat.", { focus: "status-tooltip" });
                await t.overlay.do("openChat");
                await t.overlay.do("type", "Are you there?");
                await t.overlay.chat("answers once you continue");
                await t.screen("waiting", "Euterpe waits", "What the writer says meanwhile waits too, and VS Code asks again.");
                t.world.spec.chatgpt = { refresh: "ok" };
                n.click("Continue with ChatGPT");
                const p = await signInPage(t);
                await t.screen("fresh-login", "Log in again", "This sign-in asks the writer to log in to OpenAI again (prompt=login, in the stand-in's small print), so the next one lasts.");
                const answered = t.session.response();
                p.answer();
                await answered;
                await t.wait(1500);
                await t.screen("back", "Back", "Signed in again: the turns that waited go, and the status bar is back to normal.", { focus: "status-tooltip" });
            },
        },
        {
            id: "plan-signed-out-elsewhere",
            title: "Signed out in another window",
            summary: "The writer signed out of ChatGPT in another VS Code window: the session finds out when the sign-in next needs renewing, and waits for a new one.",
            world: plan(),
            async run(t) {
                await startSession(t, { hello: BLUE_HELLO });
                await t.secret(LOGIN, null);
                t.warp(3600_000);
                await t.type(" One more sentence.", { at: "end" });
                await t.notification({ text: /isn't signed in to ChatGPT anymore/, timeout: 30_000 });
                await t.wait(800);
                await t.screen("gone", "No sign-in anymore", "", { focus: "status-tooltip" });
            },
        },
        {
            id: "plan-ended-at-start",
            title: "A sign-in that ended, at the next session",
            summary: "The sign-in ended while VS Code was closed: the next session asks for a new one, and says why.",
            world: () => ({
                provider: "openai",
                globalState: { "chatgpt.hostId": "urn:uuid:5c1f0b1e-bench", "chatgpt.registration": { ...ACCOUNT } },
                secrets: { [LOGIN]: JSON.stringify({ ...ACCOUNT, ended: "Euterpe's ChatGPT sign-in has ended: OpenAI didn't renew it, and asks you to log in again.", freshLogin: true, at: Date.now() - 86400_000 }) },
            }),
            async run(t) {
                t.run("euterpe.startSession");
                await t.modal({ text: /has ended/ });
                await t.screen("ask", "The sign-in has ended", "Why, then how to go on.");
            },
        },
        {
            id: "plan-refused",
            title: "When the plan says no",
            summary: "The plan's own refusals: an account whose plan can't be used in other apps, a permission ChatGPT doesn't accept, usage it can't check.",
            world: plan(),
            async run(t) {
                const refused = async (error, expect, key, title, notes) => {
                    const first = t.mind.turn({ kind: "session_start" });
                    t.run("euterpe.startSession");
                    const turn = await first;
                    await t.overlay.ready();
                    const ended = t.session.ended();
                    turn.reply({ error });
                    await t.notification({ text: expect });
                    await ended;
                    await t.screen(key, title, notes);
                };
                await refused({ status: 403, code: "subscription_sharing_user_not_eligible", message: "This account isn't eligible." }, /can't use its plan in other apps/, "not-eligible", "Not eligible", "Every turn would fail: the session ends.");
                await refused({ status: 403, code: "chatpass_v2_scope_not_authorized", message: "Scope not authorized." }, /didn't accept Euterpe's permission/, "not-authorized", "Permission not accepted", "");
                await startSession(t, { hello: BLUE_HELLO });
                await t.overlay.do("openChat");
                await chat(t, "Still there?", { error: { status: 503, code: "subscription_sharing_usage_unavailable", message: "Usage unavailable." } }, { open: false });
                await t.overlay.chat("couldn't check");
                await t.screen("unavailable", "Usage can't be checked", "A passing problem: Euterpe tries again at its next look.");
                await chat(t, "And now?", { cutStream: true }, { open: false });
                await t.overlay.chat("cut off", 30_000);
                await t.screen("cut-off", "An answer cut off", "The plan's stream ended before its last event.");
                await chat(t, "Once more?", { streamFail: true }, { open: false });
                await t.overlay.chat("had trouble answering", 30_000);
                await t.screen("stream-failed", "An answer that failed", "The stream said it failed, without saying why.");
                await chat(t, "Last try?", { error: { status: 401, message: "Your authentication token has expired." } }, { open: false });
                await t.notification({ text: /refused Euterpe's sign-in/, timeout: 30_000 });
                await t.screen("refused", "ChatGPT refuses the sign-in", "Even after a renewal: the session waits for a new sign-in.", { focus: "status-tooltip" });
            },
        },
        {
            id: "plan-sign-out",
            title: "Signing out of ChatGPT",
            summary: "Sign Out of ChatGPT: when OpenAI confirms, when it can't be reached, and when there's no sign-in.",
            world: plan({ chatgpt: { revoke: "fail" } }),
            async run(t) {
                t.run("euterpe.signOut");
                const m = await t.modal({ text: /Sign Euterpe out/ });
                await t.screen("ask", "Sign out?", "");
                m.click("Sign Out");
                await t.notification({ text: /couldn't confirm/ });
                await t.screen("unconfirmed", "Not confirmed", "Euterpe forgot its sign-in, but OpenAI didn't confirm it ended there: the way to disconnect Euterpe in ChatGPT's settings.");
                t.run("euterpe.signOut");
                await t.notification({ text: /isn't signed in/ });
                await t.screen("not-signed-in", "Not signed in", "");
            },
        },
        {
            id: "plan-api-key",
            title: "Set API Key, on the plan",
            summary: "Set API Key… when Euterpe is on the plan, which has a sign-in rather than a key.",
            world: plan(),
            async run(t) {
                t.run("euterpe.setApiKey");
                const n = await t.notification({ text: /no API key/ });
                await t.screen("signed-in", "No key on the plan", "Signed in: the way to sign out.");
                n.click("Sign Out");
                const m = await t.modal({ text: /Sign Euterpe out/ });
                m.click("Sign Out");
                await t.wait(800);
                t.run("euterpe.setApiKey");
                await t.notification({ text: /continue with ChatGPT instead/ });
                await t.screen("signed-out", "No key, and no sign-in", "The way to sign in.");
            },
        },
        {
            id: "plan-models-signed-out",
            title: "Choose Model, signed out",
            summary: "Choose Model on the plan, with nobody signed in.",
            world: plan({ signedIn: false }),
            async run(t) {
                t.run("euterpe.chooseModel");
                await t.notification({ text: /Sign in with ChatGPT to see/ });
                await t.screen("error", "Sign in first", "");
            },
        },
    ],
};
