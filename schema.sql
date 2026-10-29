-- HR 人才库管理系统 数据库 Schema
-- 注意：users 表结构已变更（email → phone，新增 role），
-- 如已存在旧表需先执行：DROP TABLE IF EXISTS users;

-- 角色表（自定义角色 + 菜单权限）
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，如 ["talents","risks"]
  owner_id TEXT,               -- 角色创建者：NULL=全局角色（超管建）；管理员建的角色记自己的 id
  created_at TEXT DEFAULT (datetime('now'))
);

-- 用户表（手机号登录 + 角色）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',  -- admin / user
  role_id TEXT REFERENCES roles(id), -- 关联自定义角色（admin 忽略）
  status TEXT NOT NULL DEFAULT 'active', -- active 可登录 / pending 待管理员审批 / rejected 已拒绝
  reset_requested_at TEXT,               -- 忘记密码申请时间，NULL 表示无待处理申请
  must_change_password INTEGER NOT NULL DEFAULT 0, -- 管理员设临时密码后置 1，下次登录需自行修改
  pushplus_token TEXT,                   -- 个人 PushPlus 推送 token（用于到期提醒推送到本人）
  paid_until TEXT,                       -- 会员有效期（NULL=未开通；过期时间串=已过期/有效），手动开通制
  referral_code TEXT UNIQUE,             -- 老带新邀请码（注册/建号时生成，唯一）
  referred_by TEXT,                      -- 邀请人 user id（谁带来的）
  intended_role TEXT,                    -- 注册时自报身份（hr/headhunter/team/other），仅作意向参考，不参与鉴权
  team_id TEXT,                          -- 团队标识：NULL=个人；管理员=自己的id；子用户=管理员id。同 team_id 共享业务数据
  notify_channel TEXT DEFAULT 'pushplus', -- 到期提醒推送渠道：pushplus / feishu / wecom
  feishu_open_id TEXT,                    -- 飞书 open_id（notify_channel=feishu 时使用；应用级标识）
  feishu_app_id TEXT,                     -- 绑定时使用的飞书应用 app_id（open_id 随应用而异，发信必须用同一应用）
  wecom_userid TEXT,                      -- 企业微信 userid（notify_channel=wecom 时使用）
  ai_key TEXT,                            -- 自有 DeepSeek API Key（BYOK）
  ai_key_masked TEXT,                     -- AI Key 掩码（展示用，如 sk-****abc）
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);

-- 站点简单配置（KV 风格键值表）：当前仅存支付收款配置（收款码 + 说明）
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 用户级 UI 偏好（key-value），首个用途：工作台「调整模块」模块显隐（key = workbench_modules）
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

-- 人才档案表
CREATE TABLE IF NOT EXISTS talents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  age INTEGER,
  gender TEXT,        -- 性别: 男 / 女（AI 简历解析会识别并落库）
  education TEXT,     -- 学历: 高中及以下 / 中专 / 大专 / 本科 / 硕士 / 博士 / MBA/EMBA / 其他
  school TEXT,        -- 毕业院校
  major TEXT,         -- 专业（所学专业）
  current_company TEXT,
  current_title TEXT,
  years_experience INTEGER,
  city TEXT,
  skills TEXT,          -- JSON 数组: ["Java","Spring","MySQL"]
  industry TEXT,
  expected_salary TEXT,
  expected_city TEXT,
  status TEXT DEFAULT 'active',  -- active / passive / placed / do_not_contact
  resume_url TEXT,
  resume_text TEXT,   -- 简历原文（平台同步/粘贴录入，与 resume_url 文件互不替代）
  notes TEXT,
  stage TEXT DEFAULT 'new', -- 全局招聘阶段: new/screening/interview/offer/hired/archived
  source TEXT,              -- 来源渠道: boss/liepin/51job/zhaopin/referral/campus/...
  birth_date TEXT,          -- 出生日期（生日提醒）
  contract_end TEXT,        -- 合同到期日
  probation_end TEXT,       -- 试用期结束日
  resignation_date TEXT,    -- 预计离职日期（离职倒计时）
  hire_date TEXT,           -- 入职日期（社保增员待办基准日）
  entry_type TEXT DEFAULT 'manual', -- 录入方式: manual 手工 / ai_parse AI 解析 / import 导入
  tags TEXT DEFAULT '[]',    -- 标签 JSON 数组（人才库筛选用）
  next_follow_at TEXT,      -- 下次跟进/提醒时间（录入表单可填，到期自动生成待办）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 岗位表
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,               -- 岗位名称
  department TEXT,                   -- 用人部门
  city TEXT,                         -- 工作城市
  job_type TEXT DEFAULT 'fulltime',  -- fulltime / parttime / intern / outsourced
  headcount INTEGER DEFAULT 1,       -- 招聘人数（HC）
  priority TEXT DEFAULT 'normal',    -- high / normal / low
  status TEXT DEFAULT 'open',        -- open 在招 / paused 暂停 / closed 已关闭
  salary_range TEXT,
  education TEXT,
  experience TEXT,
  description TEXT,
  requirements TEXT,
  opened_at TEXT,
  closed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 候选人-岗位关联表（一名人才可应聘多个岗位）
CREATE TABLE IF NOT EXISTS talent_jobs (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL REFERENCES talents(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  stage TEXT NOT NULL DEFAULT 'screening',  -- screening/interview1/interview2/offer/hired/rejected/withdrawn
  rating INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (talent_id, job_id)
);

-- 阶段流转日志
CREATE TABLE IF NOT EXISTS job_stage_logs (
  id TEXT PRIMARY KEY,
  talent_job_id TEXT NOT NULL REFERENCES talent_jobs(id),
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  remark TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 跟进待办表
CREATE TABLE IF NOT EXISTS talent_tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  talent_id TEXT REFERENCES talents(id),
  job_id TEXT REFERENCES jobs(id),
  title TEXT NOT NULL,
  content TEXT,
  due_date TEXT,
  original_due TEXT,                   -- 顺延前的原始到期日（节假日顺延时留底）
  shifted INTEGER DEFAULT 0,           -- 是否被节假日顺延过（1=是）
  priority TEXT DEFAULT 'normal',    -- high / normal / low
  status TEXT DEFAULT 'pending',     -- pending / done / cancelled
  source TEXT DEFAULT 'manual',      -- manual / follow_up / system
  task_type TEXT DEFAULT 'manual',   -- manual / probation / social_add / social_leave / contract_expire / pipeline_stall / follow_up / interview_remind
  done_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 文档模板表（模板库全员共享可读；创建者或管理员可改/删，内置模板 owner_id='system'）
CREATE TABLE IF NOT EXISTS doc_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,      -- 劳动合同 / 离职证明 / 调薪通知 / 警告信 / 在职证明 / 其他
  content TEXT NOT NULL,       -- 富文本 HTML，支持 {{姓名}} {{公司}} 等占位符
  scope TEXT NOT NULL DEFAULT 'shared',  -- official 官方（管理员维护，全员只读）/ shared 共享（创建者可改）/ private 个人（仅本人+管理员可见）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 人才画像表（智能匹配：上传简历 + 画像 → 排序推荐）
CREATE TABLE IF NOT EXISTS match_profiles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,                 -- 画像名称，如「前端开发工程师」
  job_title TEXT,                     -- 目标职位
  city TEXT,                          -- 工作城市
  education TEXT,                     -- 学历门槛
  min_years INTEGER,                  -- 经验年限下限
  max_years INTEGER,                  -- 经验年限上限（NULL 表示不限）
  salary_range TEXT,                  -- 薪资范围
  industry TEXT,                      -- 行业背景要求
  must_skills TEXT,                   -- JSON 数组：必备技能
  nice_skills TEXT,                   -- JSON 数组：加分技能
  requirements TEXT,                  -- 其它要求
  jd_raw TEXT,                        -- 原始 JD 文本
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 合同文件：原件存 KV（contract: 前缀），元数据存 D1。
-- extracted_* 为 AI 识别的日期（仅作记录，档案日期以 talents 表为准）。
CREATE TABLE IF NOT EXISTS contract_files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  talent_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/pdf',
  size INTEGER NOT NULL DEFAULT 0,
  kv_key TEXT NOT NULL,
  extracted_contract_end TEXT,
  extracted_probation_end TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 参保台账：一人一条，基数/比例由用户按参保地政策自填（系统不维护费率规则库）
CREATE TABLE IF NOT EXISTS talent_social (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  talent_id TEXT NOT NULL UNIQUE REFERENCES talents(id) ON DELETE CASCADE,
  si_status TEXT NOT NULL DEFAULT 'none',  -- none 未参保 / active 参保中 / stopped 已停缴
  si_city TEXT,
  si_base REAL,
  hf_base REAL,
  si_rate_personal REAL,
  si_rate_company REAL,
  hf_rate_personal REAL,
  hf_rate_company REAL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 面试安排与评价表（挂在 talent_jobs 上：同一候选人应聘多个岗位时，
-- 面试属于「某岗位的某轮面试」，故关联 talent_job_id 而非仅 talent_id）
CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  talent_id TEXT NOT NULL REFERENCES talents(id),
  job_id TEXT,                            -- 冗余存一份，便于按岗位筛选面试
  talent_job_id TEXT REFERENCES talent_jobs(id) ON DELETE CASCADE,
  round TEXT NOT NULL DEFAULT 'interview1', -- interview1 初试 / interview2 复试 / final 终面
  mode TEXT NOT NULL DEFAULT 'online',   -- online 线上 / onsite 线下 / phone 电话
  scheduled_at TEXT,                      -- 面试时间 'YYYY-MM-DD HH:mm'
  duration INTEGER DEFAULT 60,            -- 时长（分钟）
  location TEXT,                          -- 线下地点
  meeting_url TEXT,                       -- 线上会议链接
  interviewer TEXT,                       -- 面试官（多人用顿号分隔）
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled 待面试 / done 已完成 / cancelled 已取消 / no_show 未到
  result TEXT,                            -- pass 通过 / fail 不通过 / pending 待定
  score INTEGER,                          -- 综合评分 1-5
  evaluation TEXT,                        -- 评价内容
  dept_result TEXT,                       -- 用人部门结论：pass / fail / pending
  dept_score INTEGER,                     -- 用人部门评分 1-5
  dept_evaluation TEXT,                   -- 用人部门评价内容
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ---- 招聘需求（用人部门提需求 → HR 审批 → 一键转正式岗位）----
CREATE TABLE IF NOT EXISTS requisitions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),   -- 创建人（用人部门 HRBP）
  department TEXT NOT NULL,                      -- 需求部门
  title TEXT NOT NULL,                           -- 拟招岗位名称
  headcount INTEGER DEFAULT 1,                   -- 需求人数
  job_type TEXT DEFAULT 'fulltime',
  city TEXT,
  salary_range TEXT,
  education TEXT,
  experience TEXT,
  reason TEXT,                                   -- 需求原因 / 背景
  expect_date TEXT,                              -- 期望到岗时间
  priority TEXT DEFAULT 'normal',                -- high/normal/low
  status TEXT NOT NULL DEFAULT 'pending',        -- pending 待处理 / approved 已转岗 / rejected 已驳回(历史) / closed 已作废
  job_id TEXT,                                   -- 转为岗位后生成的岗位 id
  reject_reason TEXT,                            -- 驳回原因（历史数据保留）
  approved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ---- 审批流（可自建模板；Offer 审批 / 入职审批共用一套引擎）----
-- flow_steps 以 JSON 存步骤数组：[{ "name": "HR 主管审批", "role": "admin" }, ...]
CREATE TABLE IF NOT EXISTS approval_flows (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,                            -- 流程名，如「Offer 审批」
  scene TEXT NOT NULL DEFAULT 'offer',           -- offer / onboard / other
  flow_steps TEXT NOT NULL DEFAULT '[]',         -- JSON 步骤数组
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 审批实例：once 一个候选人的一次审批（biz_id = talent_jobs.id）
CREATE TABLE IF NOT EXISTS approval_instances (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),   -- 发起人
  flow_id TEXT REFERENCES approval_flows(id),
  scene TEXT NOT NULL DEFAULT 'offer',
  talent_id TEXT NOT NULL REFERENCES talents(id),
  talent_job_id TEXT REFERENCES talent_jobs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,                           -- 标题，如「张三 - 前端工程师 Offer 审批」
  current_step INTEGER NOT NULL DEFAULT 0,       -- 当前处在第几步（0 起）
  status TEXT NOT NULL DEFAULT 'pending',        -- pending 进行中 / approved 已通过 / rejected 已驳回 / cancelled 已取消
  payload TEXT,                                  -- 快照 JSON（Offer 金额等）
  ext_provider TEXT,                             -- 外部审批渠道（预留，如企业微信审批）
  ext_msg_id TEXT,                               -- 外部审批消息 ID（回调用）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 审批记录：每一步谁批的、批了什么
CREATE TABLE IF NOT EXISTS approval_steps (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  approver_id TEXT,                              -- 指定审批人；为空表示该步骤由管理员/发起人上级处理
  decision TEXT,                                 -- approve / reject
  comment TEXT,
  acted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---- 入职办理材料清单（模板可自定，逐项勾选跟进）----
CREATE TABLE IF NOT EXISTS onboarding_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  talent_id TEXT NOT NULL REFERENCES talents(id) ON DELETE CASCADE,
  talent_job_id TEXT REFERENCES talent_jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                            -- 材料/事项名称，如「身份证复印件」
  category TEXT,                                 -- 分组，如「身份材料」「财务」
  required INTEGER NOT NULL DEFAULT 1,          -- 1=必交 0=选交
  status TEXT NOT NULL DEFAULT 'pending',        -- pending 待提交 / submitted 已提交 / verified 已核验
  submitted_at TEXT,
  remark TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ---- AI 辅助产出（简历解读 / 沟通文案 / 面试问题 / 综合评估的缓存与配额计数）----
CREATE TABLE IF NOT EXISTS ai_artifacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  biz_type TEXT NOT NULL,                 -- resume_insight / outreach / interview_questions / candidate_summary
  biz_id TEXT NOT NULL,                   -- 人才 id；导入核对中的未入库记录用 "pre:{recordKey}"
  scene TEXT,                             -- 仅 outreach 用：场景+语气，如 reject:warm
  content TEXT NOT NULL,                  -- 结构化结果 JSON 字符串
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---- 老带新推广（邀请奖励）：归属注册时写入一次，管理员点开通时发奖 ----
CREATE TABLE IF NOT EXISTS referrals (
  id                    TEXT PRIMARY KEY,
  referrer_id           TEXT NOT NULL,
  invitee_id            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',  -- pending 待奖励 / rewarded 已发奖
  created_at            TEXT DEFAULT (datetime('now')),
  rewarded_at           TEXT,
  reward_months_referrer INTEGER,
  reward_months_invitee  INTEGER,
  note                  TEXT
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_talents_owner ON talents(owner_id);
CREATE INDEX IF NOT EXISTS idx_talent_social_talent ON talent_social(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_social_owner ON talent_social(owner_id);
CREATE INDEX IF NOT EXISTS idx_talents_status ON talents(status);
CREATE INDEX IF NOT EXISTS idx_doc_templates_category ON doc_templates(category);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_talent_jobs_talent ON talent_jobs(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_jobs_job ON talent_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_talent_jobs_stage ON talent_jobs(stage);
CREATE INDEX IF NOT EXISTS idx_stage_logs_tj ON job_stage_logs(talent_job_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON talent_tasks(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON talent_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_match_profiles_owner ON match_profiles(owner_id);
CREATE INDEX IF NOT EXISTS idx_contract_files_talent ON contract_files(talent_id);
CREATE INDEX IF NOT EXISTS idx_interviews_talent_job ON interviews(talent_job_id);
CREATE INDEX IF NOT EXISTS idx_interviews_owner ON interviews(owner_id);
CREATE INDEX IF NOT EXISTS idx_interviews_scheduled ON interviews(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_ai_artifacts_lookup ON ai_artifacts(owner_id, biz_type, biz_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_artifacts_quota ON ai_artifacts(owner_id, created_at);

-- ---- 社保费率模板（按城市保存五险一金比例，社保计算器一键套用）----
CREATE TABLE IF NOT EXISTS social_rate_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  city TEXT NOT NULL,
  si_rate_personal REAL,               -- 社保个人缴纳比例
  si_rate_company REAL,                -- 社保单位缴纳比例
  hf_rate_personal REAL,               -- 公积金个人缴纳比例
  hf_rate_company REAL,                -- 公积金单位缴纳比例
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_social_rate_templates_owner ON social_rate_templates(owner_id, city);

-- ---- 模块点击率日志（usage_events 明细留 30 天；usage_daily 日聚合长期保留）----
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,                    -- 事件时间（UTC）
  day TEXT NOT NULL,                   -- 归属日期 YYYY-MM-DD（UTC+8）
  user_id TEXT NOT NULL,
  role TEXT,
  menu TEXT NOT NULL,                  -- 菜单 key（见 src/usageMeta.ts）
  action TEXT NOT NULL DEFAULT 'view', -- view / click
  detail TEXT,
  platform TEXT                        -- web / mobile
);
CREATE INDEX IF NOT EXISTS idx_usage_events_day ON usage_events(day, menu);
CREATE INDEX IF NOT EXISTS idx_usage_events_user ON usage_events(user_id, ts);

-- ---- 操作审计日志（合规刚需）：谁/何时/对何对象/做了什么 ----
-- 与 usage_events（前端埋点热度）区别：audit_logs 记「影响数据的操作」，是追溯与个保合规依据。
CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  user_id     TEXT,
  user_name   TEXT,
  role        TEXT,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  target_name TEXT,
  detail      TEXT,
  ip          TEXT,
  ua          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, ts);

-- ---- 飞书集成（BYOK）：应用凭证 + 群机器人 webhook ----
-- feishu_apps 三级作用域：team_id 非空=团队自配 / user_id 非空=个人自配 / 两者 NULL=全局默认。
-- 解析顺序：团队 → 个人 → 全局（见 resolveFeishuApp）。app_secret 等密文，主密钥 AI_KEY_SECRET。
-- 发送模式（群+个人/仅群/仅个人）存 site_settings（key = feishu_notify_mode）。
CREATE TABLE IF NOT EXISTS feishu_apps (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  user_id TEXT,
  name TEXT,
  app_id TEXT NOT NULL,
  app_secret_enc TEXT NOT NULL,
  encrypt_key_enc TEXT,
  verification_token_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- feishu_webhooks：飞书群自定义机器人（零应用依赖，群内全员可见，不能私信个人）。
CREATE TABLE IF NOT EXISTS feishu_webhooks (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  name TEXT NOT NULL,
  url_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  menu TEXT NOT NULL,
  user_id TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  actions INTEGER NOT NULL DEFAULT 0,
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  last_at TEXT,
  PRIMARY KEY (day, menu, user_id)
);

-- 内容版本快照：业务正文被覆盖前留底，可回滚（先接 doc_templates，后续可扩 job/profile）。
-- 只在内容真正变化时写入；每个 target 保留最近 MAX_KEEP 版。
CREATE TABLE IF NOT EXISTS content_versions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,            -- template / job / profile
  target_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,                -- 全文快照（HTML/纯文本）
  editor_id TEXT,                       -- 触发本次变更的用户（恢复也是新版本）
  note TEXT,                            -- 可选备注，如「恢复自 v3」
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (target_type, target_id, version)
);

CREATE INDEX IF NOT EXISTS idx_cv_target ON content_versions(target_type, target_id, version);
