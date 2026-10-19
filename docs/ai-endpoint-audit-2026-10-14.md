# AI 端点重叠审计报告

- 日期：2026-10-14
- 范围：`src/worker/routes/aiAssist.ts`（11 个生成端点 + 5 个 GET 缓存读 + 2 个配额）+ `src/worker/routes/interviews.ts` 的 `ai-summary`
- 数据来源：代码通读 + 线上 `ai_artifacts` 使用统计（截至 2026-10-14，含演示数据时期）

---

## 1. 端点全景

| # | 端点 | 输入 | 输出结构 | 前端入口 | 线上使用 |
|---|------|------|----------|----------|---------|
| 1 | `/resume-insight` | 人才+岗位+简历原文 | highlights / risks / jd_fit / suggestion | 人才详情、导入核对 | 5 |
| 2 | `/outreach` | 人才+岗位+scene+tone | title / content / tips | 人才详情（4 场景） | 1 |
| 3 | `/interview-questions` | 人才+岗位+历史评价 | questions[q/focus] | 面试管理 | **0** |
| 4 | `/candidate-summary` | 人才+全部轮次评价 | summary / strengths / risks / recommendation / suggested_result | 面试管理 | **0** |
| 5 | `/job-draft` | 岗位名+部门+城市（双模式） | description / requirements / salary / education / experience | 岗位表单「AI 起草/优化」 | 7 |
| 6 | `/approval-summary` | 审批实例 id | summary / risks | 审批中心 | **0** |
| 7 | `/onboard-checklist` | 人才 id | items[name/category/required] | 入职办理 | 2 |
| 8 | `/talent-inventory` | 筛选条件（后端自查） | profile / gaps / actions | 人才库 + AI 助手 | 3 |
| 9 | `/job-diagnosis` | 前端传岗位聚合数据 | verdict / reasons / actions | 岗位详情 + AI 助手 | 3 |
| 10 | `/recap-report` | 前端传概览聚合数据 | summary / bottlenecks / suggestions | 招聘概览 | 6 |
| 11 | `/next-step` | 看板 link_id | action / suggestion / reasons / draft | 招聘看板卡片 | **0** |
| 12 | `/today-focus` | 待办列表 | top3 / arrange / defer | 待办页 | 6 |
| 13 | `/resume-optimize` | 人才+简历原文 | headline / optimized / changes / tips | AI 助手 | **0** |
| 14 | `interviews /ai-summary` | 单轮面试 id | summary / strengths / risks / recommendation / suggested_result | 面试评价弹窗 | 不落库（无法统计） |

---

## 2. 重叠发现（按严重度分级）

### P0 — 真重叠：`candidate-summary` × `interviews /ai-summary`

- **输出结构逐字段一致**（summary / strengths / risks / recommendation / suggested_result），代码注释自己写明「输出结构保持一致，前端可复用同一套渲染」。
- **输入是超集关系**：candidate-summary 查该候选人全部轮次评价；ai-summary 只总结一轮。当候选人只有一轮面试时，两者产出语义完全重合。
- **用户侧同页双入口**：`Interviews.tsx` 第 80 行（综合评估）和第 864 行（单轮总结）在同一页面，用户视角就是两个功能相似的 AI 按钮。
- **建议**：下线 `ai-summary`，统一走 `candidate-summary`（单轮时它自然就是单轮总结，prompt 已要求「评价内容太少时少给」）。前端删一个按钮，少一个认知负担。注意：ai-summary 不落 `ai_artifacts`，无缓存迁移成本。

### P1 — 结构重叠：五个「聚合数据 → AI 叙述建议」端点

`recap-report`（全局复盘）/ `job-diagnosis`（单岗位诊断）/ `talent-inventory`（库盘点）/ `next-step`（看板单卡）/ `today-focus`（待办排序）是同一模式：

```
前端/后端聚合数据 → system prompt（JSON 纪律 + 引用具体数字）→ { 一句话结论 + 2-3 条列表字段 }
```

- **语义边界是清晰的**（复盘管流程、诊断管岗位、盘点管储备、next-step 管单卡决策、today-focus 管待办排序），**不建议合并端点**。
- 但五个端点的**代码骨架逐行相似**：apiKey 检查 → quotaGuard → cache → deepseekJsonWithUsage → 降级 → saveArtifact，每个端点约 20 行样板；system prompt 的「严格 JSON / 不编造 / 引用数字 / 禁空话」要求也重复 5 遍。
- **建议**：抽一个 `narrativeEndpoint()` 工厂（传入 bizType、system 差异段、userPrompt、结果字段清洗器），五个端点各减 15-20 行；prompt 公共前缀抽常量。

### P1 — 输入组装重叠：六个「人才上下文」端点

`resume-insight` / `resume-optimize` / `interview-questions` / `candidate-summary` / `outreach` / `next-step` 都在重复同一套构造：

```
loadContext(人才+岗位) → talentBrief(talent) + jobText(job) + maskPii + truncate
```

- `resume-insight` 和 `resume-optimize` 的输入组装**几乎逐行相同**（同样的 resumeText + jdText 拼法），只是 system prompt 和输出用途不同。
- **建议**：抽 `renderTalentContext(talent, job, { resumeText })` helper，六处共用。

### P2 — 轻微重叠：`next-step.draft` × `outreach(followup)`

- next-step 产出的跟进话术草稿与 outreach 的 followup 场景功能相近。
- 但服务场景不同：看板上要的是「快速决策 + 顺手一句话」，人才详情页要的是「可直接发送的专业文案」。
- **建议**：保留两端点；前端命名已区分（「下一步建议」/「沟通文案」），无需动作，后续如观察 confusion 再议。

### P2 — 端点样板重复（结构性）

13 个生成端点各自重复：apiKey 检查（`AI_NO_KEY`）→ quotaGuard → loadRecentArtifact 缓存 → deepseekJsonWithUsage → 降级响应 → saveArtifact。`aiGuard.ts` 已收了一部分，但每个端点仍有约 20 行近重复代码。
- **建议**：与 P1 的 `narrativeEndpoint()` 工厂一并做，预计 aiAssist.ts 从 1400 行降到 1000 行左右。

---

## 3. 零使用端点分析（5 个）

`interview-questions`、`candidate-summary`、`approval-summary`、`next-step`、`resume-optimize` 线上**从未成功生成过**（ai_artifacts 无记录）。

- 这些端点都有前端入口，0 使用说明的是**曝光/价值问题，不一定是功能错误**：
  - `interview-questions`、`candidate-summary`：入口在面试管理页，需先有面试评价才可用，新用户到不了那一步；
  - `approval-summary`：入口在审批中心，需先有审批单；
  - `next-step`：看板卡片按钮，位置可能不够显眼；
  - `resume-optimize`：只在 AI 助手页，需要先选人才。
- **建议**：不删。保留一个观察周期，在入口上增加曝光（如看板卡片 next-step 按钮常显、面试管理空评价时给引导）。若下个季度仍为 0，再评估下线。

---

## 4. 行动清单

| 优先级 | 动作 | 影响面 | 预估 |
|---|---|---|---|
| P0 | 下线 `interviews /ai-summary`，统一走 `candidate-summary` | 后端 -60 行，前端 -1 按钮 | 小 |
| P1 | 抽 `narrativeEndpoint()` 工厂 + `renderTalentContext()` helper | aiAssist.ts 瘦身 ~400 行 | 中 |
| P2 | 零使用端点入口曝光优化 | 前端 3-4 处 | 小 |
| P2 | 观察期后复评零使用端点 | — | — |

**不建议做的**：合并 recap/diagnosis/inventory 三个分析端点（语义边界清晰，合并会让 prompt 和输出结构都劣化）；合并 resume-insight 与 resume-optimize（一个是读简历一个是改简历，用户预期不同）。

---

## 5. 结论

13 个端点里只有 1 对真重叠（candidate-summary × ai-summary），其余「重叠」都是**结构性的代码样板重复**而非功能重复。功能层面这个 AI 矩阵的设计是克制的；真正该做的是 P0 合并 + P1 抽工厂，预计代码量降 30%，token 成本不变，用户侧入口从 14 个概念降到 13 个且更易理解。
