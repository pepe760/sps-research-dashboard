"use strict";

// Read only a user-supplied snapshot. This module never requests an option
// chain, verifies the exchange calendar, or labels imported quotes as live.
(() => {
  const MAX_CHARS = 512 * 1024;
  const MAX_ROWS = 5000;
  const TICKS = 10000;
  const MULTIPLIER = 100;
  const LEG_WIDTH = 15;
  const MODEL_ROUND_TRIP_FEE = 2.80;
  const fields = {
    expiry: ["expiry", "expiration", "expirationdate", "expirydate", "expdate", "exp", "lasttradedateorcontractmonth"],
    strike: ["strike", "strikeprice", "putstrike", "putstrikeprice"],
    delta: ["delta", "putdelta", "modeldelta", "optiondelta"],
    bid: ["bid", "bidprice", "putbid", "putbidprice", "bestbid", "nbbobid"],
    ask: ["ask", "askprice", "putask", "putaskprice", "bestask", "nbboask", "offer"],
    symbol: ["symbol", "ticker", "root", "underlying", "underlyingsymbol", "underlyingticker", "tradingclass"],
    type: ["type", "right", "optiontype", "putcall", "callput", "cp"],
    quote_as_of: ["quoteasof", "asof", "quotetime", "quotetimestamp", "bidasktime", "bidasktimestamp"],
    contract: ["optionsymbol", "contractsymbol", "contractname", "occ", "occoption", "osi"]
  };
  const canon = value => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const fieldFor = new Map(Object.entries(fields).flatMap(([key, aliases]) => aliases.map(alias => [alias, key])));

  function delimiter(text) {
    let q = false, commas = 0, tabs = 0;
    for(let i = 0; i < text.length; i++) {
      const ch = text[i];
      if(ch === '"') {
        if(q && text[i + 1] === '"') i++;
        else q = !q;
      } else if(!q) {
        if(ch === ",") commas++;
        else if(ch === "\t") tabs++;
        else if(ch === "\n" || ch === "\r") break;
      }
    }
    return tabs > commas ? "\t" : ",";
  }

  function parseTable(text) {
    if(typeof text !== "string" || text.length > MAX_CHARS) throw Error("請貼上 512 KB 以下嘅 CSV 或 TSV 期權鏈。");
    text = text.replace(/^\uFEFF/, "").replace(/^[ \t\r]*\n(?:[ \t\r]*\n)*/, "");
    const sep = delimiter(text);
    const table = [];
    let row = [], cell = "", q = false, closed = false;
    const field = () => { row.push(cell.trim()); cell = ""; closed = false; };
    const end = () => {
      field();
      if(row.some(Boolean)) table.push(row);
      if(table.length > MAX_ROWS + 1) throw Error("請將期權鏈縮短至 5,000 行以內。");
      row = [];
    };
    for(let i = 0; i < text.length; i++) {
      const ch = text[i];
      if(q) {
        if(ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if(ch === '"') { q = false; closed = true; }
        else cell += ch;
      } else if(ch === sep) field();
      else if(ch === "\r" || ch === "\n") {
        if(ch === "\r" && text[i + 1] === "\n") i++;
        end();
      } else if(ch === '"' && !cell.trim() && !closed) { cell = ""; q = true; }
      else if(ch === '"' || (closed && ch.trim())) throw Error("CSV 引號格式唔正確，請核對後再貼。");
      else if(!closed) cell += ch;
    }
    if(q) throw Error("CSV 有未關閉嘅引號。");
    if(row.length || cell || closed) end();
    return table;
  }

  function isoDate(raw) {
    if(typeof raw !== "string") return null;
    const s = raw.trim();
    const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
    if(!m || (s.length !== 8 && s.length !== 10)) return null;
    const date = m.slice(1).join("-");
    const t = new Date(date + "T00:00:00Z");
    return Number.isFinite(+t) && t.toISOString().slice(0, 10) === date ? date : null;
  }

  function quoteTime(value) {
    if(typeof value !== "string") return null;
    const raw = value.trim().replace(" ", "T");
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/i);
    if(!m || !isoDate(m[1])) return null;
    const t = new Date(raw);
    return Number.isFinite(+t) ? t.toISOString() : null;
  }

  function fixedTicks(raw) {
    if(typeof raw !== "string") return null;
    const s = raw.trim().replace(/^\$/, "").trim();
    if(!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,4})?|\.\d{1,4})$/.test(s)) return null;
    const n = Math.round(Number(s.replaceAll(",", "")) * TICKS);
    return Number.isSafeInteger(n) && n <= 100000 * TICKS ? n : null;
  }

  function putDelta(raw) {
    if(typeof raw !== "string") return null;
    const s = raw.trim().replace(/^[−–]/, "-");
    if(!/^-?(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(s)) return null;
    const v = s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s);
    return Number.isFinite(v) && v >= -1 && v <= 0 ? v : null;
  }

  // Listed OSI identifier: root + YYMMDD + P/C + strike scaled by 1000.
  function optionId(value) {
    if(typeof value !== "string") return null;
    const m = value.toUpperCase().match(/^([A-Z0-9]{1,6})\s*(\d{6})([CP])(\d{8})$/);
    if(!m) return null;
    const expiry = isoDate("20" + m[2]);
    return expiry && {root:m[1], expiry, put:m[3] === "P", strikeTicks:Number(m[4])*10};
  }

  function makeCandidate(short, long, expiry, referenceAsOf) {
    const creditTicks = short.bid - long.ask;
    const credit = creditTicks / TICKS;
    const shortStrike = short.strike / TICKS;
    const longStrike = long.strike / TICKS;
    const maxLoss = Math.round((LEG_WIDTH * TICKS - creditTicks) * MULTIPLIER * 100 / TICKS) / 100;
    const maxProfit = Math.round(credit * MULTIPLIER * 100) / 100;
    const fee = MODEL_ROUND_TRIP_FEE;
    const cents = value => Math.round(value * 100) / 100;
    const precise = value => Math.round(value * TICKS) / TICKS;
    const timeSkewSeconds = short.at && long.at ? Math.abs(Date.parse(short.at) - Date.parse(long.at)) / 1000 : null;
    return {
      expiry, shortStrike, longStrike, shortDelta:short.delta, longDelta:long.delta,
      shortBid:short.bid/TICKS, shortAsk:short.ask/TICKS, longBid:long.bid/TICKS, longAsk:long.ask/TICKS,
      shortQuoteAsOf:short.at, longQuoteAsOf:long.at, referenceAsOf, timeSkewSeconds,
      width:LEG_WIDTH, credit, closeDebit:(short.ask-long.bid)/TICKS, maxLoss, maxProfit,
      breakEven:(short.strike-creditTicks) / TICKS, feeBuffer:fee,
      maxLossWithFees:cents(maxLoss+fee), maxProfitWithFees:cents(maxProfit-fee),
      breakEvenWithFees:precise(shortStrike-credit+fee/MULTIPLIER)
    };
  }

  function select(text, options = {}) {
    const diagnostics = {rows:0, wrongSeries:0, wrongExpiry:0, invalidRows:0, duplicateStrikes:0, deltaEligible:0, wingMissing:0, creditInvalid:0};
    const reply = (status, candidates = [], errors = [], warnings = []) => ({status, candidates, best:candidates[0] || null, diagnostics, errors, warnings});
    const expiry = isoDate(options?.expiry);
    if(!expiry) return reply("input_error", [], ["請先輸入已核對嘅下一個交易日到期日。"]);
    const date = new Date(expiry + "T00:00:00Z");
    if([0,6].includes(date.getUTCDay())) return reply("input_error", [], ["到期日唔可以係星期六或星期日；請核對交易所日曆。"]);
    const referenceAsOf = quoteTime(options?.referenceAsOf);
    let table;
    try { table = parseTable(text); }
    catch(e) { return reply("input_error", [], [e.message]); }
    const headers = table.shift() || [];
    if(!table.length) return reply("input_error", [], ["請貼上有欄名同期權報價嘅 XSP put 期權鏈。"]);
    const col = Object.create(null);
    for(const [i, header] of headers.entries()) {
      const name = fieldFor.get(canon(header));
      if(!name) continue;
      if(col[name] !== undefined) return reply("input_error", [], ["有重複欄位："+name+"。每行只保留 put 對應嘅一組欄位。"]);
      col[name] = i;
    }
    if(["delta", "bid", "ask"].some(x => col[x] === undefined) || ((col.expiry === undefined || col.strike === undefined) && col.contract === undefined)) {
      return reply("input_error", [], ["請提供 expiry、strike、delta、bid 同 ask 欄；標準 OSI 合約碼可代替 expiry 同 strike。"]);
    }
    const book = new Map();
    const ambiguous = new Set();
    const notes = [];
    let matchingRows = 0;
    diagnostics.rows = table.length;

    for(const row of table) {
      const get = key => row[col[key]] || "";
      const contract = optionId(get("contract")) || optionId(get("symbol"));
      const symbol = get("symbol").toUpperCase();
      const right = get("type").toUpperCase();
      if((contract && (contract.root !== "XSP" || !contract.put)) ||
        (symbol && !["XSP", "^XSP"].includes(symbol) && !optionId(symbol)) ||
        (right && !["P", "PUT", "PUTS"].includes(right))) {
        diagnostics.wrongSeries++; continue;
      }
      const rowExpiry = col.expiry !== undefined ? isoDate(get("expiry")) : contract?.expiry;
      const strike = col.strike !== undefined ? fixedTicks(get("strike")) : contract?.strikeTicks;
      if(!rowExpiry || (col.contract !== undefined && get("contract") && !optionId(get("contract"))) ||
         (contract && (rowExpiry !== contract.expiry || strike !== contract.strikeTicks))) {
        diagnostics.invalidRows++; continue;
      }
      if(rowExpiry !== expiry) { diagnostics.wrongExpiry++; continue; }
      matchingRows++;
      const bid = fixedTicks(get("bid")), ask = fixedTicks(get("ask")), delta = putDelta(get("delta"));
      if(!(strike > 0) || bid === null || !(ask > 0) || bid > ask) {
        diagnostics.invalidRows++; continue;
      }
      // A malformed or missing delta cannot select a short put. A valid wing
      // does not need its own delta because only its listed price is used.
      const at = quoteTime(get("quote_as_of"));
      const legs = {strike, bid, ask, delta, at};
      if(ambiguous.has(strike)) { diagnostics.duplicateStrikes++; continue; }
      const previous = book.get(strike);
      if(previous) {
        if(previous.bid === bid && previous.ask === ask && previous.delta === delta && previous.at === at) continue;
        diagnostics.duplicateStrikes++;
        ambiguous.add(strike);
        book.delete(strike);
      } else book.set(strike, legs);
    }
    if(!matchingRows) return reply("no_expiry", [], [], ["貼入資料未有已核對到期日嘅 XSP put。"]);

    const candidates = [];
    for(const short of book.values()) {
      if(short.delta === null || short.delta < -.15 || short.delta > -.05 || short.bid < .05 * TICKS) continue;
      diagnostics.deltaEligible++;
      const long = book.get(short.strike - LEG_WIDTH * TICKS);
      if(!long) { diagnostics.wingMissing++; continue; }
      const credit = short.bid - long.ask;
      if(!(credit > 0 && credit < LEG_WIDTH * TICKS)) { diagnostics.creditInvalid++; continue; }
      candidates.push(makeCandidate(short, long, expiry, referenceAsOf));
    }
    const distance = d => Math.round(Math.abs(d + .10) * 1e12);
    candidates.sort((a,b) => distance(a.shortDelta)-distance(b.shortDelta) || b.shortBid-a.shortBid || a.shortStrike-b.shortStrike);
    if(diagnostics.duplicateStrikes) notes.push("有相同行使價但報價或 delta 唔一致，已排除該行使價。");
    if(candidates.length && (!candidates[0].shortQuoteAsOf || !candidates[0].longQuoteAsOf)) notes.push("最接近組合缺獨立逐腿報價時間；只作匯入參考。");
    if(candidates[0]?.timeSkewSeconds > 15) notes.push("最接近組合嘅兩腿報價相差超過 15 秒；credit 只作參考。");
    return reply(candidates.length ? "ready" : "no_match", candidates, [], notes);
  }

  const api = Object.freeze({select});
  if(typeof module !== "undefined" && module.exports) module.exports = api;
  if(typeof window !== "undefined") window.SpsXspChain = api;
})();
