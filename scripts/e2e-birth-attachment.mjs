// 出生年月 + 人才附件的接口级验证（不依赖浏览器）。
//
// 为什么先做接口级：这两块的核心是「数据对不对」——年龄是不是真的按生日实时算、
// 附件是不是真能多份共存、删除后 KV 有没有残留。这些用 UI 截图看不出来，
// 必须直接打接口 + 查返回值。UI 只额外确认「控件存在、能渲染」。
//
// 用法（需先起 wrangler dev）：
//   node scripts/e2e-birth-attachment.mjs
const BASE = process.env.E2E_BASE || "http://localhost:8787";
const PHONE = process.env.E2E_PHONE || "13900000099";
const PASSWORD = process.env.E2E_PASSWORD || "E2eTest123456";

let cookie = "";
let failures = 0;

const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

async function login() {
  const cap = await (await fetch(`${BASE}/api/auth/captcha`)).json();
  // 验证码 SVG 里每个字符是一个 <text>，按出现顺序拼回来
  const code = [...cap.svg.matchAll(/>([^<])<\/text>/g)].map((m) => m[1]).join("");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD, captcha_id: cap.captcha_id, captcha: code }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = res.headers.get("set-cookie") || "";
  const token = /token=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error("登录成功但没拿到 cookie");
  cookie = `token=${token}`;
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { Cookie: cookie, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

/** 从 birth_date 按今天算周岁，和后端 SQL 的口径对齐，用来交叉验证 */
function expectedAge(birth) {
  const [y, m, d] = birth.split("-").map(Number);
  const now = new Date();
  let age = now.getFullYear() - y;
  const passed = now.getMonth() + 1 > m || (now.getMonth() + 1 === m && now.getDate() >= d);
  if (!passed) age -= 1;
  return age;
}

(async () => {
  console.log(`目标：${BASE}\n`);
  await login();
  console.log("登录成功\n");

  // ── 一、出生年月 → 年龄实时计算 ─────────────────────────────
  console.log("— 出生年月 —");
  const birth = "1995-06-01";
  const created = await api("/talents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "E2E测试·生日",
      birth_date: birth,
      birth_date_precision: "month",
      // 故意不传 age：后端应该完全靠 birth_date 推出来
    }),
  });
  check("创建人才（只传生日不传年龄）", created.status === 200, `status=${created.status}`);
  const talentId = created.body?.id;
  if (!talentId) {
    console.log("创建失败，后续跳过：", JSON.stringify(created.body).slice(0, 200));
    process.exit(1);
  }

  const detail = await api(`/talents/${talentId}`);
  const age = detail.body?.age;
  const want = expectedAge(birth);
  check("详情返回实时年龄", age === want, `返回 ${age}，按生日应为 ${want}`);
  check("生日精度标记保留", detail.body?.birth_date_precision === "month", `实际 ${detail.body?.birth_date_precision}`);
  check("不返回内部辅助列 age_calc", !("age_calc" in (detail.body || {})), "");

  // 改生日，年龄必须跟着变（这是「年龄是变量」的核心诉求）
  const birth2 = "1990-01-01";
  await api(`/talents/${talentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ birth_date: birth2, birth_date_precision: "month" }),
  });
  const detail2 = await api(`/talents/${talentId}`);
  check(
    "改生日后年龄自动重算",
    detail2.body?.age === expectedAge(birth2),
    `${birth}→${age}岁，改成 ${birth2}→${detail2.body?.age}岁（应为 ${expectedAge(birth2)}）`
  );

  // 列表页的 age 也必须是实时值（走的是另一条 SQL）
  const list = await api(`/talents?q=E2E测试·生日&limit=5`);
  const inList = (list.body?.items || []).find((t) => t.id === talentId);
  check("列表返回的年龄同样是实时值", inList?.age === expectedAge(birth2), `列表 ${inList?.age}`);

  // 清空生日 → 年龄应一起清掉，不留孤儿值
  await api(`/talents/${talentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ birth_date: null, birth_date_precision: null, age: null }),
  });
  const detail3 = await api(`/talents/${talentId}`);
  check("清空生日后年龄一并清空", detail3.body?.age == null, `实际 ${detail3.body?.age}`);

  // ── 二、附件：多份共存 + 下载内容一致 + 删除 ────────────────
  console.log("\n— 人才附件 —");
  // 造两份内容不同的假文件，验证「多份不会互相覆盖」
  const mkFile = (name, content) => {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/plain" }), name);
    form.append("kind", "portfolio");
    return form;
  };

  const up1 = await api(`/talents/${talentId}/files`, { method: "POST", body: mkFile("作品集-甲.txt", "AAA-第一份") });
  const up2 = await api(`/talents/${talentId}/files`, { method: "POST", body: mkFile("证书-乙.txt", "BBB-第二份") });
  check("上传第一份附件", up1.status === 200, `status=${up1.status}`);
  check("上传第二份附件", up2.status === 200, `status=${up2.status}`);

  const files = await api(`/talents/${talentId}/files`);
  check("列表返回两份（不互相覆盖）", (files.body?.items || []).length === 2, `实际 ${(files.body?.items || []).length} 份`);

  const fileA = (files.body?.items || []).find((f) => f.name === "作品集-甲.txt");
  const fileB = (files.body?.items || []).find((f) => f.name === "证书-乙.txt");
  check("第一份内容独立", !!fileA, "");
  check("第二份内容独立", !!fileB, "");

  // 下载回来比对内容：只验「有记录」不够，要验「存进去的字节是这份的」
  if (fileA) {
    const dl = await fetch(`${BASE}/api/talents/${talentId}/files/${fileA.id}`, { headers: { Cookie: cookie } });
    const text = await dl.text();
    check("下载第一份内容正确", text === "AAA-第一份", `实际「${text.slice(0, 30)}」`);
    check(
      "非图片/PDF 强制 attachment（防同源 XSS）",
      (dl.headers.get("content-disposition") || "").startsWith("attachment"),
      dl.headers.get("content-disposition") || ""
    );
  }

  // 超过 10MB 必须被挡
  const big = new FormData();
  big.append("file", new Blob([new Uint8Array(11 * 1024 * 1024)], { type: "application/octet-stream" }), "big.bin");
  big.append("kind", "other");
  const tooBig = await api(`/talents/${talentId}/files`, { method: "POST", body: big });
  check("11MB 文件被拒绝", tooBig.status === 400, `status=${tooBig.status} ${JSON.stringify(tooBig.body).slice(0, 60)}`);

  if (fileA) {
    const del = await api(`/talents/${talentId}/files/${fileA.id}`, { method: "DELETE" });
    check("删除第一份", del.status === 200, `status=${del.status}`);
    const after = await api(`/talents/${talentId}/files`);
    check("删除后只剩一份", (after.body?.items || []).length === 1, `实际 ${(after.body?.items || []).length} 份`);
    const dlGone = await fetch(`${BASE}/api/talents/${talentId}/files/${fileA.id}`, { headers: { Cookie: cookie } });
    check("删除后无法再下载", dlGone.status === 404, `status=${dlGone.status}`);
  }

  // ── 清理 ────────────────────────────────────────────────
  await api(`/talents/${talentId}`, { method: "DELETE" });
  console.log("\n已清理测试数据");

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("脚本异常：", e.message);
  process.exit(1);
});
