// 一次性死代码分析脚本 v2：正确判断「导出符号是否被其他文件 import」
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ENTRIES = ["src/main.tsx", "src/worker/index.ts"];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(path.relative(ROOT, p).replace(/\\/g, "/"));
  }
  return out;
}
const allFiles = walk(path.join(ROOT, "src"));
const fileSet = new Set(allFiles);

// 每个文件：imports(spec 列表) + 从各 spec 导入了哪些名字
const fileImports = new Map(); // file -> [{spec, names:Set, hasDefault, hasNamespace}]
const exportedNames = new Map(); // file -> Set(names)
const rawSrc = new Map();

function analyze(f) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  rawSrc.set(f, src);
  const imports = [];
  // import ... from "spec";  import "spec";  import("spec")
  const re = /(?:import|export)\s+([\s\S]*?)\s*from\s*["'](\.[^"']+)["']|import\s*["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[2] || m[3] || m[4];
    const clause = (m[1] || "").trim();
    const entry = { spec, names: new Set(), hasDefault: false, hasNamespace: false };
    if (!clause) {
      // 纯副作用 import
    } else if (/^type\s/.test(clause)) {
      const inner = clause.replace(/^type\s+/, "");
      if (inner.startsWith("{")) addNames(entry, inner);
      else entry.hasDefault = true;
    } else if (clause.startsWith("{")) {
      addNames(entry, clause);
    } else if (clause.startsWith("*")) {
      entry.hasNamespace = true;
    } else {
      entry.hasDefault = true; // import X from  /  import X, {a} from
      if (clause.includes("{")) addNames(entry, clause.slice(clause.indexOf("{")));
    }
    imports.push(entry);
  }
  function addNames(entry, clause) {
    const inner = clause.replace(/^\{|\}$/g, "");
    for (const part of inner.split(",")) {
      let t = part.trim();
      if (!t) continue;
      t = t.replace(/^type\s+/, "");
      t = t.split(/\s+as\s+/)[0].trim();
      if (t) entry.names.add(t);
    }
  }
  fileImports.set(f, imports);

  // 导出
  const names = new Set();
  const expRe = /export\s+(?:async\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = expRe.exec(src))) names.add(m[1]);
  const expList = /export\s+(?:type\s+)?\{([^}]*)\}\s*(?!from)/g;
  while ((m = expList.exec(src))) {
    for (const part of m[1].split(",")) {
      let t = part.trim();
      if (!t) continue;
      t = t.replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim();
      if (t) names.add(t);
    }
  }
  if (/export\s+default/.test(src)) names.add("default");
  exportedNames.set(f, names);
}

function resolve(from, spec) {
  const base = path.posix.join(path.posix.dirname(from), spec);
  for (const c of [base, base + ".ts", base + ".tsx", base + ".mjs", base + ".js", base + "/index.ts", base + "/index.tsx"]) {
    if (fileSet.has(c)) return c;
  }
  return null;
}

for (const f of allFiles) analyze(f);

// BFS 可达性
const reachable = new Set();
const q = [...ENTRIES];
while (q.length) {
  const f = q.pop();
  if (reachable.has(f) || !fileSet.has(f)) continue;
  reachable.add(f);
  for (const im of fileImports.get(f) || []) {
    const r = resolve(f, im.spec);
    if (r && !reachable.has(r)) q.push(r);
  }
}

// 每个文件被外部 import 了哪些名字
const importedByFile = new Map(); // file -> {names:Set, default:bool, any:bool}
for (const f of allFiles) {
  for (const im of fileImports.get(f) || []) {
    const r = resolve(f, im.spec);
    if (!r || r === f) continue;
    if (!importedByFile.has(r)) importedByFile.set(r, { names: new Set(), default: false, any: false });
    const rec = importedByFile.get(r);
    if (im.hasDefault) rec.default = true;
    if (im.hasNamespace) rec.any = true;
    for (const n of im.names) rec.names.add(n);
  }
}

console.log("=== 1) 不可达文件（两个入口均到不了；.d.ts 已排除）===");
const unreach = allFiles.filter((f) => !reachable.has(f)).sort();
if (!unreach.length) console.log("（无）");
for (const f of unreach) console.log(`  ${f}  (${rawSrc.get(f).split("\n").length} 行)`);

console.log("\n=== 2) 导出但没有任何文件 import 的符号 ===");
let anyDead = false;
for (const f of allFiles) {
  const rec = importedByFile.get(f) || { names: new Set(), default: false, any: false };
  const dead = [...(exportedNames.get(f) || new Set())].filter((n) => {
    if (n === "default") return !rec.default && !rec.any;
    return !rec.names.has(n) && !rec.any;
  });
  if (dead.length) { anyDead = true; console.log(`  ${f}: ${dead.join(", ")}`); }
}
if (!anyDead) console.log("（无）");

console.log("\n=== 3) 依赖使用核查（含副作用 import / 动态 import / 子路径）===");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const depNames = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
for (const d of depNames) {
  let used = false;
  for (const f of [...allFiles, "index.html", "vite.config.ts", "scripts/audit-nav-menu.mjs", "scripts/e2e-referral.mjs", "scripts/test-resume-parser.mjs", "scripts/check-posters.mjs"]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, "utf8");
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`["'\`]${esc}(/[^"'\`]*)?["'\`]`).test(s)) { used = true; break; }
  }
  if (!used) console.log(`  ❌ ${d} —— 全仓无任何引用`);
}
