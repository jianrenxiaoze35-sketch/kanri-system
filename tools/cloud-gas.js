/* ==========================================================
   クラウド保存（GAS＋スプレッドシート）
   GitHub Pages 版。appStoreへの書き込みを、GASのデータAPI経由で「商品管理システム データ」
   スプレッドシートへ送り、どの端末で開いても同じデータを使えるようにする。
   ・開くときに合言葉を確認する（合言葉はGAS側で照合。端末ごとに1回入れれば覚えておく）。
   ・起動時：クラウドの全データを読み込み、メモリキャッシュとIndexedDB（端末内の控え）を置き換える。
   ・保存時：appStore.setItem/removeItemの後、少し待ってからまとめてクラウドへ送る。
   ・別の端末が先に同じ項目を更新していたら、上書きしてよいか確認する。
   ・クラウドにつながらないとき：このブラウザ内だけで動く（画面上部に表示）。
   値はgzip圧縮＋base64で送る（GAS側はそのまま保存するだけ）。
   ========================================================== */
const CLOUD_API_URL = "https://script.google.com/macros/s/AKfycbzHLwuhJxkL0l9MLwo8gy9jLxHaPqQqH4UXimT1Kklgi4jziBkiSWx-6YQZxoLXVqcWLg/exec";
const CLOUD_PASS_KEY = "kanri_pass_v1";
const CLOUD_TAB_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const CLOUD_SYNCED_ONCE_KEY = "cloud_synced_once_v1";
const CLOUD_LOCAL_DIRTY_KEY = "cloud_local_dirty_v1";
const CLOUD_BATCH_CHARS = 4000000;   // 1回の送信の目安（約4MB）
const LOCAL_SNAPSHOT_DB = "app_local_snapshot_v1";
let _cloudMode = "pending";          // pending | cloud | local
let _cloudLocalReason = "";
let _cloudPending = new Set();
let _cloudRemote = new Map();        // key -> ver（この端末が把握しているクラウド上の版）
let _cloudTimer = null;
let _cloudFlushing = null;
let _cloudLoadedAt = 0;
let _cloudKnownWriteAt = null;       // この端末が最後に把握したクラウドの更新時刻（サーバー時刻）
let _cloudLastError = null;
let _cloudLastSavedAt = null;
let _cloudReloading = false;
let _localHadDataBeforeSeed = false;

const CLOUD_KEY_LABELS = {
  product_master_data_v1: "商品マスタ", material_master_data_v1: "原料・資材・半製品マスタ",
  recipe_master_data_v1: "原価・レシピ", purchase_master_data_v1: "請求書／仕入れ",
  sales_master_data_v1: "売上管理", labor_attendance_data_v1: "人件費（勤怠）",
  labor_employees_data_v1: "人件費（従業員）", product_master_options_v1: "設定（選択肢）",
  regi_settings_v1: "レジ締め設定"
};
function cloudKeyLabel(k){ return CLOUD_KEY_LABELS[k] ? `${CLOUD_KEY_LABELS[k]}（${k}）` : k; }
function cloudSleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function cloudEsc(s){ return String(s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function cloudGetPass(){ try{ return localStorage.getItem(CLOUD_PASS_KEY) || ""; }catch(e){ return ""; } }

/* ---- GAS呼び出し ---- */
async function cloudApi(action, body, passOverride){
  const payload = Object.assign({}, body || {}, {action, pass: passOverride !== undefined ? passOverride : cloudGetPass(), tab: CLOUD_TAB_ID});
  let res;
  for(let i=0;;i++){
    try{
      res = await fetch(CLOUD_API_URL, {method: "POST", headers: {"Content-Type": "text/plain;charset=utf-8"}, body: JSON.stringify(payload)});
      if(!res.ok) throw {code: "unavailable", message: "HTTP " + res.status};
      const json = await res.json();
      if(!json.ok){
        const code = json.error || "server_error";
        if(code === "server_error" && i < 2){ await cloudSleep(1500 * (i + 1)); continue; }
        throw {code, message: json.message || code};
      }
      return json;
    }catch(err){
      const code = err && err.code;
      if(code && code !== "unavailable") throw err;
      if(i >= 2) throw {code: "unavailable", message: (err && err.message) || String(err)};
      await cloudSleep(1500 * (i + 1));
    }
  }
}

async function cloudEncode(str){
  if(typeof CompressionStream !== "function") return {enc: "raw", payload: str};
  const cs = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = new Uint8Array(await new Response(cs).arrayBuffer());
  let bin = "";
  for(let i=0;i<buf.length;i+=0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return {enc: "gz", payload: btoa(bin)};
}
async function cloudDecode(enc, payload){
  if(enc !== "gz") return payload;
  const bin = atob(payload);
  const buf = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) buf[i] = bin.charCodeAt(i);
  const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(ds).text();
}
function cloudNewVer(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/* ---- 書き込み ---- */
async function cloudBuildItem(key){
  const baseVer = _cloudRemote.get(key) || "";
  if(!_regiDailyCache.has(key)) return {k: key, del: true, baseVer};
  const {enc, payload} = await cloudEncode(_regiDailyCache.get(key));
  return {k: key, ver: cloudNewVer(), enc, d: payload, baseVer};
}
// itemsを約4MBずつに分けて送る。競合したキーは確認のうえ強制上書き、または読み込み直し。
async function cloudSendItems(items, force){
  const batches = [];
  let cur = [], size = 0;
  items.forEach(it=>{
    const s = (it.d || "").length + 200;
    if(cur.length && size + s > CLOUD_BATCH_CHARS){ batches.push(cur); cur = []; size = 0; }
    cur.push(it); size += s;
  });
  if(cur.length) batches.push(cur);
  const conflicts = [];
  for(const batch of batches){
    if(_cloudReloading) return;
    const res = await cloudApi("put", {items: batch, force: !!force});
    res.saved.forEach(s=>_cloudRemote.set(s.k, s.ver));
    (res.deleted || []).forEach(k=>_cloudRemote.delete(k));
    if(res.meta) _cloudKnownWriteAt = res.meta.lastWriteAt;
    res.conflicts.forEach(c=>conflicts.push(Object.assign({}, c, {item: batch.find(b=>b.k === c.k)})));
  }
  if(!conflicts.length) return;
  const names = conflicts.map(c=>`・${cloudKeyLabel(c.k)}（${c.at ? new Date(c.at).toLocaleString("ja-JP") : ""}）`).join("\n");
  const ok = confirm(`次の項目は、この画面を開いた後に別の端末で更新されています。\n${names}\n\nOK：この端末の内容でクラウドを上書きする（別の端末での変更は失われます）\nキャンセル：上書きせず、最新のデータを読み込み直す（この端末での直前の変更は失われます）`);
  if(!ok){ cloudReloadDiscard(); return; }
  await cloudSendItems(conflicts.map(c=>c.item), true);
}
function cloudOnChange(key){
  if(_cloudMode === "cloud"){
    _cloudPending.add(key);
    clearTimeout(_cloudTimer);
    _cloudTimer = setTimeout(cloudFlush, 1500);
    cloudRenderStatus();
  } else if(_cloudMode === "local"){
    try{ if(localStorage.getItem(CLOUD_SYNCED_ONCE_KEY) === "1") localStorage.setItem(CLOUD_LOCAL_DIRTY_KEY, "1"); }catch(e){}
  }
}
function cloudFlush(){
  if(_cloudMode !== "cloud") return Promise.resolve();
  if(_cloudFlushing) return _cloudFlushing.then(()=>_cloudPending.size ? cloudFlush() : undefined);
  clearTimeout(_cloudTimer);
  if(!_cloudPending.size) return Promise.resolve();
  const keys = [..._cloudPending];
  _cloudPending.clear();
  let failed = false;
  _cloudFlushing = (async ()=>{
    try{
      const items = [];
      for(const k of keys) items.push(await cloudBuildItem(k));
      await cloudSendItems(items, false);
      _cloudLastError = null;
      _cloudLastSavedAt = new Date();
    }catch(err){
      console.error("cloud: 保存に失敗", err);
      _cloudLastError = err;
      failed = true;
      keys.forEach(k=>_cloudPending.add(k));
      if(err && err.code === "bad_pass") cloudAuthLost();
    }
  })().finally(()=>{
    _cloudFlushing = null;
    if(_cloudPending.size && !_cloudReloading && _cloudMode === "cloud"){
      clearTimeout(_cloudTimer);
      _cloudTimer = setTimeout(cloudFlush, failed ? 20000 : 1500);
    }
    cloudRenderStatus();
  });
  cloudRenderStatus();
  return _cloudFlushing;
}
async function appReloadAfterSync(){
  try{ await cloudFlush(); }catch(e){}
  _cloudReloading = true;
  location.reload();
}
function cloudReloadDiscard(){
  _cloudReloading = true;
  _cloudPending.clear();
  setTimeout(()=>location.reload(), 50);
}
window.addEventListener("beforeunload", e=>{
  if(_cloudReloading) return;
  if(_cloudMode === "cloud" && (_cloudPending.size || _cloudFlushing)){
    cloudFlush();
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ---- 端末内の控え ---- */
function localSnapshotDb(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(LOCAL_SNAPSHOT_DB, 1);
    req.onupgradeneeded = ()=>{ req.result.createObjectStore("s"); };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
async function localSnapshotSave(reason){
  const data = {};
  _regiDailyCache.forEach((v, k)=>{ data[k] = v; });
  const db = await localSnapshotDb();
  await new Promise((resolve, reject)=>{
    const tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put({at: new Date().toISOString(), reason, data}, "snapshot");
    tx.oncomplete = resolve; tx.onerror = ()=>reject(tx.error);
  });
}
async function localSnapshotGet(){
  const db = await localSnapshotDb();
  return await new Promise((resolve, reject)=>{
    const req = db.transaction("s", "readonly").objectStore("s").get("snapshot");
    req.onsuccess = ()=>resolve(req.result || null);
    req.onerror = ()=>reject(req.error);
  });
}
async function regiIdbReplaceAll(entries){
  const db = await openRegiIdb();
  await new Promise((resolve, reject)=>{
    const tx = db.transaction(REGI_IDB_STORE_NAME, "readwrite");
    const store = tx.objectStore(REGI_IDB_STORE_NAME);
    store.clear();
    entries.forEach(([k, v])=>store.put(v, k));
    tx.oncomplete = resolve; tx.onerror = ()=>reject(tx.error);
  });
}

/* ---- 合言葉の入力 ---- */
function cloudAskPass(message){
  return new Promise(resolve=>{
    const wrap = document.createElement("div");
    wrap.id = "cloudPassGate";
    wrap.style.cssText = "position:fixed;inset:0;z-index:10000;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:16px;";
    wrap.innerHTML = `<form style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:24px 26px;width:340px;max-width:100%;box-shadow:0 4px 18px rgba(0,0,0,.08);">
      <h3 style="margin:0 0 6px;color:var(--main-dark);">商品管理システム</h3>
      <div class="hint" style="margin-bottom:14px;">合言葉を入力してください。この端末では次回から入力不要です。</div>
      <input type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:9px 10px;font-size:15px;border:1px solid var(--border);border-radius:6px;" placeholder="合言葉">
      <div class="cloud-pass-msg" style="color:var(--danger);font-size:12px;min-height:18px;margin:8px 0;">${message ? cloudEsc(message) : ""}</div>
      <button type="submit" style="width:100%;padding:10px;font-size:14px;">開く</button>
    </form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector("form");
    const input = wrap.querySelector("input");
    const msg = wrap.querySelector(".cloud-pass-msg");
    const btn = wrap.querySelector("button");
    setTimeout(()=>input.focus(), 50);
    form.addEventListener("submit", async e=>{
      e.preventDefault();
      const pass = input.value.trim();
      if(!pass) return;
      btn.disabled = true; btn.textContent = "確認中…"; msg.textContent = "";
      try{
        await cloudApi("ping", {}, pass);
        try{ localStorage.setItem(CLOUD_PASS_KEY, pass); }catch(err){}
        wrap.remove();
        resolve(true);
      }catch(err){
        msg.textContent = err && err.code === "bad_pass" ? "合言葉が違います。" : "接続できませんでした。通信状態を確認してもう一度お試しください。";
        btn.disabled = false; btn.textContent = "開く";
        input.select();
      }
    });
  });
}

/* ---- 起動時の接続 ---- */
function cloudBootMessage(text){
  const el = document.getElementById("appBootLoadingMsg");
  if(el) el.textContent = text;
}
// 開いている途中で合言葉が変わった：再試行しても通らないので止める（再試行し続けない）。
// 未保存の変更はこのブラウザ内に残り、次にクラウドから読み込むときに控えへ退避される。
let _cloudAuthLostAlerted = false;
function cloudAuthLost(){
  try{ localStorage.removeItem(CLOUD_PASS_KEY); localStorage.setItem(CLOUD_LOCAL_DIRTY_KEY, "1"); }catch(e){}
  cloudGoLocal("合言葉が変更されたため、クラウドとの接続を止めました（ページを開き直して新しい合言葉を入力してください）");
  if(!_cloudAuthLostAlerted){
    _cloudAuthLostAlerted = true;
    alert("合言葉が変更されたため、クラウドに保存できなくなりました。ページを開き直して、新しい合言葉を入力してください。\n（この端末で保存しきれなかった変更は、設定の「このブラウザ内の控え」に残ります）");
  }
}
function cloudGoLocal(reason){
  _cloudMode = "local";
  _cloudLocalReason = reason;
  cloudSettingsInit();
}
async function cloudInit(){
  cloudBootMessage("クラウドに接続中…");
  // 合言葉：保存済みなら確かめる。無い・違うときは入力してもらう（入れるまで先へ進まない）
  if(!cloudGetPass()){
    await cloudAskPass("");
  } else {
    try{ await cloudApi("ping"); }
    catch(err){
      if(err && err.code === "bad_pass"){
        try{ localStorage.removeItem(CLOUD_PASS_KEY); }catch(e){}
        await cloudAskPass("合言葉が変更されています。新しい合言葉を入力してください。");
      } else {
        cloudGoLocal("クラウドに接続できませんでした（通信状態を確認して、開き直してください）");
        return;
      }
    }
  }
  cloudBootMessage("クラウドからデータを読み込み中…");
  let res;
  try{ res = await cloudApi("load"); }
  catch(err){ console.error(err); cloudGoLocal("クラウドの読み込みに失敗しました（" + ((err && err.code) || err) + "）"); return; }

  if(res.items.length){
    const loaded = new Map();
    const remote = new Map();
    const broken = (res.broken || []).slice();
    for(const it of res.items){
      try{ loaded.set(it.k, await cloudDecode(it.enc, it.d)); remote.set(it.k, it.ver); }
      catch(err){ console.error("cloud: 展開に失敗", it.k, err); broken.push(it.k); }
    }
    let syncedOnce = false, dirty = false;
    try{ syncedOnce = localStorage.getItem(CLOUD_SYNCED_ONCE_KEY) === "1"; dirty = localStorage.getItem(CLOUD_LOCAL_DIRTY_KEY) === "1"; }catch(e){}
    if((!syncedOnce && _localHadDataBeforeSeed) || dirty){
      try{ await localSnapshotSave(dirty ? "クラウド未接続のあいだにこのブラウザで変更したデータ" : "クラウド版に切り替える前のこのブラウザのデータ"); }
      catch(e){ console.warn("cloud: 控えの保存に失敗", e); }
    }
    const keep = new Map();
    broken.forEach(k=>{ if(_regiDailyCache.has(k)) keep.set(k, _regiDailyCache.get(k)); });
    _regiDailyCache.clear();
    loaded.forEach((v, k)=>_regiDailyCache.set(k, v));
    keep.forEach((v, k)=>_regiDailyCache.set(k, v));
    _cloudRemote = remote;
    try{ await regiIdbReplaceAll([..._regiDailyCache.entries()]); }catch(e){ console.warn("cloud: 端末内の控えの更新に失敗", e); }
    try{ localStorage.setItem(CLOUD_SYNCED_ONCE_KEY, "1"); localStorage.removeItem(CLOUD_LOCAL_DIRTY_KEY); }catch(e){}
    _cloudMode = "cloud";
    if(keep.size){ keep.forEach((v, k)=>_cloudPending.add(k)); setTimeout(cloudFlush, 3000); }
    if(broken.length) console.warn("cloud: 読み込めなかったキー", broken);
  } else {
    // クラウドが空：このブラウザにデータがあれば登録する
    const keys = [..._regiDailyCache.keys()];
    if(keys.length){
      const ok = confirm(`クラウドにはまだデータがありません。\nこのブラウザに保存されているデータ（${keys.length}件）をクラウドへ登録します。\n\nキャンセルすると、今回はこのブラウザ内だけで動きます。`);
      if(!ok){ cloudGoLocal("初回のクラウド登録を見送りました（次に開いたとき、もう一度確認します）"); return; }
      cloudBootMessage(`このブラウザのデータをクラウドへ登録中…（${keys.length}件）`);
      try{
        const items = [];
        for(const k of keys) items.push(await cloudBuildItem(k));
        await cloudSendItems(items, true);
      }catch(err){
        console.error(err);
        alert("クラウドへの登録に失敗しました（" + ((err && err.code) || err) + "）。データはこのブラウザ内に残っています。次に開いたとき、もう一度登録します。");
        cloudGoLocal("クラウドへの初回登録が完了していません");
        return;
      }
      _cloudLastSavedAt = new Date();
    }
    try{ localStorage.setItem(CLOUD_SYNCED_ONCE_KEY, "1"); localStorage.removeItem(CLOUD_LOCAL_DIRTY_KEY); }catch(e){}
    _cloudMode = "cloud";
  }
  _cloudLoadedAt = Date.now();
  if(res.meta && _cloudKnownWriteAt === null) _cloudKnownWriteAt = res.meta.lastWriteAt;
  // 他の端末・タブでの更新を、1分ごと（画面を開いているとき）に確認する
  const check = async ()=>{
    if(document.hidden || _cloudMode !== "cloud" || _cloudFlushing) return;
    try{
      const m = (await cloudApi("meta")).meta;
      if(m.lastTab && m.lastTab !== CLOUD_TAB_ID && m.lastWriteAt && m.lastWriteAt !== _cloudKnownWriteAt){
        const el = document.getElementById("cloudRemoteUpdateBanner");
        if(el){
          el.querySelector("span").textContent = `別の端末・タブでデータが更新されました（${new Date(m.lastWriteAt).toLocaleString("ja-JP")}）。最新の内容を見るには再読み込みしてください。`;
          el.style.display = "flex";
        }
      }
    }catch(e){
      if(e && e.code === "bad_pass") cloudAuthLost();
    }
  };
  setInterval(check, 60000);
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) check(); });
  cloudSettingsInit();
}

/* ---- 表示 ---- */
function cloudRenderStatus(){
  const side = document.getElementById("cloudStatusSide");
  const banner = document.getElementById("cloudLocalBanner");
  let text = "", color = "#dfe9e3";
  if(_cloudMode === "pending"){ text = "☁ 接続中…"; }
  else if(_cloudMode === "local"){ text = "💻 このブラウザのみ"; color = "#ffd27a"; }
  else if(_cloudFlushing || _cloudPending.size){ text = "⏳ クラウドへ保存中…"; }
  else if(_cloudLastError){ text = "⚠ 保存に失敗（再試行します）"; color = "#ffb4a8"; }
  else { text = "☁ クラウドに保存済み"; }
  if(side){ side.textContent = text; side.style.color = color; }
  if(banner){
    banner.style.display = _cloudMode === "local" ? "block" : "none";
    if(_cloudMode === "local") banner.textContent = "💻 " + _cloudLocalReason + "。いまの変更はこのブラウザ内にだけ保存され、他の端末には反映されません。";
  }
  const panel = document.getElementById("cloudSettingsStatus");
  if(panel){
    const lines = [`状態：${text}`];
    if(_cloudMode === "cloud"){
      lines.push(`読み込んだ時刻：${new Date(_cloudLoadedAt).toLocaleString("ja-JP")}`);
      if(_cloudLastSavedAt) lines.push(`最後に保存した時刻：${_cloudLastSavedAt.toLocaleString("ja-JP")}`);
      lines.push(`クラウド上のデータ：${_cloudRemote.size}件`);
    }
    if(_cloudMode === "local") lines.push(`理由：${_cloudLocalReason}`);
    if(_cloudLastError) lines.push(`直近のエラー：${(_cloudLastError.code || "") + " " + (_cloudLastError.message || "")}`);
    panel.innerHTML = lines.map(l=>`<div>${cloudEsc(l)}</div>`).join("");
  }
}
async function cloudRenderSnapshotInfo(){
  const el = document.getElementById("cloudSnapshotInfo");
  if(!el) return;
  let snap = null;
  try{ snap = await localSnapshotGet(); }catch(e){}
  if(!snap){ el.innerHTML = '<div class="hint">このブラウザには控えはありません。</div>'; return; }
  const n = Object.keys(snap.data || {}).length;
  el.innerHTML = `<div class="hint">${cloudEsc(new Date(snap.at).toLocaleString("ja-JP"))} に保存した控え（${n}件）：${cloudEsc(snap.reason)}</div>
    <div class="toolbar" style="margin-top:6px;">
      <button class="secondary" onclick="cloudDownloadSnapshot()">💾 控えをJSONで保存</button>
      <button class="danger" onclick="cloudRestoreSnapshot()">☁ 控えの内容でクラウドを上書き</button>
    </div>`;
}
async function cloudDownloadSnapshot(){
  const snap = await localSnapshotGet();
  if(!snap) return;
  const data = {};
  Object.keys(snap.data).forEach(k=>{ try{ data[k] = JSON.parse(snap.data[k]); }catch(e){ data[k] = snap.data[k]; } });
  const blob = new Blob([JSON.stringify({type: "full_app_backup_v1", exportedAt: snap.at, data})], {type: "application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `商品管理システム_ブラウザ内の控え_${snap.at.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
async function cloudRestoreSnapshot(){
  if(_cloudMode !== "cloud"){ alert("クラウドに接続しているときだけ使えます。"); return; }
  const snap = await localSnapshotGet();
  if(!snap) return;
  const n = Object.keys(snap.data).length;
  if(!confirm(`${new Date(snap.at).toLocaleString("ja-JP")} の控え（${n}件）で、クラウドの同じ項目を上書きします。他の端末で入力した同じ項目の内容は失われます。よろしいですか？`)) return;
  Object.keys(snap.data).forEach(k=>appStore.setItem(k, snap.data[k]));
  await appReloadAfterSync();
}
async function cloudChangePass(){
  if(_cloudMode !== "cloud"){ alert("クラウドに接続しているときだけ使えます。"); return; }
  const next = prompt("新しい合言葉（8文字以上）を入力してください。\n変更すると、他の端末では次に開いたときに新しい合言葉の入力が必要になります。");
  if(next === null) return;
  if(next.trim().length < 8){ alert("8文字以上にしてください。"); return; }
  const again = prompt("確認のため、もう一度入力してください。");
  if(again === null) return;
  if(again.trim() !== next.trim()){ alert("2回の入力が一致しませんでした。"); return; }
  try{
    await cloudFlush();
    await cloudApi("changePass", {newPass: next.trim()});
    try{ localStorage.setItem(CLOUD_PASS_KEY, next.trim()); }catch(e){}
    alert("合言葉を変更しました。");
  }catch(err){ alert("変更できませんでした（" + ((err && err.code) || err) + "）。"); }
}
async function cloudForgetPass(){
  if(!confirm("この端末に記憶している合言葉を消して、データの表示を閉じます。次に開くときは合言葉の入力が必要です。よろしいですか？")) return;
  try{ await cloudFlush(); }catch(e){}
  try{ localStorage.removeItem(CLOUD_PASS_KEY); }catch(e){}
  try{ await regiIdbReplaceAll([]); }catch(e){}
  _cloudReloading = true;
  location.reload();
}
function cloudSettingsInit(){
  cloudRenderStatus();
  cloudRenderSnapshotInfo();
}
