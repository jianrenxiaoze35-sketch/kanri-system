/**
 * 商品管理システム データAPI（GAS）
 * GitHub Pages に置いた画面から呼ばれ、アプリの全データをこのスプレッドシートに保存する。
 *
 * シート「kv」：1行 = 1キーの1断片。値は画面側で gzip+base64 済みの文字列。
 *   A:key  B:ver  C:enc  D:at  E:tab  F:idx  G:n  H:data（1セル4.5万文字まで）
 *   同じキーの行は必ず連続して並ぶ（書き込み時に丸ごと差し替える）。
 * 合言葉：スクリプトプロパティ PASS_HASH（SHA-256）。最初の setup 呼び出しで1回だけ設定できる。
 */

/** 先頭は読むだけの関数（エディタで誤って実行しても何も書かない） */
function diag() {
  const sh = kvSheet_();
  const props = PropertiesService.getScriptProperties().getProperties();
  Logger.log(JSON.stringify({
    rows: Math.max(sh.getLastRow() - 1, 0),
    passSet: !!props.PASS_HASH,
    lastWriteAt: props.LAST_WRITE_AT || null
  }));
}

const KV_SHEET = 'kv';
const KV_HEADER = ['key', 'ver', 'enc', 'at', 'tab', 'idx', 'n', 'data'];
const CELL_CHARS = 45000;

function doGet() {
  return json_({ ok: true, app: 'kanri-system', time: new Date().toISOString() });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'bad_request' }); }
  try {
    if (req.action === 'setup') return json_(setup_(req));
    if (!checkPass_(req.pass)) return json_({ ok: false, error: 'bad_pass' });
    switch (req.action) {
      case 'ping': return json_({ ok: true, meta: meta_() });
      case 'meta': return json_({ ok: true, meta: meta_() });
      case 'load': return json_(load_());
      case 'put': return json_(put_(req));
      case 'changePass': return json_(changePass_(req));
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'server_error', message: String(err && err.message || err) });
  }
}

/* ---- 合言葉 ---- */
function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'kanri-system:' + String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function checkPass_(pass) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails >= 30) { Utilities.sleep(2000); return false; }
  const stored = PropertiesService.getScriptProperties().getProperty('PASS_HASH');
  if (stored && pass && hash_(pass) === stored) return true;
  cache.put('fails', String(fails + 1), 600);
  Utilities.sleep(1000);
  return false;
}
function setup_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('PASS_HASH')) return { ok: false, error: 'already_set' };
    if (!req.pass || String(req.pass).length < 8) return { ok: false, error: 'pass_too_short' };
    props.setProperty('PASS_HASH', hash_(req.pass));
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function changePass_(req) {
  if (!req.newPass || String(req.newPass).length < 8) return { ok: false, error: 'pass_too_short' };
  PropertiesService.getScriptProperties().setProperty('PASS_HASH', hash_(req.newPass));
  return { ok: true };
}

/* ---- データ ---- */
function kvSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(KV_SHEET);
  if (!sh) {
    sh = ss.insertSheet(KV_SHEET);
    sh.getRange(1, 1, 1, KV_HEADER.length).setValues([KV_HEADER]);
    sh.setFrozenRows(1);
  }
  return sh;
}
function meta_() {
  const p = PropertiesService.getScriptProperties();
  return { lastWriteAt: p.getProperty('LAST_WRITE_AT') || null, lastTab: p.getProperty('LAST_TAB') || null };
}
function readAll_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, KV_HEADER.length).getValues();
}
function load_() {
  const rows = readAll_(kvSheet_());
  const map = {};
  const order = [];
  rows.forEach(function (r) {
    const key = String(r[0]);
    if (!key) return;
    if (!map[key]) { map[key] = { k: key, ver: String(r[1]), enc: String(r[2]), at: String(r[3]), n: Number(r[6]) || 1, parts: [] }; order.push(key); }
    if (String(r[1]) === map[key].ver) map[key].parts[Number(r[5]) || 0] = String(r[7]);
  });
  const items = [];
  const broken = [];
  order.forEach(function (k) {
    const it = map[k];
    let ok = true;
    for (let i = 0; i < it.n; i++) if (typeof it.parts[i] !== 'string') ok = false;
    if (!ok) { broken.push(k); return; }
    items.push({ k: it.k, ver: it.ver, enc: it.enc, at: it.at, d: it.parts.join('') });
  });
  return { ok: true, items: items, broken: broken, meta: meta_() };
}

/**
 * items: [{k, ver, enc, d, baseVer, del}]
 * baseVer が今のverと違えば、force でない限り書かずに conflicts で返す。
 */
function put_(req) {
  const items = req.items || [];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = kvSheet_();
    const rows = readAll_(sh);
    // キーごとの行位置（シート上の行番号）と現在のver
    const pos = {};
    rows.forEach(function (r, i) {
      const key = String(r[0]);
      if (!key) return;
      if (!pos[key]) pos[key] = { start: i + 2, count: 0, ver: String(r[1]), at: String(r[3]), tab: String(r[4]) };
      pos[key].count++;
    });
    const conflicts = [];
    const accepted = [];
    items.forEach(function (it) {
      const cur = pos[it.k];
      if (!req.force && cur && cur.ver !== (it.baseVer || '') && cur.tab !== req.tab) {
        conflicts.push({ k: it.k, ver: cur.ver, at: cur.at });
        return;
      }
      accepted.push(it);
    });
    // 下の行から消していくと行番号がずれない
    accepted
      .filter(function (it) { return pos[it.k]; })
      .sort(function (a, b) { return pos[b.k].start - pos[a.k].start; })
      .forEach(function (it) { sh.deleteRows(pos[it.k].start, pos[it.k].count); });
    const at = new Date().toISOString();
    const out = [];
    const saved = [];
    accepted.forEach(function (it) {
      if (it.del) return;
      const d = String(it.d || '');
      const n = Math.max(1, Math.ceil(d.length / CELL_CHARS));
      for (let i = 0; i < n; i++) {
        out.push([it.k, it.ver, it.enc, at, req.tab || '', i, n, d.slice(i * CELL_CHARS, (i + 1) * CELL_CHARS)]);
      }
      saved.push({ k: it.k, ver: it.ver });
    });
    if (out.length) {
      // 値が「=」で始まっても数式にならないよう、書式をテキストにしてから書く
      const start = sh.getLastRow() + 1;
      const range = sh.getRange(start, 1, out.length, KV_HEADER.length);
      range.setNumberFormat('@');
      range.setValues(out);
    }
    if (accepted.length) {
      const p = PropertiesService.getScriptProperties();
      p.setProperty('LAST_WRITE_AT', at);
      p.setProperty('LAST_TAB', req.tab || '');
    }
    return { ok: true, saved: saved, deleted: accepted.filter(function (it) { return it.del; }).map(function (it) { return it.k; }), conflicts: conflicts, meta: meta_() };
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
