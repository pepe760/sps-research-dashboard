"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const STATUS_URL = "./data/status.json";
  const SYMBOLS = ["SPY", "XSP", "SPX", "VIX"];
  const LABELS = { SPY: "ETF OPTIONS", XSP: "MINI INDEX", SPX: "INDEX REFERENCE", VIX: "VOLATILITY INDEX" };
  const state = { data: null, chartRange: "1M", chartsKey: null };
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
    const optionsSource = state.data?.sources?.options;
    const candidateStatus = effectiveStatus(candidates, 90);
    setBadge($("candidate-badge"), candidateStatus);
    const box = $("candidates-content");
    box.replaceChildren();
    const items = Array.isArray(candidates?.items) ? candidates.items : [];
    if (!items.length) {
      const info = optionsSource?.status === "connected"
        ? ["有資料來源，暫未有合資格組合", "未收到符合時間、到期日、delta 同兩腿報價規則嘅候選。"]
        : optionsSource?.status === "unavailable"
          ? ["期權來源暫時讀唔到", "無可核對盤口，不提供自動 strike 或 credit。"]
          : ["未連接公開期權來源", "請喺已授權報價來源核對；可喺下方用手動盤口做紙上記錄。"];
      box.append(empty(...info));
      return;
    }
    if (candidates.source) box.append(el("p", "micro-note", "期權來源：" + candidates.source));
    if (candidateStatus !== "available") box.append(el("p", "candidate-warning", "以下為未驗證／過期嘅參考記錄，唔代表現時可交易。"));
    const wrap = el("div", "table-wrap");
    const table = el("table", "candidate-table");
    table.append(el("caption", "sr-only", "狀態檔嘅候選合約報價"));
    const head = document.createElement("thead");
    const tr = document.createElement("tr");
    ["標的", "入場 / 到期", "Short strike", "Short bid / ask", "Long strike", "Long bid / ask", "Delta", "Credit", "自然平倉 debit", "Break-even", "模型最大虧損", "as-of", "Gate 記錄"].forEach((text) => { const th = el("th", "", text); th.scope = "col"; tr.append(th); });
    head.append(tr);
    table.append(head);
    const body = document.createElement("tbody");
    for (const item of items.slice(0, 30)) {
      const row = document.createElement("tr");
      const price = (value) => finite(value) ? "$" + money(value) : "—";
      const pair = (bid, ask) => price(bid) + " / " + price(ask);
      const gate = candidateStatus === "available" && freshTimestamp(item.as_of, 90) ? item.gate : "unknown";
      [item.symbol || "—", (item.entry_date || "未提供") + " / " + (item.expiry || "—"), price(item.short_strike), pair(item.short_bid, item.short_ask), price(item.long_strike), pair(item.long_bid, item.long_ask), finite(item.delta) ? money(item.delta) : "—", price(item.credit), price(item.natural_close_debit), price(item.break_even), price(item.max_loss_usd), item.as_of || "未提供", GATE_LABELS[gate] || GATE_LABELS.unknown].forEach((value) => row.append(el("td", "", String(value))));
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
    renderCharts();
  }

  function svgNode(tag, attributes, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function validChartRows(rows) {
    const unique = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date + "T00:00:00Z")) || !finite(row.close) || row.close <= 0) continue;
      unique.set(row.date, row);
    }
    return Array.from(unique.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  function renderNumericChart(symbol, allRows, charts) {
    const host = $("chart-" + symbol.toLowerCase());
    const anchor = new Date(allRows.at(-1).date + "T00:00:00Z");
    const year = anchor.getUTCFullYear(), month = anchor.getUTCMonth() - (state.chartRange === "3M" ? 3 : 1);
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const cutoff = Date.UTC(year, month, Math.min(anchor.getUTCDate(), lastDay));
    const rows = allRows.filter((row) => Date.parse(row.date + "T00:00:00Z") >= cutoff);
    host.replaceChildren();
    if (rows.length < 2) { host.append(empty("呢段期間數據不足", "需要至少兩個已核實收市點；唔會補造走勢。")); return; }
    const fields = symbol === "SPX" ? [["close", "收市", "close"], ["sma20", "SMA20", "sma20"], ["sma50", "SMA50", "sma50"], ["sma200", "SMA200", "sma200"]] : [["close", "收市", "close vix-close"], ["sma20", "SMA20", "sma20"], ["sma50", "SMA50", "sma50"]];
    const first = rows[0], last = rows.at(-1);
    const percent = (last.close / first.close - 1) * 100;
    const summary = el("div", "chart-number-line");
    summary.append(el("strong", "", money(last.close)), el("span", percent >= 0 ? "chart-change positive" : "chart-change negative", (percent >= 0 ? "+" : "") + money(percent) + "%"), el("small", "", "區間 " + first.date + " → " + last.date));
    host.append(summary);
    const legend = el("div", "chart-legend");
    for (const [field, label, className] of fields) {
      const present = rows.some((row) => finite(row[field]));
      const entry = el("span", present ? "legend-item" : "legend-item missing");
      entry.append(el("i", "legend-line " + className), document.createTextNode(label + (present ? "" : " 未提供")));
      legend.append(entry);
    }
    host.append(legend);
    const values = rows.flatMap((row) => fields.map(([field]) => row[field]).filter(finite));
    let lo = Math.min(...values), hi = Math.max(...values);
    const padding = Math.max((hi - lo) * 0.12, hi * 0.002, 0.05);
    lo -= padding; hi += padding;
    const width = 560, height = 244, left = 58, right = 15, top = 12, bottom = 31;
    const x = (index) => left + index / (rows.length - 1) * (width - left - right);
    const y = (value) => top + (hi - value) / (hi - lo) * (height - top - bottom);
    const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": `${symbol}-plot-title ${symbol}-plot-desc`, class: "first-party-chart" });
    svg.append(svgNode("title", { id: symbol + "-plot-title" }, symbol + " " + state.chartRange + " 每日收市及均線"));
    svg.append(svgNode("desc", { id: symbol + "-plot-desc" }, `由 ${first.date} 至 ${last.date}，收市由 ${money(first.close)} 至 ${money(last.close)}。均線只顯示資料提供嘅值；下方可展開逐日數值。`));
    for (let i = 0; i < 5; i++) {
      const value = lo + (hi - lo) * i / 4, yy = y(value);
      svg.append(svgNode("line", { x1: left, y1: yy, x2: width - right, y2: yy, class: "chart-grid-line" }), svgNode("text", { x: left - 9, y: yy + 3, "text-anchor": "end", class: "chart-axis-text" }, money(value, symbol === "SPX" ? 0 : 1)));
    }
    for (const index of [0, Math.floor((rows.length - 1) / 2), rows.length - 1]) svg.append(svgNode("text", { x: x(index), y: height - 8, "text-anchor": index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle", class: "chart-axis-text" }, rows[index].date.slice(5)));
    for (const [field, , className] of fields.slice().reverse()) {
      let path = "", previousValid = false;
      rows.forEach((row, index) => {
        const value = row[field];
        if (!finite(value)) { previousValid = false; return; }
        path += (previousValid ? " L " : " M ") + x(index).toFixed(2) + " " + y(value).toFixed(2);
        previousValid = true;
      });
      if (path) svg.append(svgNode("path", { d: path, class: "chart-series " + className, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }));
    }
    host.append(svg);
    const details = el("details", "chart-data-details"), table = el("table", "chart-data-table");
    details.append(el("summary", "", "睇最近 10 個收市及均線數值"));
    const header = el("tr");
    for (const label of ["日期", ...fields.map(([, label]) => label)]) { const th = el("th", "", label); th.scope = "col"; header.append(th); }
    const thead = el("thead"); thead.append(header); table.append(thead);
    const tbody = el("tbody");
    for (const row of rows.slice(-10)) {
      const tr = el("tr"); tr.append(el("td", "", row.date));
      for (const [field] of fields) tr.append(el("td", "", finite(row[field]) ? money(row[field]) : "—"));
      tbody.append(tr);
    }
    table.append(tbody); const wrap = el("div", "table-wrap"); wrap.append(table); details.append(wrap); host.append(details);
    host.append(el("p", "chart-inline-note", "歷史收市線 · " + (charts.source || "來源未提供") + (charts.as_of ? " · as-of " + charts.as_of : " · as-of 未提供")));
  }

  function providerFrame(kind, title, config) {
    // The provider's own cross-origin iframe cannot read the site's paper ledger.
    const frame = document.createElement("iframe");
    frame.className = kind === "advanced-chart" ? "provider-frame advanced-chart-widget" : "provider-frame provider-tape";
    frame.title = title;
    const url = new URL("https://www.tradingview-widget.com/embed-widget/" + kind + "/");
    url.searchParams.set("locale", config.locale);
    const { locale, ...settings } = config;
    url.hash = encodeURIComponent(JSON.stringify({ ...settings, width: "100%", height: "100%", utm_source: new URL(location.href).hostname, utm_medium: "widget_new", utm_campaign: kind }));
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.src = url.href;
    return frame;
  }

  function renderSourceLinks(symbol) {
    const host = $("chart-" + symbol.toLowerCase());
    const ref = symbol === "SPX" ? "SP-SPX" : "CBOE-VIX";
    const source = el("a", "secondary-button source-chart-button", "去 TradingView 睇 " + symbol + " 原圖 ↗");
    source.href = "https://www.tradingview.com/symbols/" + ref + "/";
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    const marketStatus = state.data?.sources?.market?.status;
    const title = marketStatus === "connected" ? "未有合資格嘅指數日線" : marketStatus === "unavailable" ? "指數來源暫時讀唔到" : "未有可公開顯示嘅指數圖";
    const panel = empty(title, "原生指數可喺來源網站查看。接駁獲授權收市數據後，呢度會顯示 1M／3M 同 SMA。");
    panel.append(source);
    host.replaceChildren(panel);
  }

  function renderCharts() {
    const charts = state.data?.charts;
    const key = JSON.stringify([charts || null, state.data?.sources?.market?.status ?? null, state.chartRange]);
    if (state.chartsKey === key) return;
    state.chartsKey = key;
    let fallbacks = 0;
    for (const symbol of ["SPX", "VIX"]) {
      const rows = validChartRows(charts?.series?.[symbol]);
      const numeric = ["available", "stale"].includes(charts?.status) && rows.length >= 2;
      const badge = $("chart-" + symbol.toLowerCase() + "-badge");
      if (numeric) {
        badge.textContent = charts.status === "stale" ? "歷史資料 · 已過期" : "每日收市 · 數值圖";
        badge.className = "pill " + (charts.status === "stale" ? "warning-pill" : "good-pill");
        renderNumericChart(symbol, rows, charts);
      } else {
        fallbacks++;
        badge.textContent = "未接駁 · 可前往原圖";
        badge.className = "pill neutral-pill";
        renderSourceLinks(symbol);
      }
    }
    $("charts-source-note").textContent = fallbacks ? "未接駁嘅指數只提供原圖連結，唔用 CFD、期貨或者模擬價格替代。指數日線未公開前，1M／3M 切換暫停。" : "來源：" + (charts.source || "未提供") + " · " + (charts.as_of || "as-of 未提供") + "。SMA 使用已提供數值；缺值保留空白。";
    document.querySelectorAll("[data-chart-range]").forEach((button) => {
      button.disabled = fallbacks === 2;
      button.setAttribute("aria-pressed", String(button.dataset.chartRange === state.chartRange));
    });
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
  document.querySelectorAll("[data-chart-range]").forEach((button) => button.addEventListener("click", () => { state.chartRange = button.dataset.chartRange; renderCharts(); }));
  $("tv-load").addEventListener("click", () => {
    const button = $("tv-load");
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "TradingView 已要求載入";
    $("tv-container").hidden = false;
    $("tv-status").textContent = "TradingView 獨立顯示；市場資料可能延遲，唔會讀入任何計算。";
    $("tv-container").append(providerFrame("ticker-tape", "TradingView 市場參考帶 — 可能延遲", { symbols: [{ proName: "AMEX:SPY", title: "SPY ETF" }], showSymbolLogo: true, isTransparent: true, displayMode: "adaptive", colorTheme: "light", locale: "zh_TW" }));
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
