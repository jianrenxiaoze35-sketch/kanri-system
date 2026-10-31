/**
 * 受入検査と理論在庫（2026-10-31〜）
 * 仕様：vault「在庫入力の理論と行データ定義（2026-10-31）」。Tana.gs と同じく在庫入力アプリのGAS経由で呼ばれる。
 * 理論在庫は記録から毎回計算する。棚卸は上書きしない。金額は仕入れ、数は受入で、両方は足さない。
 * 計算のレシピは kv のレシピではなくシート「理論レシピ」を読む（kv の材料は今のマスタとつながっていないため）。
 */
const UKE_SHEET = '受入記録';
const UKE_HEADER = ['受入ID', '受入日時', '品目ID', '品名', '仕入先', '数', '単位', '最小単位の数', '最小単位', '使い道', 'ロット番号', '期限', '品温', '納品書一致', '確認結果', '自動判定', '判定理由', '判定', '隔離場所', '対応', '判定日時', '判定者', '受入者', '端末', '取消'];
const UKE_SET_SHEET = '受入の品目設定';
const UKE_SET_HEADER = ['品目ID', '品名', '保管区分', '更新日時', '人'];
const UKE_DOC_SHEET = '受入書類';
const UKE_DOC_HEADER = ['書類ID', '日時', '書類名', '対象', '有効期限', '確認者', 'メモ', '取消'];
const MOVE_SHEET = '場所移動';
const MOVE_HEADER = ['移動ID', '日時', '品目ID', '品名', '数', '単位', '最小単位の数', '最小単位', '内訳', '出した場所', '入れた場所', '人', '端末', '取消'];
const PREP_MAP_SHEET = '仕込み品の対応';
const PREP_MAP_HEADER = ['ハブの品目名', 'ハブの単位', '仕込み品名', '換算（ハブの1単位＝標準単位いくつ）', '標準単位', '既定の保管先', '対象', 'メモ'];
const RECIPE_SHEET = '理論レシピ';
const RECIPE_HEADER = ['種類（商品／仕込み品）', '作るもの', '使う品名', '1つあたりの量（使う品の最小単位）', 'メモ'];
const START_SHEET = '理論在庫の開始';
const START_HEADER = ['品目ID', '品名', '保管場所', '開始日', '開始数（最小単位）', '最小単位', '元', '入れた人', '入れた日時'];
const THEORY_SHEET = '理論在庫';
const THEORY_HEADER = ['表', '品目ID', '品名', '開始日', '開始数', '入った分', '仕込みで使った分', '売上で使った分', '使った・捨てた', '出した分', '理論値', '単位', '棚卸の数', '差', '警告', '計算日時'];
const CHEST_LOC = 'チェストストッカー';
const PREP_SOURCE_SHEET = '仕込み記録';
const UKE_RESULTS = ['合格', '保留', '不合格'];

function rironRoute_(req) {
  switch (req.action) {
    case 'tanaUkeConfig': return ukeConfig_();
    case 'tanaUkePut': return ukePut_(req);
    case 'tanaUkeList': return ukeList_(req);
    case 'tanaUkeDecide': return ukeDecide_(req);
    case 'tanaUkeCancel': return ukeCancel_(req);
    case 'tanaUkeDocPut': return ukeDocPut_(req);
    case 'tanaUkeDocCancel': return ukeDocCancel_(req);
    case 'tanaMovePut': return movePut_(req);
    case 'tanaMoveList': return moveList_(req);
    case 'tanaMoveCancel': return moveCancel_(req);
    case 'tanaTheory': return theoryGet_();
    case 'tanaTheoryStart': return theoryStart_(req);
    default: return { ok: false, error: 'unknown_action' };
  }
}
function jstDate_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d) ? '' : Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function rowCancel_(sheet, header, id, staff) {
  const col = header.indexOf('取消') + 1;
  return withLock_(function () {
    const sh = tanaSheet_(sheet, header), rows = tanaRows_(sheet, header);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0]) !== String(id)) continue;
      sh.getRange(i + 2, col).setValue(new Date().toISOString() + ' ' + String(staff || '').slice(0, 40));
      return { ok: true, row: rows[i] };
    }
    return { ok: false, error: 'not_found' };
  });
}

/* ---- 受入 ---- */
function ukeRowObj_(r) {
  const o = {};
  ['rowId', 'at', 'id', 'name', 'supplier', 'v', 'unit', 'small', 'smallUnit', 'use', 'lot', 'exp', 'temp', 'slip', 'checks', 'auto', 'why', 'res', 'place', 'action', 'decidedAt', 'decidedBy', 'by', 'route', 'canceled']
    .forEach(function (k, i) { o[k] = r[i] instanceof Date ? r[i].toISOString() : String(r[i]); });
  o.v = o.v === '' ? null : Number(o.v); o.small = o.small === '' ? null : Number(o.small);
  return o;
}
function ukeConfig_() {
  const sets = {};
  tanaRows_(UKE_SET_SHEET, UKE_SET_HEADER).forEach(function (r) { sets[String(r[0])] = String(r[2]); });
  const docs = tanaRows_(UKE_DOC_SHEET, UKE_DOC_HEADER).filter(function (r) { return !String(r[7]); }).map(function (r) {
    return { rowId: String(r[0]), name: String(r[2]), target: String(r[3]), until: jstDate_(r[4]), by: String(r[5]), memo: String(r[6]) };
  });
  return { ok: true, sets: sets, docs: docs, today: jstDate_(new Date()) };
}
function ukePut_(req) {
  const x = req.row || {}, res = String(x.res || '');
  if (!x.id || !req.staff || UKE_RESULTS.indexOf(res) < 0 || !(Number(x.small) > 0)) return { ok: false, error: 'bad_request' };
  if (res === '保留' && !String(x.place || '').trim()) return { ok: false, error: 'need_place' };
  if (res === '不合格' && !String(x.action || '').trim()) return { ok: false, error: 'need_action' };
  const id = Utilities.getUuid(), at = new Date().toISOString(), staff = String(req.staff).slice(0, 40);
  const t = function (v, n) { return String(v === null || v === undefined ? '' : v).slice(0, n); };
  const row = [id, at, t(x.id, 80), t(x.name, 200), t(x.supplier, 100), Number(x.v), t(x.unit, 20), Number(x.small), t(x.smallUnit, 20), t(x.use, 60), t(x.lot, 80), t(x.exp, 10), t(x.temp, 10),
    x.slip === null || x.slip === undefined ? '' : (x.slip ? 'OK' : '不一致'), JSON.stringify(x.checks || {}).slice(0, 1000), res, t(x.why, 500), res, t(x.place, 80), t(x.action, 80), res === '保留' ? '' : at, res === '保留' ? '' : staff, staff, t(req.route, 80), ''];
  withLock_(function () {
    tanaAppend_(UKE_SHEET, UKE_HEADER, [row]);
    if (x.storage && !x.storageFixed) tanaAppend_(UKE_SET_SHEET, UKE_SET_HEADER, [[t(x.id, 80), t(x.name, 200), t(x.storage, 20), at, staff]]);
  });
  return { ok: true, id: id, at: at, res: res };
}
function ukeList_(req) {
  const limit = Math.min(Math.max(Number(req.limit) || 50, 1), 300), hold = req.kind === '保留', out = [];
  const rows = tanaRows_(UKE_SHEET, UKE_HEADER);
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const o = ukeRowObj_(rows[i]);
    if (hold && (o.res !== '保留' || o.canceled)) continue;
    out.push(o);
  }
  return { ok: true, rows: out };
}
function ukeDecide_(req) {
  const res = String(req.op || '');
  if ((res !== '合格' && res !== '不合格') || !req.staff) return { ok: false, error: 'bad_request' };
  const c = { res: UKE_HEADER.indexOf('判定') + 1, why: UKE_HEADER.indexOf('判定理由') + 1, act: UKE_HEADER.indexOf('対応') + 1, at: UKE_HEADER.indexOf('判定日時') + 1, by: UKE_HEADER.indexOf('判定者') + 1 };
  return withLock_(function () {
    const sh = tanaSheet_(UKE_SHEET, UKE_HEADER), rows = tanaRows_(UKE_SHEET, UKE_HEADER);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0]) !== String(req.id)) continue;
      const o = ukeRowObj_(rows[i]);
      if (o.res !== '保留' || o.canceled) return { ok: false, error: 'not_on_hold' };
      const at = new Date().toISOString(), staff = String(req.staff).slice(0, 40), r = i + 2;
      sh.getRange(r, c.res).setValue(res);
      sh.getRange(r, c.why).setValue((o.why + '／' + staff + 'が' + res + 'に判定' + (req.name ? '：' + String(req.name).slice(0, 200) : '')).slice(0, 700));
      if (res === '不合格') sh.getRange(r, c.act).setValue(String(req.name || '').slice(0, 80));
      sh.getRange(r, c.at).setValue(at);
      sh.getRange(r, c.by).setValue(staff);
      o.res = res;
      return { ok: true, row: o };
    }
    return { ok: false, error: 'not_found' };
  });
}
function ukeCancel_(req) {
  const r = rowCancel_(UKE_SHEET, UKE_HEADER, req.id, req.staff);
  return r.ok ? { ok: true } : r;
}
function ukeDocPut_(req) {
  const x = req.row || {};
  if (!x.name || !req.staff) return { ok: false, error: 'bad_request' };
  const id = Utilities.getUuid();
  withLock_(function () { tanaAppend_(UKE_DOC_SHEET, UKE_DOC_HEADER, [[id, new Date().toISOString(), String(x.name).slice(0, 100), String(x.target || '').slice(0, 200), String(x.until || '').slice(0, 10), String(req.staff).slice(0, 40), String(x.memo || '').slice(0, 300), '']]); });
  return { ok: true, id: id };
}
function ukeDocCancel_(req) {
  const r = rowCancel_(UKE_DOC_SHEET, UKE_DOC_HEADER, req.id, req.staff);
  return r.ok ? { ok: true } : r;
}

/* ---- 場所移動 ---- */
function movePut_(req) {
  const x = req.row || {};
  if (!x.id || !req.staff || !(Number(x.small) > 0) || !x.from || !x.to || x.from === x.to) return { ok: false, error: 'bad_request' };
  const id = Utilities.getUuid(), at = new Date().toISOString();
  const row = [id, at, String(x.id).slice(0, 80), String(x.name || '').slice(0, 200), Number(x.v), String(x.unit || '').slice(0, 20), Number(x.small), String(x.smallUnit || '').slice(0, 20), String(x.detail || '').slice(0, 200), String(x.from).slice(0, 80), String(x.to).slice(0, 80), String(req.staff).slice(0, 40), String(req.route || '').slice(0, 80), ''];
  withLock_(function () { tanaAppend_(MOVE_SHEET, MOVE_HEADER, [row]); });
  return { ok: true, id: id, at: at };
}
function moveList_(req) {
  const limit = Math.min(Math.max(Number(req.limit) || 30, 1), 300), rows = tanaRows_(MOVE_SHEET, MOVE_HEADER), out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const r = rows[i];
    out.push({ rowId: String(r[0]), at: String(r[1]), id: String(r[2]), name: String(r[3]), v: Number(r[4]), unit: String(r[5]), small: Number(r[6]), detail: String(r[8]), from: String(r[9]), to: String(r[10]), by: String(r[11]), canceled: String(r[13]) });
  }
  return { ok: true, rows: out };
}
function moveCancel_(req) {
  const r = rowCancel_(MOVE_SHEET, MOVE_HEADER, req.id, req.staff);
  return r.ok ? { ok: true } : r;
}

/* ---- 仕込み品 ---- */
function prepSourceRows_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PREP_SOURCE_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const data = sh.getDataRange().getValues(), head = data[0].map(String);
  return data.slice(1).filter(function (r) { return r[0]; }).map(function (r) {
    const o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o;
  });
}
/** ハブに出てきた「品目名＋単位」を対応シートへ足す。品目名が単位違いで複数あると換算が決められないので空にする */
function prepMapSync_() {
  return withLock_(function () {
    const src = prepSourceRows_(), have = {};
    tanaRows_(PREP_MAP_SHEET, PREP_MAP_HEADER).forEach(function (r) { have[String(r[0]) + '|' + String(r[1])] = true; });
    const units = {};
    src.forEach(function (o) { const n = String(o['品目']); (units[n] = units[n] || {})[String(o['単位'])] = true; });
    const add = [];
    Object.keys(units).forEach(function (n) {
      const us = Object.keys(units[n]);
      us.forEach(function (u) {
        if (have[n + '|' + u]) return;
        const skip = n === 'テスト' || n === 'コースメニュー';
        add.push([n, u, n, us.length === 1 ? 1 : '', us.length === 1 ? u : '', '', skip ? '対象外' : '対象', us.length === 1 ? '' : '単位が複数あるので換算と標準単位を入れる']);
      });
    });
    if (add.length) { const s = tanaSheet_(PREP_MAP_SHEET, PREP_MAP_HEADER); s.getRange(s.getLastRow() + 1, 1, add.length, add[0].length).setValues(add); }
    return tanaRows_(PREP_MAP_SHEET, PREP_MAP_HEADER).map(function (r) {
      return { hub: String(r[0]), hubUnit: String(r[1]), name: String(r[2]), rate: r[3] === '' ? null : Number(r[3]), unit: String(r[4]), loc: String(r[5]), on: String(r[6]) !== '対象外' };
    });
  });
}
/** 棚卸・現場入力で選べる仕込み品。保管先が決まるまでは棚卸の一覧には出さず、検索からだけ選べる */
function prepItems_() {
  const seen = {}, out = [];
  prepMapSync_().forEach(function (m) {
    if (!m.on || !m.unit || seen[m.name]) return;
    seen[m.name] = true;
    out.push({ id: 's:' + m.name, name: m.name, dept: 'レストラン', bunrui: '仕込み品', sub: '', maker: '', code: '', active: true, hidden: !m.loc,
      locs: m.loc ? [m.loc] : [], units: [{ lv: '中', u: m.unit, per: 1 }], stockLv: '中', priceSmall: 0 });
  });
  return out;
}

/* ---- 理論在庫 ---- */
function theoryCalc_() {
  const master = tanaMaster_().items, byId = {}, byName = {};
  master.forEach(function (it) { byId[it.id] = it; if (!byName[it.name]) byName[it.name] = it; });
  const small = function (it) { return it.units[it.units.length - 1].u; };
  const stockPer = function (it) { return (it.units.filter(function (u) { return u.lv === it.stockLv; })[0] || it.units[0]); };
  const warnings = [];

  // 開始数：品目ごとに一番新しい開始日の行だけ使う。同じ品目・場所は後の行が勝つ
  const startDate = {}, startLoc = {};
  tanaRows_(START_SHEET, START_HEADER).forEach(function (r) {
    const id = String(r[0]), d = jstDate_(r[3]);
    if (!d) return;
    if (!startDate[id] || d > startDate[id]) { startDate[id] = d; startLoc[id] = {}; }
    if (d === startDate[id]) startLoc[id][String(r[2])] = Number(r[4]) || 0;
  });
  const after = function (id, date) { return !startDate[id] || (date && date > startDate[id]); };
  const T = {};
  const row = function (id) {
    return T[id] || (T[id] = { id: id, inn: 0, prepUse: 0, sold: 0, used: 0, chestIn: 0, chestOut: 0 });
  };
  Object.keys(startDate).forEach(function (id) { row(id); });

  // 受入：合格だけ
  const noItem = {};
  tanaRows_(UKE_SHEET, UKE_HEADER).forEach(function (r) {
    const o = ukeRowObj_(r), d = jstDate_(o.decidedAt);
    // 工場の受入はブルワリーアプリも書く。対応する品目が無い原料は品目IDが空で届くので、数えずに警告へ
    if (o.res !== '合格' || o.canceled || String(o.route) === '動作確認') return;
    if (!o.id) { noItem[o.name] = true; return; }
    if (after(o.id, d)) row(o.id).inn += Number(o.small) || 0;
  });
  if (Object.keys(noItem).length) warnings.push('マスタに品目がなく計上していない受入：' + Object.keys(noItem).join('、'));
  // 使った・捨てた
  tanaRows_(FIELD_SHEET, FIELD_HEADER).forEach(function (r) {
    if (String(r[2]) !== '使った・捨てた' || String(r[15]) || String(r[7]) === '') return;
    const id = String(r[3]);
    if (after(id, jstDate_(r[1]))) row(id).used += Number(r[7]) || 0;
  });
  // レシピ（名前でつなぐ）
  const recipes = { '商品': {}, '仕込み品': {} }, badRecipe = {};
  tanaRows_(RECIPE_SHEET, RECIPE_HEADER).forEach(function (r) {
    const kind = String(r[0]).indexOf('仕込') >= 0 ? '仕込み品' : '商品', mk = String(r[1]), use = String(r[2]), q = Number(r[3]);
    if (!mk || !use || !(q > 0)) return;
    const it = byName[use] || (byId['s:' + use]);
    if (!it) { badRecipe[use] = true; return; }
    (recipes[kind][mk] = recipes[kind][mk] || []).push({ id: it.id, q: q });
  });
  const bad = Object.keys(badRecipe);
  if (bad.length) warnings.push('理論レシピの「使う品名」がマスタと一致しません：' + bad.slice(0, 8).join('、') + (bad.length > 8 ? ' ほか' + (bad.length - 8) + '件' : ''));

  // 仕込み：完了だけ。増えるのは仕込み品、減るのは原料
  const map = prepMapSync_(), mapBy = {};
  map.forEach(function (m) { mapBy[m.hub + '|' + m.hubUnit] = m; });
  const unmapped = {}, noPrepRecipe = {};
  prepSourceRows_().forEach(function (o) {
    if (String(o['状態']) !== '完了') return;
    const m = mapBy[String(o['品目']) + '|' + String(o['単位'])], d = jstDate_(o['完了日']) || jstDate_(o['予定日']);
    if (!m || !m.on) return;
    if (m.rate === null || !m.unit) { unmapped[m.hub + '（' + m.hubUnit + '）'] = true; return; }
    const id = 's:' + m.name, q = (Number(o['計上量']) || 0) * m.rate;
    if (after(id, d)) {
      row(id).inn += q;
      if (m.loc === CHEST_LOC) row(id).chestIn += q;
    }
    const rc = recipes['仕込み品'][m.name];
    if (!rc) { noPrepRecipe[m.name] = true; return; }
    rc.forEach(function (x) { if (after(x.id, d)) row(x.id).prepUse += x.q * q; });
  });
  if (Object.keys(unmapped).length) warnings.push('換算が未設定で計上していない仕込み：' + Object.keys(unmapped).join('、'));
  if (Object.keys(noPrepRecipe).length) warnings.push('原料レシピがなく、原料を引いていない仕込み品：' + Object.keys(noPrepRecipe).join('、'));

  // 売上：レシピがある商品だけ引く
  let sales = kvJson_('sales_master_data_v1', []);
  if (sales && !Array.isArray(sales)) sales = sales.salesDays || [];
  let salesUntil = '';
  const noRecipe = {};
  (sales || []).forEach(function (day) {
    const items = day.items || [], d = String(day.date || '');
    if (items.length && d > salesUntil) salesUntil = d;
    items.forEach(function (it) {
      const rc = recipes['商品'][it.productName], q = Number(it.qty) || 0;
      if (!q) return;
      if (!rc) { if (Object.keys(startDate).length === 0 || d > minStart_(startDate)) noRecipe[it.productName] = true; return; }
      rc.forEach(function (x) { if (after(x.id, d)) row(x.id).sold += x.q * q; });
    });
  });
  const noRecipeN = Object.keys(noRecipe).length;
  if (noRecipeN) warnings.push('理論レシピがなく、売上で引いていない商品：' + noRecipeN + '品目');

  // 場所移動（チェスト内だけ動く。合計は変わらない）
  tanaRows_(MOVE_SHEET, MOVE_HEADER).forEach(function (r) {
    if (String(r[13])) return;
    const id = String(r[2]), d = jstDate_(r[1]), q = Number(r[6]) || 0;
    if (!after(id, d)) return;
    if (String(r[10]) === CHEST_LOC) row(id).chestIn += q;
    if (String(r[9]) === CHEST_LOC) row(id).chestOut += q;
  });

  // 棚卸：一番新しい回の最新の数（差の表示だけ）
  const tana = {}; let latestRound = '';
  tanaRows_(TANA_SHEET, TANA_HEADER).forEach(function (r) { if (String(r[5]) !== '' && String(r[11]) !== '動作確認' && String(r[1]) > latestRound) latestRound = String(r[1]); });
  tanaRows_(TANA_SHEET, TANA_HEADER).forEach(function (r) {
    if (String(r[1]) !== latestRound) return;
    const k = String(r[2]), l = String(r[4]);
    (tana[k] = tana[k] || {});
    if (String(r[5]) === '') delete tana[k][l]; else tana[k][l] = Number(r[7]) || 0;
  });

  const rows = [], at = new Date().toISOString();
  Object.keys(T).forEach(function (id) {
    const t = T[id], it = byId[id], st = startLoc[id], hasStart = !!startDate[id];
    const unit = it ? stockPer(it) : { u: '', per: 1 };
    const conv = function (v) { return Math.round(v / unit.per * 1000) / 1000; };
    const total = hasStart ? Object.keys(st).reduce(function (s, k) { return s + st[k]; }, 0) : 0;
    const flow = t.inn - t.prepUse - t.sold - t.used, val = total + flow;
    const counted = tana[id] ? Object.keys(tana[id]).reduce(function (s, k) { return s + tana[id][k]; }, 0) : null;
    const warn = [];
    if (!it) warn.push('マスタにない品目');
    if (!hasStart) warn.push('開始数なし');
    if (hasStart && val < 0) warn.push('マイナス');
    const isPrep = id.indexOf('s:') === 0, name = it ? it.name : id.replace(/^[ms]:/, '');
    rows.push({ table: isPrep ? '仕込み品' : '原料', id: id, name: name, start: startDate[id] || '', startQty: hasStart ? conv(total) : null, inn: conv(t.inn), prepUse: conv(t.prepUse), sold: conv(t.sold), used: conv(t.used), out: 0,
      val: hasStart ? conv(val) : null, unit: unit.u, counted: counted === null ? null : conv(counted), diff: counted === null || !hasStart ? null : conv(counted - val), warn: warn.join('、') });
    const chestStart = hasStart && st[CHEST_LOC] !== undefined;
    if (chestStart || t.chestIn || t.chestOut) {
      const cs = chestStart ? st[CHEST_LOC] : 0, cv = cs + t.chestIn - t.chestOut, cw = [];
      if (!chestStart) cw.push('開始数なし');
      if (chestStart && cv < 0) cw.push('マイナス');
      const cc = tana[id] && tana[id][CHEST_LOC] !== undefined ? tana[id][CHEST_LOC] : null;
      rows.push({ table: 'チェストストッカー', id: id, name: name, start: startDate[id] || '', startQty: chestStart ? conv(cs) : null, inn: conv(t.chestIn), prepUse: 0, sold: 0, used: 0, out: conv(t.chestOut),
        val: chestStart ? conv(cv) : null, unit: unit.u, counted: cc === null ? null : conv(cc), diff: cc === null || !chestStart ? null : conv(cc - cv), warn: cw.join('、') });
    }
  });
  rows.sort(function (a, b) { return a.table === b.table ? a.name.localeCompare(b.name, 'ja') : a.table < b.table ? -1 : 1; });
  return { ok: true, rows: rows, warnings: warnings, salesUntil: salesUntil, round: latestRound, at: at, hasStart: Object.keys(startDate).length > 0 };
}
function minStart_(m) {
  return Object.keys(m).map(function (k) { return m[k]; }).sort()[0];
}
function theoryGet_() {
  const res = theoryCalc_();
  const p = PropertiesService.getScriptProperties(), last = Number(p.getProperty('THEORY_SHEET_AT')) || 0, now = Date.now();
  if (now - last >= 300000) {
    p.setProperty('THEORY_SHEET_AT', String(now));
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(THEORY_SHEET);
    if (!sh) { sh = ss.insertSheet(THEORY_SHEET); sh.setFrozenRows(1); sh.protect().setDescription('表示専用。再計算で作り直します').setWarningOnly(true); }
    const blank = function (v) { return v === null ? '' : v; };
    const data = [THEORY_HEADER].concat(res.rows.map(function (r) {
      return [r.table, r.id, r.name, r.start, blank(r.startQty), r.inn, r.prepUse, r.sold, r.used, r.out, blank(r.val), r.unit, blank(r.counted), blank(r.diff), r.warn, res.at];
    }));
    sh.clearContents();
    sh.getRange(1, 1, data.length, THEORY_HEADER.length).setValues(data);
  }
  return res;
}
/** 棚卸回の数を開始数に写す。1回だけ使う想定で、同じ品目をやり直すと後の行が勝つ */
function theoryStart_(req) {
  const round = tanaRound_(req.round), date = String(req.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !req.staff) return { ok: false, error: 'bad_request' };
  const st = tanaState_({ round: round }), at = new Date().toISOString(), master = tanaMaster_().items, byId = {};
  master.forEach(function (it) { byId[it.id] = it; });
  const rows = Object.keys(st.counts).filter(function (k) { return k.indexOf('m:test') !== 0; }).map(function (k) {
    const i = k.lastIndexOf('|'), id = k.slice(0, i), it = byId[id];
    return [id, it ? it.name : '', k.slice(i + 1), date, st.counts[k].small, it ? it.units[it.units.length - 1].u : '', round + ' 棚卸', String(req.staff).slice(0, 40), at];
  });
  if (!rows.length) return { ok: false, error: 'no_counts' };
  withLock_(function () { tanaAppend_(START_SHEET, START_HEADER, rows); });
  return { ok: true, saved: rows.length };
}

/* ---- 仕入れと受入の照合（商品管理システムの画面から）。受入が始まった日以降の仕入れだけ比べる ---- */
function theoryMatch_() {
  const uke = tanaRows_(UKE_SHEET, UKE_HEADER).map(ukeRowObj_).filter(function (o) { return !o.canceled && String(o.route) !== '動作確認'; });
  if (!uke.length) return { since: '', rows: [] };
  const since = uke.map(function (o) { return jstDate_(o.at); }).sort()[0], M = {};
  const get = function (id, name) { return M[id] || (M[id] = { id: id, name: name, buy: [], recv: [], pass: 0, hold: 0, ng: 0 }); };
  uke.forEach(function (o) {
    const m = get(o.id, o.name);
    m.recv.push(o.v + o.unit + '（' + o.res + '）');
    if (o.res === '合格') m.pass++; else if (o.res === '保留') m.hold++; else m.ng++;
  });
  (kvJson_('purchase_master_data_v1', []) || []).forEach(function (p) {
    const d = String(p.deliveryDate || p.date || '');
    if (d < since) return;
    (p.items || []).forEach(function (x) {
      const id = 'm:' + x.materialId;
      get(id, p.itemName || id).buy.push(x.qty + String(p.unit || ''));
    });
  });
  return { since: since, rows: Object.keys(M).map(function (k) {
    const m = M[k];
    return { name: m.name, buy: m.buy.join('、'), recv: m.recv.join('、'), state: !m.recv.length ? '受入の入力なし' : !m.buy.length ? '請求なし' : m.hold ? '判定待ち' : m.ng ? '不合格あり・返品を確認' : '両方あり' };
  }) };
}
function theoryForKanri_() {
  const res = theoryGet_();
  res.match = theoryMatch_();
  res.hold = tanaRows_(UKE_SHEET, UKE_HEADER).map(ukeRowObj_).filter(function (o) { return o.res === '保留' && !o.canceled; }).length;
  return res;
}
/* ログページ用：受入と場所移動 */
function rironLogRows_() {
  const out = [];
  tanaRows_(UKE_SHEET, UKE_HEADER).forEach(function (r) {
    const o = ukeRowObj_(r);
    out.push({ rowId: o.rowId, at: o.at, kind: '受入（' + o.res + '）', id: o.id, name: o.name, v: o.v, unit: o.unit, detail: o.lot ? 'ロット ' + o.lot : '', reason: o.why, exp: o.exp, memo: o.place, by: o.by, route: o.route, canceled: o.canceled });
  });
  tanaRows_(MOVE_SHEET, MOVE_HEADER).forEach(function (r) {
    out.push({ rowId: String(r[0]), at: String(r[1]), kind: '移した', id: String(r[2]), name: String(r[3]), v: Number(r[4]), unit: String(r[5]), detail: String(r[8]), reason: String(r[9]) + ' → ' + String(r[10]), exp: '', memo: '', by: String(r[11]), route: String(r[12]), canceled: String(r[13]) });
  });
  return out;
}
