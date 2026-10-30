// 安庫 POS 的介面與 IndexedDB。計算一律交給 core.js。
import * as core from './core.js';

// MARK: - IndexedDB

const DB_NAME = 'anku-pos';
const DB_VERSION = 1;
let dbPromise;

function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('transactions')) {
        db.createObjectStore('transactions', { keyPath: 'posId' }).createIndex('eventId', 'eventId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/// 在一個交易裡執行 work(stores)，等到交易真正寫入（oncomplete）才 resolve。
async function withStores(names, mode, work) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode, { durability: 'strict' });
    const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
    let result;
    const ret = work(stores);
    if (ret && 'onsuccess' in ret) ret.onsuccess = () => { result = ret.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('寫入被中止'));
  });
}

const META_KEYS = ['event', 'items', 'lastExportAt', 'quickMode', 'presets'];

async function loadAll() {
  const meta = {};
  await withStores(['meta'], 'readonly', ({ meta: store }) => {
    for (const key of META_KEYS) {
      const r = store.get(key);
      r.onsuccess = () => { meta[key] = r.result; };
    }
  });
  const transactions = await withStores(['transactions'], 'readonly', ({ transactions: store }) => store.getAll());
  return { meta, transactions: transactions ?? [] };
}

const putMeta = (values) => withStores(['meta'], 'readwrite', ({ meta }) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) meta.delete(key);
    else meta.put(value, key);
  }
});

const putTransaction = (t) => withStores(['transactions'], 'readwrite', ({ transactions }) => { transactions.put(t); });

const clearEventData = () => withStores(['meta', 'transactions'], 'readwrite', ({ meta, transactions }) => {
  transactions.clear();
  for (const key of ['event', 'items', 'lastExportAt']) meta.delete(key);
});

// MARK: - 狀態

const state = {
  event: null,
  items: [],
  transactions: [],
  lastExportAt: null,
  quickMode: false,
  presets: [],
  basket: [],
  discount: { type: 'amount', value: '' },
  view: 'register',
  search: '',
  category: null,
  selectedDay: null,
  drawerOpen: false,
};

const $ = (id) => document.getElementById(id);
const decimals = () => core.currencyDecimals(state.event?.currencyCode ?? 'TWD');
const today = () => core.localDateString(new Date());
const eventTransactions = () => state.transactions.filter((t) => t.eventId === state.event?.id);

let moneyFormatter;
function money(minor) {
  const code = state.event?.currencyCode ?? 'TWD';
  if (moneyFormatter?.resolvedOptions().currency !== code) {
    const d = core.currencyDecimals(code);
    moneyFormatter = new Intl.NumberFormat('zh-TW', { style: 'currency', currency: code, minimumFractionDigits: d, maximumFractionDigits: d });
  }
  return moneyFormatter.format(core.fromMinor(minor, decimals()));
}

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => escapeMap[c]);

function formatTime(ms) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return core.localDateString(d) === today() ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function dayChipLabel(date) {
  const [, m, d] = date.split('-').map(Number);
  const label = core.eventDayLabel(core.eventDay(state.event, date));
  return `${m}/${d} ${label}${date === today() ? ' · 今天' : ''}`;
}

// MARK: - 頂部列

function renderTopbar() {
  const event = state.event;
  $('topbar').hidden = !event;
  if (!event) return;
  $('event-name').textContent = event.name;
  const info = core.eventDay(event, today());
  const badge = $('day-badge');
  badge.textContent = core.eventDayLabel(info);
  badge.classList.toggle('warn', info.phase !== 'during');
  badge.title = info.phase === 'during' ? '' : `活動日期 ${event.startDate} – ${event.endDate}`;

  const summary = core.daySummary(eventTransactions(), today());
  $('today-revenue').textContent = money(summary.revenue);
  $('today-count').textContent = summary.count;
  $('quick-toggle').checked = state.quickMode;

  const pending = core.unexportedCount(eventTransactions(), state.lastExportAt);
  const remind = core.needsExportReminder(eventTransactions(), state.lastExportAt, Date.now());
  const status = $('export-status');
  const last = state.lastExportAt ? `上次匯出 ${formatTime(state.lastExportAt)}` : '尚未匯出';
  status.textContent = remind
    ? `⚠︎ 超過 12 小時未匯出（${pending} 筆變更）`
    : pending ? `${last} · ${pending} 筆未匯出` : last;
  status.classList.toggle('warn', remind);

  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === state.view));
  }
}

// MARK: - 商品格

/// 類別膠囊：點一下只顯示該類別，「全部」顯示所有；只有一個類別時不顯示。
function renderCategoryChips() {
  const groups = core.groupByCategory(state.items);
  if (!groups.some((g) => g.category === state.category)) state.category = null;
  const chips = $('category-chips');
  chips.hidden = groups.length < 2;
  const chip = (category, label, count) =>
    `<button type="button" role="tab" data-category="${esc(category ?? '')}" aria-selected="${category === state.category}">${esc(label)} <span class="count">${count}</span></button>`;
  chips.innerHTML = chip(null, '全部', state.items.length)
    + groups.map((g) => chip(g.category, g.category, g.items.length)).join('');
}

function renderGrid() {
  const grid = $('grid');
  renderCategoryChips();
  const items = state.items.filter((i) => (state.category === null || i.category === state.category) && core.matchesSearch(i, state.search));
  if (items.length === 0) {
    grid.innerHTML = `<p class="no-results">${state.items.length ? '找不到符合的商品' : '帶貨檔沒有品項'}</p>`;
    return;
  }
  grid.innerHTML = core.groupByCategory(items).map((group) => `
    <section class="category">
      ${state.category === null ? `<h2>${esc(group.category)}</h2>` : ''}
      <div class="cards">${group.items.map((item) => `
        <button type="button" class="card" data-variant="${esc(item.variantKey)}">
          ${item.photo
            ? `<img class="photo" src="${esc(item.photo)}" alt="" loading="lazy" decoding="async">`
            : `<span class="photo" aria-hidden="true">${esc(item.variantName.slice(0, 1) || item.productName.slice(0, 1))}</span>`}
          <span class="info">
            <span class="variant">${esc(item.variantName || item.productName)}</span>
            <span class="product">${esc(item.variantName ? item.productName : '')}</span>
            <span class="meta"><span class="price">${money(item.priceMinor)}</span><span class="sold"></span></span>
          </span>
        </button>`).join('')}
      </div>
    </section>`).join('');
  updateGridState();
}

/// 只更新已售數、變灰與購物籃數量，不重建商品格（避免照片重新解碼）。
function updateGridState() {
  const sold = core.soldByVariant(eventTransactions());
  const inBasket = new Map();
  for (const l of state.basket) if (l.variantKey) inBasket.set(l.variantKey, (inBasket.get(l.variantKey) ?? 0) + l.quantity);
  const byKey = new Map(state.items.map((i) => [i.variantKey, i]));
  for (const card of document.querySelectorAll('.card')) {
    const item = byKey.get(card.dataset.variant);
    if (!item) continue;
    const n = sold.get(item.variantKey) ?? 0;
    const soldOut = n >= item.broughtQty;
    card.classList.toggle('sold-out', soldOut);
    card.querySelector('.sold').textContent = `已售 ${n}／${item.broughtQty}`;
    card.setAttribute('aria-label', `${core.itemDisplayName(item)}，${money(item.priceMinor)}，已售 ${n} 件，帶去 ${item.broughtQty} 件`);
    let tag = card.querySelector('.in-basket');
    const q = inBasket.get(item.variantKey);
    if (q && !tag) {
      tag = document.createElement('span');
      tag.className = 'in-basket';
      card.append(tag);
    }
    if (tag) {
      if (q) tag.textContent = q;
      else tag.remove();
    }
  }
}

// MARK: - 購物籃

function addToBasket(item) {
  const existing = state.basket.find((l) => l.variantKey === item.variantKey && l.unitPriceMinor === item.priceMinor && !l.edited);
  if (existing) existing.quantity += 1;
  else state.basket.push({ id: core.uuid(), variantKey: item.variantKey, name: core.itemDisplayName(item), quantity: 1, unitPriceMinor: item.priceMinor, listPriceMinor: item.priceMinor, edited: false });
  renderBasket();
}

function basketTotals() {
  return core.computeTotals(state.basket, state.discount, decimals());
}

function renderBasket() {
  const list = $('basket-lines');
  list.innerHTML = state.basket.length === 0
    ? `<li class="empty">點左邊的商品加入購物籃</li>`
    : state.basket.map((l) => `
      <li class="basket-line" data-line="${l.id}">
        <span class="name">${esc(l.name)}</span>
        <span class="line-total">${money(l.quantity * l.unitPriceMinor)}</span>
        <span class="controls">
          <button type="button" class="unit-price${l.edited ? ' edited' : ''}" data-action="edit-price" aria-label="單價 ${money(l.unitPriceMinor)}，點一下修改">單價 ${money(l.unitPriceMinor)}</button>
          <span class="stepper">
            <button type="button" data-action="decrement" aria-label="減少">−</button>
            <span class="qty">${l.quantity}</span>
            <button type="button" data-action="increment" aria-label="增加">＋</button>
          </span>
        </span>
      </li>`).join('');

  for (const b of document.querySelectorAll('[data-discount-type]')) {
    b.setAttribute('aria-selected', String(b.dataset.discountType === state.discount.type));
  }
  const input = $('discount-input');
  if (document.activeElement !== input) input.value = state.discount.value;
  input.placeholder = state.discount.type === 'percent' ? '0 %' : '0';

  const totals = basketTotals();
  $('subtotal').textContent = money(totals.subtotal);
  $('discount-amount').textContent = totals.discount ? `−${money(totals.discount)}` : money(0);
  $('total').textContent = money(totals.total);
  const count = state.basket.reduce((s, l) => s + l.quantity, 0);
  $('checkout').disabled = count === 0;
  $('checkout').textContent = count ? `結帳 ${money(totals.total)}` : '結帳';
  $('handle-text').textContent = count ? `購物籃 ${count} 件 · 實收 ${money(totals.total)}` : '購物籃是空的';
  $('basket').classList.toggle('collapsed', !state.drawerOpen);
  updateGridState();
}

function resetBasket() {
  state.basket = [];
  state.discount = { type: state.discount.type, value: '' };
  $('discount-input').value = '';
  renderBasket();
}

// MARK: - 結帳、作廢

async function checkout(basketLines, discount) {
  const t = core.makeTransaction({
    eventId: state.event.id,
    basketLines,
    discount,
    decimals: decimals(),
    now: new Date(),
    posId: core.uuid(),
  });
  try {
    await putTransaction(t);
  } catch (error) {
    await alertDialog('沒有存到', `交易沒有寫入 iPad：${error?.message ?? error}。請再結帳一次，或改用計數表記錄。`);
    return null;
  }
  state.transactions.push(t);
  renderAfterChange();
  return t;
}

async function checkoutBasket() {
  if (state.basket.length === 0) return;
  const t = await checkout(state.basket, state.discount);
  if (!t) return;
  resetBasket();
  state.drawerOpen = false;
  renderBasket();
  showToast(`已結帳，實收 ${money(t.total)}`, '復原', () => setVoided(t.posId, true, '已復原這筆交易'));
}

async function quickCheckout(item) {
  const t = await checkout([{ variantKey: item.variantKey, name: core.itemDisplayName(item), quantity: 1, unitPriceMinor: item.priceMinor }], null);
  if (t) showToast(`已結帳 ${core.itemDisplayName(item)} ${money(t.total)}`, '復原', () => setVoided(t.posId, true, '已復原這筆交易'));
}

async function setVoided(posId, voided, message) {
  const index = state.transactions.findIndex((t) => t.posId === posId);
  if (index < 0) return;
  const updated = { ...state.transactions[index], voided, modifiedAt: Date.now() };
  try {
    await putTransaction(updated);
  } catch (error) {
    await alertDialog('沒有存到', `變更沒有寫入 iPad：${error?.message ?? error}`);
    return;
  }
  state.transactions[index] = updated;
  renderAfterChange();
  if (message) {
    showToast(message, voided ? '恢復' : '再作廢', () => setVoided(posId, !voided, voided ? '已恢復這筆交易' : '已作廢這筆交易'));
  }
}

async function undoLast() {
  const t = core.lastValidTransaction(eventTransactions());
  if (!t) {
    showToast('沒有可以復原的交易');
    return;
  }
  await setVoided(t.posId, true, `已作廢上一筆（${t.occurredAt.slice(11, 16)}，${money(t.total)}）`);
}

function renderAfterChange() {
  renderTopbar();
  updateGridState();
  if (state.view === 'records') renderRecords();
  if (state.view === 'summary') renderSummary();
}

// MARK: - 交易紀錄、每日摘要

function selectedDay() {
  const dates = core.transactionDates(eventTransactions(), today());
  if (!dates.includes(state.selectedDay)) state.selectedDay = today();
  return { dates, day: state.selectedDay };
}

function renderDayChips(container, dates, day) {
  container.innerHTML = dates.map((d) => `<button type="button" data-day="${d}" aria-selected="${d === day}">${esc(dayChipLabel(d))}</button>`).join('');
}

function renderRecords() {
  const { dates, day } = selectedDay();
  renderDayChips($('records-days'), dates, day);
  const list = eventTransactions()
    .filter((t) => core.localDateOf(t.occurredAt) === day)
    .sort((a, b) => b.createdAt - a.createdAt);
  $('records-list').innerHTML = list.length === 0
    ? `<li class="empty">這天沒有交易</li>`
    : list.map((t) => `
      <li class="record${t.voided ? ' voided' : ''}" data-pos="${t.posId}">
        <span class="record-time">${t.occurredAt.slice(11, 16)}</span>
        <span class="record-lines">
          ${esc(t.lines.map((l) => `${l.name} ×${l.quantity}${l.variantKey ? '' : '（自訂）'}`).join('、'))}
          ${t.discount ? `<span class="note">小計 ${money(t.subtotal)}，折扣 −${money(t.discount)}</span>` : ''}
        </span>
        ${t.voided ? '<span class="voided-tag">已作廢</span>' : ''}
        <span class="record-total">${money(t.total)}</span>
        ${t.voided
          ? `<button type="button" class="btn btn-gray" data-action="restore">恢復</button>`
          : `<button type="button" class="btn btn-gray btn-destructive" data-action="void">作廢</button>`}
      </li>`).join('');
}

function renderSummary() {
  const { dates, day } = selectedDay();
  renderDayChips($('summary-days'), dates, day);
  const s = core.daySummary(eventTransactions(), day);
  const sold = core.soldByVariant(eventTransactions());
  const order = new Map(state.items.map((item, i) => [item.variantKey, i]));
  const byKey = new Map(state.items.map((i) => [i.variantKey, i]));
  const variantRows = s.lines.filter((l) => l.variantKey).sort((a, b) => (order.get(a.variantKey) ?? 1e9) - (order.get(b.variantKey) ?? 1e9));
  const customRows = s.lines.filter((l) => !l.variantKey);

  const rows = [];
  let lastCategory;
  for (const l of variantRows) {
    const item = byKey.get(l.variantKey);
    const category = item?.category ?? '不在帶貨清單';
    if (category !== lastCategory) {
      rows.push(`<tr class="group"><td colspan="4">${esc(category)}</td></tr>`);
      lastCategory = category;
    }
    const total = sold.get(l.variantKey) ?? 0;
    const over = item && total > item.broughtQty;
    rows.push(`<tr><td>${esc(l.name)}</td><td>${l.quantity}</td><td>${money(l.amount)}</td><td${over ? ' class="over" title="POS 售出比帶去數量多，帶去數量可能有誤"' : ''}>${item ? `${total}／${item.broughtQty}` : '—'}</td></tr>`);
  }
  if (customRows.length) {
    rows.push(`<tr class="group"><td colspan="4">自訂品項</td></tr>`);
    for (const l of customRows) rows.push(`<tr><td>${esc(l.name)}</td><td>${l.quantity}</td><td>${money(l.amount)}</td><td>—</td></tr>`);
  }

  $('summary-content').innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="label">營收</div><div class="value">${money(s.revenue)}</div></div>
      <div class="stat"><div class="label">交易數</div><div class="value">${s.count}</div></div>
      <div class="stat"><div class="label">客單價</div><div class="value">${money(s.average)}</div></div>
      <div class="stat"><div class="label">售出件數</div><div class="value">${s.lines.reduce((n, l) => n + l.quantity, 0)}</div></div>
    </div>
    ${rows.length
      ? `<table class="summary">
          <thead><tr><th>品項</th><th>售出</th><th>金額（折扣前）</th><th>累計／帶去</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
        ${s.discount ? `<p class="summary-note">整筆折扣合計 −${money(s.discount)}，營收已扣除。</p>` : ''}`
      : '<ul class="list"><li class="empty">這天沒有交易</li></ul>'}`;
}

// MARK: - 畫面切換

function showView(view) {
  state.view = view;
  const hasEvent = Boolean(state.event);
  $('view-empty').hidden = hasEvent;
  $('view-register').hidden = !hasEvent || view !== 'register';
  $('view-records').hidden = !hasEvent || view !== 'records';
  $('view-summary').hidden = !hasEvent || view !== 'summary';
  renderTopbar();
  if (!hasEvent) return;
  if (view === 'records') renderRecords();
  if (view === 'summary') renderSummary();
}

function renderAll() {
  renderTopbar();
  if (state.event) {
    $('quick-banner').hidden = !state.quickMode;
    renderGrid();
    renderBasket();
  }
  showView(state.view);
}

// MARK: - 提示

let toastTimer;
let toastHandler;
function showToast(text, actionLabel, handler) {
  $('toast-text').textContent = text;
  const action = $('toast-action');
  action.hidden = !actionLabel;
  action.textContent = actionLabel ?? '';
  toastHandler = handler;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() {
  $('toast').hidden = true;
  toastHandler = null;
}

// MARK: - 對話框

/// 顯示對話框。buttons: [{ label, value, style }]，回傳按下的 value（取消或點外面為 'cancel'）。
function openDialog(html, buttons, { onOpen } = {}) {
  const dialog = $('dialog');
  const form = $('dialog-form');
  form.innerHTML = `${html}<div class="dialog-actions">${buttons.map((b) =>
    b === 'spacer' ? '<span class="spacer"></span>'
      : `<button type="submit" class="btn ${b.style ?? 'btn-gray'}" value="${esc(b.value)}">${esc(b.label)}</button>`).join('')}</div>`;
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    // 前一個對話框的 close 事件可能在這個對話框打開後才送到，所以只在真的關掉時 resolve。
    const onClose = () => {
      if (dialog.open) return;
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue || 'cancel');
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    onOpen?.(form);
  });
}

// 在輸入框按 Return 等於按「確定」；否則瀏覽器會送出第一個按鈕（取消）。
$('dialog-form').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.target.tagName !== 'INPUT' || event.isComposing) return;
  event.preventDefault();
  if ($('dialog-form').querySelector('button[value="ok"]')) $('dialog').close('ok');
});

async function confirmDialog(title, message, confirmLabel, { destructive = false, strong = '' } = {}) {
  const result = await openDialog(
    `<h2>${esc(title)}</h2><p>${esc(message)}</p>${strong ? `<p class="warn-text">${esc(strong)}</p>` : ''}`,
    [{ label: '取消', value: 'cancel' }, { label: confirmLabel, value: 'ok', style: destructive ? 'btn-filled btn-destructive' : 'btn-filled' }],
  );
  return result === 'ok';
}

function alertDialog(title, message) {
  return openDialog(`<h2>${esc(title)}</h2><p>${esc(message)}</p>`, [{ label: '好', value: 'ok', style: 'btn-filled' }]);
}

function parseAmount(text) {
  const value = Number(String(text).replace(/[,\s$]/g, ''));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function editPrice(lineId) {
  const line = state.basket.find((l) => l.id === lineId);
  if (!line) return;
  const d = decimals();
  const result = await openDialog(`
    <h2>修改單價</h2>
    <p class="strong">${esc(line.name)}</p>
    <p>活動價 ${money(line.listPriceMinor)}。只改這一筆，例如瑕疵品。</p>
    <label>單價<input type="text" name="price" inputmode="decimal" autocomplete="off" value="${core.fromMinor(line.unitPriceMinor, d)}"></label>`,
    [{ label: '恢復活動價', value: 'reset', style: 'btn-plain' }, 'spacer', { label: '取消', value: 'cancel' }, { label: '確定', value: 'ok', style: 'btn-filled' }],
    { onOpen: (form) => form.price.select() },
  );
  if (result === 'reset') {
    line.unitPriceMinor = line.listPriceMinor;
    line.edited = false;
  } else if (result === 'ok') {
    const value = parseAmount($('dialog-form').price.value);
    if (value == null) return;
    line.unitPriceMinor = core.toMinor(value, d);
    line.edited = line.unitPriceMinor !== line.listPriceMinor;
  }
  renderBasket();
}

async function addCustomItem() {
  const d = decimals();
  const presetsHTML = state.presets.length
    ? `<p>最近用過</p><div class="presets">${state.presets.map((p, i) =>
        `<button type="button" data-preset="${i}">${esc(p.name)} ${money(p.unitPriceMinor)}</button>`).join('')}</div>`
    : '';
  let picked = null;
  const result = await openDialog(`
    <h2>自訂品項</h2>
    <p>似顏繪等現場服務，只計入營收，不對應任何款式。</p>
    ${presetsHTML}
    <label>名稱<input type="text" name="name" autocomplete="off" enterkeyhint="next"></label>
    <label>金額<input type="text" name="price" inputmode="decimal" autocomplete="off"></label>
    <label>數量<input type="number" name="qty" inputmode="numeric" min="1" value="1"></label>`,
    [{ label: '取消', value: 'cancel' }, { label: state.quickMode ? '直接結帳' : '加入購物籃', value: 'ok', style: 'btn-filled' }],
    {
      onOpen: (form) => {
        form.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
          picked = state.presets[Number(b.dataset.preset)];
          form.name.value = picked.name;
          form.price.value = core.fromMinor(picked.unitPriceMinor, d);
          form.qty.focus();
        }));
        form.name.focus();
      },
    },
  );
  if (result !== 'ok') return;
  const form = $('dialog-form');
  const name = form.name.value.trim();
  const price = parseAmount(form.price.value);
  const qty = Math.max(1, Math.floor(Number(form.qty.value) || 1));
  if (!name || price == null) {
    await alertDialog('沒有加入', '請輸入名稱與金額。');
    return;
  }
  const unitPriceMinor = core.toMinor(price, d);
  state.presets = core.rememberPreset(state.presets, { name, unitPriceMinor });
  putMeta({ presets: state.presets }).catch(() => {});
  const line = { id: core.uuid(), variantKey: null, name, quantity: qty, unitPriceMinor, listPriceMinor: unitPriceMinor, edited: false };
  if (state.quickMode) {
    const t = await checkout([line], null);
    if (t) showToast(`已結帳 ${name} ${money(t.total)}`, '復原', () => setVoided(t.posId, true, '已復原這筆交易'));
  } else {
    state.basket.push(line);
    renderBasket();
  }
}

// MARK: - 匯入、匯出、清除

function chooseFile() {
  const input = $('file-input');
  input.value = '';
  input.click();
}

async function importPackingFile(file) {
  let parsed;
  try {
    parsed = core.parsePackingFile(await file.text());
  } catch (error) {
    await alertDialog('無法匯入', error.message);
    return;
  }
  const current = state.event;
  if (current && current.id !== parsed.event.id) {
    const list = eventTransactions();
    const pending = core.unexportedCount(list, state.lastExportAt);
    const ok = await confirmDialog(
      '換成另一場活動？',
      `POS 一次只放一場活動。匯入「${parsed.event.name}」會清除「${current.name}」的帶貨清單與 ${list.length} 筆交易。`,
      '清除並匯入',
      { destructive: true, strong: pending ? `還有 ${pending} 筆變更沒有匯出！請先按「取消」再匯出交易檔。` : '' },
    );
    if (!ok) return;
    await clearEventData();
    state.transactions = [];
    state.lastExportAt = null;
  }
  await putMeta({ event: parsed.event, items: parsed.items });
  const sameEvent = current?.id === parsed.event.id;
  state.event = parsed.event;
  state.items = parsed.items;
  state.basket = state.basket.filter((l) => !l.variantKey || parsed.items.some((i) => i.variantKey === l.variantKey));
  state.view = 'register';
  moneyFormatter = null;
  navigator.storage?.persist?.().catch(() => {});
  renderAll();
  showToast(sameEvent ? `已更新帶貨清單（${parsed.items.length} 款），交易保留` : `已匯入「${parsed.event.name}」（${parsed.items.length} 款）`);
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function markExported(time) {
  state.lastExportAt = time;
  await putMeta({ lastExportAt: time }).catch(() => {});
  renderTopbar();
  showToast(`已匯出 ${eventTransactions().length} 筆交易`);
}

/// 匯出要在點擊當下同步呼叫 navigator.share，不能先 await 其他東西，否則 Safari 會拒絕分享。
function exportTransactions() {
  if (!state.event) return;
  const now = new Date();
  const data = core.buildTransactionFile(state.event, eventTransactions(), now);
  const file = new File([JSON.stringify(data, null, 2)], core.transactionFileName(state.event, now), { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] })
      .then(() => markExported(now.getTime()))
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        downloadFile(file);
        markExported(now.getTime());
      });
  } else {
    downloadFile(file);
    markExported(now.getTime());
  }
}

async function clearEvent() {
  const list = eventTransactions();
  const pending = core.unexportedCount(list, state.lastExportAt);
  const ok = await confirmDialog(
    '清除這場活動？',
    `會刪除「${state.event.name}」的帶貨清單與 ${list.length} 筆交易。請先確認 Mac 已經匯入交易檔。`,
    '清除',
    { destructive: true, strong: pending ? `還有 ${pending} 筆變更沒有匯出！` : '' },
  );
  if (!ok) return;
  await clearEventData();
  Object.assign(state, { event: null, items: [], transactions: [], lastExportAt: null, basket: [], view: 'register' });
  renderAll();
  showToast('已清除活動資料');
}

function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

// 匯入、匯出按鈕由全域點擊處理同步執行：選檔與分享面板都要在點擊當下呼叫。
async function openSettings() {
  const e = state.event;
  const list = eventTransactions();
  const pending = core.unexportedCount(list, state.lastExportAt);
  let persisted = null;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* 不支援 */ }
  const result = await openDialog(`
    <h2>設定</h2>
    ${e ? `<dl class="info-list">
      <dt>活動</dt><dd>${esc(e.name)}</dd>
      <dt>日期</dt><dd>${esc(e.startDate)} – ${esc(e.endDate)}</dd>
      <dt>幣別</dt><dd>${esc(e.currencyCode)}</dd>
      <dt>品項</dt><dd>${state.items.length} 款，帶去 ${state.items.reduce((n, i) => n + i.broughtQty, 0)} 件</dd>
      <dt>交易</dt><dd>${list.length} 筆（作廢 ${list.filter((t) => t.voided).length} 筆）</dd>
      <dt>匯出</dt><dd>${state.lastExportAt ? formatTime(state.lastExportAt) : '尚未匯出'}${pending ? `，<span class="warn-text">${pending} 筆變更未匯出</span>` : ''}</dd>
    </dl>` : ''}
    <dl class="info-list">
      <dt>開啟方式</dt><dd>${isStandalone() ? '主畫面' : '<span class="warn-text">瀏覽器（請加入主畫面後使用）</span>'}</dd>
      <dt>本機儲存</dt><dd>${persisted === true ? '已設為保留' : persisted === false ? '一般（系統可能清除）' : '—'}</dd>
    </dl>
    <div class="settings-actions">
      <button type="button" class="btn" data-action="import" data-close>匯入帶貨檔…</button>
      ${e ? `<button type="button" class="btn" data-action="export" data-close>匯出交易檔…</button>
      <button type="button" class="btn btn-destructive" data-action="clear-event" data-close>清除這場活動的資料…</button>` : ''}
    </div>`,
    [{ label: '完成', value: 'cancel', style: 'btn-filled' }],
  );
  return result;
}

// MARK: - 事件

document.addEventListener('click', (event) => {
  const target = event.target.closest('button, [data-action]');
  if (!target) return;

  const card = target.closest('.card');
  if (card) {
    const item = state.items.find((i) => i.variantKey === card.dataset.variant);
    if (!item) return;
    if (state.quickMode) quickCheckout(item);
    else addToBasket(item);
    return;
  }
  if (target.dataset.category !== undefined) {
    state.category = target.dataset.category || null;
    renderGrid();
    $('grid').scrollTop = 0;
    return;
  }
  if (target.dataset.view) {
    showView(target.dataset.view);
    return;
  }
  if (target.dataset.day) {
    state.selectedDay = target.dataset.day;
    showView(state.view);
    return;
  }
  if (target.dataset.discountType) {
    state.discount = { type: target.dataset.discountType, value: state.discount.value };
    renderBasket();
    return;
  }
  if (target.id === 'toast-action') {
    const handler = toastHandler;
    hideToast();
    handler?.();
    return;
  }

  if (target.hasAttribute('data-close')) $('dialog').close('cancel');

  const lineId = target.closest('[data-line]')?.dataset.line;
  const posId = target.closest('[data-pos]')?.dataset.pos;
  switch (target.dataset.action) {
    case 'import': chooseFile(); break;
    case 'export': exportTransactions(); break;
    case 'settings': openSettings(); break;
    case 'custom': addCustomItem(); break;
    case 'checkout': checkoutBasket(); break;
    case 'undo-last': undoLast(); break;
    case 'clear-basket': resetBasket(); break;
    case 'clear-event': clearEvent(); break;
    case 'toggle-drawer':
      state.drawerOpen = !state.drawerOpen;
      renderBasket();
      break;
    case 'edit-price': editPrice(lineId); break;
    case 'increment':
    case 'decrement': {
      const line = state.basket.find((l) => l.id === lineId);
      if (!line) break;
      line.quantity += target.dataset.action === 'increment' ? 1 : -1;
      if (line.quantity <= 0) state.basket = state.basket.filter((l) => l !== line);
      renderBasket();
      break;
    }
    case 'void': {
      const t = state.transactions.find((x) => x.posId === posId);
      if (!t) break;
      confirmDialog('作廢這筆交易？', `${t.occurredAt.slice(11, 16)}，${money(t.total)}。作廢後保留紀錄，但不計入營收與售出數，之後可以恢復。`, '作廢', { destructive: true })
        .then((ok) => ok && setVoided(posId, true));
      break;
    }
    case 'restore': setVoided(posId, false); break;
  }
});

$('search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderGrid();
});

$('discount-input').addEventListener('input', (event) => {
  state.discount = { type: state.discount.type, value: event.target.value.replace(/[^\d.]/g, '') };
  renderBasket();
});

$('quick-toggle').addEventListener('change', (event) => {
  state.quickMode = event.target.checked;
  $('quick-banner').hidden = !state.quickMode;
  putMeta({ quickMode: state.quickMode }).catch(() => {});
});

$('file-input').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) importPackingFile(file);
});

// 換日、12 小時提醒：每 30 秒與回到前景時更新頂部列。
setInterval(renderTopbar, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderAfterChange();
});

// MARK: - 啟動

async function start() {
  try {
    const { meta, transactions } = await loadAll();
    state.event = meta.event ?? null;
    state.items = meta.items ?? [];
    state.lastExportAt = meta.lastExportAt ?? null;
    state.quickMode = meta.quickMode ?? false;
    state.presets = meta.presets ?? [];
    state.transactions = transactions;
  } catch (error) {
    await alertDialog('無法讀取本機資料', String(error?.message ?? error));
  }
  $('install-hint').hidden = isStandalone() || !/iPad|iPhone|Macintosh/.test(navigator.userAgent) || !('ontouchend' in document);
  renderAll();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
