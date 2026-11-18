/* Normalize user-copied Cboe table text locally. No fetch, clipboard access, or storage. */
(() => {
  "use strict";

  const COLUMNS="Last Net Bid Ask Vol IV Delta Gamma Int";
  const MONTHS="JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(" ");
  const DATE_FRAGMENT="(?:[A-Za-z]{3,9}\\s+)?[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}";
  const HEADER="expiry,strike,delta,bid,ask,symbol,type";
  const DECIMAL=/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\.\d+)%?$/;
  const MISSING=/^(?:-|--|—|–|N\/A|NA|N\.A\.|null)$/i;

  function dateIso(x) {
    if (!x) return null;
    const text=x.trim();
    let y,m,d;
    const iso=/^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (iso) [,y,m,d]=iso.map((v,i)=>i ? Number(v) : v);
    else {
      const mm=/^(?:[A-Za-z]{3,9}\s+)?([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
      if (!mm) return null;
      m=MONTHS.indexOf(mm[1].slice(0,3).toUpperCase())+1; d=Number(mm[2]); y=Number(mm[3]);
    }
    if(y<2000 || y>2100 || !m || m>12 || !d || d>31) return null;
    const time=new Date(Date.UTC(y,m-1,d));
    if(time.getUTCMonth()!==m-1 || time.getUTCDate()!==d) return null;
    return time.toISOString().slice(0,10);
  }

  const containsHeader=(text,phrase)=>new RegExp("\\b"+phrase.replaceAll(" ","\\s+")+"\\b","ig").test(text);
  const numberToken=x=>typeof x==="string" && DECIMAL.test(x) && !x.endsWith("%") ? Number(x.replaceAll(",","")) : NaN;
  const validQuoteCell=x=>typeof x==="string" && (DECIMAL.test(x) || MISSING.test(x));
  const normalizedText=x=>x.replaceAll("\u2212","-").replaceAll("\u00a0"," ").replaceAll("\u202f"," ")
    .replace(/^\s*\|?[\s|:\-]+\|?\s*$/gm,"").replace(/[\s|]+/g," ").trim();

  function tableEnd(headers,marks,h,text) {
    return text.slice(h.end, Math.min(headers.find(x=>x.index>h.index)?.index??text.length,
      marks.find(x=>x.index>h.index)?.index??text.length));
  }

  function quoteRows(body,{combined}) {
    const parts=body.split(" ");
    const result=[];
    for(let i=0;i<parts.length;i++) {
      if(!/^\^?XSP$/i.test(parts[i])) continue;
      if(combined && (i<9 || parts.slice(i-9,i).some(x=>!validQuoteCell(x)))) continue;
      const strike=numberToken(parts[i+1]);
      const q=parts.slice(i+2,i+11); // last net bid ask vol iv delta gamma int
      if(!Number.isFinite(strike)||strike<=0||q.length!==9||q.some(x=>!validQuoteCell(x))) continue;
      const bid=numberToken(q[2]),ask=numberToken(q[3]),delta=MISSING.test(q[6])?null:numberToken(q[6]);
      if(!Number.isFinite(ask)||!Number.isFinite(bid)||bid<0||ask<=0||bid>ask) continue;
      if(delta!==null && (!Number.isFinite(delta)||delta< -1||delta>0)) continue;
      result.push({strike,delta,bid,ask});
      i+=10;
    }
    return result;
  }

  function convert(input,options={}) {
    const no=(status,message,info={})=>({status,message,csv:null,rows:0,...info});
    if(typeof input!=="string" || !input.trim()) return no("not_cboe",null);
    const crop=input.slice(0,500001);
    const flat=normalizedText(crop);
    const combinedHeader=COLUMNS+" Strike "+COLUMNS;
    const putsHeader="Strike "+COLUMNS;
    const combined=containsHeader(flat,combinedHeader);
    const separate=/\b(?:Calls?|Puts?)\s*\(\s*(?:EXPR|Expiration|Expiry)\s*:/i.test(flat) && containsHeader(flat,putsHeader);
    if(!combined && !separate) return no("not_cboe",null);
    if(input.length>500000) return no("input_error","貼上內容太長，請只複製所選到期日嘅 XSP 期權表。");
    const expiry=dateIso(options.expiry);
    if(!expiry) return no("input_error","未有可核對嘅到期日。");
    const pageTimes=[...new Set(flat.match(/\b\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2} ET(?: \(Delayed\))?/ig)||[])];
    const displayAsOf=pageTimes.length===1?pageTimes[0]:null;
    const heads=[...flat.matchAll(new RegExp("\\b"+(combined?combinedHeader:putsHeader)+"\\b","ig"))]
      .map(x=>({index:x.index,end:x.index+x[0].length}));
    const marker=combined?new RegExp("\\bCalls\\s+("+DATE_FRAGMENT+")\\s+Puts\\b","ig")
      :/\b(Calls?|Puts?)\s*\(\s*(?:EXPR|Expiration|Expiry)\s*:\s*([^)]+)\)/ig;
    const marks=[...flat.matchAll(marker)].map(x=>({
      index:x.index,end:x.index+x[0].length,isPut:combined||/^P/i.test(x[1]),
      expiry:dateIso(combined?x[1]:x[2])
    }));
    const dated=marks.length>0;
    // A partially copied undated single table needs a user's prior confirmation.
    // Never override a visible, conflicting date with the target expiry.
    if(!dated && (!combined || !options.confirmedXsp || heads.length!==1))
      return no("input_error","請連同到期日標題複製，或確認只選咗目標到期日嘅 XSP 表。",{displayAsOf});
    let seenTarget=false;
    const found=[];
    for(const h of heads) {
      const mark=marks.filter(x=>x.end<=h.index).at(-1);
      if(dated && (!mark || (h.index-mark.end)>100 || !mark.isPut || mark.expiry!==expiry)) continue;
      seenTarget=true;
      found.push(...quoteRows(tableEnd(heads,marks,h,flat),{combined}));
    }
    if(!seenTarget) return no("input_error","複製內容冇可識別嘅 "+expiry+" XSP Put 表。請查到期選單後再複製。",{displayAsOf});
    if(!found.length) return no("input_error","搵唔到有效 XSP Put Bid／Ask；請連標題複製完整表，並擴闊行使價範圍。",{displayAsOf});
    const byStrike=new Map();
    for(const row of found) {
      const previous=byStrike.get(row.strike);
      if(previous && (previous.bid!==row.bid||previous.ask!==row.ask||previous.delta!==row.delta))
        return no("input_error","同一 XSP 行使價有不同盤口。請只貼一次快照。",{displayAsOf});
      byStrike.set(row.strike,row);
    }
    const lines=[HEADER];
    for(const q of byStrike.values()) lines.push([expiry,q.strike,q.delta??"",q.bid,q.ask,"XSP","put"].join(","));
    return {status:"ready",message:null,csv:lines.join("\n"),rows:byStrike.size,displayAsOf};
  }

  window.SpsXspCboePaste=Object.freeze({convert});
})();
