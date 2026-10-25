// 安庫 POS 的純計算：不碰 DOM 與 IndexedDB，tests/ 直接匯入測試。
// 金額在內部一律用「最小單位」整數（TWD 為元、USD 為分），避免浮點誤差；
// 只在讀檔與寫檔時與 JSON 數字互換。

export const SCHEMA_VERSION = 1;
export const EXPORT_REMINDER_MS = 12 * 60 * 60 * 1000;

const ZERO_DECIMAL_CURRENCIES = new Set(['TWD', 'JPY', 'KRW']);

export function currencyDecimals(code) {
  return ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
}

export function toMinor(amount, decimals) {
  return Math.round(Number(amount) * 10 ** decimals);
}

export function fromMinor(minor, decimals) {
  return decimals === 0 ? minor : Number((minor / 10 ** decimals).toFixed(decimals));
}

/// UUID v4。`crypto.randomUUID` 只在 HTTPS（安全環境）才有，區網 http 測試時改用 getRandomValues。
export function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// MARK: - 帶貨檔

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/// 讀取帶貨檔文字，回傳 { event, items }；格式不對時丟出中文訊息的 Error。
/// items 的金額轉成最小單位（priceMinor）。
export function parsePackingFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('這不是有效的 JSON 檔案。');
  }
  if (!data || typeof data !== 'object') throw new Error('檔案內容不是帶貨檔。');
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`不支援的帶貨檔版本（${data.schemaVersion ?? '沒有版本'}），請更新安庫 POS 或重新從 Mac 匯出。`);
  }
  if (Array.isArray(data.transactions)) throw new Error('這是交易檔，不是帶貨檔。');

  const e = data.event;
  if (!e || typeof e !== 'object') throw new Error('帶貨檔缺少活動資料。');
  if (typeof e.id !== 'string' || !e.id) throw new Error('帶貨檔的活動缺少 id。');
  if (typeof e.name !== 'string' || !e.name) throw new Error('帶貨檔的活動缺少名稱。');
  if (!DATE_RE.test(e.startDate ?? '') || !DATE_RE.test(e.endDate ?? '')) {
    throw new Error('帶貨檔的活動日期格式不對（應為 YYYY-MM-DD）。');
  }
  if (e.endDate < e.startDate) throw new Error('帶貨檔的活動結束日早於開始日。');
  const currencyCode = e.currencyCode == null ? 'TWD' : String(e.currencyCode).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error(`不認得的幣別「${e.currencyCode}」。`);
  const event = { id: e.id, name: e.name, startDate: e.startDate, endDate: e.endDate, currencyCode };

  if (!Array.isArray(data.items)) throw new Error('帶貨檔缺少品項清單。');
  const decimals = currencyDecimals(currencyCode);
  const seen = new Set();
  const items = data.items.map((it, i) => {
    const where = `第 ${i + 1} 個品項`;
    if (!it || typeof it !== 'object') throw new Error(`${where}格式不對。`);
    if (typeof it.variantKey !== 'string' || !it.variantKey) throw new Error(`${where}缺少 variantKey。`);
    if (seen.has(it.variantKey)) throw new Error(`${where}的 variantKey 重複。`);
    seen.add(it.variantKey);
    for (const key of ['productName', 'variantName', 'category']) {
      if (typeof it[key] !== 'string') throw new Error(`${where}缺少 ${key}。`);
    }
    if (typeof it.price !== 'number' || !Number.isFinite(it.price) || it.price < 0) {
      throw new Error(`${where}（${it.productName} ${it.variantName}）的價格不對。`);
    }
    if (!Number.isInteger(it.broughtQty) || it.broughtQty < 0) {
      throw new Error(`${where}（${it.productName} ${it.variantName}）的帶去數量不對。`);
    }
    if (it.photo != null && typeof it.photo !== 'string') throw new Error(`${where}的照片格式不對。`);
    return {
      variantKey: it.variantKey,
      productName: it.productName,
      variantName: it.variantName,
      category: it.category || '未分類',
      priceMinor: toMinor(it.price, decimals),
      broughtQty: it.broughtQty,
      photo: it.photo ?? null,
    };
  });
  return { event, items };
}

/// 依類別第一次出現的順序分組，組內維持檔案順序。
export function groupByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  return [...groups].map(([category, list]) => ({ category, items: list }));
}

export function itemDisplayName(item) {
  return item.variantName ? `${item.productName} ${item.variantName}` : item.productName;
}

export function matchesSearch(item, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.productName, item.variantName, item.category].some((s) => s.toLowerCase().includes(q));
}

// MARK: - 金額

/// lines: [{ quantity, unitPriceMinor }]；discount: { type: 'amount' | 'percent', value }（value 為使用者輸入的數字）。
/// 回傳 { subtotal, discount, total }，皆為最小單位。
export function computeTotals(lines, discount, decimals) {
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceMinor, 0);
  let off = 0;
  const value = Number(discount?.value);
  if (Number.isFinite(value) && value > 0) {
    off = discount.type === 'percent'
      ? Math.round((subtotal * Math.min(value, 100)) / 100)
      : toMinor(value, decimals);
  }
  off = Math.min(Math.max(off, 0), subtotal);
  return { subtotal, discount: off, total: subtotal - off };
}

// MARK: - 日期

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function localDateString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/// 當地時間加時區，例如 2026-03-08T14:02:11+08:00。
export function localISOString(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${localDateString(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/// localISOString 產生的字串，前 10 碼就是當地日期。
export function localDateOf(iso) {
  return iso.slice(0, 10);
}

function dayNumber(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/// 依日期算活動第幾天：{ phase: 'before' | 'during' | 'after', day, totalDays }。
export function eventDay(event, dateString) {
  const day = dayNumber(dateString) - dayNumber(event.startDate) + 1;
  const totalDays = dayNumber(event.endDate) - dayNumber(event.startDate) + 1;
  const phase = day < 1 ? 'before' : day > totalDays ? 'after' : 'during';
  return { phase, day, totalDays };
}

export function eventDayLabel(info) {
  if (info.phase === 'before') return '活動前';
  if (info.phase === 'after') return '活動後';
  return info.totalDays > 1 ? `第 ${info.day} 天` : '活動當天';
}

// MARK: - 交易

/// 建立一筆交易紀錄（存進 IndexedDB 的形狀）。basketLines: [{ variantKey, name, quantity, unitPriceMinor }]。
export function makeTransaction({ eventId, basketLines, discount, decimals, now, posId }) {
  const lines = basketLines
    .filter((l) => l.quantity > 0)
    .map((l) => ({ variantKey: l.variantKey ?? null, name: l.name, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor }));
  if (lines.length === 0) throw new Error('購物籃是空的。');
  const totals = computeTotals(lines, discount, decimals);
  const occurredAt = localISOString(now);
  return {
    posId,
    eventId,
    occurredAt,
    voided: false,
    lines,
    subtotal: totals.subtotal,
    discount: totals.discount,
    total: totals.total,
    // 以下只在 POS 內使用：排序「上一筆」與判斷是否有未匯出的變更。
    createdAt: now.getTime(),
    modifiedAt: now.getTime(),
  };
}

export function validTransactions(transactions) {
  return transactions.filter((t) => !t.voided);
}

/// 全部天數、未作廢交易的各款售出數：Map variantKey → 數量。
export function soldByVariant(transactions) {
  const sold = new Map();
  for (const t of validTransactions(transactions)) {
    for (const l of t.lines) {
      if (l.variantKey) sold.set(l.variantKey, (sold.get(l.variantKey) ?? 0) + l.quantity);
    }
  }
  return sold;
}

/// 某一天的摘要。lines 依品項彙總（款式依 variantKey，自訂品項依名稱與單價）。
export function daySummary(transactions, dateString) {
  const list = validTransactions(transactions).filter((t) => localDateOf(t.occurredAt) === dateString);
  const revenue = list.reduce((s, t) => s + t.total, 0);
  const lineMap = new Map();
  for (const t of list) {
    for (const l of t.lines) {
      const key = l.variantKey ?? `custom:${l.name}`;
      const row = lineMap.get(key) ?? { variantKey: l.variantKey, name: l.name, quantity: 0, amount: 0 };
      row.quantity += l.quantity;
      row.amount += l.quantity * l.unitPriceMinor;
      lineMap.set(key, row);
    }
  }
  return {
    date: dateString,
    revenue,
    count: list.length,
    average: list.length ? Math.round(revenue / list.length) : 0,
    discount: list.reduce((s, t) => s + t.discount, 0),
    lines: [...lineMap.values()],
  };
}

/// 有交易的日期（新到舊），加上 today。
export function transactionDates(transactions, today) {
  const dates = new Set(transactions.map((t) => localDateOf(t.occurredAt)));
  dates.add(today);
  return [...dates].sort().reverse();
}

/// 最近一筆未作廢的交易（「復原上一筆」的對象）。
export function lastValidTransaction(transactions) {
  return validTransactions(transactions).reduce((latest, t) => (!latest || t.createdAt > latest.createdAt ? t : latest), null);
}

// MARK: - 匯出

export function unexportedCount(transactions, lastExportAt) {
  return transactions.filter((t) => lastExportAt == null || t.modifiedAt > lastExportAt).length;
}

/// 有未匯出的變更，且距離上次匯出（從未匯出時為第一筆未匯出的變更）超過 12 小時。
export function needsExportReminder(transactions, lastExportAt, now) {
  const pending = transactions.filter((t) => lastExportAt == null || t.modifiedAt > lastExportAt);
  if (pending.length === 0) return false;
  const since = lastExportAt ?? Math.min(...pending.map((t) => t.modifiedAt));
  return now - since > EXPORT_REMINDER_MS;
}

/// 第 11 節的交易檔物件。
export function buildTransactionFile(event, transactions, now) {
  const decimals = currencyDecimals(event.currencyCode);
  const money = (m) => fromMinor(m, decimals);
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: event.id,
    exportedAt: localISOString(now),
    transactions: transactions
      .filter((t) => t.eventId === event.id)
      .slice()
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .map((t) => ({
        posId: t.posId,
        occurredAt: t.occurredAt,
        voided: t.voided,
        lines: t.lines.map((l) => ({
          variantKey: l.variantKey ?? null,
          name: l.name,
          quantity: l.quantity,
          unitPrice: money(l.unitPriceMinor),
        })),
        subtotal: money(t.subtotal),
        discount: money(t.discount),
        total: money(t.total),
      })),
  };
}

export function transactionFileName(event, now) {
  const name = event.name.replace(/[\\/:*?"<>|]/g, '-').trim();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `安庫POS-${name}-${stamp}.json`;
}

// MARK: - 自訂品項的快速按鈕

/// 把剛用過的自訂品項放到最前面，名稱與金額相同的只留一個，最多 8 個。
export function rememberPreset(presets, preset, limit = 8) {
  const rest = presets.filter((p) => !(p.name === preset.name && p.unitPriceMinor === preset.unitPriceMinor));
  return [preset, ...rest].slice(0, limit);
}
