/**
 * 侧栏菜单改造（一级/二级，2026-10-08）的回归校验脚本。
 *
 * 目的：证明「把扁平菜单改成一级/二级分组」**没有动任何权限语义**。
 * 做法：把 Layout.tsx 里的 NAV_TREE 解析出来，与改造前的扁平清单逐条比对
 *      （路径 + 权限 + 是否仅管理员），再按不同角色模拟一遍可见菜单。
 *
 * 用法：node scripts/audit-nav-menu.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");

/* ---------- 1. 解析改造后的 NAV_TREE ---------- */
const layout = read("src/components/Layout.tsx");
const start = layout.indexOf("const NAV_TREE");
const end = layout.indexOf("\n];", start);
if (start < 0 || end < 0) {
  console.error("找不到 NAV_TREE，脚本需要跟随代码结构更新");
  process.exit(1);
}
const block = layout.slice(start, end);
const lines = block.split("\n");

const ids = [...block.matchAll(/^\s{4}id:\s*"([^"]+)",/gm)].map((m) => m[1]);
const groups = ids.map((id) => ({ id, children: [] }));
const topLeaves = [];

let gi = -1;
for (const raw of lines) {
  const line = raw.trim();
  const indent = raw.length - raw.trimStart().length;
  const idm = raw.match(/^\s{4}id:\s*"([^"]+)",/);
  if (idm) {
    gi = ids.indexOf(idm[1]);
    continue;
  }
  if (!line.startsWith("{") || !line.includes('to: "')) continue;
  const to = line.match(/to:\s*"([^"]+)"/)?.[1];
  const perm = line.match(/perm:\s*"([^"]+)"/)?.[1];
  if (!to || !perm) continue;
  const entry = { to, perm, adminOnly: /adminOnly:\s*true/.test(line) };
  if (indent >= 6 && gi >= 0) groups[gi].children.push(entry);
  else if (indent < 6) topLeaves.push(entry);
}

const NEW = [...topLeaves, ...groups.flatMap((g) => g.children)];

/* ---------- 2. 改造前的扁平清单（改造前 Layout.tsx 的 navItems 固化） ---------- */
const OLD = [
  { to: "/tasks", perm: "tasks", adminOnly: false },
  { to: "/jobs", perm: "jobs", adminOnly: false },
  { to: "/pipeline", perm: "pipeline", adminOnly: false },
  { to: "/interviews", perm: "interviews", adminOnly: false },
  { to: "/approvals", perm: "pipeline", adminOnly: false },
  { to: "/onboarding", perm: "pipeline", adminOnly: false },
  { to: "/funnel", perm: "funnel", adminOnly: false },
  { to: "/contracts", perm: "contracts", adminOnly: false },
  { to: "/social", perm: "social", adminOnly: false },
  { to: "/profiles", perm: "profiles", adminOnly: false },
  { to: "/talents", perm: "talents", adminOnly: false },
  { to: "/templates", perm: "templates", adminOnly: false },
  { to: "/roles", perm: "roles", adminOnly: true },
  { to: "/users", perm: "users", adminOnly: true },
  { to: "/settings", perm: "settings", adminOnly: true },
];

/* ---------- 3. 逐条比对 ---------- */
const key = (e) => `${e.to}|${e.perm}|${e.adminOnly ? "admin" : "all"}`;
const oldKeys = OLD.map(key);
const newKeys = NEW.map(key);
const missing = oldKeys.filter((k) => !newKeys.includes(k));
const added = newKeys.filter((k) => !oldKeys.includes(k));

console.log("=== 叶子节点比对（路径 + 权限 + adminOnly）===");
console.log(`改造前 ${OLD.length} 项 / 改造后 ${NEW.length} 项`);
console.log(`缺失: ${missing.length ? missing.join(", ") : "无"}`);
console.log(`新增: ${added.length ? added.join(", ") : "无"}`);
console.log(`一级分组 ${groups.length} 个: ${groups.map((g) => `${g.id}(${g.children.length})`).join(", ")}`);
console.log("");

/* ---------- 4. 权限 key 是否都在后端白名单里 ---------- */
const menuKeys =
  read("src/worker/permissions.ts")
    .match(/MENU_KEYS = \[([^\]]+)\]/)?.[1]
    .split(",")
    .map((s) => s.trim().replace(/"/g, ""))
    .filter(Boolean) || [];
const badPerms = NEW.filter((e) => !e.adminOnly && !menuKeys.includes(e.perm));
console.log("=== 权限 key 白名单（worker/permissions.ts MENU_KEYS）===");
console.log(`不在白名单的 perm: ${badPerms.length ? badPerms.map((b) => `${b.to}=${b.perm}`).join(", ") : "无"}`);
console.log("");

/* ---------- 5. 路由是否存在 ---------- */
const app = read("src/App.tsx");
const badRoutes = NEW.filter((e) => !app.includes(`path="${e.to}"`));
console.log("=== 路由存在性（App.tsx）===");
console.log(`找不到对应 Route 的菜单: ${badRoutes.length ? badRoutes.map((b) => b.to).join(", ") : "无"}`);
console.log("");

/* ---------- 6. 按角色模拟可见菜单 ---------- */
const canSee = (e, user) =>
  e.adminOnly ? user.role === "admin" : user.role === "admin" || (user.permissions || []).includes(e.perm);
const visibleWith = (user, list) => list.filter((e) => canSee(e, user)).map((e) => e.to);

const roles = [
  { name: "admin", role: "admin", permissions: [] },
  {
    name: "HR 全权限",
    role: "user",
    permissions: ["tasks", "jobs", "pipeline", "interviews", "funnel", "contracts", "social", "profiles", "talents", "templates"],
  },
  {
    name: "猎头（无合同/社保/模板）",
    role: "user",
    permissions: ["tasks", "jobs", "pipeline", "interviews", "funnel", "profiles", "talents"],
  },
  { name: "仅人才库", role: "user", permissions: ["talents"] },
  { name: "无任何权限", role: "user", permissions: [] },
];

console.log("=== 可见菜单模拟：改造前 vs 改造后（按同一顺序对比）===");
let allSame = true;
for (const r of roles) {
  const before = visibleWith(r, OLD).slice().sort();
  const after = visibleWith(r, NEW).slice().sort();
  const same = before.length === after.length && before.every((p, i) => p === after[i]);
  if (!same) allSame = false;
  console.log(`[${r.name}] ${same ? "一致" : "!! 不一致 !!"}  ${after.join(" ") || "(空)"}`);
}
console.log("");
console.log(
  allSame && !missing.length && !added.length
    ? "结论：权限与可见性完全对等，改造未引入任何权限变化。"
    : "结论：存在差异，请检查！",
);
