/* ---- 賞味期限・ポーション基準のシート（2026-11-14） ----
 * スタッフが書き込むのはスプレッドシート「レストラン食材 賞味期限・ポーション基準（製品ごと）」のまま。
 * 商品管理はここを読んで原料マスタの横に並べる（kigenRead）のと、商品管理に増えた食材の行を
 * シートに足す（kigenAdd）だけ。シートの値を商品管理側で書き換えることはしない。
 * 品名（商品管理の表記）でつなぐ。見出しの文字で列を探すので、列の並べ替えには耐える。 */
const KIGEN_SHEET_ID = '1T-LhnDp1zoKdgYC8wSfhCMXn1eJ3REHjcRV5_DABEVs';
const KIGEN_TAB = '基準表';
const KIGEN_HEAD_ROW = 2;
const KIGEN_COLS = [
  ['No', 'no'], ['分類', 'bunrui'], ['品名（商品管理の表記）', 'name'],
  ['入荷時の状態', 'arrive'], ['保管場所', 'place'],
  ['未開封の期限', 'unopened'], ['開封後の使用期限（日）', 'openDays'], ['解凍のしかた', 'thaw'],
  ['解凍後の使用期限（日）', 'thawDays'], ['仕込み後の使用期限（日）', 'prepDays'], ['期限切れ・迷ったとき', 'onExpire'],
  ['ポーションにする', 'portion'], ['1ポーションの量', 'portionQty'], ['単位', 'portionUnit'],
  ['1箱に入れる数', 'perBox'], ['箱の置き場所', 'boxPlace'], ['先出しの置き方', 'fifo'],
  ['記入者', 'by'], ['記入日', 'date'], ['責任者確認', 'checked'], ['メモ（根拠・メーカー表示など）', 'memo']
];
const KIGEN_ADD_MAX = 50;

/** エディタで実行して、シートを開く権限を承認するための読むだけの関数 */
function kigenCheck() {
  const r = kigenRead_();
  Logger.log(r.title + ' 行数 ' + r.rows.length + ' 見つからない列 ' + JSON.stringify(r.missingCols));
}

function kigenNorm_(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}
function kigenOpen_() {
  const ss = SpreadsheetApp.openById(KIGEN_SHEET_ID);
  const sh = ss.getSheetByName(KIGEN_TAB);
  if (!sh) throw new Error('シートに「' + KIGEN_TAB + '」のタブがありません');
  const lastCol = sh.getLastColumn();
  const head = sh.getRange(KIGEN_HEAD_ROW, 1, 1, lastCol).getDisplayValues()[0].map(function (s) { return String(s).trim(); });
  const idx = {};
  KIGEN_COLS.forEach(function (c) { idx[c[1]] = head.indexOf(c[0]); });
  if (idx.name < 0) throw new Error('「品名（商品管理の表記）」の列が見つかりません');
  return { ss: ss, sh: sh, lastCol: lastCol, idx: idx };
}
/** 見出しの次の行から、品名のある最後の行までを読む */
function kigenRows_(o) {
  const n = o.sh.getLastRow() - KIGEN_HEAD_ROW;
  const vals = n > 0 ? o.sh.getRange(KIGEN_HEAD_ROW + 1, 1, n, o.lastCol).getDisplayValues() : [];
  const rows = [];
  vals.forEach(function (v, i) {
    const name = String(v[o.idx.name] || '').trim();
    if (!name) return;
    const r = { row: KIGEN_HEAD_ROW + 1 + i };
    KIGEN_COLS.forEach(function (c) { r[c[1]] = o.idx[c[1]] < 0 ? '' : String(v[o.idx[c[1]]] || '').trim(); });
    r.checked = String(r.checked).toUpperCase() === 'TRUE';
    rows.push(r);
  });
  return rows;
}
function kigenRead_() {
  const o = kigenOpen_();
  return {
    ok: true, title: o.ss.getName(), url: o.ss.getUrl(), tab: KIGEN_TAB,
    rows: kigenRows_(o),
    missingCols: KIGEN_COLS.filter(function (c) { return o.idx[c[1]] < 0; }).map(function (c) { return c[0]; }),
    at: new Date().toISOString()
  };
}
/** 商品管理に有ってシートに無い食材の行を、表の最後に足す（No・分類・品名だけ。書式とプルダウンは1行目の写し） */
function kigenAdd_(req) {
  const items = (Array.isArray(req.items) ? req.items : []).slice(0, KIGEN_ADD_MAX).map(function (x) {
    return { name: String((x && x.name) || '').trim().slice(0, 200), bunrui: String((x && x.bunrui) || '').trim().slice(0, 50) };
  }).filter(function (x) { return x.name; });
  if (!items.length) return { ok: false, error: 'no_items' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const o = kigenOpen_();
    const rows = kigenRows_(o);
    const have = {};
    rows.forEach(function (r) { have[kigenNorm_(r.name)] = 1; });
    let lastRow = rows.length ? rows[rows.length - 1].row : KIGEN_HEAD_ROW;
    let no = rows.reduce(function (mx, r) { const v = parseInt(r.no, 10); return v > mx ? v : mx; }, 0);
    const tpl = rows.length ? o.sh.getRange(rows[0].row, 1, 1, o.lastCol) : null;
    const added = [], skipped = [];
    items.forEach(function (it) {
      const key = kigenNorm_(it.name);
      if (have[key]) { skipped.push(it.name); return; }
      have[key] = 1;
      const r = lastRow + 1;
      if (r > o.sh.getMaxRows()) o.sh.insertRowsAfter(o.sh.getMaxRows(), 10);
      const dest = o.sh.getRange(r, 1, 1, o.lastCol);
      if (tpl) {
        tpl.copyTo(dest, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
        tpl.copyTo(dest, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
      }
      const line = new Array(o.lastCol).fill('');
      no += 1;
      if (o.idx.no >= 0) line[o.idx.no] = no;
      if (o.idx.bunrui >= 0) line[o.idx.bunrui] = it.bunrui;
      line[o.idx.name] = it.name;
      if (o.idx.checked >= 0) line[o.idx.checked] = false;
      dest.setValues([line]);
      lastRow = r;
      added.push(it.name);
    });
    SpreadsheetApp.flush();
    return { ok: true, added: added, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}
