"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const ui = {
    market:$("market-metrics"), refs:$("market-references"), feed:$("feed-status"), stamp:$("feed-updated"),
    refresh:$("feed-refresh"), result:$("candidates-content"), candidate:$("candidate-status"),
    decision:$("decision-note"), gates:$("gate-list"), events:$("events-list"),
    chart:$("vix-chart"), period:$("vix-period"), chartNote:$("vix-chart-note"), expiry:$("xsp-auto-expiry")
  };
  const STATIC = "./data/status.json";
  const LIVE_TTL = 90 * 1000;
  const FUTURE_TOLERANCE = 3000;
  const YAHOO_VIX = "https://finance.yahoo.com/chart/%5EVIX/";
  const YAHOO_XSP = "https://finance.yahoo.com/quote/%5EXSP/";
  const YAHOO_SPX = "https://finance.yahoo.com/quote/%5EGSPC/";
  const MARKET = [["XSP","Mini-SPX 指數"],["VIX","Cboe 波幅指數"],["SPX","S&P 500 參考指數"]];
  const HKT = new Intl.DateTimeFormat("en-GB", {timeZone:"Asia/Hong_Kong",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  const POINTS = new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const USD = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"});
  const state = {current:null,lastStatic:null,endpoint:null,route:"none",loading:false,sourceError:false,lastMarketKey:"",lastVixKey:"",lastCandidateKey:""};
  const labels = new Map([
    ["market_unconfigured","未設定公開指數行情"],
    ["options_unconfigured","未設定公開 XSP 期權盤口"],
    ["market_unavailable","指數來源暫時讀唔到"],
    ["options_unavailable","期權來源暫時讀唔到"],
    ["xsp_not_live","未有新鮮、可驗證嘅 XSP 現價"],
    ["spx_not_live","未有新鮮、可驗證嘅 SPX 指數"],
    ["options_not_live","期權資料唔係可驗證即時盤口"],
    ["options_stale","兩腿報價已超過即時核對時限"],
    ["outside_entry_window","未到研究核對時段、已收市或非今日交易日"],
    ["no_candidate","未見符合研究條件嘅兩腿"],
    ["quote_unavailable","冇符合條件嘅兩腿報價"],
    ["selection_not_verified","未驗證 09:45 ET 選腿記錄"],
    ["selection_not_live","未驗證 09:45 ET 選腿記錄"],
    ["calendar_unverified","未確認下一交易日到期"],
    ["option_legs_not_live","兩腿缺即時盤口、個別時間過舊或時間差太大"],
    ["blocked_sma200","SMA200 研究條件未通過"],
    ["blocked_event","撞到研究規則指定嘅經濟事件"],
    ["gate_unknown","SMA200／事件資料不足，未能核對研究條件"],
    ["client_stale","報價已超過 90 秒，請以券商當刻盤口再核對"],
    ["live_transport_unavailable","即時接駁未開通；公開快照按排程產生"],
    ["source_unreachable","即時資料暫時讀唔到，以下只供參考"]
  ]);
  const AUTO_MESSAGE = new Map([
    ["no_regular_session","呢日冇正常美股交易時段，系統會等下一個交易日。"],
    ["outside_capture_or_pricing_window","未到盤口核對時間，或今日交易已結束。"],
    ["selection_saved","09:45 ET 選腿已記錄；10:45 ET 起更新同一組盤口。"],
    ["selection_not_available","正在等 09:45 ET 嘅有效期權報價。"],
    ["no_0945_selection","今日未能喺 09:45 ET 記錄合資格嘅兩腿，唔會用後來報價補選。"],
    ["missing_fresh_matching_legs","已鎖定兩腿，暫未取得同時段嘅有效 bid／ask。"]
  ]);
  function el(tag, value, cls) {
    const n = document.createElement(tag);
    if (value !== undefined) n.textContent = value;
    if (cls) n.className = cls;
    return n;
  }
  function link(title, href) {
    const a=el("a", title, "quiet-link");
    a.href=href; a.target="_blank"; a.rel="noopener noreferrer";
    return a;
  }
  const num = x => Number.isFinite(x);
  const stamp = x => typeof x === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(x) ? Date.parse(x) : NaN;
  const asHkt = x => num(stamp(x)) ? HKT.format(stamp(x)).replace(",", "")+" HKT" : "時間未提供";
  function recent(x) {
    const d=Date.now()-stamp(x);
    return num(d) && d>=-FUTURE_TOLERANCE && d<=LIVE_TTL;
  }
  function badge(n,text,tone="neutral") { n.className="pill "+tone+"-pill"; n.textContent=text; }
  function todayDay() {
    const parts = new Intl.DateTimeFormat("en",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
    const fields = Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
    return fields.year+"-"+fields.month+"-"+fields.day;
  }
  function validDay(v) { return typeof v==="string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && num(Date.parse(v+"T00:00:00Z")); }

  function marketRows(d) {
    const rows = MARKET.map(([symbol,name])=>{
      const q=d?.desk?.market?.[symbol] || {};
      const hasPrice=num(q.spot) && q.spot>0 && num(stamp(q.as_of));
      const live=q.status==="live" && hasPrice && recent(q.as_of);
      const text=live ? "即時來源" : hasPrice && (q.feed_mode==="delayed" || q.status==="delayed") ? "延遲參考" : hasPrice ? "舊／未證實即時" : "未有報價";
      return [symbol,name,q,hasPrice,live,text];
    });
    const key=JSON.stringify(rows);
    if(key!==state.lastMarketKey) {
      state.lastMarketKey=key;
      ui.market.replaceChildren(...rows.map(([symbol,name,q,hasPrice,live,text])=>{
        const card=el("article",undefined,"metric-card"+(symbol==="VIX"?" vix-metric":""));
        card.append(el("h3",symbol+" · "+name,"metric-label"),el("strong",hasPrice ? POINTS.format(q.spot) : "—","metric-value"));
        const p=el("small",text+(hasPrice ? " · "+asHkt(q.as_of) : ""),"metric-meta");
        card.append(p);
        if(hasPrice && q.source) card.append(el("small",q.source,"metric-meta"));
        return card;
      }));
    }
    return rows.some(r=>r[4]);
  }

  function setupFor(d) {
    const s=d?.desk?.setup;
    const reasons=Array.isArray(s?.blockers) ? s.blockers.filter(k=>typeof k==="string") : ["market_unconfigured","options_unconfigured"];
    const raw=s?.candidate;
    const fields=["short_strike","long_strike","short_bid","short_ask","long_bid","long_ask","credit","max_loss_usd"];
    const c=raw?.symbol==="XSP" && validDay(raw.expiry) && fields.every(k=>num(raw[k])) &&
      raw.short_strike-raw.long_strike===15 && raw.short_bid<=raw.short_ask && raw.long_bid<=raw.long_ask &&
      raw.credit>0 && raw.credit<15 ? raw : null;
    let ready = s?.status==="ready" && c?.quote_status==="live" && recent(c.short_quote_as_of) && recent(c.long_quote_as_of)
      && recent(d?.checked_at) && recent(d?.desk?.market?.XSP?.as_of) && recent(d?.desk?.market?.SPX?.as_of);
    if(s?.status==="ready" && !ready) reasons.push("client_stale");
    if(state.sourceError && state.endpoint) { reasons.push("source_unreachable"); ready=false; }
    return {c,ready,reasons:Array.from(new Set(reasons)),source:s?.source,collectorState:s?.collector_state};
  }

  function setupPanel({c,ready,reasons,source,collectorState}) {
    const key=JSON.stringify([c,ready,reasons,source,collectorState]);
    if(key===state.lastCandidateKey) return;
    state.lastCandidateKey=key;
    const missing = reasons.includes("options_unconfigured") || reasons.includes("market_unconfigured");
    badge(ui.candidate,ready ? "盤口可核對" : c ? "只供參考" : missing ? "等待自動行情接駁" : "未有可核對組合",ready?"good":c?"warning":"neutral");
    const list = reasons.map(k=>labels.get(k)).filter(Boolean);
    const summary=c ? (ready ? "研究條件同報價時間已核對。落單前仍要喺券商再核對即時兩腿限價。" : "以下報價只作參考，未通過即時核對。")
      : missing ? "公開即時行情服務尚未設定，暫未能取數。" : (AUTO_MESSAGE.get(collectorState)||"暫時未能確認符合研究規格嘅即時組合。");
    ui.decision.textContent=summary;
    ui.decision.dataset.tone=ready?"good":"warn";
    ui.gates.replaceChildren(...list.map(t=>el("li",t)));
    if(!c) {
      const empty=el("div",undefined,"empty-block");
      empty.append(el("strong",missing?"自動盤口未接通":"未取得可用兩腿"),el("p",missing?"系統接通行情後會自動揀兩腿，開頁唔需要輸入資料。":"系統暫時未取得符合 1DTE、delta、W15 同報價要求嘅配對。"));
      ui.result.replaceChildren(empty);return;
    }
    const meta=el("p", "同一到期："+c.expiry+" · W15 · "+(source||"合約報價來源未命名"),"micro-note");
    const table=el("table"), heading=el("thead"), row=el("tr");
    for (const h of ["方向","行使價","Delta","Bid","Ask","盤口時間"]) {const th=el("th",h);th.scope="col";row.append(th);}
    heading.append(row);table.append(heading);
    const body=el("tbody");
    for(const [side,strike,delta,bid,ask,time] of [
      ["賣出 Short put",c.short_strike,c.delta,c.short_bid,c.short_ask,c.short_quote_as_of],
      ["買入 Long put",c.long_strike,null,c.long_bid,c.long_ask,c.long_quote_as_of]
    ]) {
      const tr=el("tr"), sideCell=el("th",side);sideCell.scope="row";
      tr.append(sideCell, el("td",POINTS.format(strike)),el("td",num(delta)?delta.toFixed(3):"—"),
        el("td",POINTS.format(bid)),el("td",POINTS.format(ask)),el("td",asHkt(time)));
      body.append(tr);
    }
    table.append(body);
    const cards=el("div",undefined,"quote-facts");
    for(const [name,value,detail] of [
      ["參考開倉 credit",USD.format(c.credit*100),POINTS.format(c.credit)+" 點 × $100 · 未扣費"],
      ["最大到期虧損／套",USD.format(c.max_loss_usd),"已預留 "+USD.format(c.fee_buffer_usd??2.8)+" 費用；核對券商實收"],
      ["打和點",num(c.break_even)?POINTS.format(c.break_even):"—","含費用預留；按到期結算"],
      ["參考平倉 debit",num(c.natural_close_debit)?USD.format(c.natural_close_debit*100):"—","Short ask − Long bid · 未扣費"],
    ]) {const col=el("div",undefined,"quote-fact");col.append(el("small",name),el("strong",value),el("small",detail));cards.append(col);}
    ui.result.replaceChildren(meta,table,cards);
    if(num(stamp(c.selection_as_of))) ui.result.append(el("p","選腿記錄："+asHkt(c.selection_as_of)+"。盤口欄係兩腿各自嘅市場時間。","micro-note"));
  }

  function events(d) {
    const data=d?.events, day=todayDay();
    const next=Array.isArray(data?.items) ? data.items.filter(x=>validDay(x?.date) && x.date>=day && ["CPI","NFP","FOMC"].includes(x.type)).slice(0,5) : [];
    if(!next.length){ui.events.replaceChildren(el("p","未有完整可核對日曆。","micro-note"));return;}
    const out=el("ul");
    for (const x of next) out.append(el("li",x.date+" · "+x.type+(x.time_et?" · "+x.time_et+" ET":"")));
    ui.events.replaceChildren(out);
    if(data.status!=="available") ui.events.append(el("p","日曆有缺口或未更新，請再核對。","micro-note"));
  }

  function svg(tag,a={},label) {
    const e=document.createElementNS("http://www.w3.org/2000/svg",tag);
    for(const [k,v] of Object.entries(a)) e.setAttribute(k,v);
    if (label!==undefined) e.textContent=label;
    return e;
  }
  function renderVix(d) {
    const hist=d?.desk?.vix_history;
    const rows=(Array.isArray(hist?.series)? hist.series:[]).filter(r=>validDay(r?.date)&&num(r.close)&&r.close>0).slice(-70);
    const key=JSON.stringify([hist?.status,hist?.source,rows]);
    if(key===state.lastVixKey) return;
    state.lastVixKey=key;
    if(rows.length<2) {
      badge(ui.period,"Yahoo ^VIX · 外部圖表");
      const content=el("div",undefined,"empty-block");
      content.append(el("p","Yahoo Finance 可以直接睇 ^VIX 最新公布值同近三個月走勢。"),link("開 Yahoo ^VIX 圖表，揀「3M」↗",YAHOO_VIX));
      ui.chart.replaceChildren(content);
      ui.chartNote.textContent="留意 Yahoo 顯示嘅行情時間。3M 係同一個 ^VIX 嘅近三個月，唔係 ^VIX3M。";
      return;
    }
    const first=rows[0],last=rows.at(-1),vs=rows.map(r=>r.close);
    const pad=Math.max((Math.max(...vs)-Math.min(...vs))*.09,.35);
    const lo=Math.min(...vs)-pad,hi=Math.max(...vs)+pad;
    const x=i=>42+((i/(rows.length-1))*546),y=v=>15+(1-(v-lo)/(hi-lo))*147;
    const graph=svg("svg",{viewBox:"0 0 610 190",role:"img","aria-label":"VIX "+first.date+" 至 "+last.date+" 每日收市"});
    graph.append(svg("title",{}, "VIX 近三個月每日收市"));
    for(let i=0;i<4;i++){
      const v=lo+(hi-lo)*i/3, p=y(v);
      graph.append(svg("line",{x1:42,x2:588,y1:p,y2:p,stroke:"#e2e7e4"}),svg("text",{x:0,y:p+4},v.toFixed(1)));
    }
    graph.append(svg("polyline",{points:rows.map((r,i)=>x(i)+","+y(r.close)).join(" "),fill:"none","stroke-width":2,class:"chart-line"}),
      svg("text",{x:42,y:180},first.date),svg("text",{x:588,y:180,"text-anchor":"end"},last.date));
    const details=el("details",undefined,"mini-details");
    details.append(el("summary","查看最近 10 個收市紀錄"));
    const list=el("ul");
    for(const r of rows.slice(-10).reverse())list.append(el("li",r.date+" · "+POINTS.format(r.close)));
    details.append(list);
    ui.chart.replaceChildren(graph,details);
    badge(ui.period,first.date+" 至 "+last.date,hist.status==="stale"?"warning":"neutral");
    ui.chartNote.textContent="最近已完成收市："+POINTS.format(last.close)+" · 來源 "+(hist.source||"未命名")+(hist.status==="stale"?" · 歷史資料已過期":"")+"。";
  }

  function render() {
    const session=window.SpsXspSession?.next();
    const target=session?.known ? (session.isPlanned?"下一個正常交易時段":"今個正常交易時段")+"（美東 "+session.entryDate+"）→ 1DTE："+session.expiry+" 到期" : "未能核對下一個交易日。";
    if(ui.expiry.textContent!==target)ui.expiry.textContent=target;
    const d=state.current;
    const marketLive=marketRows(d);
    const setup=setupFor(d);
    setupPanel(setup);renderVix(d);events(d);
    const hasConfigured=d?.sources?.options?.status==="connected" || d?.sources?.market?.status==="connected" || Boolean(state.endpoint);
    if(state.sourceError) badge(ui.feed,"資料讀取暫時失敗","warning");
    else if(setup.ready) badge(ui.feed,"即時盤口可核對","good");
    else if(marketLive) badge(ui.feed,"指數已有即時值；期權待核對","warning");
    else badge(ui.feed,hasConfigured?"未取得可核對即時數據":"即時行情未接駁","neutral");
    ui.stamp.textContent=(num(stamp(d?.checked_at))?"網站查詢："+asHkt(d.checked_at):"尚未取得網站查詢時間")
      +(state.route==="live"?" · 15 秒自動查詢":" · 網站排程資料");
  }

  function publicEndpoint(v) {
    try {
      const u=new URL(v);
      return u.protocol==="https:" && !u.username && !u.password && !u.hash && !u.search ? u.href : null;
    } catch { return null; }
  }
  async function loadJson(url,cross=false) {
    const abort=new AbortController(), timer=setTimeout(()=>abort.abort(),8000);
    try {
      const res=await fetch(url,{cache:"no-store",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer",signal:abort.signal,...(cross?{mode:"cors"}:{})});
      if(!res.ok) throw Error("unavailable");
      const payload=await res.json();
      if(!payload || typeof payload!=="object" || !num(stamp(payload.checked_at))) throw Error("invalid snapshot");
      return payload;
    } finally { clearTimeout(timer); }
  }
  async function refresh(force=false) {
    if(state.loading) return;
    state.loading=true;ui.refresh.disabled=true;
    try {
      if(force || !state.lastStatic || !state.endpoint) {
        try {state.lastStatic=await loadJson(STATIC);state.endpoint=publicEndpoint(state.lastStatic?.live_desk?.url);}
        catch (e) {if(!state.lastStatic) throw e;}
      }
      state.sourceError=false;
      if(state.endpoint) {
        try {
          const live=await loadJson(state.endpoint,true);
          if(!live.desk || typeof live.desk!=="object") throw Error("missing desk");
          if(!recent(live.checked_at)) throw Error("stale desk");
          state.current={...state.lastStatic,...live,desk:live.desk};state.route="live";
        } catch {
          state.sourceError=true;state.current=state.lastStatic;state.route="static";
        }
      } else {state.current=state.lastStatic;state.route="static";}
    } catch {
      state.sourceError=true;
    } finally {
      state.loading=false;ui.refresh.disabled=false;render();
    }
  }

  ui.refs.replaceChildren(link("Yahoo ^VIX 最新／3M ↗",YAHOO_VIX),link("Yahoo ^XSP 現值 ↗",YAHOO_XSP),link("Yahoo ^GSPC（SPX）↗",YAHOO_SPX));
  ui.refresh.addEventListener("click",()=>refresh(true));
  refresh(true);
  setInterval(()=>{if(!document.hidden){render();if(state.endpoint) refresh();}},15000);
  setInterval(()=>{if(!document.hidden) refresh(true);},60000);
})();
