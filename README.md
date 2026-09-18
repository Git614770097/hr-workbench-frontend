# HR 人才库管理系统

基于 Cloudflare Workers + React + D1 的 HR 人才库管理系统 MVP。

## 功能

- **用户认证**：注册 / 登录 / 会话管理（JWT + KV）
- **人才档案**：增删改查，包含基本信息、技能、求职意向、备注
- **关键词搜索**：按姓名、公司、职位、技能、行业、备注多字段搜索
- **筛选**：按状态、城市、标签筛选人才
- **标签管理**：自定义标签，支持颜色，关联人才
- **沟通记录**：记录每次联系（电话/微信/面试/邮件），支持评分和跟进提醒
- **批量导入**：JSON 格式批量导入人才数据

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + React Router 7 + Vite |
| 后端 | Hono (Cloudflare Workers) |
| 数据库 | Cloudflare D1 (SQLite) |
| 会话 | Cloudflare KV |
| 部署 | Cloudflare Workers + Static Assets |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 初始化数据库（首次部署时执行）
npx wrangler d1 create hr-talent-pool-db
# 将返回的 database_id 填入 wrangler.jsonc
npm run db:init

# 3. 本地开发
npm run dev

# 4. 部署到 Cloudflare
npm run build
npm run deploy
```

## 项目结构

```
hr-talent-pool/
├── src/
│   ├── main.tsx              # React 入口
│   ├── App.tsx               # 路由 & 认证
│   ├── api.ts                # API 请求封装
│   ├── types.ts              # TypeScript 类型
│   ├── styles/global.css     # 全局样式
│   ├── components/
│   │   └── Layout.tsx        # 侧边栏布局
│   ├── pages/
│   │   ├── Login.tsx         # 登录
│   │   ├── Register.tsx      # 注册
│   │   ├── TalentList.tsx    # 人才列表（搜索/筛选/分页）
│   │   ├── TalentDetail.tsx  # 人才详情 + 沟通记录
│   │   ├── TalentForm.tsx    # 新增/编辑人才
│   │   ├── Tags.tsx          # 标签管理
│   │   └── Import.tsx        # 批量导入
│   └── worker/
│       ├── index.ts          # Hono 入口
│       └── routes/
│           ├── auth.ts       # 认证路由
│           ├── talents.ts    # 人才 CRUD + 搜索
│           ├── tags.ts       # 标签 CRUD
│           └── communications.ts # 沟通记录
├── schema.sql                # D1 数据库 Schema
├── wrangler.jsonc            # Cloudflare 配置
├── vite.config.ts            # Vite + Cloudflare 插件
└── package.json
```

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/auth/register | 注册 |
| POST | /api/auth/login | 登录 |
| GET | /api/auth/me | 获取当前用户 |
| POST | /api/auth/logout | 退出登录 |
| GET | /api/talents | 人才列表（搜索/筛选/分页） |
| GET | /api/talents/:id | 人才详情 |
| POST | /api/talents | 新增人才 |
| PUT | /api/talents/:id | 编辑人才 |
| DELETE | /api/talents/:id | 删除人才 |
| POST | /api/talents/import | 批量导入 |
| GET | /api/tags | 标签列表 |
| POST | /api/tags | 新增标签 |
| PUT | /api/tags/:id | 编辑标签 |
| DELETE | /api/tags/:id | 删除标签 |
| GET | /api/communications/talent/:talentId | 沟通记录列表 |
| POST | /api/communications | 添加沟通记录 |
| DELETE | /api/communications/:id | 删除沟通记录 |

## 后续规划

- [ ] 团队协作 & 共享人才库
- [ ] 钉钉/飞书/企业微信数据导入
- [ ] Workers AI 语义搜索
- [ ] R2 简历附件上传
- [ ] 跟进提醒仪表盘
