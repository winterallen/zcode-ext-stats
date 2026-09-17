"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { aggregate, readSummary } = require("../scripts/zcode-ext-stats-main.cjs");
const model = (extra = {}) => ({ status: "completed", input_tokens: 1000, output_tokens: 200,
  cache_read_input_tokens: 800, cache_creation_input_tokens: 50, computed_total_tokens: 1200,
  duration_ms: 3000, time_to_first_token_ms: 1000, first_token_at: 2000, completed_at: 4000, ...extra });

test("inclusive input: cache is not added twice and writes belong to uncached input", () => {
  const s = aggregate([model()], [{}], []);
  assert.equal(s.totalTokens, 1200); assert.equal(s.uncachedInputTokens, 200);
  assert.equal(s.cacheHitRate, 0.8); assert.equal(s.tps, 100); assert.equal(s.ttftMs, 1000);
  assert.equal(s.uncachedInputTokens + s.cacheReadTokens + s.outputTokens, s.totalTokens);
});
test("exclusive provider input normalizes to the same additive breakdown", () => {
  const s = aggregate([model({ input_tokens: 150 })], [{}], []);
  assert.equal(s.totalTokens, 1200); assert.equal(s.cacheHitRate, 0.8);
});
test("request-weighted TTFT and output/time TPS; parallel tool times sum", () => {
  const s = aggregate([model(), model({ output_tokens: 600, completed_at: 8000, duration_ms: 9000, time_to_first_token_ms: 3000 })], [{}, {}], [{ duration_ms: 1000 }, { duration_ms: 2000 }]);
  assert.equal(s.ttftMs, 2000); assert.equal(s.tps, 100);
  assert.equal(s.modelMs, 12000); assert.equal(s.toolMs, 3000);
  assert.equal(s.steps, 2); assert.equal(s.turns, 2);
});
test("missing timing is unavailable, not an invented zero or inflated speed", () => {
  const s = aggregate([model({ first_token_at: null, duration_ms: null, time_to_first_token_ms: null })], [{}], [{ status: "error", duration_ms: null }]);
  assert.equal(s.tps, null); assert.equal(s.modelMs, null); assert.equal(s.toolMs, null); assert.equal(s.ttftMs, null);
});
test("empty/zero input has no cache percentage; running state persists", () => {
  assert.equal(aggregate([], [], []).cacheHitRate, null);
  assert.equal(aggregate([], [{ status: "running" }], []).running, true);
});
test("read-only snapshots isolate sessions, survive reopening, and never accumulate twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "ztps-db-")), path = join(dir, "usage.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE model_usage (session_id TEXT, turn_id TEXT, status TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, provider_total_tokens INTEGER,
      computed_total_tokens INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER, first_token_at INTEGER, completed_at INTEGER);
      CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT);
      CREATE TABLE tool_usage (session_id TEXT, status TEXT, duration_ms INTEGER);
      INSERT INTO model_usage VALUES ('s_a','t_a','completed',1000,200,800,50,1200,1200,3000,1000,2000,4000);
      INSERT INTO model_usage VALUES ('s_b','t_b','completed',500,100,0,0,600,600,2000,1000,2000,3000);
      INSERT INTO turn_usage VALUES ('s_a','t_a','completed'),('s_b','t_b','completed');
      INSERT INTO tool_usage VALUES ('s_a','completed',200);`);
    db.close();
    const a = readSummary("s_a", path), again = readSummary("s_a", path), b = readSummary("s_b", path);
    assert.equal(a.ok, true); assert.equal(a.totalTokens, 1200); assert.equal(again.totalTokens, 1200);
    assert.equal(b.totalTokens, 600); assert.equal(a.turns, 1); assert.equal(a.toolMs, 200);
    assert.equal(readSummary("s_missing", path).reason, "no-history");
    assert.equal(readSummary("' OR 1=1 --", path).reason, "invalid-session");
    const absent = join(dir, "absent.sqlite");
    assert.equal(readSummary("s_a", absent).reason, "database-unavailable"); assert.equal(existsSync(absent), false);
    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal(check.prepare("SELECT count(*) AS n FROM model_usage").get().n, 2); check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("IPC exposes only the packaged main frame and validates session IDs", () => {
  const vm = require("node:vm");
  const { readFileSync } = require("node:fs");
  const { pathToFileURL } = require("node:url");
  let handler, registrations = 0;
  const root = join(tmpdir(), "ztps-ipc-app", "app.asar");
  const electron = { app: { getAppPath: () => root }, ipcMain: { handle(channel, callback) {
    assert.equal(channel, "zcode-patcher:session-stats:v2"); handler = callback; registrations++;
  } } };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(join(__dirname, "../scripts/zcode-ext-stats-main.cjs"), "utf8"), {
    module, console, URL, require: (name) => name === "electron" ? electron : name === "node:sqlite"
      ? { DatabaseSync: class { exec() {} prepare() { return { all: () => [] }; } close() {} } } : require(name),
  });
  module.exports.install(); module.exports.install(); assert.equal(registrations, 1);
  const frame = { url: pathToFileURL(join(root, "out/renderer/index.html")).href + "?tab=1" };
  assert.equal(handler({ senderFrame: frame, sender: { mainFrame: frame } }, "s_a").reason, "no-history");
  assert.equal(handler({ senderFrame: frame, sender: { mainFrame: frame } }, { sql: "SELECT *" }).reason, "invalid-session");
  assert.equal(handler({ senderFrame: frame, sender: { mainFrame: {} } }, "s_a").reason, "untrusted-frame");
  frame.url = "https://example.com/out/renderer/index.html";
  assert.equal(handler({ senderFrame: frame, sender: { mainFrame: frame } }, "s_a").reason, "untrusted-frame");
});

test("turn count only uses persisted turn records", () => {
  const models = [model({ turn_id: 't1' }), model({ turn_id: 't1' }), model({ turn_id: 't2' })];
  assert.equal(aggregate(models, [], []).turns, 0);
  assert.equal(aggregate(models, [{ turn_id: 't1' }], []).turns, 1);
  assert.equal(aggregate(models, [{ turn_id: 't1' }, { turn_id: 't2' }], []).turns, 2);
});

test("TPS excludes incomplete samples from both numerator and denominator, retaining all usage", () => {
  const s = aggregate([
    model({output_tokens:33438,first_token_at:1789615190355,completed_at:1789615725918}),
    model({output_tokens:339,first_token_at:1789615733094,completed_at:1789615738737}),
    model({output_tokens:15,first_token_at:null,completed_at:1789615740894}),
  ], [{}], []);
  assert.ok(Math.abs(s.tps - 62.41061629028503) < 1e-10);
  assert.equal(s.tpsValidCalls, 2); assert.equal(s.steps, 3);
  assert.equal(s.outputTokens, 33792);
});
test("TPS rejects invalid times and zero output; all invalid samples remain unavailable", () => {
  const invalid = [
    model({first_token_at:null}), model({completed_at:null}),
    model({completed_at:2000}), model({completed_at:1000}),
    model({first_token_at:NaN}), model({completed_at:Infinity}),
    model({output_tokens:0}),
  ];
  assert.equal(aggregate(invalid, [], []).tps, null);
  const s = aggregate([model(), ...invalid], [], []);
  assert.equal(s.tps, 100); assert.equal(s.tpsValidCalls, 1);
});
