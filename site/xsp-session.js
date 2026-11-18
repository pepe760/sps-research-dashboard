"use strict";

(() => {
  // Cboe C1 Options, RTH column (not Global Trading Hours):
  // https://www.cboe.com/about/hours/us-options/
  // https://www.cboe.com/tradable-products/sp-500/xsp-options/specifications/
  // Use only the two posted years. A computed date is a target, not evidence
  // that an XSP contract with that expiry/settlement has been listed.
  const SOURCE = "https://www.cboe.com/about/hours/us-options/";
  const HOLIDAYS = new Set([
    "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25",
    "2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
    "2027-01-01","2027-01-18","2027-02-15","2027-03-26","2027-05-31",
    "2027-06-18","2027-07-05","2027-09-06","2027-11-25","2027-12-24"
  ]);
  const EARLY = new Set(["2026-11-27","2026-12-24","2027-11-26"]);
  const FIRST = "2026-01-01", LAST = "2027-12-31";
  const OPEN = "09:30", NORMAL_CLOSE = "16:15", STRATEGY_CLOSE = "16:00";
  const ET = new Intl.DateTimeFormat("en-US", {
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"
  });

  function knownDay(day) {
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < FIRST || day > LAST) return null;
    const dt = new Date(day+"T00:00:00.000Z");
    return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0,10)===day ? dt : null;
  }

  function session(day) {
    const dt = knownDay(day);
    if (!dt) return null;
    if (dt.getUTCDay()===0 || dt.getUTCDay()===6 || HOLIDAYS.has(day)) return {closed:true};
    const closeET=EARLY.has(day)?"13:00":NORMAL_CLOSE;
    return {closed:false, closeET, strategyCloseET:closeET < STRATEGY_CLOSE ? closeET : STRATEGY_CLOSE};
  }

  function plusDay(day) {
    const dt = knownDay(day);
    if (!dt) return null;
    dt.setUTCDate(dt.getUTCDate()+1);
    const added = dt.toISOString().slice(0,10);
    return knownDay(added) ? added : null;
  }

  function firstOpen(day) {
    for (let i=0; day && i<10; i++,day=plusDay(day)) {
      const s=session(day);
      if (s && !s.closed) return day;
    }
    return null;
  }

  function result(entryDate, nowET = null, currentRth = false) {
    const s=session(entryDate);
    const expiry = s && !s.closed ? firstOpen(plusDay(entryDate)) : null;
    const known = Boolean(expiry);
    return {
      known, entryDate:known?entryDate:null, expiry, currentRth:known&&currentRth,
      isPlanned:known&&!currentRth, closeET:known?s.closeET:null,
      strategyCloseET:known?s.strategyCloseET:null, openET:known?OPEN:null,
      nowET, sourceUrl:SOURCE
    };
  }

  function next(now = new Date()) {
    // Accept a Date, Unix milliseconds, or explicit-offset timestamp. Refuse
    // machine-local timestamp strings, whose ET conversion would be ambiguous.
    let dt;
    if (Object.prototype.toString.call(now)==="[object Date]") dt=new Date(now.getTime());
    else if (typeof now==="number" || (typeof now==="string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(now))) dt=new Date(now);
    if (!dt || !Number.isFinite(dt.getTime())) return result(null);
    const p=Object.fromEntries(ET.formatToParts(dt).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
    const day=p.year+"-"+p.month+"-"+p.day;
    const hm=p.hour+":"+p.minute, nowET=day+"T"+hm+":"+p.second;
    const s=session(day);
    if (!s) return result(null,nowET);
    const currentRth=!s.closed&&hm>=OPEN&&hm<s.closeET;
    const entry=(!s.closed&&hm<s.closeET)?day:firstOpen(plusDay(day));
    return result(entry,nowET,currentRth);
  }

  window.SpsXspSession=Object.freeze({next,forEntry:day=>result(day)});
})();
