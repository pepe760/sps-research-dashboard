"use strict";
(() => {
  const $=id=>document.getElementById(id);
  const form=$("xsp-scan-form"), input=$("xsp-scan-input"), file=$("xsp-scan-file");
  const expiry=form.elements.namedItem("expiry"), source=form.elements.namedItem("source");
  const confirmed=form.elements.namedItem("confirmed"), result=$("xsp-scan-result"), dateInfo=$("xsp-scan-expiry");
  const cap=250000;
  const USD=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"});
  const POINT=new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:4});
  const HK=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Hong_Kong",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  const ET=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
  let shownExpiry=null;
  let fileVersion=0;

  function n(tag,text,cls) {
    const node=document.createElement(tag);
    if(text!==undefined) node.textContent=text;
    if(cls) node.className=cls;
    return node;
  }
  function error(text) {result.replaceChildren(n("p",text,"empty-block")); }
  function timeHkt(date) {
    const dt=typeof date==="string"?Date.parse(date):NaN;
    return Number.isFinite(dt)?HK.format(dt).replace(",","")+" HKT":"即時盤口時間未提供";
  }
  function dayEt(date){
    const dt=typeof date==="string"?Date.parse(date):NaN;
    if(!Number.isFinite(dt))return null;
    const p=Object.fromEntries(ET.formatToParts(dt).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
    return p.year+"-"+p.month+"-"+p.day;
  }
  function schedule() {
    const session=window.SpsXspSession.next();
    if(!session.known) {
      dateInfo.textContent="交易日日曆未有覆蓋，暫停 1DTE 自動配對。";
      return session;
    }
    const nextText=(session.isPlanned?"下一個正常交易時段":"今個正常交易時段")+"（美東 "+session.entryDate+"）→ 1DTE 目標："+session.expiry+" 到期";
    if(dateInfo.textContent!==nextText)dateInfo.textContent=nextText;
    if(shownExpiry!==session.expiry) {
      if(shownExpiry!==null) {
        result.replaceChildren();
        confirmed.checked=false;
      }
      if(!expiry.value || expiry.value===shownExpiry) expiry.value=session.expiry;
      shownExpiry=session.expiry;
    }
    return session;
  }
  function table(head, rows) {
    const t=n("table"),h=n("thead"),tr=n("tr");
    for(const text of head){const th=n("th",text);th.scope="col";tr.append(th);}
    h.append(tr);t.append(h);
    const body=n("tbody");
    for(const vals of rows){
      const r=n("tr");
      vals.forEach((v,i)=>{const c=n(i===0?"th":"td",v);if(i===0)c.scope="row";r.append(c);});
      body.append(r);
    }
    t.append(body);return t;
  }
  function fact(parent,title,value,note) {
    const card=n("div",undefined,"quote-fact");
    card.append(n("small",title),n("strong",value),n("small",note));parent.append(card);
  }
  function show(scan,session,cboe) {
    const b=scan.best;
    const header=n("p",undefined,"scan-snapshot-title");
    const tag=n("span",cboe?"Cboe 延遲快照":"券商快照 · 手動匯入","pill warning-pill");
    header.append(n("strong","最接近 −0.10Δ 嘅完整組合"),document.createTextNode(" "),tag);
    const market=n("p","XSP put · "+b.expiry+" 到期（美東） · 闊度 15 點","micro-note");
    const prices=table(["方向","行使價","Delta","Bid","Ask","逐腿報價時間"],[
      ["賣 Short put",POINT.format(b.shortStrike),b.shortDelta.toFixed(3),POINT.format(b.shortBid),POINT.format(b.shortAsk),timeHkt(b.shortQuoteAsOf)],
      ["買 Long put",POINT.format(b.longStrike),Number.isFinite(b.longDelta)?b.longDelta.toFixed(3):"—",POINT.format(b.longBid),POINT.format(b.longAsk),timeHkt(b.longQuoteAsOf)]
    ]);
    const cards=n("div",undefined,"quote-facts");
    fact(cards,"參考淨收金",POINT.format(b.credit)+" 點／"+USD.format(b.maxProfit),"Short bid − Long ask，未扣費");
    fact(cards,"最大到期虧損／套",USD.format(b.maxLoss),"(15 − credit) × $100，未計費");
    fact(cards,"到期打和點",POINT.format(b.breakEven),"Short strike − credit，未計費");
    result.replaceChildren(header,market,prices,cards);
    if(scan.candidates.length>1){
      const detail=n("details",undefined,"mini-details");
      detail.append(n("summary","其他合資格配對（最多五組）"),table(["Short","Long","Short Δ","參考 credit"],scan.candidates.slice(1,6).map(c=>[
        POINT.format(c.shortStrike),POINT.format(c.longStrike),c.shortDelta.toFixed(3),POINT.format(c.credit)+" 點"
      ])));
      result.append(detail);
    }
    const tips=[...(scan.warnings||[])];
    if(cboe?.displayAsOf)tips.push("Cboe 畫面時間："+cboe.displayAsOf+"；唔係逐腿報價時間。");
    if([b.shortQuoteAsOf,b.longQuoteAsOf].some(x=>x && dayEt(x)!==session.entryDate))tips.push("提供嘅逐腿時間同目標入場日唔同，只作計劃參考。");
    if(tips.length) {
      const notes=n("ul",undefined,"checklist-list");
      for(const tip of tips) notes.append(n("li",tip));
      result.append(notes);
    }
    result.append(n("p","呢個係所貼快照嘅配對。落單前以券商當刻嘅 combo 價同費用核對。","micro-note"));
  }
  form.addEventListener("submit",event=>{
    event.preventDefault();
    const session=schedule();
    if(!session.known)return error("未能核對下一交易日，暫停篩選。");
    if(expiry.value!==session.expiry)return error("到期日唔符。按美東交易日日曆，今次 1DTE 係 "+session.expiry+"。");
    if(!confirmed.checked)return error("請先確認原生 XSP put 同到期日。");
    let text=input.value;
    if(!text.trim() || text.length>cap)return error("請貼上或匯入 250 KB 以下嘅 XSP put 期權鏈。");
    const adapted=window.SpsXspCboePaste?.convert(text,{expiry:session.expiry,confirmedXsp:true});
    if(adapted?.status==="input_error")return error(adapted.message||"未能確認 Cboe 表格嘅 puts 同到期日。");
    if(adapted?.status==="ready")text=adapted.csv;
    const scan=window.SpsXspChain.select(text,{expiry:session.expiry});
    if(scan.status==="input_error")return error(scan.errors.join(" "));
    if(scan.status==="no_expiry")return error("所貼資料搵唔到 "+session.expiry+" 到期嘅 XSP puts。");
    if(!scan.best){
      const d=scan.diagnostics;
      return error(d.deltaEligible===0 ? "冇 short put 同時有 −0.15 至 −0.05 delta、有效 bid／ask 同至少 0.05 bid。" :
        "冇完整 W15 配對。已有 "+d.deltaEligible+" 個 short 候選；請確保貼齊低 15 點嘅 put 同兩腿盤口，而 credit 要大過零。");
    }
    show(scan,session,adapted?.status==="ready"?adapted:source.value==="cboe"?{}:null);
  });
  file.addEventListener("change",async()=>{
    const version=++fileVersion;
    const selected=file.files?.[0];
    if(!selected)return;
    if(selected.size>cap){file.value="";return error("檔案太大；只需匯入目標到期日嘅 XSP puts，最多 250 KB。");}
    try {
      const text=await selected.text();
      if(version!==fileVersion)return;
      if(text.includes("\u0000")){file.value="";return error("請匯入 UTF-8 CSV 或純文字表格。");}
      input.value=text;confirmed.checked=false;result.replaceChildren();
    } catch{if(version===fileVersion)error("讀唔到呢個表格，請用 UTF-8 CSV 或直接貼上。");}
  });
  for(const field of [input,expiry,source,confirmed])field.addEventListener("input",()=>result.replaceChildren());
  $("xsp-scan-clear").addEventListener("click",()=>{
    fileVersion++;input.value="";file.value="";confirmed.checked=false;result.replaceChildren();input.focus();
  });
  schedule();
  window.setInterval(schedule,30000);
})();
