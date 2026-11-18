"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const STATUS_URL = "./data/status.json";
  const SYMBOLS = ["SPY", "XSP", "SPX", "VIX"];
  const LABELS = { SPY: "ETF OPTIONS", XSP: "MINI INDEX", SPX: "INDEX REFERENCE", VIX: "VOLATILITY INDEX" };
  const state = { data: null };
  const money = (n, digits = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const GATE_LABELS = { passes: "條件已通過", blocked_sma200: "SMA200 阻擋", blocked_event: "事件日阻擋", unknown: "資料未齊／未知" };

  function freshTimestamp(value, minutes) {
    const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
    const age = Date.now() - timestamp;
    return Number.isFinite(timestamp) && age >= -5 * 60000 && age <= minutes * 60000;
  }

  function effectiveStatus(section, ageMinutes) {
    if (!section) return "unavailable";
    if (section.status !== "available") return section.status || "unavailable";
    if (!freshTimestamp(state.data?.checked_at, 120)) return "stale";
    if (ageMinutes && !freshTimestamp(section.as_of, ageMinutes)) return "stale";
    return "available";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function statusLabel(status) {
    return ({ available: "已提供資料", partial: "部分資料", stale: "資料已過期", unconfigured: "未連接", unavailable: "未提供" })[status] || "狀態未知";
  }

  function setBadge(node, status) {
    node.textContent = statusLabel(status);
    node.className = "pill " + (status === "available" ? "good-pill" : status === "stale" || status === "partial" ? "warning-pill" : "neutral-pill");
  }

  function empty(title, text) {
    const box = el("div", "empty-block");
    box.append(el("strong", "", title), el("span", "", text));
    return box;
  }

  function renderMarket() {
    const market = state.data?.market;
    const marketStatus = effectiveStatus(market, 90);
    const current = marketStatus === "available";
    $("market-cards").replaceChildren();
    for (const symbol of SYMBOLS) {
      const quote = market?.instruments?.[symbol];
      const card = el("article", "market-card");
      const top = el("div", "market-card-top");
      top.append(el("h3", "", symbol), el("span", "market-label", LABELS[symbol]));
      card.append(top, el("div", "market-price", finite(quote?.spot) ? money(quote.spot) : "—"));
      card.append(el("small", "", finite(quote?.spot) ? (current ? "狀態檔提供 · 非即時串流" : "參考值 · 未驗證／過期") : "未連接市場資料"));
      if (finite(quote?.sma200)) card.append(el("div", "market-meta", "SMA200 " + money(quote.sma200)));
      $("market-cards").append(card);
    }
    setBadge($("market-badge"), marketStatus);
    renderGates();
  }

  function gateRow(title, detail, value, mode = "unknown") {
    const li = el("li", "gate-row");
    const text = el("div");
    text.append(el("span", "gate-icon " + mode, mode === "pass" ? "✓" : mode === "fail" ? "×" : "?"));
    const description = el("div");
    description.append(el("strong", "", title), el("small", "", detail));
    text.append(description);
    li.append(text, el("span", "gate-value", value));
    return li;
  }

  function renderGates() {
    const market = state.data?.market;
    const symbol = $("gate-symbol").value;
    const signalSymbol = symbol === "XSP" ? "SPX" : symbol;
    const quote = market?.instruments?.[signalSymbol];
    const valid = effectiveStatus(market, 90) === "available";
    const rows = [];
    rows.push(gateRow("資料時間與來源", market?.as_of ? "as-of: " + market.as_of : "冇可核對嘅市場時間戳", valid && market?.as_of ? "已提供" : "待核對", valid && market?.as_of ? "pass" : "unknown"));
    if (valid && finite(quote?.prior_close) && finite(quote?.sma200)) {
      const pass = quote.prior_close > quote.sma200;
      rows.push(gateRow("SMA200", signalSymbol + " 上一完整收市 " + money(quote.prior_close) + " ／ SMA200 " + money(quote.sma200) + (symbol === "XSP" ? "（XSP 使用 SPX 訊號）" : ""), pass ? "前收市在線上" : "前收市未在線上", pass ? "pass" : "fail"));
    } else rows.push(gateRow("SMA200", "需要 " + signalSymbol + " 上一完整收市 prior_close 與 SMA200，唔用即時 spot", "資料未齊"));
    rows.push(gateRow("Rule C", "FOMC 入場日停開；原定到期日遇 FOMC / CPI / NFP 停開", "日期待核對"));
    const events = state.data?.events;
    rows.push(gateRow("事件與 PIT", events?.covered_through ? "有限日曆覆蓋至 " + events.covered_through + "；超出範圍屬未知，空白唔代表無事件" : "FOMC / CPI / NFP：日曆覆蓋及歷史可知性須核實", statusLabel(events?.status || "unavailable")));
    const candidates = state.data?.candidates;
    const candidateValid = effectiveStatus(candidates, 90) === "available";
    const candidate = Array.isArray(candidates?.items) ? candidates.items.find((item) => item.symbol === symbol) : null;
    const gate = candidateValid && candidate && freshTimestamp(candidate.as_of, 90) ? candidate.gate : "unknown";
    rows.push(gateRow("候選 gate 記錄", candidate ? symbol + " 原定到期 " + candidate.expiry + "；" + (candidateValid ? "以候選 as-of 記錄核對" : "記錄已過期／未驗證") : "未有 " + symbol + " 候選合約", GATE_LABELS[gate] || GATE_LABELS.unknown, gate === "passes" ? "pass" : gate === "blocked_sma200" || gate === "blocked_event" ? "fail" : "unknown"));
    rows.push(gateRow("雙腿可執行報價", "同到期、strike、bid / ask、delta 同 quote 時間均須核實", candidateValid ? "有候選，待核對" : "未驗證"));
    $("gate-list").replaceChildren(...rows);
  }

  function safeURL(url) {
    try { const value = new URL(url); return value.protocol === "https:" ? value.href : null; } catch { return null; }
  }

  function renderEvents() {
    const events = state.data?.events;
    setBadge($("events-badge"), events?.status || "unavailable");
    const content = $("events-list");
    content.replaceChildren();
    const items = Array.isArray(events?.items) ? events.items : [];
    if (events?.status === "partial" || events?.covered_through) {
      content.append(el("p", "candidate-warning", events?.covered_through ? "日曆只覆蓋至 " + events.covered_through + "；呢個係有限覆蓋，超出範圍或冇列出事件唔等於安全。" : "事件日曆只係部分資料；空白唔代表冇事件。"));
    }
    if (!items.length) {
      content.append(empty("未有可核對嘅事件日曆", "空白唔代表冇事件。需要官方日曆及 as-of 記錄。"));
      return;
    }
    for (const item of items.slice(0, 6)) {
      const row = el("div", "event-row");
      const date = el("div", "event-date", item.date || "日期未知");
      date.append(el("small", "", item.time_et ? item.time_et + " ET" : "時間未提供"));
      const detail = el("div", "event-detail", item.title || item.type || "事件");
      const href = safeURL(item.source_url);
      if (href) {
        const link = el("a", "", "官方／來源頁 ↗");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        detail.append(link);
      }
      row.append(date, detail);
      content.append(row);
    }
  }

  function renderCandidates() {
    const candidates = state.data?.candidates;
    const candidateStatus = effectiveStatus(candidates, 90);
    setBadge($("candidate-badge"), candidateStatus);
    const box = $("candidates-content");
    box.replaceChildren();
    const items = Array.isArray(candidates?.items) ? candidates.items : [];
    if (!items.length) {
      box.append(empty("未連接 option chain", "請喺已授權報價來源核對。下面嘅 strike 計算器只係模型示範。"));
      return;
    }
    if (candidateStatus !== "available") box.append(el("p", "candidate-warning", "以下為未驗證／過期嘅參考記錄，唔代表現時可交易。"));
    const wrap = el("div", "table-wrap");
    const table = el("table", "candidate-table");
    table.append(el("caption", "sr-only", "狀態檔嘅候選合約報價"));
    const head = document.createElement("thead");
    const tr = document.createElement("tr");
    ["標的", "到期", "Short / Long", "Delta", "Credit", "模型最大虧損", "as-of", "Gate 記錄"].forEach((text) => { const th = el("th", "", text); th.scope = "col"; tr.append(th); });
    head.append(tr);
    table.append(head);
    const body = document.createElement("tbody");
    for (const item of items.slice(0, 30)) {
      const row = document.createElement("tr");
      const strikes = finite(item.short_strike) && finite(item.long_strike) ? money(item.short_strike) + " / " + money(item.long_strike) : "未提供";
      const gate = candidateStatus === "available" && freshTimestamp(item.as_of, 90) ? item.gate : "unknown";
      [item.symbol || "—", item.expiry || "—", strikes, finite(item.delta) ? money(item.delta) : "—", finite(item.credit) ? "$" + money(item.credit) : "—", finite(item.max_loss_usd) ? "$" + money(item.max_loss_usd) : "—", item.as_of || "未提供", GATE_LABELS[gate] || GATE_LABELS.unknown].forEach((value) => row.append(el("td", "", String(value))));
      body.append(row);
    }
    table.append(body);
    wrap.append(table);
    box.append(wrap);
  }

  async function loadStatus() {
    try {
      const response = await fetch(STATUS_URL, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("Status file unavailable");
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid status schema");
      state.data = data;
      const globalFresh = freshTimestamp(data.checked_at, 120);
      const marketFresh = effectiveStatus(data.market, 90) === "available";
      $("global-status").textContent = !globalFresh ? "狀態檔過期／時間未知 · 唔當即時資料" : marketFresh ? "狀態檔已讀取 · 非即時串流" : "狀態檔已讀取 · 報價未就緒";
      $("global-dot").className = "status-dot " + (!globalFresh ? "warning" : marketFresh ? "" : "neutral");
      $("updated-at").textContent = data.checked_at ? "狀態核對 " + data.checked_at : "狀態檔未提供 checked_at";
    } catch {
      state.data = null;
      $("global-status").textContent = "未能讀取狀態檔 · 保留未知";
      $("updated-at").textContent = "冇補造價格；模型可手動使用。";
      $("global-dot").className = "status-dot warning";
    }
    renderMarket();
    renderEvents();
    renderCandidates();
  }

  // Peter J. Acklam's rational inverse-normal approximation; model use only.
  function inverseNormal(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    if (!(p > 0 && p < 1)) return NaN;
    const poly = (coefficients, x) => coefficients.reduce((sum, v) => sum * x + v, 0);
    if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return poly(c, q) / (poly(d, q) * q + 1); }
    if (p > 0.97575) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -poly(c, q) / (poly(d, q) * q + 1); }
    const q = p - 0.5, r = q * q;
    return poly(a, r) * q / (poly(b, r) * r + 1);
  }

  function readNumber(id) {
    const raw = $(id).value.trim();
    return raw === "" ? NaN : Number(raw);
  }

  function calculate(event) {
    event.preventDefault();
    const spot = readNumber("calc-spot"), ivPct = readNumber("calc-iv"), days = readNumber("calc-dte");
    const delta = readNumber("calc-delta"), width = readNumber("calc-width"), grid = readNumber("calc-grid");
    const creditText = $("calc-credit").value.trim(), credit = creditText === "" ? null : Number(creditText);
    const errors = [];
    if (!(spot >= 1 && spot <= 1000000)) errors.push("價格請輸入 1 至 1,000,000。");
    if (!(ivPct >= 0.1 && ivPct <= 500)) errors.push("IV 請輸入 0.1% 至 500%。");
    if (!(days >= 0.01 && days <= 365)) errors.push("Calendar days 請輸入 0.01 至 365。");
    if (!(delta >= 0.01 && delta <= 0.49)) errors.push("|delta| 請輸入 0.01 至 0.49。");
    if (!(width >= 1 && width <= 500)) errors.push("Width 請輸入 1 至 500 points。");
    if (![0.5, 1, 5].includes(grid)) errors.push("請選擇有效 strike grid。");
    if (credit !== null && !(Number.isFinite(credit) && credit > 0 && credit < width)) errors.push("假設 credit 必須大於 0 而小於 width。");
    let shortStrike, longStrike;
    if (!errors.length) {
      const sigma = ivPct / 100, t = days / 365;
      const raw = spot * Math.exp(0.5 * sigma * sigma * t - inverseNormal(1 - delta) * sigma * Math.sqrt(t));
      shortStrike = Math.floor((raw + 1e-9) / grid) * grid;
      longStrike = shortStrike - width;
      if (!(longStrike > 0)) errors.push("模型 long strike 必須大於 0；請減少 width。");
    }
    const error = $("calc-error");
    if (errors.length) {
      error.textContent = errors.join(" ");
      error.hidden = false;
      return;
    }
    error.hidden = true;
    error.textContent = "";
    const result = $("calculator-result");
    result.className = "calculator-result has-results";
    result.replaceChildren();
    const top = el("div", "result-top");
    top.append(el("h3", "", $("calc-symbol").value + " · 手動輸入模型結果"), el("span", "pill model-pill", "非市場報價"));
    const metrics = el("div", "result-grid");
    for (const [label, value, note] of [["模型 short put", money(shortStrike), "向下按 grid 取整"], ["模型 long put", money(longStrike), "short − " + money(width) + " points"], ["模型最大虧損", credit === null ? "未計" : "$" + money((width - credit) * 100), credit === null ? "需輸入假設 credit" : "每張 ×100 · 未計費用"]]) {
      const metric = el("div", "result-metric");
      metric.append(el("span", "", label), el("strong", "", value), el("small", "", note));
      metrics.append(metric);
    }
    result.append(top, metrics, el("p", "result-footnote", "呢啲 strike 未經上市合約核對。取整後 delta 會改變；冇真實 bid / ask，就未知道可收幾多 credit。"));
  }

  $("calculator-form").addEventListener("submit", calculate);
  $("gate-symbol").addEventListener("change", renderGates);
  $("calc-symbol").addEventListener("change", () => { $("calc-grid").value = $("calc-symbol").value === "XSP" ? "1" : "0.5"; });
  $("tv-load").addEventListener("click", () => {
    const button = $("tv-load");
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "TradingView 已要求載入";
    $("tv-container").hidden = false;
    $("tv-status").textContent = "正在載入第三方顯示；市場資料可能延遲，唔會讀入任何計算。";
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js";
    script.async = true;
    script.type = "text/javascript";
    script.textContent = JSON.stringify({ symbols: [{ proName: "SP:SPX", title: "S&P 500" }, { proName: "AMEX:SPY", title: "SPY" }, { proName: "CBOE:VIX", title: "VIX" }], showSymbolLogo: true, isTransparent: true, displayMode: "adaptive", colorTheme: "light", locale: "zh_TW" });
    script.addEventListener("error", () => { $("tv-status").textContent = "第三方顯示未能載入，可能被網絡或瀏覽器阻擋。狀態檔同手動模型仍可使用。"; });
    const observer = new MutationObserver(() => {
      const iframe = $("tv-container").querySelector("iframe");
      if (iframe) {
        iframe.title = "TradingView 市場參考帶 — 可能延遲，唔作計算輸入";
        $("tv-status").textContent = "TradingView 獨立顯示已建立。可能延遲；唔會讀入 gate 或模型。";
        observer.disconnect();
      }
    });
    observer.observe($("tv-container"), { childList: true, subtree: true });
    $("tv-container").append(script);
    window.setTimeout(() => {
      if (!$("tv-container").querySelector("iframe")) {
        observer.disconnect();
        $("tv-status").textContent = "如參考帶仍未顯示，可能被網絡或瀏覽器阻擋；可使用 TradingView 官方連結。";
      }
    }, 12000);
  });
  if ("IntersectionObserver" in window) {
    const links = Array.from(document.querySelectorAll(".nav-link"));
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) links.forEach((link) => link.classList.toggle("active", link.hash === "#" + entry.target.id));
    }, { rootMargin: "-10% 0px -65% 0px" });
    document.querySelectorAll(".anchor-section").forEach((section) => observer.observe(section));
  }
  loadStatus();
  window.setInterval(() => { if (!document.hidden) loadStatus(); }, 5 * 60 * 1000);
})();
