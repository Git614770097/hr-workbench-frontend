# HR 人才库管理系统

基于 Cloudflare Workers + React + Ant Design + D1 + KV 的 HR 人才库管理系统。

## 功能

- **手机号登录**（注册）
- **角色权限**：管理员可看所有数据，普通用户只看自己的
- **用户管理**（管理员）：创建/删除普通用户，重置密码
- 人才档案 CRUD（基本信息、年龄、学历、院校、技能、求职意向、备注）
- **分字段搜索**：姓名、手机号、邮箱、年龄、学历、院校、年限、城市、职位、状态、创建人 + 标签筛选 + 分页
- 标签管理（自定义颜色）
- 沟通记录（电话/微信/面试/邮件，评分 + 跟进提醒）
- **简历文件上传、预览与删除**：导入时自动保存原始 PDF/Word 文件到 KV，列表页/详情页可在线预览（PDF 原生渲染，保留原始格式），也可单独删除简历文件
- 批量导入（上传 PDF / Word 简历，自动提取姓名、手机号、邮箱、年龄、学历、院校、年限、城市、职位等信息，核对后导入，同时保存原始文件）
- **统一弹窗风格**：新增、编辑、导入等二级页面全部使用弹窗，按钮统一靠右

### 招聘流程（P0）

- **岗位管理**：岗位 CRUD、用人部门、HC 需求、紧急度、薪资范围、在招/暂停/关闭状态流转（关闭自动记日期）、招聘进度条（已入职/HC）、看板式岗位详情
- **招聘流程看板**：7 个阶段（简历筛选 → 初试 → 复试 → Offer → 已入职 / 已淘汰 / 已放弃）分列展示，支持**拖拽卡片换阶段**、每条卡片快速流转、阶段流转日志留痕、停留天数预警（≥7 天标橙）
- 一名人才可同时应聘多个岗位，互不影响
- 候选人**加入流程弹窗**：从人才库选人挂到岗位，或从岗位详情批量添加
- **跟进待办**：手动创建待办（关联人才/岗位、到期日、优先级），逾期/今日到期高亮，侧栏角标提醒；可按人才/优先级/负责人筛选

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + Ant Design 5 + Vite |
| 后端 | Hono (Cloudflare Workers) |
| 数据库 | Cloudflare D1 |
| 会话 | Cloudflare KV |
| 文件存储 | Cloudflare KV（简历文件，单文件上限 25MB） |
| 简历解析 | pdfjs-dist（本地打包，不依赖 CDN）+ mammoth (Word) |

## 快速开始

```bash
npm install

# 创建 KV 命名空间（用于简历文件存储）
npx wrangler kv namespace create RESUMES
# 将输出的 id 填入 wrangler.jsonc 中 RESUMES 的 id 字段

# ⚠️ users 表结构已变更（email → phone + role），需重建：
npx wrangler d1 execute hr-workbench --remote --command "DROP TABLE IF EXISTS users;"
npx wrangler d1 execute hr-workbench --remote --file=./schema.sql

# 增量迁移统一放在 ./migrations/ 目录，文件按日期命名（YYYYMMDD-描述.sql），按序执行：
# ⚠️ 2026-09-18 talents 表新增 年龄/学历/院校 字段：
npx wrangler d1 execute hr-workbench --remote --file=./migrations/migration-20260918-add-edu-fields.sql

# ⚠️ 2026-09-21 新增 岗位/招聘流程/待办 四张表 + talents.stage/source 字段：
npx wrangler d1 execute hr-workbench --remote --file=./migrations/migration-20260921-jobs-pipeline-tasks.sql

# 注意：migrations/ 下的脚本多为「归档记录」，生产库已执行过，
# 仅新环境需按文件名日期顺序依次执行；重复执行 ALTER TABLE ADD COLUMN 会报错。

npm run build
npm run deploy
```

部署后访问 **https://hr-work.club**，用手机号登录。
