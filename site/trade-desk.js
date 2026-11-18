/* Manual paper records only. No network, brokerage connection, or live signal. */
(() => {
  'use strict';
  const KEY = 'sps.manual-paper.v1';
  const FEE = 2.80;
  const MULTIPLIER = 100;
  const money = n => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(n);
  const point = n => Number(n).toFixed(2);
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + 'T12:00:00Z')) &&
    new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
  const validStamp = value => !value || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) &&
    validDate(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60;

  function mount() {
    const desk = document.getElementById('strike-desk');
    if (!desk || desk.dataset.manualMounted) return;
    desk.dataset.manualMounted = 'true';
    desk.classList.add('panel', 'anchor-section', 'trade-desk');
    desk.setAttribute('aria-labelledby', 'td-title');
    desk.innerHTML = `
      <div class="section-heading"><div><span class="eyebrow">MANUAL PAPER DESK</span><h2 id="td-title">用真盤口，手動做記錄</h2></div><span class="pill neutral-pill">紙上記錄 · 無落單功能</span></div>
      <p class="section-intro">輸入同一到期日嘅兩隻 put，核對開倉同平倉兩邊價。所有欄位由你填；唔會自動代入模型價或網站市場帶。</p>
      <form id="td-form" novalidate>
        <div class="td-fields">
          <label>標的<select name="ticker"><option>XSP</option><option>SPY</option></select></label>
          <label>入場日 · 美國 ET<input name="entry_date" type="date" required></label>
          <label>兩腿到期日 · 美國日期<input name="expiry" type="date" required></label>
          <label>報價時間 · ET（選填）<input name="quote_et" type="datetime-local" step="60"><small>直接填紐約時鐘，唔係你部機嘅時區。</small></label>
          <label>Short put strike<input name="short_strike" type="number" inputmode="decimal" step="any" min="0.01" placeholder="請填行使價" required></label>
          <label>Long put strike<input name="long_strike" type="number" inputmode="decimal" step="any" min="0.01" placeholder="較低行使價" required></label>
          <label>Short put delta · 帶負號<input name="delta" type="number" inputmode="decimal" step="any" min="-1" max="-0.0001" placeholder="例如 −0.10" required></label>
          <label>紙上套數<input name="quantity" type="number" step="1" min="1" max="1000" value="1" required></label>
        </div>
        <div class="td-legs">
          <fieldset><legend>Short put · 開倉睇 bid，平倉睇 ask</legend><div class="td-quote-fields"><label>Short bid<input name="short_bid" type="number" inputmode="decimal" step="any" min="0" placeholder="每股／點" required></label><label>Short ask<input name="short_ask" type="number" inputmode="decimal" step="any" min="0" placeholder="每股／點" required></label></div></fieldset>
          <fieldset><legend>Long put · 開倉睇 ask，平倉睇 bid</legend><div class="td-quote-fields"><label>Long bid<input name="long_bid" type="number" inputmode="decimal" step="any" min="0" placeholder="每股／點" required></label><label>Long ask<input name="long_ask" type="number" inputmode="decimal" step="any" min="0" placeholder="每股／點" required></label></div></fieldset>
        </div>
        <details class="td-session"><summary>下一交易日到期有冇核實？</summary><p>唔會靠「加一日」或者星期幾判斷。週末同假期要查交易所日曆。</p><div class="td-quote-fields"><label>獨立核對嘅下一交易日（選填）<input name="verified_next_session" type="date"></label><label>日曆來源／核對記錄（選填）<input name="calendar_reference" type="text" maxlength="240" placeholder="你所查嘅官方日曆或記錄"></label></div></details>
        <div class="td-actions"><button type="submit" class="primary-button">核對盤口同風險</button><button id="td-save" type="button" class="secondary-button">保存紙上開倉</button><span>每套 100 乘數；模型來回費 $2.80／套</span></div>
      </form>
      <div id="td-errors" class="form-error" role="alert" hidden></div>
      <div id="td-results" class="td-results" aria-live="polite"><p class="td-empty">填齊 bid／ask 同合約資料，再核對。未填嘅價唔當 $0。</p></div>
      <details class="td-checklist"><summary>實際跟蹤，每次核對呢幾項</summary><ol><li>兩腿係 put、同到期、同套數；short strike 高過 long strike。核實 delta 時點及上市行使價。</li><li>記錄美國入場日、到期日、ET 時鐘、報價來源。先獨立查下一交易日，再查 SMA200 及已公布事件日曆。</li><li>開倉用 short bid − long ask；平倉用 short ask − long bid。報價可延遲，零 long bid 只當零回收估值。</li><li>真實成交價、滑價同 broker 總費用另對成交單。本區固定 $2.80 模型費；SPY 美式指派及資金需求另查。</li><li>每日對未平倉數、已實現／未實現損益及帳戶風險額；紙上記錄唔會執行止蝕或滾倉。</li></ol></details>
      <div class="td-record-heading"><h3>今個瀏覽器嘅紙上記錄</h3><button id="td-export" class="secondary-button" type="button">匯出 CSV</button></div>
      <p id="td-storage-note" class="td-note">只存喺同一瀏覽器，唔會上傳。清除網站資料或轉瀏覽器會睇唔返；可先匯出。</p>
      <div id="td-records"></div><p id="td-notice" class="td-note" role="status" aria-live="polite"></p>`;

    const form = desk.querySelector('#td-form');
    const result = desk.querySelector('#td-results');
    const errors = desk.querySelector('#td-errors');
    const notice = desk.querySelector('#td-notice');
    const recordsNode = desk.querySelector('#td-records');
    let records = [];
    let storageAvailable = true;
    let exitId = null;
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(stored)) throw new Error('invalid storage');
      records = stored.filter(validRecord);
      if (records.length !== stored.length) notice.textContent = '部分舊記錄格式不合，未載入。';
    } catch (_) {
      storageAvailable = false;
      desk.querySelector('#td-storage-note').textContent = '本機儲存未可用。今次只暫存在頁面，重新載入會消失；可先匯出 CSV。';
    }
    function storeRecords() {
      if (!storageAvailable) return false;
      try { localStorage.setItem(KEY, JSON.stringify(records)); return true; }
      catch (_) {
        storageAvailable = false;
        desk.querySelector('#td-storage-note').textContent = '保存失敗，暫存在頁面，重新載入會消失。請先匯出 CSV。';
        return false;
      }
    }
    function getInput() {
      const values = Object.fromEntries(new FormData(form));
      for (const key of ['short_strike', 'long_strike', 'delta', 'quantity', 'short_bid', 'short_ask', 'long_bid', 'long_ask']) {
        values[key] = String(values[key] || '').trim() === '' ? NaN : Number(values[key]);
      }
      values.calendar_reference = values.calendar_reference.trim();
      return values;
    }
    function validate(v) {
      const issues = [];
      if (!['SPY', 'XSP'].includes(v.ticker)) issues.push('請揀 SPY 或 XSP。');
      if (!validDate(v.entry_date) || !validDate(v.expiry)) issues.push('請填有效嘅美國入場日同到期日。');
      else if (v.expiry <= v.entry_date) issues.push('到期日要遲過入場日。');
      if (!validStamp(v.quote_et)) issues.push('報價時間格式不合。');
      if (v.quote_et && v.quote_et.slice(0, 10) !== v.entry_date) issues.push('開倉報價嘅 ET 日期要同入場日一致。');
      if (![v.short_strike, v.long_strike].every(n => Number.isFinite(n) && n > 0) || v.short_strike <= v.long_strike) issues.push('Short strike 要高過 long strike，兩者都要大過零。');
      if (!Number.isFinite(v.delta) || v.delta >= 0 || v.delta < -1) issues.push('Put delta 要帶負號，介乎 −1 同 0 之間。');
      if (!Number.isInteger(v.quantity) || v.quantity < 1 || v.quantity > 1000) issues.push('套數要係 1–1,000 嘅整數。');
      if (!['short_bid', 'short_ask', 'long_bid', 'long_ask'].every(k => Number.isFinite(v[k]) && v[k] >= 0)) issues.push('四個 bid／ask 都要填，並且唔可以負數。');
      else {
        if (v.short_ask < v.short_bid || v.long_ask < v.long_bid) issues.push('Ask 唔可以低過同一腿嘅 bid。');
        if (v.long_bid > v.short_bid || v.long_ask > v.short_ask) issues.push('較低 strike put 價格高過 short put，請核對合約、時間同盤口。');
        if (!(v.short_bid - v.long_ask > 0 && v.short_bid - v.long_ask < v.short_strike - v.long_strike)) issues.push('Credit 要正數，並低過實際價差闊度。');
      }
      if (v.verified_next_session && !validDate(v.verified_next_session)) issues.push('核對嘅交易日格式不合。');
      else if (v.verified_next_session && validDate(v.entry_date) && v.verified_next_session <= v.entry_date) issues.push('核對嘅下一交易日要遲過入場日。');
      if (Boolean(v.verified_next_session) !== Boolean(v.calendar_reference)) issues.push('要標示已核對下一交易日，請同時填日期同來源。');
      return issues;
    }
    function calculate(v) {
      const width = v.short_strike - v.long_strike;
      const credit = v.short_bid - v.long_ask;
      const debit = v.short_ask - v.long_bid;
      return {width, credit, debit, max_profit: credit * MULTIPLIER - FEE,
        max_loss: (width - credit) * MULTIPLIER + FEE,
        breakeven: v.short_strike - credit + FEE / MULTIPLIER,
        immediate_net: (credit - debit) * MULTIPLIER - FEE};
    }
    function check() {
      const v = getInput();
      const issues = validate(v);
      errors.hidden = !issues.length;
      errors.textContent = issues.join(' ');
      if (issues.length) { result.replaceChildren(el('p', '請先修正欄位，再保存。', 'td-empty')); return null; }
      const c = calculate(v);
      result.replaceChildren();
      const header = el('div', undefined, 'td-result-heading');
      header.append(el('strong', `${v.ticker} ${v.short_strike}／${v.long_strike} put spread · ${v.expiry}`));
      result.append(header);
      const summary = el('div', undefined, 'td-summary');
      const metrics = [
        ['開倉自然 credit', `${point(c.credit)} 點`, `${money(c.credit * 100)}／套，未扣費`],
        ['同盤口平倉 debit', `${point(c.debit)} 點`, 'Short ask − long bid'],
        ['模型最大淨利', money(c.max_profit * v.quantity), `${money(c.max_profit)}／套，已留來回費`],
        ['模型最大虧損', money(c.max_loss * v.quantity), `${money(c.max_loss)}／套，已留來回費`],
        ['到期打和價', point(c.breakeven), '含 $2.80／套費用口徑'],
        ['即開即平估值', money(c.immediate_net * v.quantity), '同一份盤口＋來回費，唔係已實現 PnL']];
      metrics.forEach(([label, value, note]) => { const card = el('div'); card.append(el('span', label), el('strong', value), el('small', note)); summary.append(card); });
      result.append(summary);
      const session = !v.verified_next_session ? '下一交易日到期：未知，未核實交易所日曆。' : v.verified_next_session === v.expiry ? '下一交易日到期：你已手動核對（網站未獨立驗證）。' : '下一交易日到期：唔符合你所填嘅交易日。';
      const nominal = v.ticker === 'XSP' ? Math.abs(c.width - 15) < 1e-8 : c.width >= 13 && c.width <= 17;
      result.append(el('p', `${session} 實際闊度 ${point(c.width)}：${nominal ? (v.ticker === 'XSP' ? '符合精確 W15' : '落喺研究名義 W15 嘅 13–17 點範圍') : '唔屬原 W15 研究規格'}。`, 'td-note'));
      if (v.long_bid === 0) result.append(el('p', 'Long bid = 0：只估零回收，未證明可以平兩腿。', 'td-warning'));
      if (Math.abs(v.delta + 0.10) > 0.05 + 1e-10) result.append(el('p', 'Short delta 唔喺原研究約 −0.10（±0.05）範圍；記錄唔代表原規則。', 'td-warning'));
      if (c.max_profit <= 0) result.append(el('p', '收取 credit 未覆蓋模型來回費，模型最大淨利不大於零。', 'td-warning'));
      result.append(el('p', '最大損失係同到期、同套數價差到期模型，唔係 broker 保證金或實際出場保證。呢度按兩腿報價估算；唔代表有同時可成交嘅組合盤。', 'td-note'));
      return {values: v, metrics: c};
    }
    form.addEventListener('submit', e => { e.preventDefault(); check(); });
    form.addEventListener('input', () => {
      result.replaceChildren(el('p', '欄位有更新，請重新核對盤口同風險。', 'td-empty'));
      errors.hidden = true;
    });
    desk.querySelector('#td-save').addEventListener('click', () => {
      const checked = check(); if (!checked) return;
      const v = checked.values;
      const duplicate = records.some(r => JSON.stringify(r.entry) === JSON.stringify(v));
      if (duplicate) { notice.textContent = '相同紙上開倉已存在；如係另一單，先記錄唔同報價時間。'; return; }
      records.push({id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, entry: v, saved_at: new Date().toISOString(), exit: null});
      const saved = storeRecords(); renderRecords(); notice.textContent = saved ? '已保存紙上開倉，未有落單。' : '只暫存在今次頁面；請先匯出。';
    });

    function validRecord(r) {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || r.id.length > 120 || !r.entry || typeof r.entry !== 'object') return false;
      const v = r.entry;
      if (!['SPY', 'XSP'].includes(v.ticker) || !validDate(v.entry_date) || !validDate(v.expiry) || v.expiry <= v.entry_date) return false;
      if (!['short_strike', 'long_strike', 'delta', 'quantity', 'short_bid', 'short_ask', 'long_bid', 'long_ask'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k]))) return false;
      if (v.short_strike <= v.long_strike || v.long_strike <= 0 || v.delta >= 0 || v.delta < -1 || !Number.isInteger(v.quantity) || v.quantity < 1 || v.quantity > 1000) return false;
      if (Math.min(v.short_bid, v.long_bid) < 0 || v.short_ask < v.short_bid || v.long_ask < v.long_bid || !(v.short_bid - v.long_ask > 0 && v.short_bid - v.long_ask < v.short_strike - v.long_strike)) return false;
      if (typeof v.calendar_reference !== 'string' || v.calendar_reference.length > 240 || typeof v.quote_et !== 'string' || !validStamp(v.quote_et)) return false;
      if (v.quote_et && v.quote_et.slice(0, 10) !== v.entry_date) return false;
      if (r.exit && (!['short_ask', 'long_bid'].every(k => typeof r.exit[k] === 'number' && Number.isFinite(r.exit[k]) && r.exit[k] >= 0) || !validDate(r.exit.date) || r.exit.date < v.entry_date || r.exit.short_ask < r.exit.long_bid || r.exit.date > v.expiry || !validStamp(r.exit.quote_et))) return false;
      return true;
    }
    function exitForm(record) {
      const wrap = el('form', undefined, 'td-exit-form'); wrap.noValidate = true;
      const title = el('strong', '紙上平倉 · 原行使價同到期日保持固定'); wrap.append(title);
      const grid = el('div', undefined, 'td-fields');
      for (const [name, label, type] of [['date', '平倉日 · 美國 ET', 'date'], ['quote_et', '平倉時間 · ET（選填）', 'datetime-local'], ['short_ask', '買回 short：當刻 ask', 'number'], ['long_bid', '賣出 long：當刻 bid', 'number']]) {
        const lab = el('label', label); const input = el('input'); input.name = name; input.type = type;
        if (type === 'number') { input.min = '0'; input.step = 'any'; input.inputMode = 'decimal'; }
        if (type === 'datetime-local') input.step = '60'; else input.required = true;
        if (type === 'date') { input.min = record.entry.entry_date; input.max = record.entry.expiry; }
        lab.append(input); grid.append(lab);
      }
      const actions = el('div', undefined, 'td-actions'); const save = el('button', '保存紙上平倉', 'secondary-button'); save.type = 'submit';
      const cancel = el('button', '取消', 'secondary-button'); cancel.type = 'button'; cancel.addEventListener('click', () => { exitId = null; renderRecords(); }); actions.append(save, cancel);
      const message = el('p', '', 'td-warning'); message.setAttribute('role', 'alert'); wrap.append(grid, actions, message);
      wrap.addEventListener('submit', e => {
        e.preventDefault(); const v = Object.fromEntries(new FormData(wrap));
        if (!validDate(v.date) || v.date < record.entry.entry_date || v.date > record.entry.expiry || !validStamp(v.quote_et) || (v.quote_et && v.quote_et.slice(0, 10) !== v.date)) { message.textContent = '請核對平倉日及 ET 時間；只可喺入場日至到期日之間。'; return; }
        if (record.entry.quote_et && v.quote_et && v.quote_et < record.entry.quote_et) { message.textContent = '平倉時間唔可以早過入場時間。'; return; }
        for (const k of ['short_ask', 'long_bid']) v[k] = v[k].trim() === '' ? NaN : Number(v[k]);
        if (![v.short_ask, v.long_bid].every(n => Number.isFinite(n) && n >= 0) || v.short_ask < v.long_bid) { message.textContent = 'Short ask 同 long bid 都要有非負數，平倉 debit 唔可以負數。'; return; }
        record.exit = v; storeRecords(); exitId = null; renderRecords(); notice.textContent = '已記錄紙上平倉；按自然價扣模型費計算，唔係 broker 成交紀錄。';
      });
      return wrap;
    }
    function renderRecords() {
      recordsNode.replaceChildren();
      if (!records.length) { recordsNode.append(el('p', '未有紙上開倉。保存後，可逐單記錄平倉盤口。', 'td-empty')); return; }
      const view = el('div', undefined, 'td-table-wrap'); const table = el('table', undefined, 'td-table');
      const caption = el('caption', '紙上記錄 · PnL 只按你輸入嘅盤口及模型費'); table.append(caption);
      const head = el('thead'); const line = el('tr'); ['標的／到期', 'Short／Long', '開倉／套數', '狀態／淨 PnL', '記錄操作'].forEach(t => line.append(el('th', t))); head.append(line); table.append(head);
      const body = el('tbody');
      [...records].reverse().forEach(r => {
        const tr = el('tr'); const c = calculate(r.entry);
        const name = el('td', `${r.entry.ticker} · ${r.entry.expiry}`); name.append(el('small', `入場 ${r.entry.entry_date}${r.entry.quote_et ? ` ${r.entry.quote_et.slice(11)} ET` : ' · 時間未填'}`));
        const credit = el('td', `${point(c.credit)} 點 × ${r.entry.quantity} 套`);
        const net = r.exit ? (c.credit - (r.exit.short_ask - r.exit.long_bid)) * 100 * r.entry.quantity - FEE * r.entry.quantity : null;
        const state = el('td', r.exit ? money(net) : '未平倉 · 未有已實現 PnL');
        if (r.exit) { state.className = net < 0 ? 'td-negative' : 'td-positive'; state.append(el('small', `${r.exit.date}${r.exit.quote_et ? ` ${r.exit.quote_et.slice(11)} ET` : ''} · 模型扣費`)); }
        const actions = el('td');
        if (!r.exit) { const close = el('button', '記錄平倉', 'secondary-button'); close.type = 'button'; close.addEventListener('click', () => { exitId = exitId === r.id ? null : r.id; renderRecords(); }); actions.append(close); }
        const remove = el('button', '刪除', 'td-delete'); remove.type = 'button'; remove.setAttribute('aria-label', `刪除 ${r.entry.ticker} ${r.entry.entry_date} 紙上記錄`);
        remove.addEventListener('click', () => { records = records.filter(x => x.id !== r.id); storeRecords(); renderRecords(); notice.textContent = '已刪除本機紙上記錄。'; }); actions.append(remove);
        tr.append(name, el('td', `${r.entry.short_strike}／${r.entry.long_strike}`), credit, state, actions); body.append(tr);
        if (exitId === r.id && !r.exit) { const row = el('tr'); const cell = el('td'); cell.colSpan = 5; cell.append(exitForm(r)); row.append(cell); body.append(row); }
      });
      table.append(body); view.append(table); recordsNode.append(view);
    }
    desk.querySelector('#td-export').addEventListener('click', () => {
      if (!records.length) { notice.textContent = '未有記錄可以匯出。'; return; }
      const columns = ['ticker', 'entry_date_et', 'entry_quote_time_et', 'expiry', 'short_strike', 'long_strike', 'signed_short_delta', 'quantity', 'entry_short_bid', 'entry_short_ask', 'entry_long_bid', 'entry_long_ask', 'entry_credit_points', 'round_trip_model_fee_usd', 'verified_next_session_user_supplied', 'calendar_reference_user_supplied', 'exit_date_et', 'exit_quote_time_et', 'exit_short_ask', 'exit_long_bid', 'exit_debit_points', 'paper_net_usd', 'record_type'];
      const rows = records.map(r => { const v = r.entry, c = calculate(v), x = r.exit; return [v.ticker, v.entry_date, v.quote_et, v.expiry, v.short_strike, v.long_strike, v.delta, v.quantity, v.short_bid, v.short_ask, v.long_bid, v.long_ask, c.credit, FEE * v.quantity, v.verified_next_session || '', v.calendar_reference, x?.date || '', x?.quote_et || '', x?.short_ask ?? '', x?.long_bid ?? '', x ? x.short_ask - x.long_bid : '', x ? ((c.credit - (x.short_ask - x.long_bid)) * 100 - FEE) * v.quantity : '', 'MANUAL_PAPER_QUOTES_NOT_FILLS']; });
      const escape = value => { let s = String(value); if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
      const csv = '\uFEFF' + [columns, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'})); const link = el('a'); link.href = url; link.download = 'SPS_manual_paper_records.csv'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice.textContent = '已產生 CSV，包含你嘅手動輸入同模型損益；未傳送任何資料。';
    });
    renderRecords();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
})();
