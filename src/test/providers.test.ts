import * as assert from "node:assert/strict";
import { test } from "node:test";
import { endpointFor, OPENAI_BASE_URL, PRESETS, providerFor, secretName } from "../providers";

test("the provider is Claude unless the setting says openai", () => {
    assert.equal(providerFor("openai"), "openai");
    for (const v of ["claude", "", undefined, "gemini", 3]) { assert.equal(providerFor(v), "claude", String(v)); }
});

test("an empty address is the ChatGPT plan: OpenAI's API, signed in rather than keyed", () => {
    const e = endpointFor("");
    assert.deepEqual(e, { baseURL: OPENAI_BASE_URL, origin: "https://api.openai.com", openai: false, chatgpt: true, local: false, name: "ChatGPT" });
    assert.deepEqual(endpointFor(undefined), e);
    assert.deepEqual(endpointFor("  "), e);
    assert.deepEqual(endpointFor(PRESETS[0].url), e);
    assert.ok(!endpointFor(OPENAI_BASE_URL).chatgpt, "OpenAI's API by its address: a key");
});

test("OpenAI's own API, at its own origin only", () => {
    assert.deepEqual(endpointFor(OPENAI_BASE_URL), { baseURL: OPENAI_BASE_URL, origin: "https://api.openai.com", openai: true, chatgpt: false, local: false, name: "OpenAI API" });
    assert.ok(!endpointFor("https://api.openai.com.evil.example/v1").openai);
});

test("other APIs: named when they're a preset, local when on this computer, trailing slashes dropped", () => {
    const router = endpointFor(" https://openrouter.ai/api/v1/ ");
    assert.equal(router.baseURL, "https://openrouter.ai/api/v1");
    assert.equal(router.name, "OpenRouter");
    assert.ok(!router.openai && !router.local && !router.chatgpt);
    const ollama = endpointFor("http://localhost:11434/v1");
    assert.equal(ollama.name, "Ollama");
    assert.ok(ollama.local);
    assert.ok(endpointFor("http://127.0.0.1:8080/v1").local);
    assert.ok(endpointFor("http://[::1]:8080/v1").local);
    assert.equal(endpointFor("https://my-gateway.example.com/openai/v1").name, "my-gateway.example.com");
    for (const p of PRESETS) { assert.equal(endpointFor(p.url).name, p.name); }
});

test("an address that isn't one is refused, saying why", () => {
    assert.throws(() => endpointFor("openrouter.ai"), /isn't a web address/);
    assert.throws(() => endpointFor("file:///etc/passwd"), /http or https/);
});

test("a key belongs to one origin", () => {
    assert.equal(secretName(endpointFor("https://openrouter.ai/api/v1").origin), "euterpe.apiKey:https://openrouter.ai");
    assert.notEqual(secretName(endpointFor(OPENAI_BASE_URL).origin), secretName(endpointFor("https://api.openai.com.evil.example/v1").origin));
});
