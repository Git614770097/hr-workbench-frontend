// 简历解析规则回归测试：node scripts/test-resume-parser.mjs
//
// 为什么需要它：src/utils/resumeParser.ts 是纯正则的启发式规则，改一处很容易碰坏另一处，
// 而它一旦出错就是「静默写错数据」（比报错更难发现）。本文件把已修复的真实缺陷固化成断言：
//   1. 公司名被解析成学校名  —— 教育经历行含"大学/学院"、又排在实习/工作行之前
//   2. 姓名被解析成城市名    —— 简历头部独立一行的城市名（"广州"仅 2 个汉字，能通过姓名正则）
//   3. 姓名漏解析            —— 姓名与职位写在同一行（"刘鹏 - 前端工程师"）
//   4. AI 返回脏值           —— current_company = "2013"（把年份当公司名）
// 前 3 项修在 resumeParser.ts，第 4 项修在 utils/fieldSanity.ts。
//
// 用 esbuild 的 JS API 现场打包 TS 源码（不新增依赖、不污染仓库），再动态 import 断言。
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "resume-parser-test-"));

async function loadModule(entry, name) {
  const outfile = join(outDir, name);
  await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

let pass = 0;
const failures = [];

function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    failures.push(`${label}\n      实际 = ${JSON.stringify(actual)}\n      期望 = ${JSON.stringify(expected)}`);
    console.log(`  FAIL  ${label}`);
    return;
  }
  console.log(`  ok    ${label.padEnd(36)} ${JSON.stringify(actual)}`);
}

const P = await loadModule("src/utils/resumeParser.ts", "resumeParser.mjs");
const S = await loadModule("src/utils/fieldSanity.ts", "fieldSanity.mjs");

// ---------------------------------------------------------------------------
console.log("\n[1] 教育行在工作行之前（公司不能被解析成学校）");
// ---------------------------------------------------------------------------
const EDU_BEFORE_WORK = `刘鹏 - 前端工程师

性别：男
年龄：28
电话：13800138000

求职意向
意向岗位：前端工程师
意向城市：广州

教育经历
2013.8~2017.6\t华南师范大学

工作经历
2013.2-至今\t广东行致互联科技有限公司
前端工程师
`;
eq("姓名", P.extractName(EDU_BEFORE_WORK), "刘鹏");
eq("公司（不能是学校）", P.extractCompany(EDU_BEFORE_WORK), "广东行致互联科技有限公司");
eq("院校", P.extractSchool(EDU_BEFORE_WORK), "华南师范大学");
eq("职位", P.extractTitle(EDU_BEFORE_WORK), "前端工程师");
eq("城市", P.extractCity(EDU_BEFORE_WORK), "广州");
eq("公司 ≠ 院校", P.extractCompany(EDU_BEFORE_WORK) !== P.extractSchool(EDU_BEFORE_WORK), true);

// ---------------------------------------------------------------------------
console.log("\n[2] 城市名不能被当成姓名");
// ---------------------------------------------------------------------------
const CITY_LINE = `广州
男 | 28岁 | 5年经验
前端开发工程师
电话 13800138000
现居：广州
`;
eq("姓名（城市名不算）", P.extractName(CITY_LINE), "");
eq("城市仍能取到", P.extractCity(CITY_LINE), "广州");

const PROVINCE_LINE = `广东
男 32岁
2015.03-至今\t华为技术有限公司
`;
eq("姓名（省名不算）", P.extractName(PROVINCE_LINE), "");
eq("公司", P.extractCompany(PROVINCE_LINE), "华为技术有限公司");

// ---------------------------------------------------------------------------
console.log("\n[3] 标签式简历回归（确认没改坏）");
// ---------------------------------------------------------------------------
const LABELED = `个人简历
姓名：李明
性别：男 年龄：30
学历：本科 毕业院校：北京大学
所在公司：阿里巴巴集团
求职意向：高级Java工程师
现居城市：杭州
`;
eq("姓名", P.extractName(LABELED), "李明");
eq("公司", P.extractCompany(LABELED), "阿里巴巴集团");
eq("院校", P.extractSchool(LABELED), "北京大学");
eq("城市（北京在院校名里，应取杭州）", P.extractCity(LABELED), "杭州");

const DOTTED = `欧阳·娜娜
女 26岁
电话：13900139000
2018.09-2022.06\t四川大学
2022.07-至今\t腾讯科技有限公司
`;
eq("间隔号姓名", P.extractName(DOTTED), "欧阳·娜娜");
eq("公司", P.extractCompany(DOTTED), "腾讯科技有限公司");
eq("院校", P.extractSchool(DOTTED), "四川大学");

const EDU_ONLY = `张三
男 24岁 电话 13700137000
2020.09-2024.06\t浙江大学
`;
eq("无工作经历时公司为空", P.extractCompany(EDU_ONLY), "");
eq("院校", P.extractSchool(EDU_ONLY), "浙江大学");

const SECTION_WORDS = `个人优势
熟悉 React / Vue / TypeScript
电话 13600136000
`;
eq("章节词/技能行不算姓名", P.extractName(SECTION_WORDS), "");

// ---------------------------------------------------------------------------
console.log("\n[4] AI 返回值校验（线上真实脏值必须被清成空）");
// ---------------------------------------------------------------------------
eq("公司=2013（线上脏值）", S.sanitizeField("current_company", "2013"), "");
eq("公司=2013-2016", S.sanitizeField("current_company", "2013-2016"), "");
eq("公司=广州", S.sanitizeField("current_company", "广州"), "");
eq("公司=华南师范大学", S.sanitizeField("current_company", "华南师范大学"), "");
eq("公司=正常值", S.sanitizeField("current_company", "广东行致互联科技有限公司"), "广东行致互联科技有限公司");
eq("公司=浙大大学科技园有限公司（含公司字样，保留）", S.sanitizeField("current_company", "浙大大学科技园有限公司"), "浙大大学科技园有限公司");
eq("姓名=广州（线上脏值）", S.sanitizeField("name", "广州"), "");
eq("姓名=个人优势", S.sanitizeField("name", "个人优势"), "");
eq("姓名=正常值", S.sanitizeField("name", "刘鹏"), "刘鹏");
eq("姓名=英文名", S.sanitizeField("name", "Zhang San"), "Zhang San");
eq("姓名=间隔号", S.sanitizeField("name", "欧阳·娜娜"), "欧阳·娜娜");
eq("职位=2013", S.sanitizeField("current_title", "2013"), "");
eq("院校=阿里巴巴集团（非院校）", S.sanitizeField("school", "阿里巴巴集团"), "");
eq("城市=2013", S.sanitizeField("city", "2013"), "");
eq("技能清洗", S.sanitizeSkills(["Java", "2013", "熟悉", "", "MySQL"]), ["Java", "MySQL"]);

// ---------------------------------------------------------------------------
rmSync(outDir, { recursive: true, force: true });

console.log(`\n通过 ${pass}，失败 ${failures.length}`);
if (failures.length > 0) {
  console.log("\n失败明细：");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
