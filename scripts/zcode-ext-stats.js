/** Independent live estimator. Persisted token totals are never modified here. */
function createZcodeLiveTracker(clock = Date.now) {
  const sessions = new Map(), frames = new Map();
  const estimate = (value) => {
    let tokens = 0;
    for (const char of value) tokens += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char) ? 1 : 0.25;
    return tokens;
  };
  const clear = (s) => { s.samples = []; s.firstAt = null; s.lastTextAt = null; };
  function get(id) {
    if (!sessions.has(id)) {
      if (sessions.size >= 50) sessions.delete(sessions.keys().next().value);
      sessions.set(id, { active: false, known: false, command: null, turn: null,
        request: null, requestDone: false, response: null, epoch: 0, tools: new Set(),
        rows: new Map(), commands: new Map(), seen: new Set(), samples: [], firstAt: null, lastTextAt: null });
    }
    return sessions.get(id);
  }
  function add(s, tokens) {
    if (!s.active || s.requestDone || s.tools.size || tokens <= 0) return;
    const now = clock();
    // The first batch establishes a time baseline; it has no measurable duration.
    if (s.firstAt == null) { s.firstAt = now; s.lastTextAt = now; return; }
    s.lastTextAt = now;
    // Bound memory independently of streaming frequency; retain at most 4 seconds.
    const last = s.samples.at(-1);
    if (last && last.at === now) last.tokens += tokens;
    else s.samples.push({ at: now, tokens });
    while (s.samples.length && s.samples[0].at <= now - 4000) s.samples.shift();
  }
  function event(e) {
    if (e?.version !== 1 || !e.sessionId) return false;
    const now = clock();
    // Replayed historical telemetry must never become live traffic.
    if (!Number.isFinite(e.occurredAt) || now - e.occurredAt > 5000 || e.occurredAt - now > 5000) return false;
    const s = get(e.sessionId);
    if (e.eventId) {
      if (s.seen.has(e.eventId)) return false;
      s.seen.add(e.eventId);
      if (s.seen.size > 2048) s.seen.delete(s.seen.values().next().value);
    }
    if (e.kind === "turn.started") {
      s.known = true; s.active = true; s.command = e.sourceCommandId ?? null; s.turn = e.turnId ?? null;
      s.request = null; s.response = null; s.requestDone = false; s.epoch++;
      s.tools.clear(); clear(s); return true;
    }
    if ((s.command && e.sourceCommandId && s.command !== e.sourceCommandId) ||
        (s.turn && e.turnId && s.turn !== e.turnId)) return false;
    if (e.kind === "turn.terminal") {
      s.known = true; s.active = false; s.tools.clear(); clear(s); return true;
    }
    // Attach mid-generation only on fresh positive activity, never on old rows.
    if (!s.known && (e.kind === "stream.chunk" || e.kind === "model.request.status" || e.kind === "tool.lifecycle")) {
      s.known = true; s.active = true; s.command = e.sourceCommandId ?? null; s.turn = e.turnId ?? null;
    }
    if (!s.active) return false;
    if (e.kind === "model.request.status") {
      if (e.status === "model_request_started") {
        s.request = e.requestId; s.response = null; s.requestDone = false; s.epoch++; clear(s);
      } else if (e.status === "model_stream_stalled" && (!s.request || s.request === e.requestId)) {
        clear(s);
      } else if (["model_request_failed", "model_retry_scheduled"].includes(e.status) && (!s.request || s.request === e.requestId)) {
        s.requestDone = true; clear(s);
      }
      // Transport completion does not prove that response-body streaming ended.
      // Wait for usage.delta/turn.terminal instead of rejecting subsequent text.
      return true;
    }
    if (e.kind === "usage.delta") {
      if (!s.request || !e.requestId || s.request === e.requestId) { s.requestDone = true; clear(s); }
      return true;
    }
    if (e.kind === "stream.chunk") {
      if (s.requestDone) return false;
      if (e.assistantMessageId) s.response = e.assistantMessageId;
      // chunkLength is not tokens: use only conversation text increments below.
      return true;
    }
    if (e.kind === "tool.lifecycle") {
      if (["started", "progress"].includes(e.phase)) { s.tools.add(e.toolCallId); clear(s); }
      else if (e.phase === "scheduled") clear(s);
      else s.tools.delete(e.toolCallId);
      return true;
    }
    return false;
  }
  function row(id, value, snapshot = false) {
    if (!id || !value) return;
    const s = get(id), key = value.rowId;
    if (value.kind === "turnHeader" && value.turnId && value.sourceCommandId) {
      s.commands.set(value.turnId, value.sourceCommandId);
      if (s.commands.size > 200) s.commands.delete(s.commands.keys().next().value);
      if (s.command === value.sourceCommandId && /^(completed|failed|stopped|cancelled)/.test(value.state ?? "")) {
        s.active = false; s.known = true; s.tools.clear(); clear(s);
      }
    }
    if (key == null) return;
    const previous = s.rows.get(key);
    if (value.op === "row.delta") {
      if (value.path !== "text" || typeof value.append !== "string" || !previous) return;
      const increment = estimate(value.append);
      previous.tokens += increment;
      if (!snapshot && bindsToRequest(s, previous)) add(s, increment);
      return;
    }
    if (!["assistantText", "reasoning"].includes(value.kind) || typeof value.text !== "string") return;
    const tokens = estimate(value.text), command = value.sourceCommandId ?? s.commands.get(value.turnId);
    const entry = { tokens, command: command ?? previous?.command,
      response: value.assistantResponseId ?? previous?.response, epoch: s.epoch };
    s.rows.set(key, entry);
    if (s.rows.size > 2000) s.rows.delete(s.rows.keys().next().value);
    // A first full row/snapshot is a baseline, not newly generated output.
    if (!snapshot && previous && bindsToRequest(s, previous) && bindsToRequest(s, entry)) add(s, Math.max(0, tokens - previous.tokens));
  }
  function bindsToRequest(s, entry) {
    if ((entry.command && s.command && entry.command !== s.command) ||
        (entry.response && s.response && entry.response !== s.response)) return false;
    if (entry.epoch === s.epoch) return true;
    // Product rows may be created before model_request_started. A fresh chunk's
    // response ID proves ownership even when the row carries an earlier epoch.
    if (s.response && entry.response === s.response) { entry.epoch = s.epoch; return true; }
    return false;
  }
  function accept(message) {
    if (!message || typeof message !== "object") return false;
    if (message.version === 1) return event(message);
    const frame = message.frame ?? message;
    const payload = frame.payload;
    if (!payload) return false;
    const topic = message.topic ?? frame.topic;
    const id = frame.sessionId ?? payload.sessionId ?? payload.snapshot?.sessionId ??
      (typeof topic === "string" && topic.startsWith("conversation/") ? topic.slice(13) : null);
    if (Number.isFinite(frame.toSeq) && id) {
      const key = `${id}:${frame.logEpoch ?? ""}:${topic ?? ""}`;
      if (frames.has(key) && frames.get(key) >= frame.toSeq) return false;
      frames.set(key, frame.toSeq);
      if (frames.size > 256) frames.delete(frames.keys().next().value);
    }
    const snapshot = payload.kind === "snapshot";
    const snapshotRows = payload.snapshot?.rows;
    const rows = snapshot ? snapshotRows?.window ?? snapshotRows : payload.deltas ?? payload.events;
    for (const item of Array.isArray(rows) ? rows : Object.values(rows ?? {})) {
      if (item.version === 1) event(item);
      else row(id ?? item.sessionId ?? item.row?.sessionId, item.row ?? item, snapshot);
    }
    return true;
  }
  function view(id) {
    const s = sessions.get(id);
    if (!s?.known) return null;
    if (!s.active) return { phase: "idle" };
    if (s.tools.size) return { phase: "tool" };
    const now = clock();
    if (s.firstAt == null || now - s.lastTextAt >= 2000 || s.requestDone) return { phase: "waiting" };
    if (now - s.firstAt < 1000) return { phase: "sampling", readyAt: s.firstAt + 1000 };
    while (s.samples.length && s.samples[0].at <= now - 4000) s.samples.shift();
    const seconds = Math.min(4000, now - s.firstAt) / 1000;
    return { phase: "streaming", tps: s.samples.reduce((sum, x) => sum + x.tokens, 0) / seconds };
  }
  return { accept, view };
}

/** ZCode session statistics: persisted averages plus a separate live footer. */
(() => {
  "use strict";
  if (typeof window === "undefined") { module.exports = { createZcodeLiveTracker }; return; }
  if (window.__ztps) return;
  window.__ztps = true;
  const bridge = window.zcodeSessionStats;
  const live = createZcodeLiveTracker();
  const decoder = new TextDecoder(), ports = new WeakSet();
  function hookPort(port) {
    if (!port || ports.has(port)) return;
    ports.add(port);
    port.addEventListener("message", (e) => {
      try {
        let value = e.data;
        if (value instanceof ArrayBuffer) value = new Uint8Array(value);
        if (ArrayBuffer.isView(value)) {
          const text = decoder.decode(value), start = text.indexOf("{");
          if (start < 0) return;
          value = JSON.parse(text.slice(start));
        }
        if (live.accept(value)) {
          if (value?.kind === "turn.terminal") lastRead = 0;
          render(); // State transitions are immediate; numerical TPS remains throttled.
        }
      } catch { /* Ignore unrelated or unsupported frames; never affect the host. */ }
    });
    // Observe only. The client starts the port after attaching its RPC handlers.
    // Starting it here can drain the queued initialization handshake too early.
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    // 3.12.2 sends the main port as { type, ...metadata }; older builds used a string.
    const type = typeof e.data === "string" ? e.data : e.data?.type;
    if (type === "zcode:service-port" || type === "zcode:scoped-service-port") {
      for (const port of e.ports ?? []) hookPort(port);
    }
  }, true);
  const ns = "http://www.w3.org/2000/svg";
  let host = null, popup = null, activeButton = null, activeKind = null;
  let sessionId = null, data = null, generation = 0, pending = false, lastRead = 0;
  let hasModelUsage = false;
  let scheduled = false;
  let liveSession = null, liveView = null, lastLiveRender = 0;
  let liveWarmupTimer = null;
  const full = (n) => Math.round(n).toLocaleString("en-US");
  const compact = (n) => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : full(n);
  const speed = (n) => n == null ? "—" : `${+n.toFixed(1)} tok/s`;
  const percent = (n) => n == null ? "—" : `${Math.round(n * 100)}%`;
  const duration = (ms) => {
    if (ms == null) return "—";
    const s = Math.round(ms / 1000);
    if (s >= 3600) return `${Math.floor(s / 3600)}小时${Math.floor(s % 3600 / 60)}分${s % 60}秒`;
    if (s >= 60) return `${Math.floor(s / 60)}分${s % 60}秒`;
    return `${+(ms / 1000).toFixed(1)}秒`;
  };
  function icon(kind) {
    const svg = document.createElementNS(ns, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
    const paths = kind === "usage"
      ? ["M20 6c0 2.2-16 2.2-16 0s16-2.2 16 0Z", "M4 6v12c0 4 16 4 16 0V6", "M4 12c0 4 16 4 16 0"]
      : ["M4 18a9 9 0 1 1 16 0", "m12 13 4-5", "M12 13h.01", "M5 10l1.5.8", "M12 4v2"];
    for (const d of paths) { const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); svg.append(p); }
    return svg;
  }
  function text(node, value) { if (node.textContent !== value) node.textContent = value; }
  function visible(el) { return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"; }
  function locate() {
    const input = [...document.querySelectorAll('[data-testid="v4-composer-input"]')].find(visible);
    if (!input) return null;
    const form = input.closest("form");
    const card = form ? form.parentElement : input.parentElement;
    if (!card) return null;
    const row = [...card.querySelectorAll("div")].find((el) =>
      !el.hasAttribute("data-ztps-bar") && /(?:^|\s)items-end(?:\s|$)/.test(el.className || "") &&
      /(?:^|\s)flex(?:\s|$)/.test(el.className || "") && !el.contains(input) && visible(el));
    if (!row) return null;
    let owner = input.closest("[data-session-id]");
    if (!owner) {
      const owners = [...document.querySelectorAll("[data-session-id]")].filter(visible);
      const ids = new Set(owners.map((el) => el.getAttribute("data-session-id")).filter(Boolean));
      if (ids.size !== 1) return null;
      owner = owners[0];
    }
    const id = owner?.getAttribute("data-session-id");
    return id ? { card, id } : null;
  }
  function closePopup() {
    if (popup) popup.remove();
    if (activeButton) activeButton.setAttribute("aria-expanded", "false");
    popup = null; activeButton = null; activeKind = null;
  }
  function positionPopup() {
    if (!popup || !activeButton?.isConnected) return;
    const anchor = activeButton.getBoundingClientRect(), rect = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - rect.width - 8))}px`;
    const above = anchor.top - rect.height - 10;
    popup.style.top = `${Math.max(8, above >= 8 ? above : Math.min(anchor.bottom + 10, innerHeight - rect.height - 8))}px`;
  }
  function popupContent() {
    if (!popup) return;
    const signature = JSON.stringify([activeKind, data]);
    if (popup._signature === signature) { positionPopup(); return; }
    popup._signature = signature;
    popup.replaceChildren();
    const title = document.createElement("div"); title.className = "ztps-title";
    title.append(icon(activeKind), document.createTextNode(activeKind === "usage" ? "Token 用量" : "会话统计"));
    if (activeKind === "usage" && data?.ok) {
      const total = document.createElement("strong"); total.textContent = `${full(data.totalTokens)} tok`; title.append(total);
    }
    popup.append(title);
    if (data?.ok) {
      const rows = activeKind === "usage" ? [
        ["缓存命中", percent(data.cacheHitRate)],
        ["未缓存输入", `${full(data.uncachedInputTokens)} tok`, "包括缓存写入，和缓存读取、输出相加等于总量"],
        ["缓存读取", `${full(data.cacheReadTokens)} tok`], ["输出", `${full(data.outputTokens)} tok`],
      ] : [
        ["模型用时", duration(data.modelMs), "各次已记录的模型请求耗时累计"],
        ["工具调用用时", duration(data.toolMs), "各次工具执行耗时累计；并行调用分别计时"],
        ["平均首 token 延迟（TTFT）", duration(data.ttftMs), "有首 token 记录的模型请求的平均等待时间"],
        ["平均输出速度（TPS）", speed(data.tps), "仅统计有输出且计时完整的调用：累计输出 token ÷ 累计首 token 到完成的耗时"],
      ];
      const dl = document.createElement("dl");
      for (const [label, value, hint] of rows) {
        const dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = label; dd.textContent = value; if (hint) dt.title = hint;
        dl.append(dt, dd);
      }
      popup.append(dl);
    } else {
      const p = document.createElement("p");
      p.textContent = data == null ? "正在读取会话统计…" : data.reason === "no-history"
        ? "暂无本地用量记录" : "暂时无法读取会话统计";
      popup.append(p);
    }
    positionPopup();
  }
  function openPopup(button, kind) {
    if (activeButton !== button) closePopup();
    activeButton = button; activeKind = kind;
    button.setAttribute("aria-expanded", "true");
    if (!popup) {
      popup = document.createElement("div"); popup.className = "ztps-popup";
      popup.id = "ztps-details"; popup.setAttribute("role", "region");
      popup.setAttribute("aria-label", kind === "usage" ? "Token 用量详情" : "会话统计详情");
      document.body.append(popup);
    }
    popupContent();
  }
  function createBar(card) {
    host = document.createElement("div"); host.setAttribute("data-ztps-bar", "2");
    host.hidden = true;
    for (const [kind, label] of [["stats", "会话统计"], ["usage", "Token 用量"]]) {
      const button = document.createElement("button"); button.type = "button";
      button.setAttribute("aria-label", label); button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "ztps-details"); button.dataset.kind = kind;
      const value = document.createElement("span"); button.append(icon(kind), value);
      button.onclick = () => {
        if (activeButton === button) closePopup(); else openPopup(button, kind);
      };
      host.append(button);
    }
    card.insertAdjacentElement("afterend", host);
  }
  function render() {
    clearTimeout(liveWarmupTimer);
    liveWarmupTimer = null;
    if (!host) return;
    if (data?.ok && data.steps > 0) hasModelUsage = true;
    host.hidden = !hasModelUsage;
    if (!hasModelUsage) { closePopup(); return; }
    const now = Date.now();
    const currentLive = live.view(sessionId);
    if (liveSession !== sessionId || currentLive?.phase !== liveView?.phase ||
        currentLive?.readyAt !== liveView?.readyAt || now - lastLiveRender >= 1000) {
      liveSession = sessionId; liveView = currentLive; lastLiveRender = now;
    }
    const realtime = liveView;
    if (realtime?.phase === "sampling") {
      // Fire at the actual sampling deadline, not at the next 1-second UI tick.
      liveWarmupTimer = setTimeout(render, Math.max(1, realtime.readyAt - now));
    }
    const phase = realtime?.phase ?? (data?.running ? "waiting" : "idle");
    const liveLabel = phase === "streaming" ? `≈ ${speed(realtime.tps)}`
      : phase === "tool" ? "工具执行中" : phase === "sampling" ? "正在采样" : phase === "waiting" ? "等待输出" : null;
    const emptyLabel = data == null ? "读取中…" : data.reason === "no-history" ? "暂无统计" : "统计不可用";
    const stats = data?.ok ? `${data.turns} 轮 · ${data.steps} 次请求 · ${liveLabel ?? speed(data.tps)}`
      : liveLabel ?? emptyLabel;
    const usage = data?.ok ? `${compact(data.totalTokens)} tok · 缓存命中 ${percent(data.cacheHitRate)}` : emptyLabel;
    text(host.children[0].lastChild, stats); text(host.children[1].lastChild, usage);
    host.title = "底栏生成中为近 4 秒实时估速（≈）；结束后及弹窗为会话平均。请求次数指模型请求，包含重试和失败请求。";
    popupContent();
  }
  async function refresh() {
    if (!sessionId || pending || Date.now() - lastRead < 2000) return;
    const id = sessionId, version = generation;
    pending = true; lastRead = Date.now();
    let timer;
    try {
      const request = bridge?.read ? bridge.read(id) : Promise.resolve({ ok: false, reason: "bridge-unavailable" });
      const result = await Promise.race([request, new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), 5000);
      })]);
      if (version !== generation || id !== sessionId) return;
      data = result?.sessionId && result.sessionId !== id ? { ok: false, reason: "session-mismatch" } : result;
    } catch { if (version === generation) data = { ok: false, reason: "unavailable" }; }
    finally {
      clearTimeout(timer);
      if (version === generation) { pending = false; render(); }
    }
  }
  function scan() {
    const target = locate(), next = target?.id ?? null;
    if (next !== sessionId) {
      generation++; sessionId = next; data = null; pending = false; lastRead = 0; closePopup();
      hasModelUsage = false;
      if (host) { host.remove(); host = null; }
    }
    if (!target) { if (host) host.remove(); host = null; closePopup(); return; }
    if (!host?.isConnected || host.previousElementSibling !== target.card) {
      if (host) host.remove(); closePopup(); createBar(target.card);
    }
    render(); refresh();
  }
  function start() {
    const style = document.createElement("style");
    style.textContent = `
      [data-ztps-bar="2"]{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 16px;align-items:center;min-width:0;margin-top:6px;padding:0 2px;color:var(--color-foreground-subtle,#858994);font:13px/1.5 system-ui,sans-serif;font-variant-numeric:tabular-nums}
      [data-ztps-bar="2"][hidden]{display:none}
      [data-ztps-bar="2"] button{display:inline-flex;align-items:center;gap:7px;max-width:100%;min-width:0;padding:2px 8px;border:0;border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
      [data-ztps-bar="2"] button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      [data-ztps-bar="2"] svg,.ztps-popup svg{flex:none}
      [data-ztps-bar="2"] button:hover,[data-ztps-bar="2"] button[aria-expanded="true"]{background:rgba(127,127,127,.09)}
      [data-ztps-bar="2"] button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
      .ztps-popup{position:fixed;z-index:2147483000;box-sizing:border-box;width:390px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:20px 24px;border:1px solid var(--color-border,rgba(127,127,127,.18));border-radius:14px;background:var(--color-background,#fff);color:var(--color-foreground,#202228);box-shadow:0 5px 22px #00000012;font:14px/1.55 system-ui,sans-serif;font-variant-numeric:tabular-nums}
      .ztps-title{display:flex;align-items:center;gap:9px;padding-bottom:13px;border-bottom:1px solid var(--color-border,#ddd);font-weight:500}
      .ztps-title strong{margin-left:auto;font-size:14px;white-space:nowrap}
      .ztps-popup dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 14px;margin:14px 0;color:var(--color-foreground-subtle,#858994)}
      .ztps-popup dt,.ztps-popup dd{margin:0}.ztps-popup dd{text-align:right;color:var(--color-foreground,#686d77)}
      .ztps-popup small{display:block;font-size:11px;color:var(--color-foreground-subtle,#858994)}
      @media(prefers-color-scheme:dark){.ztps-popup{background:var(--color-background,#24262b);color:var(--color-foreground,#e8e8e8)}.ztps-popup dd{color:var(--color-foreground,#ccc)}}
      @media(max-width:360px){.ztps-popup{padding:14px}.ztps-title{flex-wrap:wrap}.ztps-popup dl{gap:7px;font-size:12px}}
    `;
    document.head.append(style);
    const observer = new MutationObserver((records) => {
      if (records.every((r) => r.target.closest?.('[data-ztps-bar],.ztps-popup'))) return;
      if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; scan(); }); }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-session-id", "hidden", "aria-hidden", "class", "style"] });
    window.addEventListener("resize", positionPopup);
    window.addEventListener("scroll", positionPopup, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopup(); });
    document.addEventListener("pointerdown", (e) => { if (popup && !popup.contains(e.target) && !host?.contains(e.target)) closePopup(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastRead = 0; scan(); } });
    setInterval(() => { if (!document.hidden) scan(); }, 1000);
    scan();
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
