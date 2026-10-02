// 全データバックアップ(JSON)を、GASのデータAPIへそのまま登録する（初回投入用）。
// 使い方: node tools/seed.mjs <backup.json>   （合言葉は環境変数 KANRI_PASS）
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const API = "https://script.google.com/macros/s/AKfycbzHLwuhJxkL0l9MLwo8gy9jLxHaPqQqH4UXimT1Kklgi4jziBkiSWx-6YQZxoLXVqcWLg/exec";
const pass = process.env.KANRI_PASS;
if (!pass) throw new Error("KANRI_PASS が未設定");
const backup = JSON.parse(readFileSync(process.argv[2], "utf8"));
const tab = "seed-" + Date.now().toString(36);

const items = Object.entries(backup.data).map(([k, v]) => {
  const str = typeof v === "string" ? v : JSON.stringify(v);
  return { k, ver: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), enc: "gz", d: gzipSync(Buffer.from(str, "utf8")).toString("base64"), baseVer: "" };
});

const batches = [];
let cur = [], size = 0;
for (const it of items) {
  if (cur.length && size + it.d.length > 3_000_000) { batches.push(cur); cur = []; size = 0; }
  cur.push(it); size += it.d.length;
}
if (cur.length) batches.push(cur);

let total = 0;
for (const [i, batch] of batches.entries()) {
  const res = await fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "put", pass, tab, force: true, items: batch }) });
  const json = await res.json();
  if (!json.ok) throw new Error(`batch ${i}: ${json.error} ${json.message || ""}`);
  total += json.saved.length;
  console.log(`batch ${i + 1}/${batches.length}: ${json.saved.length}件`);
}
console.log(`完了: ${total} / ${items.length} 件`);
