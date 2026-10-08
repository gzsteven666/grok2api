import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Use the installed compiler so the tests also run on the project's Node 20 CI.
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
vm.runInNewContext(compile("../src/cost-controls.ts"), { exports, Response, Request, URL, Date });
const { createGenerationBudget, limitRequest } = exports;

test("connection budget does not reset across start/stop cycles", () => {
  const budget = createGenerationBudget(() => 0);
  assert.equal(budget.begin(), true);
  assert.equal(budget.begin(), false);
  for (let i = 0; i < 10; i++) assert.equal(budget.nextBatch(), 60_000);
  assert.equal(budget.nextBatch(), 0);
  budget.finish();
  assert.equal(budget.begin(), false);
});

test("stopping does not replenish rounds and the deadline limits the final call", () => {
  let now = 0;
  const budget = createGenerationBudget(() => now);
  assert.equal(budget.begin(), true);
  assert.equal(budget.nextBatch(), 60_000);
  budget.finish();
  now = 100_000;
  assert.equal(budget.begin(), true);
  assert.equal(budget.nextBatch(), 20_000);
  now = 111_000;
  assert.equal(budget.nextBatch(), 0);
  budget.finish();
  assert.equal(budget.begin(), false);
});

test("login limiter is selected before API/database work", async () => {
  let called = 0;
  const binding = { async limit({ key }) { assert.equal(key, "192.0.2.1"); called++; return { success: false }; } };
  for (const path of ["/api/login", "/api/v1/admin/login"]) {
    const response = await limitRequest(new Request(`https://test${path}`, {
      method: "POST", headers: { "CF-Connecting-IP": "192.0.2.1" },
    }), { LOGIN_RATE_LIMIT: binding });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
  }
  assert.equal(called, 2);
});

test("all API verbs and WebSocket handshakes use the API limiter", async () => {
  for (const path of ["/api/v1/admin/imagine/ws", "/v1/chat/completions", "/api/settings"]) {
    const result = await limitRequest(new Request(`https://test${path}`), {
      API_RATE_LIMIT: { async limit() { return { success: false }; } },
    });
    assert.equal(result.status, 429);
  }
});

test("missing or failed native bindings fail closed; successful reads continue", async () => {
  const request = new Request("https://test/login");
  assert.equal((await limitRequest(request, {})).status, 503);
  assert.equal((await limitRequest(request, { READ_RATE_LIMIT: { async limit() { throw new Error("offline"); } } })).status, 503);
  assert.equal(await limitRequest(request, { READ_RATE_LIMIT: { async limit() { return { success: true }; } } }), null);
});

test("scheduled cleanup cannot exceed 500 deletes even with an oversized configured batch", async () => {
  const result = {};
  let deleted = 0;
  let pages = 0;
  vm.runInNewContext(compile("../src/kv/cleanup.ts"), {
    exports: result,
    require(name) {
      if (name.includes("time")) return { nowMs: () => 0 };
      return {
        async listOldestRows(db, type, until, batch) {
          pages++; assert.equal(batch, 50);
          return Array.from({ length: batch }, (_, i) => ({ key: `${pages}:${i}` }));
        },
        async deleteCacheRows() {},
      };
    },
  });
  const response = await result.runKvDailyClear({ KV_CLEANUP_BATCH: "99999", DB: {}, KV_CACHE: {
    async delete() { deleted++; },
  } });
  assert.equal(deleted, 500);
  assert.equal(response.deleted, 500);
  assert.equal(pages, 10);
});

function websocketHarness(select, generate) {
  const code = compile("../src/routes/admin.ts");
  const marker = 'exports.adminRoutes.get("/api/v1/admin/imagine/ws", ';
  const start = code.indexOf(marker) + marker.length;
  const end = code.indexOf('exports.adminRoutes.get("/api/v1/admin/tokens"', start);
  assert.ok(start >= marker.length && end > start);
  const callback = code.slice(start, end).trim().replace(/\);$/, "");
  const server = { handlers: {}, sent: [], accept() {}, close() {},
    send(data) { this.sent.push(JSON.parse(data)); },
    addEventListener(name, listener) { this.handlers[name] = listener; },
  };
  const route = vm.runInNewContext(`(${callback})`, {
    WebSocketPair: class { constructor() { return { 0: {}, 1: server }; } },
    Response: class { constructor(body, init) { Object.assign(this, init); } },
    verifyWsApiKeyForImagine: async () => true,
    settings_1: { getSettings: async () => ({ grok: {} }), normalizeCfCookie: () => "" },
    cost_controls_1: { createGenerationBudget },
    tokens_1: { selectBestToken: select },
    imagineExperimental_1: { generateImagineWs: generate, resolveAspectRatio: () => "2:3" },
    encodeAssetPath: value => value,
    parseWsMessageData: JSON.parse,
    wsSleep: async () => {},
    crypto: { randomUUID: () => "test-run" }, Date, encodeURIComponent,
  });
  return { server, route, message(type) { server.handlers.message({ data: JSON.stringify({ type, prompt: "test" }) }); } };
}

test("actual websocket handler stops after 10 batches and cannot reset its connection budget", async () => {
  let calls = 0;
  const harness = websocketHarness(async () => ({ token: "fixture", token_type: "sso" }), async ({ timeoutMs }) => {
    assert.ok(timeoutMs <= 60_000); calls++; return ["test.png"];
  });
  await harness.route({ req: { header: () => "websocket" }, env: { DB: {} } });
  harness.message("start");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 10);
  harness.message("start");
  assert.equal(harness.server.sent.at(-1).code, "rate_limit_exceeded");
  assert.equal(calls, 10);
});

test("actual websocket handler rejects overlapping starts, including stop/start while upstream is pending", async () => {
  let calls = 0;
  let finish;
  const harness = websocketHarness(async () => ({ token: "fixture", token_type: "sso" }), async () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  });
  await harness.route({ req: { header: () => "websocket" }, env: { DB: {} } });
  harness.message("start");
  await new Promise(resolve => setImmediate(resolve));
  harness.message("start");
  assert.equal(harness.server.sent.at(-1).code, "rate_limit_exceeded");
  harness.message("stop");
  harness.message("start");
  assert.equal(harness.server.sent.at(-1).code, "rate_limit_exceeded");
  assert.equal(calls, 1);
  finish([]);
  await new Promise(resolve => setImmediate(resolve));
});

test("actual websocket handler does not poll endlessly when no token is available", async () => {
  let lookups = 0;
  const harness = websocketHarness(async () => { lookups++; return null; }, async () => {
    throw new Error("must not generate");
  });
  await harness.route({ req: { header: () => "websocket" }, env: { DB: {} } });
  harness.message("start");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, 1);
  assert.equal(harness.server.sent.at(-1).status, "stopped");
});
