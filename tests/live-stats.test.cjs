const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createZcodeLiveTracker } = require("../scripts/zcode-ext-stats.js");

function setup() {
  let time = 10000, seq = 0, eventSeq = 0;
  const tracker = createZcodeLiveTracker(() => time);
  const event = (kind, extra = {}) => tracker.accept({ version: 1, sessionId: "a", turnId: "t", sourceCommandId: "c",
    eventId: `e${++eventSeq}`, occurredAt: time, kind, ...extra });
  const rows = (deltas, extra = {}) => {
    const frame = { topic: "conversation/a", frame: { logEpoch: "epoch", toSeq: ++seq, payload: { kind: "deltas", deltas } }, ...extra };
    tracker.accept(frame); return frame;
  };
  event("turn.started"); event("model.request.status", { status: "model_request_started", requestId: "r" });
  rows([{ kind: "turnHeader", rowId: "h", turnId: "product-t", sourceCommandId: "c", state: "running" },
    { kind: "assistantText", rowId: "text", turnId: "product-t", assistantResponseId: "response", text: "", state: "streaming" }]);
  event("stream.chunk", { assistantMessageId: "response", chunkLength: 99999 });
  return { tracker, event, rows, advance: (ms) => time += ms,
    append: (text = "字".repeat(100)) => rows([{ op: "row.delta", rowId: "text", path: "text", append: text }]),
    view: () => tracker.view("a") };
}

test("one second warm-up, 4s window, and a constant 100 token/s stream", () => {
  const h = setup(); assert.equal(h.view().phase, "waiting");
  h.append(); assert.equal(h.view().phase, "sampling");
  assert.equal(h.view().readyAt, 11000);
  h.advance(500); assert.equal(h.view().phase, "sampling");
  h.advance(500); h.append(); assert.equal(h.view().tps, 100);
  for (let i = 0; i < 8; i++) { h.advance(1000); h.append(); assert.equal(h.view().tps, 100); }
  for (let i = 0; i < 4; i++) { h.advance(1000); h.append("字".repeat(200)); }
  assert.equal(h.view().tps, 200);
});
test("small English deltas preserve fractional tokens instead of rounding to zero", () => {
  const h = setup(); h.append("a");
  for (let i = 0; i < 40; i++) { h.advance(100); h.append("a"); }
  assert.equal(h.view().tps, 2.5);
});
test("inactivity waits; tools do not keep the last speed; finish returns idle", () => {
  const h = setup(); h.append(); h.advance(1000); h.append();
  h.advance(2000); assert.equal(h.view().phase, "waiting");
  h.event("tool.lifecycle", { phase: "started", toolCallId: "tool1" });
  h.event("tool.lifecycle", { phase: "started", toolCallId: "tool2" });
  assert.equal(h.view().phase, "tool");
  h.event("tool.lifecycle", { phase: "completed", toolCallId: "tool1" }); assert.equal(h.view().phase, "tool");
  h.event("tool.lifecycle", { phase: "failed", toolCallId: "tool2" }); assert.equal(h.view().phase, "waiting");
  h.event("turn.terminal", { status: "interrupted" }); assert.equal(h.view().phase, "idle");
  h.append(); assert.equal(h.view().phase, "idle");
});
test("duplicate transport frames and full-text upserts do not count twice", () => {
  const h = setup(); h.append(); h.advance(1000);
  const frame = h.append(); h.tracker.accept(frame); assert.equal(h.view().tps, 100);
  h.rows([{ kind: "assistantText", rowId: "text", turnId: "product-t", text: "字".repeat(200) }]);
  assert.equal(h.view().tps, 100);
});
test("snapshots and chunkLength never become estimated token output", () => {
  const h = setup(); h.advance(1000);
  assert.equal(h.view().phase, "waiting");
  h.tracker.accept({ topic: "conversation/a", frame: { payload: { kind: "snapshot", snapshot: { rows: [
    { kind: "assistantText", rowId: "text", turnId: "product-t", text: "字".repeat(50000) },
  ] } } } });
  assert.equal(h.view().phase, "waiting");
  h.append(); h.advance(1000); h.append(); assert.equal(h.view().tps, 100);
});
test("sessions are isolated and historical telemetry is rejected", () => {
  const h = setup(); h.append(); h.advance(1000); h.append();
  h.event("turn.started", { sessionId: "b" });
  assert.equal(h.tracker.view("b").phase, "waiting"); assert.equal(h.view().tps, 100);
  h.event("turn.started", { sessionId: "old", occurredAt: 1 }); assert.equal(h.tracker.view("old"), null);
});
test("retry clears the window and excludes delayed output from the previous attempt", () => {
  const h = setup(); h.append(); h.advance(1000); h.append();
  h.event("model.request.status", { status: "model_request_started", requestId: "retry" });
  h.append(); assert.equal(h.view().phase, "waiting");
  h.rows([{ kind: "assistantText", rowId: "new", turnId: "product-t", text: "" }]);
  h.rows([{ op: "row.delta", rowId: "new", path: "text", append: "字".repeat(30) }]);
  h.advance(1000); h.rows([{ op: "row.delta", rowId: "new", path: "text", append: "字".repeat(30) }]);
  assert.equal(h.view().tps, 30);
});
test("reused turn ID and duplicate start event do not resurrect old stats", () => {
  const h = setup(); h.append(); h.advance(1000); h.append();
  h.event("turn.terminal");
  const start = { version: 1, sessionId: "a", turnId: "t", sourceCommandId: "new-command", kind: "turn.started", occurredAt: 11000, eventId: "unique" };
  h.tracker.accept(start); assert.equal(h.view().phase, "waiting");
  h.append(); assert.equal(h.view().phase, "waiting");
  h.event("turn.terminal", { sourceCommandId: "new-command" });
  h.tracker.accept(start); assert.equal(h.view().phase, "idle");
});
test("stalled streams can resume; usage completion stops live estimates", () => {
  const h = setup(); h.append(); h.advance(1000); h.append();
  h.event("model.request.status", { status: "model_stream_stalled", requestId: "r" });
  assert.equal(h.view().phase, "waiting");
  h.append(); h.advance(1000); h.append(); assert.equal(h.view().tps, 100);
  h.event("usage.delta", { requestId: "r" });
  assert.equal(h.view().phase, "waiting");
});

test("network completion before body streaming must not disable live output", () => {
  const h = setup();
  h.event("model.request.status", { status: "model_request_completed", requestId: "r" });
  h.event("stream.chunk", { assistantMessageId: "response" }); h.append();
  h.advance(1000); h.event("stream.chunk", { assistantMessageId: "response" }); h.append();
  assert.equal(h.view().tps, 100);
});

test("a row arriving before model start can bind to the fresh streaming response", () => {
  const h = setup();
  h.rows([{ kind: "assistantText", rowId: "early", turnId: "product-t", assistantResponseId: "next-response", text: "" }]);
  h.event("model.request.status", { status: "model_request_started", requestId: "next-request" });
  h.event("stream.chunk", { assistantMessageId: "next-response" });
  h.rows([{ op: "row.delta", rowId: "early", path: "text", append: "字".repeat(30) }]);
  h.advance(1000);
  h.rows([{ op: "row.delta", rowId: "early", path: "text", append: "字".repeat(30) }]);
  assert.equal(h.view().tps, 30);
});

test("late rows from a previous response cannot bind to a new streaming response", () => {
  const h = setup(); h.append(); h.advance(1000); h.append();
  h.event("model.request.status", { status: "model_request_started", requestId: "next-request" });
  h.event("stream.chunk", { assistantMessageId: "different-response" });
  h.append(); h.advance(1000); h.append();
  assert.equal(h.view().phase, "waiting");
});

test("3.12.2 snapshot rows.window and numeric row zero seed live deltas", () => {
  const h = setup();
  h.tracker.accept({ topic: "conversation/a", frame: { payload: { kind: "snapshot", snapshot: { rows: {
    window: [{ kind: "assistantText", rowId: 0, assistantResponseId: "response", text: "historical baseline" }],
    totalCount: 1, firstRowId: 0,
  } } } } });
  assert.equal(h.view().phase, "waiting");
  h.rows([{ op: "row.delta", rowId: 0, path: "text", append: "字".repeat(100) }]);
  assert.equal(h.view().phase, "sampling");
  h.advance(1000);
  h.rows([{ op: "row.delta", rowId: 0, path: "text", append: "字".repeat(100) }]);
  assert.equal(h.view().tps, 100);
});
