// 计算 index.html 里 modulepreload / script / stylesheet 引用的首屏文件体积
// 用法：node scripts/first-screen-size.mjs [dist 目录]
import { readFileSync, statSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { resolve } from "node:path";

const dir = process.argv[2] || "dist/client";
const html = readFileSync(resolve(dir, "index.html"), "utf8");

const files = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((m) => m[1]);
const uniq = [...new Set(files)];

let rawTotal = 0;
let gzTotal = 0;
let brTotal = 0;
const rows = [];

for (const f of uniq) {
  const p = resolve(dir, "assets", f);
  const buf = readFileSync(p);
  const raw = statSync(p).size;
  const gz = gzipSync(buf).length;
  const br = brotliCompressSync(buf).length;
  rawTotal += raw;
  gzTotal += gz;
  brTotal += br;
  rows.push({ f, raw, gz, br });
}

rows.sort((a, b) => b.raw - a.raw);
for (const r of rows) {
  console.log(
    `${(r.raw / 1024).toFixed(1).padStart(8)} KiB  ${(r.gz / 1024).toFixed(1).padStart(7)} gz  ${(r.br / 1024).toFixed(1).padStart(7)} br  ${r.f}`
  );
}
console.log("-".repeat(60));
console.log(
  `合计 ${rows.length} 个文件：${(rawTotal / 1024).toFixed(1)} KiB / ${(gzTotal / 1024).toFixed(1)} KiB gzip / ${(brTotal / 1024).toFixed(1)} KiB br`
);
