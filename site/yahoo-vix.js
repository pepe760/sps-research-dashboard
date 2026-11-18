"use strict";

(() => {
  const input=document.getElementById("yahoo-vix-file");
  const result=document.getElementById("yahoo-vix-result");
  const clear=document.getElementById("yahoo-vix-clear");
  if(!input || !result || !clear) return;
  const source="Yahoo Finance · 手動匯入";
  const event="sps:yahoo-vix-history";
  const maxFile=512*1024;
  const fmt=new Intl.DateTimeFormat("en",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
  const iso=d=>d.toISOString().slice(0,10);
  let load=0;

  // Yahoo daily CSV is comma-delimited, with Date and Close columns. Accept
  // standard quoted fields, BOM and CRLF without turning file data into HTML.
  function rows(text) {
    const out=[];
    let row=[], field="", quoted=false, closed=false;
    text=text.replace(/^\uFEFF/,"");
    function push() {row.push(field);field="";closed=false;}
    function end() {push();if(row.some(value=>value.trim()!=="")) out.push(row);row=[];}
    for(let i=0;i<text.length;i++) {
      const ch=text[i];
      if(quoted) {
        if(ch==='"' && text[i+1]==='"') {field+='"';i++;}
        else if(ch==='"') {quoted=false;closed=true;}
        else field+=ch;
      } else if(ch===",") push();
      else if(ch==="\n" || ch==="\r") {if(ch==="\r" && text[i+1]==="\n") i++;end();}
      else if(ch==='"' && field==="" && !closed) quoted=true;
      else if(closed || ch==='"') throw Error("CSV 嘅引號格式唔正確。");
      else field+=ch;
    }
    if(quoted) throw Error("CSV 嘅引號未關閉。");
    if(row.length || field || closed) end();
    return out;
  }

  function readHistory(text) {
    const all=rows(text);
    const header=(all.shift()||[]).map(s=>s.trim().toLowerCase());
    if(header.filter(s=>s==="date").length!==1 || header.filter(s=>s==="close").length!==1) throw Error("請提供有 Date 同 Close 欄嘅 Yahoo Finance ^VIX 日線 CSV。");
    const dateCol=header.indexOf("date"), closeCol=header.indexOf("close");
    const part=Object.fromEntries(fmt.formatToParts(new Date()).map(({type,value})=>[type,value]));
    const today=part.year+"-"+part.month+"-"+part.day;
    const [year,month,date]=[part.year,part.month,part.day].map(Number);
    const first=iso(new Date(Date.UTC(year, month-4, Math.min(date,new Date(Date.UTC(year,month-3,0)).getUTCDate()))));
    const data=new Map();
    let omitted=0;
    for(const row of all) {
      const day=row[dateCol]?.trim(), raw=row[closeCol]?.trim();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day||"") || day<first || day>=today) {omitted++;continue;}
      const d=new Date(day+"T00:00:00Z");
      const close=/^\d+(?:\.\d+)?$/.test(raw||"")?Number(raw):NaN;
      if(!Number.isFinite(+d) || iso(d)!==day || [0,6].includes(d.getUTCDay()) || !(Number.isFinite(close) && close>0)) {omitted++;continue;}
      if(data.has(day) && data.get(day)!==close) throw Error("同一日有兩個唔同嘅 Close，請核對 CSV。");
      if(data.has(day)) {omitted++;continue;}
      data.set(day,close);
    }
    const series=Array.from(data,([date,close])=>({date,close})).sort((a,b)=>a.date.localeCompare(b.date));
    if(series.length<2) throw Error("近三個月未有至少兩個有效收市值；美國今日嘅日線會略過。");
    const as_of=series[series.length-1].date;
    const stale=(Date.parse(today)-Date.parse(as_of))>4*86400000;
    return {history:{status:stale?"stale":"available",source,as_of,series},omitted};
  }

  function publish(history,text) {
    result.textContent=text;
    clear.disabled=!history;
    window.dispatchEvent(new CustomEvent(event,{detail:history}));
  }

  clear.disabled=true;
  clear.addEventListener("click",()=>{
    ++load;
    input.value="";
    publish(null,"已清除匯入紀錄。");
  });
  input.addEventListener("change",async()=>{
    const file=input.files?.[0];
    if(!file) return;
    const token=++load;
    result.textContent="讀取檔案中…";
    try {
      if(file.size>maxFile) throw Error("檔案超過 512 KB，請下載最近三個月嘅日線 CSV。");
      const text=await file.text();
      if(token!==load) return;
      const {history,omitted}=readHistory(text);
      publish(history,"已匯入 "+history.series.length+" 個收市值，到 "+history.as_of+"。"+(omitted?" 略過 "+omitted+" 行。":"")+" 只供參考；檔案冇上傳。");
    } catch(e) {
      if(token!==load) return;
      input.value="";
      publish(null,e.message||"讀唔到 CSV。");
    }
  });
})();
