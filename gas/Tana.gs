/**
 * 棚卸（2026-10-30〜）
 * 在庫入力アプリの「棚卸」画面から、在庫入力アプリのGAS経由でだけ呼ばれる（画面には鍵を出さない）。
 * 合言葉の代わりに棚卸用の鍵（スクリプトプロパティ TANA_KEY_HASH）で確かめる。鍵は最初の tanaPair で1回だけ決まる。
 *
 * 品目は kv の material_master_data_v1・product_master_data_v1 を読むだけ（マスタには書かない）。
 * シート「tana」     ：1行＝1回の入力。同じ 棚卸回・品目・場所 は後の行が勝つ。数が空なら取り消し。
 * シート「tana_loc」 ：棚卸画面で足した・外した保管場所（マスタの保管場所に足して使う）。
 * シート「tana_done」：場所を数え終えた記録。
 */
const TANA_SHEET = 'tana';
const TANA_HEADER = ['日時', '棚卸回', '品目ID', '品名', '保管場所', '在庫単位の数', '在庫単位', '最小単位の数', '最小単位', '内訳', '数えた人', '端末'];
const TANA_LOC_SHEET = 'tana_loc';
const TANA_LOC_HEADER = ['日時', '品目ID', '品名', '保管場所', '操作', '人'];
const TANA_DONE_SHEET = 'tana_done';
const TANA_DONE_HEADER = ['日時', '棚卸回', '部門', '保管場所', '人', '操作'];
// 棚卸の対象にする原料・資材・半製品マスタの中分類（コスト・経費の中分類は数えない）
const TANA_BUNRUI = ['原料', '資材', '雑貨', '備品'];

function tanaRoute_(req) {
  if (req.action === 'tanaPair') return tanaPair_(req);
  if (!tanaKeyOk_(req.key)) return { ok: false, error: 'bad_key' };
  switch (req.action) {
    case 'tanaMaster': return tanaMaster_();
    case 'tanaState': return tanaState_(req);
    case 'tanaPut': return tanaPut_(req);
    case 'tanaPlace': return tanaPlace_(req);
    case 'tanaDone': return tanaDone_(req);
    default: return { ok: false, error: 'unknown_action' };
  }
}

/* ---- 鍵 ---- */
function tanaPair_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('TANA_KEY_HASH')) return { ok: false, error: 'already_paired' };
    if (!req.key || String(req.key).length < 32) return { ok: false, error: 'key_too_short' };
    props.setProperty('TANA_KEY_HASH', hash_('tana:' + req.key));
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function tanaKeyOk_(key) {
  const stored = PropertiesService.getScriptProperties().getProperty('TANA_KEY_HASH');
  if (stored && key && hash_('tana:' + key) === stored) return true;
  Utilities.sleep(1000);
  return false;
}
/** 鍵を作り直すとき用。持ち主がエディタから実行する（在庫入力アプリ側の KANRI_TANA_KEY も消すこと） */
function tanaUnpair() {
  PropertiesService.getScriptProperties().deleteProperty('TANA_KEY_HASH');
  Logger.log('TANA_KEY_HASH を消しました。');
}

/* ---- マスタを読む ---- */
function kvValue_(key) {
  const rows = readAll_(kvSheet_());
  let ver = null, enc = '', n = 1;
  const parts = [];
  rows.forEach(function (r) {
    if (String(r[0]) !== key) return;
    if (ver === null) { ver = String(r[1]); enc = String(r[2]); n = Number(r[6]) || 1; }
    if (String(r[1]) === ver) parts[Number(r[5]) || 0] = String(r[7]);
  });
  if (ver === null) return null;
  for (let i = 0; i < n; i++) if (typeof parts[i] !== 'string') throw new Error('kv broken: ' + key);
  const d = parts.join('');
  if (enc !== 'gz') return d;
  const blob = Utilities.newBlob(Utilities.base64Decode(d), 'application/x-gzip');
  return Utilities.ungzip(blob).getDataAsString('UTF-8');
}
function kvJson_(key, fallback) {
  const s = kvValue_(key);
  if (s === null || s === '') return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

// 商品管理システムと同じ単位の決まり：小＝unit・中＝midUnit・大＝lotUnit。
// 数値(小)packQty＝中1つの中身（小の数）、数値(中)lotQty＝大1つに入る中の数。「なし」の階層は無いものとして扱う。
function tanaUnits_(m) {
  const none = function (u) { u = String(u || '').trim(); return !u || u === 'なし'; };
  const num = function (v) { v = parseFloat(v); return v > 0 ? v : 1; };
  const s = none(m.midUnit) ? 1 : num(m.packQty);
  const mid = none(m.lotUnit) ? 1 : num(m.lotQty);
  const out = [];
  if (!none(m.lotUnit)) out.push({ lv: '大', u: String(m.lotUnit).trim(), per: s * mid });
  if (!none(m.midUnit)) out.push({ lv: '中', u: String(m.midUnit).trim(), per: s });
  if (!none(m.unit)) out.push({ lv: '小', u: String(m.unit).trim(), per: 1 });
  // 単位の文字が入っていない品目は「個」で数える
  if (!out.length) out.push({ lv: '中', u: '個', per: 1 });
  let stockLv = (m.stockLevel === '大' || m.stockLevel === '小') ? m.stockLevel : '中';
  if (!out.some(function (x) { return x.lv === stockLv; })) stockLv = out.some(function (x) { return x.lv === '中'; }) ? '中' : out[0].lv;
  return { units: out, stockLv: stockLv };
}

function tanaMaster_() {
  const materials = kvJson_('material_master_data_v1', []);
  const products = kvJson_('product_master_data_v1', []);
  const disp = kvJson_('material_display_settings_v1', {}) || {};
  const hidden = {};
  (disp.hiddenCombos || []).forEach(function (k) { hidden[k] = true; });
  const shownProducts = {};
  (disp.shownProducts || []).forEach(function (k) { shownProducts[k] = true; });
  const items = [];
  materials.forEach(function (m) {
    if (!m || !m.id || TANA_BUNRUI.indexOf(m.bunrui) < 0) return;
    const u = tanaUnits_(m);
    const smallPerMid = (u.units.filter(function (x) { return x.lv === '中'; })[0] || { per: 1 }).per;
    const price = parseFloat(m.packPrice) > 0 ? parseFloat(m.packPrice) / smallPerMid
      : (parseFloat(m.lotPrice) > 0 ? parseFloat(m.lotPrice) / (u.units[0].per || 1) : 0);
    items.push({
      id: 'm:' + m.id, name: String(m.name || ''), dept: String(m.department || ''), bunrui: String(m.bunrui || ''),
      sub: String(m.subCategory || ''), maker: String(m.maker || ''), code: String(m.itemCode || ''),
      active: m.status === '在庫〇', hidden: !!hidden[JSON.stringify([m.bunrui, m.subCategory || ''])],
      locs: (m.storageLocations || []).map(String), units: u.units, stockLv: u.stockLv,
      priceSmall: Math.round(price * 1000) / 1000
    });
  });
  products.forEach(function (p) {
    if (!p || !p.id) return;
    if (!shownProducts[JSON.stringify(['商品', p.category || ''])] && !p.stocktakeTarget) return;
    items.push({
      id: 'p:' + p.id, name: String(p.name || ''), dept: String(p.department || ''), bunrui: '商品',
      sub: String(p.category || ''), maker: '', code: String(p.code || ''), active: true, hidden: false,
      locs: (p.storageLocations || []).map(String), units: [{ lv: '中', u: '個', per: 1 }], stockLv: '中',
      priceSmall: parseFloat(p.purchaseCost) || 0
    });
  });
  const opts = kvJson_('product_master_options_v1', null);
  return { ok: true, items: items, at: new Date().toISOString(), locOptions: (opts && opts.storageLocation) || null };
}

/* ---- 入力 ---- */
function tanaSheet_(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
  }
  return sh;
}
function tanaRows_(name, header) {
  const sh = tanaSheet_(name, header);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, header.length).getValues();
}
function tanaAppend_(name, header, rows) {
  if (!rows.length) return;
  const sh = tanaSheet_(name, header);
  const range = sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length);
  range.setNumberFormat('@');
  range.setValues(rows);
}
function tanaRound_(r) {
  r = String(r || '');
  if (!/^\d{4}-\d{2}$/.test(r)) throw new Error('bad round');
  return r;
}

/** 棚卸回（YYYY-MM）の、品目×場所ごとの最新の数・場所の追加・完了した場所 */
function tanaState_(req) {
  const round = tanaRound_(req.round);
  const counts = {};
  tanaRows_(TANA_SHEET, TANA_HEADER).forEach(function (r) {
    if (String(r[1]) !== round) return;
    const k = String(r[2]) + '|' + String(r[4]);
    if (String(r[5]) === '') { delete counts[k]; return; }
    counts[k] = { v: Number(r[5]), small: Number(r[7]), detail: String(r[9]), by: String(r[10]), at: String(r[0]) };
  });
  const locs = {};
  tanaRows_(TANA_LOC_SHEET, TANA_LOC_HEADER).forEach(function (r) {
    const id = String(r[1]), loc = String(r[3]);
    const list = locs[id] || (locs[id] = []);
    const i = list.indexOf(loc);
    if (String(r[4]) === '外す') { if (i >= 0) list.splice(i, 1); }
    else if (i < 0) list.push(loc);
  });
  const done = {};
  tanaRows_(TANA_DONE_SHEET, TANA_DONE_HEADER).forEach(function (r) {
    if (String(r[1]) !== round) return;
    const k = String(r[2]) + '|' + String(r[3]);
    if (String(r[5]) === '取り消し') delete done[k];
    else done[k] = { by: String(r[4]), at: String(r[0]) };
  });
  return { ok: true, round: round, counts: counts, locs: locs, done: done, at: new Date().toISOString() };
}

/** rows: [{id, name, loc, v, unit, small, smallUnit, detail}]。v が null なら取り消し */
function tanaPut_(req) {
  const round = tanaRound_(req.round);
  const at = new Date().toISOString();
  const staff = String(req.staff || '').slice(0, 40), route = String(req.route || '').slice(0, 80);
  const rows = (req.rows || []).slice(0, 200).map(function (x) {
    const blank = x.v === null || x.v === undefined || x.v === '';
    return [at, round, String(x.id || ''), String(x.name || '').slice(0, 200), String(x.loc || ''),
      blank ? '' : Number(x.v), String(x.unit || ''), blank ? '' : Number(x.small), String(x.smallUnit || ''),
      String(x.detail || '').slice(0, 200), staff, route];
  }).filter(function (r) { return r[2] && r[4]; });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { tanaAppend_(TANA_SHEET, TANA_HEADER, rows); } finally { lock.releaseLock(); }
  return { ok: true, saved: rows.length, at: at };
}
function tanaPlace_(req) {
  const at = new Date().toISOString();
  const row = [at, String(req.id || ''), String(req.name || '').slice(0, 200), String(req.loc || ''), req.op === 'del' ? '外す' : '置く', String(req.staff || '').slice(0, 40)];
  if (!row[1] || !row[3]) return { ok: false, error: 'bad_request' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { tanaAppend_(TANA_LOC_SHEET, TANA_LOC_HEADER, [row]); } finally { lock.releaseLock(); }
  return { ok: true, at: at };
}
function tanaDone_(req) {
  const round = tanaRound_(req.round);
  const at = new Date().toISOString();
  const row = [at, round, String(req.dept || ''), String(req.loc || ''), String(req.staff || '').slice(0, 40), req.undo ? '取り消し' : '完了'];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { tanaAppend_(TANA_DONE_SHEET, TANA_DONE_HEADER, [row]); } finally { lock.releaseLock(); }
  return { ok: true, at: at };
}
