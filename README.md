# HR 人才库管理系统

基于 Cloudflare Workers + React + Ant Design + D1 + KV 的 HR 人才库管理系统。

## 功能

- **手机号登录**（无注册，首个登录自动成为管理员）
- **角色权限**：管理员可看所有数据，普通用户只看自己的
- **用户管理**（管理员）：创建/删除普通用户，重置密码
- 人才档案 CRUD（基本信息、年龄、学历、院校、技能、求职意向、备注）
- **分字段搜索**：姓名、手机号、邮箱、年龄、学历、院校、年限、城市、职位、状态、创建人 + 标签筛选 + 分页
- 标签管理（自定义颜色）
- 沟通记录（电话/微信/面试/邮件，评分 + 跟进提醒）
- **简历文件上传、预览与删除**：导入时自动保存原始 PDF/Word 文件到 KV，列表页/详情页可在线预览（PDF 原生渲染，保留原始格式），也可单独删除简历文件
- 批量导入（上传 PDF / Word 简历，自动提取姓名、手机号、邮箱、年龄、学历、院校、年限、城市、职位等信息，核对后导入，同时保存原始文件）
- **统一弹窗风格**：新增、编辑、导入等二级页面全部使用弹窗，按钮统一靠右

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

# ⚠️ 2026-09-18 talents 表新增 年龄/学历/院校 字段，已有数据库需执行迁移：
npx wrangler d1 execute hr-workbench --remote --file=./migration-20260918-add-edu-fields.sql

npm run build
npm run deploy
```

部署后访问 **https://hr-work.club**，用手机号登录（首个自动成为管理员）。
