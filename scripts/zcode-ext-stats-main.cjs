/* Read-only local session statistics. No conversation text or arbitrary SQL IPC. */
"use strict";
const { join } = require("node:path");
const { homedir } = require("node:os");
const CHANNEL = "zcode-patcher:session-stats:v2";
const number = (v) => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0;

function aggregate(models, turns, tools) {
  const result = {
    turns: turns.length,
    steps: models.length, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 0, totalTokens: 0,
    modelMs: 0, toolMs: 0, ttftMs: null, tps: null, tpsValidCalls: 0, cacheHitRate: null,
    running: [...models, ...turns, ...tools].some((r) => r.status === "running"),
  };
  let latency = 0, latencyCount = 0, decodeMs = 0, decodeOutput = 0;
  let modelTimeMissing = false, toolTimeMissing = false;
  for (const row of models) {
    const input = number(row.input_tokens), output = number(row.output_tokens);
    const read = number(row.cache_read_input_tokens), write = number(row.cache_creation_input_tokens);
    const total = row.provider_total_tokens ?? row.computed_total_tokens;
    // Normalize older/provider-specific records whose input excludes cache.
    let normalized = input || read + write;
    if (input > 0 && total != null &&
        Math.abs(number(total) - (input + read + write + output)) < Math.abs(number(total) - (input + output))) {
      normalized = input + read + write;
    }
    normalized = Math.max(normalized, read + write);
    result.inputTokens += normalized;
    result.outputTokens += output;
    result.cacheReadTokens += read;
    result.cacheWriteTokens += write;
    if (row.duration_ms != null) result.modelMs += number(row.duration_ms);
    else if (row.status !== "running") modelTimeMissing = true;
    if (row.time_to_first_token_ms != null) {
      latency += number(row.time_to_first_token_ms); latencyCount++;
    }
    if (output > 0) {
      const ms = row.first_token_at != null && row.completed_at != null
        ? Number(row.completed_at) - Number(row.first_token_at) : 0;
      // Exclude both tokens and time when timing is incomplete or invalid.
      if (Number.isFinite(ms) && ms > 0) {
        decodeMs += ms; decodeOutput += output; result.tpsValidCalls++;
      }
    }
  }
  for (const row of tools) {
    if (row.duration_ms != null) result.toolMs += number(row.duration_ms);
    else if (row.status !== "running") toolTimeMissing = true;
  }
  result.totalTokens = result.inputTokens + result.outputTokens;
  // Cache writes did not hit an existing cache and belong to uncached input.
  result.uncachedInputTokens = result.inputTokens - result.cacheReadTokens;
  result.cacheHitRate = result.inputTokens > 0 ? result.cacheReadTokens / result.inputTokens : null;
  result.ttftMs = latencyCount ? latency / latencyCount : null;
  result.tps = decodeMs > 0 ? decodeOutput / (decodeMs / 1000) : null;
  if (modelTimeMissing) result.modelMs = null;
  if (toolTimeMissing) result.toolMs = null;
  return result;
}

function readSummary(sessionId, dbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite")) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sessionId)) {
    return { ok: false, reason: "invalid-session" };
  }
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 150; BEGIN");
    const models = db.prepare(`SELECT status, input_tokens, output_tokens,
      cache_read_input_tokens, cache_creation_input_tokens, provider_total_tokens,
      computed_total_tokens, duration_ms, time_to_first_token_ms, first_token_at, completed_at
      FROM model_usage WHERE session_id = ?`).all(sessionId);
    const turns = db.prepare("SELECT status FROM turn_usage WHERE session_id = ?").all(sessionId);
    const tools = db.prepare("SELECT status, duration_ms FROM tool_usage WHERE session_id = ?").all(sessionId);
    db.exec("COMMIT");
    if (!models.length && !turns.length && !tools.length) return { ok: false, reason: "no-history", sessionId };
    return { ok: true, sessionId, sampledAt: Date.now(), retentionDays: 30, ...aggregate(models, turns, tools) };
  } catch {
    return { ok: false, reason: "database-unavailable", sessionId };
  } finally { if (db) db.close(); }
}

function install() {
  const { ipcMain, app } = require("electron");
  const { pathToFileURL } = require("node:url");
  const allowed = pathToFileURL(join(app.getAppPath(), "out", "renderer", "index.html"));
  if (ipcMain.__zcodePatcherStatsV2) return;
  ipcMain.__zcodePatcherStatsV2 = true;
  ipcMain.handle(CHANNEL, (event, sessionId) => {
    try {
      const frame = event.senderFrame, url = new URL(frame.url);
      if (frame !== event.sender.mainFrame || url.protocol !== allowed.protocol || url.host !== allowed.host || url.pathname !== allowed.pathname) {
        return { ok: false, reason: "untrusted-frame" };
      }
      return readSummary(sessionId);
    } catch { return { ok: false, reason: "unavailable" }; }
  });
}

module.exports = { CHANNEL, aggregate, readSummary, install };
