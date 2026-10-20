#!/usr/bin/env node
/**
 * SQL 重构回归测试（纯静态分析，不连数据库、不依赖部署）
 *
 * 用法：
 *   node scripts/test-sql-refactor.mjs            # 与 HEAD~1 对比
 *   BASE_REF=3ab8fa35 node scripts/test-sql-refactor.mjs   # 指定基线提交
 *
 * 这个项目没有测试框架，worker 侧的 SQL 散落在十几个路由文件里，靠人肉 review
 * 很难保证「合并/提取常量」这类重构不发生语义漂移。这个脚本做四件事：
 *
 *   C1 级联删除覆盖：schema 里所有 REFERENCES talents(id) 且没有 ON DELETE CASCADE
 *      的表，都必须在 deleteTalentCascade 里被清掉。
 *      （漏一个 = 删除人才时撞外键 500，这是本项目踩过的坑）
 *   C2 别名契约：sqlFragments.ts 的常量以别名（tj/t/j/l）为契约。凡是展开后用到
 *      JOIN_TALENT_T 的查询，必须真的有 talent_jobs 的 tj 别名，否则 SQL 直接报错。
 *   C3 语义漂移：把重构前后全库 SQL 提取出来归一化后做集合差分。
 *      提取重复 SQL 成常量不应该改变任何一条 SQL 的文本。
 *   C4 注入面：列出现仍拼接进 SQL 的模板变量，新增变量需要人工确认（白名单制）。
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WORKER_DIR = path.join(ROOT, "src", "worker");
const BASE_REF = process.env.BASE_REF || "HEAD~1";

let failures = 0;
const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (m) => console.log(`  ${C.g}✓${C.x} ${m}`);
const no = (m) => { failures++; console.log(`  ${C.r}✗${C.x} ${m}`); };
const warn = (m) => console.log(`  ${C.y}!${C.x} ${m}`);
const info = (m) => console.log(`    ${C.d}${m}${C.x}`);
const head = (m) => console.log(`\n${C.y}${m}${C.x}`);

// ---------------------------------------------------------------- 基础工具

/** 收集源码里所有字符串/模板串字面量（会跳过注释，避免把注释里的 SQL 也算进来） */
function collectStrings(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      let j = i + 1;
      let buf = "";
      while (j < n) {
        if (src[j] === "\\") { buf += src[j] + (src[j + 1] ?? ""); j += 2; continue; }
        if (src[j] === q) break;
        buf += src[j];
        j++;
      }
      out.push({ start: i, end: j + 1, value: buf });
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** 把 `"aaa" + "bbb"` 这种跨行拼接合并成一个字面量，否则长 SQL 会被切成两半 */
function mergeConcat(literals, src) {
  const merged = [];
  for (const lit of literals) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const between = src.slice(prev.end, lit.start);
      // 只允许中间是空白和 +（模板串 ${...} 内部的字符串不会满足，因为含 { }）
      if (/^[\s+]*$/.test(between) && !between.includes("{") && !between.includes("}")) {
        prev.value += lit.value;
        prev.end = lit.end;
        continue;
      }
    }
    merged.push({ ...lit });
  }
  return merged;
}

/** 递归展开 ${CONST}（只展开常量表里的名字，其余原样保留，供 C4 统计） */
function expand(value, consts) {
  let out = value;
  for (let i = 0; i < 6; i++) {
    let changed = false;
    out = out.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (full, name) => {
      if (consts.has(name)) { changed = true; return consts.get(name); }
      return full;
    });
    if (!changed) break;
  }
  return out;
}

/** 归一化：折叠空白、去掉运算符两侧空格、去尾分号。用于「是否同一条 SQL」的比较 */
function norm(sql) {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>])\s*/g, "$1")
    .replace(/;+\s*$/, "")
    .trim();
}

const SQL_START = /^\s*(SELECT|INSERT\s+INTO|INSERT\s+OR|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i;

/** 解析一个 TS 源文件里的 `export const XXX = "..."`，得到片段常量表 */
function parseConsts(src) {
  const lits = mergeConcat(collectStrings(src), src);
  const map = new Map();
  const re = /export\s+const\s+([A-Z][A-Z0-9_]*)\s*=/g;
  let m;
  while ((m = re.exec(src))) {
    const lit = lits.find((l) => l.start > m.index && l.start - m.index < 300);
    if (lit) map.set(m[1], lit.value);
  }
  return map;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function rel(p) { return path.relative(ROOT, p).split(path.sep).join("/"); }

function readAt(ref, relPath) {
  try {
    return execSync(`git show "${ref}:${relPath}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null; // 该提交里没有这个文件
  }
}

/** 从一份源码里提取所有 SQL（展开常量后归一化），返回 Map<normSql, {file, raw}> */
function extractSql(src, consts, fileLabel) {
  const found = new Map();
  for (const lit of mergeConcat(collectStrings(src), src)) {
    const expanded = expand(lit.value, consts);
    if (!SQL_START.test(expanded)) continue;
    const key = norm(expanded);
    if (!found.has(key)) found.set(key, { file: fileLabel, raw: expanded });
  }
  return found;
}

// ---------------------------------------------------------------- C1 级联

/** 从 schema.sql + migrations 里找出所有「外键指向 talents(id)」的表 */
function schemaTalentRefs() {
  const refs = []; // { table, cascade }
  const parse = (sql) => {
    const lines = sql.split(/\r?\n/);
    let cur = null;
    for (const rawLine of lines) {
      const line = rawLine.replace(/--.*$/, ""); // 剥注释：注释里的 talent_id 不算
      const create = line.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(/i);
      if (create) { cur = create[1]; continue; }
      if (/^\s*\);/.test(line)) { cur = null; continue; }
      const col = line.match(/^\s*talent_id\b(.*)$/i);
      if (col && cur && /REFERENCES\s+talents\s*\(\s*id\s*\)/i.test(col[1])) {
        refs.push({ table: cur, cascade: /ON\s+DELETE\s+CASCADE/i.test(col[1]) });
      }
      // 迁移里补的外键：ALTER TABLE xxx ADD COLUMN ... REFERENCES talents(id)
      const alter = line.match(/^\s*ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+COLUMN\s+talent_id\b(.*)$/i);
      if (alter && /REFERENCES\s+talents\s*\(\s*id\s*\)/i.test(alter[1] || "")) {
        refs.push({ table: alter[1], cascade: /ON\s+DELETE\s+CASCADE/i.test(alter[2] || "") });
      }
    }
  };
  const schemaPath = path.join(ROOT, "schema.sql");
  if (fs.existsSync(schemaPath)) parse(fs.readFileSync(schemaPath, "utf8"));
  const migDir = path.join(ROOT, "migrations");
  if (fs.existsSync(migDir)) {
    for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
      parse(fs.readFileSync(path.join(migDir, f), "utf8"));
    }
  }
  return refs;
}

function checkCascade() {
  head("C1 级联删除覆盖（防删除人才撞外键 500）");
  const talentsSrc = fs.readFileSync(path.join(WORKER_DIR, "routes", "talents.ts"), "utf8");
  const fnStart = talentsSrc.indexOf("async function deleteTalentCascade");
  if (fnStart < 0) { no("找不到 deleteTalentCascade，级联删除唯一实现丢失"); return; }
  // 函数体：到下一个顶层 `}` 为止（该函数的缩进是 0 层）
  const fnEnd = talentsSrc.indexOf("\n}", fnStart);
  const body = talentsSrc.slice(fnStart, fnEnd < 0 ? undefined : fnEnd);

  const touched = new Set();
  for (const lit of mergeConcat(collectStrings(body), body)) {
    const m = lit.value.match(/^\s*(?:DELETE\s+FROM|UPDATE)\s+[`"]?(\w+)[`"]?/i);
    if (m) touched.add(m[1]);
  }

  // 全库范围内，除了 deleteTalentCascade 之外还有别处按 talent_id 清理这些子表吗？
  // 只认「按 talent_id 删」的语句 —— `DELETE FROM interviews WHERE id = ?` 这类单条
  // 业务删除是正常的，不算级联拷贝。
  const dupSources = [];
  for (const file of walk(WORKER_DIR)) {
    const src = fs.readFileSync(file, "utf8");
    const idx = src.indexOf("deleteTalentCascade");
    const fnEndIdx = idx >= 0 ? src.indexOf("\n}", idx) : -1;
    for (const lit of mergeConcat(collectStrings(src), src)) {
      const m = lit.value.match(/^\s*(?:DELETE\s+FROM|UPDATE)\s+[`"]?(\w+)[`"]?/i);
      if (!m || !touched.has(m[1])) continue;
      if (!/\btalent_id\b/i.test(lit.value)) continue; // 不是按人才清理 → 正常业务删除
      const inFn = idx >= 0 && fnEndIdx > 0 && lit.start > idx && lit.start < fnEndIdx;
      if (inFn) continue;
      if (KNOWN_DUP.includes(`${rel(file)}:${m[1]}`)) continue;
      dupSources.push(`${rel(file)} → ${lit.value.replace(/\s+/g, " ").trim()}`);
    }
  }

  const refs = schemaTalentRefs().filter((r) => r.table !== "talents");
  const fkRefs = refs.filter((r) => !r.cascade);
  let missing = [];
  for (const r of fkRefs) {
    if (r.table === "talent_jobs") continue; // talent_jobs 在级联里单独处理
    if (!touched.has(r.table)) missing.push(r.table);
  }
  // 反向：级联里清理了，但 schema 里连 talent_id 列都没这张表的（真·死表，可清理）
  const allTables = new Set(refs.map((r) => r.table));
  const orphan = [...touched].filter(
    (t) => !allTables.has(t) && !["talents", "talent_jobs", "approval_steps", "job_stage_logs"].includes(t)
  );

  if (missing.length === 0) {
    ok(`schema 中 ${fkRefs.length} 张外键依赖 talents 的表全部被覆盖`);
  } else {
    no(`以下表外键指向 talents(id) 但级联里没清：${missing.join(", ")}`);
    info("后果：删除人才时外键约束报 500。补进 deleteTalentCascade 即可。");
  }
  if (orphan.length) warn(`级联里清理了但 schema 无 talent_id 列（疑似死表）：${orphan.join(", ")}`);
  if (dupSources.length === 0) ok("级联清理只有一份实现，无第二份拷贝");
  else {
    no(`这些地方出现了另一份按 talent_id 的清理逻辑（易漏删子表）：`);
    for (const d of dupSources) info(d);
    info("修法：改为遍历调用 deleteTalentCascade(db, id)，避免两处实现不一致。");
  }
  info(`覆盖表：${[...touched].sort().join(", ")}`);
}

// ---------------------------------------------------------------- C2 别名契约

function checkAliasContract() {
  head("C2 片段常量别名契约（tj/t/j/l）");
  const fragPath = path.join(WORKER_DIR, "sqlFragments.ts");
  if (!fs.existsSync(fragPath)) { no("sqlFragments.ts 不存在"); return; }
  const fragSrc = fs.readFileSync(fragPath, "utf8");
  const consts = parseConsts(fragSrc);

  // 常量自身：不允许残留未解析的 ${...}（说明引用了不存在的常量，运行时会变 undefined）
  for (const [name, raw] of consts) {
    const expanded = expand(raw, consts);
    const leftover = expanded.match(/\$\{[^}]*\}/g);
    if (leftover) no(`${name} 含未解析插值 ${leftover.join(",")} —— 运行时会拼出 undefined`);
  }

  // 任何引用 JOIN_TALENT_T 的常量，展开后必须自带 FROM talent_jobs tj
  const joinT = consts.get("JOIN_TALENT_T");
  if (!joinT) { no("找不到 JOIN_TALENT_T"); return; }
  let checked = 0;
  for (const file of walk(WORKER_DIR)) {
    if (rel(file) === "src/worker/sqlFragments.ts") continue; // 常量定义处不算
    const src = fs.readFileSync(file, "utf8");
    for (const lit of mergeConcat(collectStrings(src), src)) {
      const expanded = expand(lit.value, consts);
      if (!expanded.includes(joinT)) continue;
      checked++;
      if (!/\btalent_jobs\s+(?:AS\s+)?tj\b/i.test(expanded)) {
        no(`${rel(file)} 用了 JOIN_TALENT_T 却没有 talent_jobs 的 tj 别名：\n      ${norm(expanded).slice(0, 120)}`);
      }
    }
  }
  if (checked > 0) ok(`${checked} 处引用 JOIN_TALENT_T 的查询均满足 tj 别名契约`);
  else warn("没有任何查询引用 JOIN_TALENT_T（常量可能已废弃）");
}

// ---------------------------------------------------------------- C3 语义漂移

function checkDrift() {
  head(`C3 重构前后 SQL 集合差分（基线 ${BASE_REF}）`);
  let baseExists = true;
  try {
    execSync(`git rev-parse --verify "${BASE_REF}"`, { stdio: "ignore" });
  } catch {
    baseExists = false;
  }
  if (!baseExists) { warn(`基线 ${BASE_REF} 不存在，跳过（可用 BASE_REF=xxx 指定）`); return; }

  const fragSrc = (() => {
    try { return fs.readFileSync(path.join(WORKER_DIR, "sqlFragments.ts"), "utf8"); } catch { return null; }
  })();
  const consts = fragSrc ? parseConsts(fragSrc) : new Map();

  const before = new Map();
  const after = new Map();
  const files = walk(WORKER_DIR).map(rel);
  for (const f of files) {
    const now = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const [k, v] of extractSql(now, consts, f)) if (!after.has(k)) after.set(k, v);
    const old = readAt(BASE_REF, f);
    if (old == null) continue;
    for (const [k, v] of extractSql(old, consts, f)) if (!before.has(k)) before.set(k, v);
  }

  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));

  // 这次重构里「预期内」的 SQL 变化（提取常量 / 归一化写法），登记在此以免误报警：
  //   ① site_settings 的 key 从硬编码字面量改成 getSetting 的 bind 占位符；
  //   ② job_stage_logs 的 from_stage 硬编码 NULL 改成 stageLogStmt 的 bind；
  //   ③ 新增 settings.ts 的批量读 IN(?) 助手。
  const EXPECTED_REMOVED = [
    [/site_settings/i, "site_settings 读写收敛到 settings.ts 助手（硬编码 key/列表 → bind 参数化）"],
    [/job_stage_logs\([^)]*\)\s*VALUES\([^)]*NULL[^)]*\)/i, "from_stage 硬编码 NULL → 统一由 stageLogStmt 用 bind 传 null"],
  ];
  const EXPECTED_ADDED = [
    [/site_settings WHERE key IN\(\$\{ph\}\)/i, "新增 settings.ts 批量读助手 IN(?)"],
    // 操作审计（2026-10-20）：新增 audit_logs 一张表，写入 + 查询均走 bind 参数化
    [/INSERT INTO audit_logs\(/i, "操作审计：writeAudit 落库（全部字段 bind）"],
    [/FROM audit_logs/i, "操作审计：审计日志查询（参数化分页/筛选）"],
    // index.ts 里 AUDIT_ACTION_BY_METHOD 的值 "update" 是纯字符串，被 SQL_START 正则
    // 当成半条 SQL——它不碰数据库，只是 method→action 的映射表，登记以免误报。
    [/^update$/i, "操作审计中间件的方法→操作映射值（非 SQL，正则误报项）"],
  ];
  const isExpectedRemoved = (k) => EXPECTED_REMOVED.some(([re]) => re.test(k));
  const isExpectedAdded = (k) => EXPECTED_ADDED.some(([re]) => re.test(k));

  const realRemoved = removed.filter((k) => !isExpectedRemoved(k));
  const realAdded = added.filter((k) => !isExpectedAdded(k));
  const expectedRemoved = removed.filter(isExpectedRemoved);
  const expectedAdded = added.filter(isExpectedAdded);

  console.log(`    基线 ${before.size} 条 / 当前 ${after.size} 条`);
  if (realAdded.length === 0 && realRemoved.length === 0) {
    ok(`SQL 集合一致（${expectedRemoved.length} 条预期内的写法归一化 / ${expectedAdded.length} 条新增助手）`);
    return;
  }
  warn(`新增 ${added.length}（预期 ${expectedAdded.length}）/ 消失 ${removed.length}（预期 ${expectedRemoved.length}），其中意外项需确认`);
  for (const k of realRemoved.slice(0, 12)) {
    console.log(`    ${C.r}- ${C.x}[${before.get(k).file}] ${k.slice(0, 150)}`);
  }
  for (const k of realAdded.slice(0, 12)) {
    console.log(`    ${C.g}+ ${C.x}[${after.get(k).file}] ${k.slice(0, 150)}`);
  }
  if (realRemoved.length > 12) info(`… 另有 ${realRemoved.length - 12} 条意外消失`);
  if (realAdded.length > 12) info(`… 另有 ${realAdded.length - 12} 条意外新增`);
  if (realRemoved.length || realAdded.length) {
    no("存在非预期 SQL 变化 —— 请确认不是重构引入的语义漂移，或补进 EXPECTED_* 白名单");
  }
}

// ---------------------------------------------------------------- C4 注入面

/**
 * 允许被拼进 SQL 的变量：全是代码内部生成的片段（占位符 `?`、数据作用域条件、
 * ORDER BY 枚举、列名集合），不含用户输入。
 * 出现白名单外的名字 → 失败并提示人工确认（防止有人把 body.xxx 直接拼进去）。
 * 加名字前先确认该变量的值不可能来自请求体。
 */
const CONCAT_WHITELIST = new Set([
  // 占位符：ids.map(() => "?").join(",")
  "ph", "ph2", "ph3", "placeholders",
  // 数据作用域片段：ownerScope() 返回的内部 SQL（可能为空串 / " AND t.owner_id = ?"）
  "sc", "scT", "scTj", "scTJ", "scIv", "scJ", "scTk", "scSync", "scSoc", "scTags",
  "scStage", "scopeSql", "scopePart", "ownerCond", "ownerAnd", "ivOwnerAnd", "taskOwnerAnd",
  // 动态 WHERE / 排序：由固定枚举或内部条件拼出
  "where", "whereSql", "trendWhere", "conditions", "orderBy", "orderSql", "limitSql",
  "sets", "dateSet", "talents", "talentIds", "SCOPE_ORDER", "mscTags",
]);

// 登记「已被允许的第二份级联删除」。目前为空：auth.ts 那一处是真隐患，先暴露出来。
const KNOWN_DUP = [];

function checkInjection() {
  head("C4 SQL 拼接面（新变量需人工确认）");
  const fragPath = path.join(WORKER_DIR, "sqlFragments.ts");
  const consts = fs.existsSync(fragPath) ? parseConsts(fs.readFileSync(fragPath, "utf8")) : new Map();

  const unknown = new Map();
  for (const file of walk(WORKER_DIR)) {
    const src = fs.readFileSync(file, "utf8");
    for (const lit of mergeConcat(collectStrings(src), src)) {
      const expanded = expand(lit.value, consts);
      if (!SQL_START.test(expanded)) continue;
      for (const m of expanded.matchAll(/\$\{([^}]*)\}/g)) {
        const root = m[1].split(/[.(\[]/)[0].trim();
        if (CONCAT_WHITELIST.has(root)) continue;
        if (!unknown.has(root)) unknown.set(root, rel(file));
      }
    }
  }
  if (unknown.size === 0) {
    ok(`拼接变量均在白名单内（${[...CONCAT_WHITELIST].join(", ")}）`);
  } else {
    no(`SQL 里出现了白名单外的拼接变量：${[...unknown.keys()].join(", ")}`);
    for (const [k, f] of unknown) info(`${k} ← ${f}`);
    info("确认它不携带用户输入；确需拼接请加进 CONCAT_WHITELIST 并注明理由。");
  }

  // settings.ts 的 IN 占位符必须只由 ? 拼成，不能拼外部串
  const setPath = path.join(WORKER_DIR, "settings.ts");
  if (fs.existsSync(setPath)) {
    const s = fs.readFileSync(setPath, "utf8");
    if (/keys\.map\(\(\)\s*=>\s*"\?"\)/.test(s)) ok("settings 批量读的 IN 占位符只由 ? 生成");
    else no("settings.ts 的 IN 占位符生成方式变了，确认不是直接拼字符串");
  }
}

// ---------------------------------------------------------------- 主流程

console.log(`\n${C.y}SQL 重构回归测试${C.x}  基线=${BASE_REF}`);
checkCascade();
checkAliasContract();
checkDrift();
checkInjection();

console.log("");
if (failures === 0) console.log(`${C.g}全部通过${C.x}`);
else console.log(`${C.r}${failures} 项未通过${C.x}`);
process.exit(failures === 0 ? 0 : 1);
