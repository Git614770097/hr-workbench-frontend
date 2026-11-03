// 导入记录的接口级验证（不依赖浏览器）。
//
// 为什么先做接口级：这块的核心全是「数对不对」——上传 4 份、录入 1 份、失败 1 份、
// 未处理 2 份，这四个数必须严格相加等于上传份数。这种事截图看不出来，只能打接口核对。
// 另外「批次结束后的写入要拒绝」「别人的批次读不到」这类负向用例，也只有接口层能测。
//
// 用法（需先起 wrangler dev）：
//   node scripts/e2e-import-history.mjs
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
  return { status: res.status, body };
}

const post = (path, data) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const patch = (path, data) =>
  api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

(async () => {
  console.log(`目标：${BASE}\n`);

  // ---- 未登录必须被拦 ----
  const anon = await fetch(`${BASE}/api/import-batches`);
  check("未登录访问导入记录被拒", anon.status === 401, `HTTP ${anon.status}`);

  await login();
  console.log("已登录\n");

  // ---- 1. 建批次 ----
  const created = await post("/import-batches", { source: "BOSS直聘", dedup: true });
  check("建批次返回 id", created.status === 200 && !!created.body?.id, JSON.stringify(created.body).slice(0, 80));
  const bid = created.body?.id;
  if (!bid) throw new Error("没有批次 id，后续用例无法继续");

  // ---- 2. 提交 4 条明细：3 份解析成功（pending）+ 1 份解析失败 ----
  const items = [
    { file_name: "张三.pdf", file_size: 120_000, talent_name: "张三", status: "pending", parse_source: "ai" },
    { file_name: "李四.docx", file_size: 88_000, talent_name: "李四", status: "pending", parse_source: "local" },
    { file_name: "王五.pdf", file_size: 66_000, talent_name: "王五", status: "pending", parse_source: "ai" },
    { file_name: "坏文件.pdf", file_size: 3_000, status: "failed", error: "PDF 解析失败：文件已损坏" },
  ];
  const added = await post(`/import-batches/${bid}/items`, items);
  check("批量写明细返回 4 个 id", added.status === 200 && added.body?.ids?.length === 4,
    `ids=${added.body?.ids?.length}`);
  const ids = added.body?.ids || [];

  // ---- 3. 列表计数：上传 4 / 失败 1 / 未处理 3 ----
  let list = await api("/import-batches?limit=50");
  let row = list.body?.items?.find((b) => b.id === bid);
  check("列表里能找到该批次", !!row);
  check("上传份数 = 4", row?.total === 4, `total=${row?.total}`);
  check("失败份数 = 1", row?.failed === 1, `failed=${row?.failed}`);
  check("未处理份数 = 3", row?.pending === 3, `pending=${row?.pending}`);
  check("来源渠道已记录", row?.source === "BOSS直聘", `source=${row?.source}`);
  check("四态相加等于上传份数",
    row && row.imported + row.duplicate + row.failed + row.pending === row.total,
    row ? `${row.imported}+${row.duplicate}+${row.failed}+${row.pending}=${row.total}` : "");

  // ---- 4. 录入 1 份、判重跳过 1 份，计数要跟着动 ----
  await patch(`/import-batches/${bid}/items/${ids[0]}`, { status: "imported", talent_id: "t-not-exist", talent_name: "张三" });
  await patch(`/import-batches/${bid}/items/${ids[1]}`, { status: "duplicate", talent_name: "李四" });

  list = await api("/import-batches?limit=50");
  row = list.body?.items?.find((b) => b.id === bid);
  check("录入份数 = 1", row?.imported === 1, `imported=${row?.imported}`);
  check("重复跳过份数 = 1", row?.duplicate === 1, `duplicate=${row?.duplicate}`);
  check("未处理份数降到 1", row?.pending === 1, `pending=${row?.pending}`);
  check("改完计数后仍满足相加关系",
    row && row.imported + row.duplicate + row.failed + row.pending === row.total,
    row ? `${row.imported}+${row.duplicate}+${row.failed}+${row.pending}=${row.total}` : "");

  // ---- 5. 详情：顺序与提交顺序一致，talent_alive 能识别悬空引用 ----
  const detail = await api(`/import-batches/${bid}`);
  check("详情返回 4 条明细", detail.body?.items?.length === 4, `len=${detail.body?.items?.length}`);
  check("明细保持提交顺序",
    detail.body?.items?.map((i) => i.file_name).join(",") === "张三.pdf,李四.docx,王五.pdf,坏文件.pdf",
    detail.body?.items?.map((i) => i.file_name).join(","));
  const importedItem = detail.body?.items?.find((i) => i.status === "imported");
  check("人才已被删时 talent_alive = 0", importedItem?.talent_alive === 0, `alive=${importedItem?.talent_alive}`);
  check("失败原因原样返回",
    detail.body?.items?.find((i) => i.status === "failed")?.error?.includes("文件已损坏"),
    detail.body?.items?.find((i) => i.status === "failed")?.error);
  check("解析来源已记录（AI / 本地规则可区分）",
    detail.body?.items?.filter((i) => i.parse_source === "ai").length === 2,
    detail.body?.items?.map((i) => i.parse_source).join(","));
  check("详情里的计数与列表一致",
    detail.body?.batch?.total === row?.total && detail.body?.batch?.imported === row?.imported);

  // ---- 6. 非法状态落成 failed，不能悄悄变成 pending 骗过统计 ----
  await patch(`/import-batches/${bid}/items/${ids[2]}`, { status: "已录入" });
  const afterBad = await api(`/import-batches/${bid}`);
  const bad = afterBad.body?.items?.find((i) => i.id === ids[2]);
  check("非法 status 落成 failed 而不是 pending", bad?.status === "failed", `status=${bad?.status}`);

  // ---- 7. 结束批次：幂等 + 结束后拒绝再写 ----
  const fin1 = await post(`/import-batches/${bid}/finish`, {});
  check("结束批次成功", fin1.status === 200, `HTTP ${fin1.status}`);
  const d1 = await api(`/import-batches/${bid}`);
  const firstFinished = d1.body?.batch?.finished_at;
  check("finished_at 已写入", !!firstFinished, firstFinished || "");

  await new Promise((r) => setTimeout(r, 1200));
  await post(`/import-batches/${bid}/finish`, {});
  const d2 = await api(`/import-batches/${bid}`);
  check("重复结束不覆盖首次结束时间", d2.body?.batch?.finished_at === firstFinished,
    `${firstFinished} vs ${d2.body?.batch?.finished_at}`);

  const lateWrite = await post(`/import-batches/${bid}/items`, [
    { file_name: "迟到的.pdf", file_size: 1000, status: "pending" },
  ]);
  check("批次结束后拒绝追加明细", lateWrite.status === 409, `HTTP ${lateWrite.status}`);

  // ---- 8. 不存在的批次返回 404（不是 500，也不泄露存在性）----
  const ghost = await api("/import-batches/00000000-0000-0000-0000-000000000000");
  check("不存在的批次返回 404", ghost.status === 404, `HTTP ${ghost.status}`);

  // ---- 9. 单次提交上限 ----
  const b2 = await post("/import-batches", { dedup: false });
  const tooMany = await post(`/import-batches/${b2.body.id}/items`,
    Array.from({ length: 201 }, (_, i) => ({ file_name: `f${i}.pdf`, file_size: 1 })));
  check("单次超过 200 条被拒", tooMany.status === 400, `HTTP ${tooMany.status}`);
  const empty = await post(`/import-batches/${b2.body.id}/items`, []);
  check("空明细被拒", empty.status === 400, `HTTP ${empty.status}`);
  await post(`/import-batches/${b2.body.id}/finish`, {});

  // ---- 10. dedup 开关如实记录 ----
  // 注意走详情接口而不是列表：列表会滤掉 0 份明细的批次（这个批次只有被拒的写入，没有明细）
  const b2detail = await api(`/import-batches/${b2.body.id}`);
  check("dedup 关闭被如实记录为 0", b2detail.body?.batch?.dedup === 0, `dedup=${b2detail.body?.batch?.dedup}`);
  check("0 份明细的批次不出现在列表里（避免噪音）",
    !(await api("/import-batches?limit=50")).body?.items?.some((b) => b.id === b2.body.id), "");

  // ---- 11. 分页 ----
  const p1 = await api("/import-batches?page=1&limit=1");
  check("分页 limit 生效", p1.body?.items?.length === 1, `len=${p1.body?.items?.length}`);
  check("分页返回总数", typeof p1.body?.total === "number" && p1.body.total >= 1, `total=${p1.body?.total}`);

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
