#!/usr/bin/env node
/**
 * 部署前数据库 schema 漂移检查。
 *
 * 背景：2026-11-05 线上「删除人才」报 `no such table: talent_files`，
 * 根因是 migrations/20261103-*.sql 只提交了文件、从没在 D1 执行过——
 * 部署命令（wrangler deploy）里没有任何迁移或校验步骤，SQL 变更全靠人记。
 *
 * 本脚本把 schema.sql 当作唯一事实源，部署前比对线上的表与列，缺了就拦住部署。
 *
 * 用法：node scripts/db-check.mjs [--staging]
 *
 * 只拦截「线上缺表 / 缺列」。线上多出来的表或列只提示不阻断：
 * 那可能是历史遗留，删表属于需要另行评审的破坏性操作。
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = process.argv.includes("--staging");
const DB = STAGING ? "hr-workbench-staging" : "hr-workbench";
const SKIP = /^(sqlite_|_cf_KV)/;

/** 从 CREATE TABLE 的括号体里提取列名：忽略行注释与表级约束。
 *  必须按「顶层逗号」切分而不是按行：SQLite 会把 ALTER TABLE ADD COLUMN
 *  追加的列全部塞在同一行（`, role_id TEXT, status TEXT, ...`），
 *  按行解析会把整批后加列漏掉，产生上百条假阳性。 */
function columns(body) {
  const out = new Set();
  const KEYWORDS = new Set(["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT", "KEY", "EXCLUDE"]);
  const clean = body.replace(/--[^\r\n]*/g, "");
  const parts = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const nx = clean[i + 1];
    if (quote) {
      if (ch === "'" && nx === "'") { i++; continue; }
      if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") { quote = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(clean.slice(start, i)); start = i + 1; }
  }
  parts.push(clean.slice(start));
  for (const part of parts) {
    const bare = part.trim().replace(/^["'`[\]]+/, "").trim();
    const m = bare.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!m || KEYWORDS.has(m[1].toUpperCase())) continue;
    out.add(m[1]);
  }
  return out;
}

/** 扫描整份 SQL 找出所有 CREATE TABLE。括号配对，能处理 DEFAULT (datetime('now')) */
function tables(sql) {
  const out = new Map();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    let i = re.lastIndex;
    let depth = 1;
    let quote = false;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      const nx = sql[i + 1];
      if (quote) {
        if (ch === "'" && nx === "'") { i += 2; continue; }
        if (ch === "'") quote = false;
        i++; continue;
      }
      if (ch === "-" && nx === "-") {
        const nl = sql.indexOf("\n", i);
        i = nl === -1 ? sql.length : nl + 1;
        continue;
      }
      if (ch === "/" && nx === "*") {
        const end = sql.indexOf("*/", i);
        i = end === -1 ? sql.length : end + 2;
        continue;
      }
      if (ch === "'") { quote = true; i++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    out.set(name, columns(sql.slice(re.lastIndex, i - 1)));
    re.lastIndex = i;
  }
  return out;
}

const local = tables(readFileSync(resolve(ROOT, "schema.sql"), "utf8"));

// 一次拿全库 DDL：pragma_table_info 表值函数在 D1 被 SQLITE_AUTH 拦，
// 但 sqlite_master + json_group_array 可用，避免逐表 PRAGMA 往返几十次。
const query = "SELECT json_group_array(json_object('t', name, 's', sql)) AS d FROM sqlite_master WHERE type='table';";
const online = new Map();
try {
  const out = execSync(
    `npx wrangler d1 execute ${DB} --remote --json --command "${query}"`,
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }
  );
  const payload = JSON.parse(out)?.[0]?.results?.[0]?.d;
  if (!payload) throw new Error("查询结果为空");
  for (const row of JSON.parse(payload)) {
    if (SKIP.test(row.t) || !row.s) continue;
    online.set(row.t, tables(row.s).get(row.t) || new Set());
  }
} catch (e) {
  console.error(`[db-check] 无法读取线上 ${DB} 的 schema：${e.message}`);
  if (e.stderr) console.error(String(e.stderr).split("\n").slice(-6).join("\n"));
  console.error("[db-check] 常见原因：wrangler 登录过期（npx wrangler login --device --browser=false）。");
  process.exit(1);
}

const count = (map) => [...map.values()].reduce((a, s) => a + s.size, 0);
console.log(`[db-check] 本地 schema.sql: ${local.size} 表 / ${count(local)} 列`);
console.log(`[db-check] 线上 ${DB}: ${online.size} 表 / ${count(online)} 列`);

const extra = [...online.keys()].filter((t) => !local.has(t));
if (extra.length) console.log(`[db-check] 提示（不拦截）线上多出的表：${extra.join(", ")}`);

const missingTables = [...local.keys()].filter((t) => !SKIP.test(t) && !online.has(t));
const missingCols = [];
for (const [table, cols] of local) {
  if (SKIP.test(table) || !online.has(table)) continue;
  for (const col of cols) if (!online.get(table).has(col)) missingCols.push(`${table}.${col}`);
}

if (missingTables.length || missingCols.length) {
  if (missingTables.length) console.error(`[db-check] ❌ 线上缺少表：${missingTables.join(", ")}`);
  if (missingCols.length) console.error(`[db-check] ❌ 线上缺少列：${missingCols.join(", ")}`);
  console.error(`[db-check] 先补齐迁移再部署：npx wrangler d1 execute ${DB} --remote --file=./migrations/<迁移>.sql`);
  process.exit(1);
}
console.log("[db-check] ✅ schema 一致，可以继续部署");
