-- HR 人才库管理系统 数据库 Schema
-- 注意：users 表结构已变更（email → phone，新增 role），
-- 如已存在旧表需先执行：DROP TABLE IF EXISTS users;

-- 角色表（自定义角色 + 菜单权限）
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，如 ["talents","risks"]
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
  intended_role TEXT,                    -- 注册时自报身份（hr/headhunter/team/other），仅作意向参考，不参与鉴权
  created_at TEXT DEFAULT (datetime('now'))
);

-- 站点简单配置（KV 风格键值表）：当前仅存支付收款配置（收款码 + 说明）
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
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
  notes TEXT,
  stage TEXT DEFAULT 'new', -- 全局招聘阶段: new/screening/interview/offer/hired/archived
  source TEXT,              -- 来源渠道: boss/liepin/51job/zhaopin/referral/campus/...
  birth_date TEXT,          -- 出生日期（生日提醒）
  contract_end TEXT,        -- 合同到期日
  probation_end TEXT,       -- 试用期结束日
  resignation_date TEXT,    -- 预计离职日期（离职倒计时）
  hire_date TEXT,           -- 入职日期（社保增员待办基准日）
  next_follow_at TEXT,      -- 下次跟进/提醒时间（录入表单可填，到期自动生成待办）
  is_demo INTEGER DEFAULT 0, -- 示例数据标记：1=一键载入的演示数据，可整批清除
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
  is_demo INTEGER DEFAULT 0, -- 示例数据标记：1=一键载入的演示数据，可整批清除
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
  priority TEXT DEFAULT 'normal',    -- high / normal / low
  status TEXT DEFAULT 'pending',     -- pending / done / cancelled
  source TEXT DEFAULT 'manual',      -- manual / follow_up / system
  done_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 标签表
-- 沟通记录表
CREATE TABLE IF NOT EXISTS communications (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL REFERENCES talents(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT,            -- call / wechat / interview / email / other
  content TEXT,
  rating INTEGER,      -- 1-5 评分
  follow_up_date TEXT,  -- 跟进提醒日期
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

-- 人才画像的级别（初级/中级/高级…）：一个画像下挂多个级别，
-- 每个级别有独立的年限区间、学历、技能、城市，以及对应的市场薪资。
CREATE TABLE IF NOT EXISTS match_profile_levels (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES match_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                -- 级别名，如「初级」「中级」「高级」
  min_years INTEGER,                 -- 年限下限
  max_years INTEGER,                 -- 年限上限（NULL = 不设上限）
  education TEXT,                    -- 学历门槛
  city TEXT,                         -- 工作城市
  must_skills TEXT,                  -- JSON 数组：必备技能
  nice_skills TEXT,                  -- JSON 数组：加分技能
  requirements TEXT,                 -- 其它要求
  salary_min INTEGER,                -- 市场薪资下限（月薪，元）
  salary_max INTEGER,                -- 市场薪资上限（月薪，元）
  salary_note TEXT,                  -- 薪资说明，如「一线城市」「13 薪」
  sort_order INTEGER DEFAULT 0,      -- 级别排序（初级在前）
  created_at TEXT DEFAULT (datetime('now'))
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
  status TEXT NOT NULL DEFAULT 'pending',        -- pending 待审批 / approved 已通过转岗位 / rejected 已驳回 / closed 已关闭
  job_id TEXT,                                   -- 审批通过后生成的岗位 id
  reject_reason TEXT,                            -- 驳回原因
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

-- 索引
CREATE INDEX IF NOT EXISTS idx_talents_owner ON talents(owner_id);
CREATE INDEX IF NOT EXISTS idx_talent_social_talent ON talent_social(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_social_owner ON talent_social(owner_id);
CREATE INDEX IF NOT EXISTS idx_talents_status ON talents(status);
CREATE INDEX IF NOT EXISTS idx_communications_talent ON communications(talent_id);
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
CREATE INDEX IF NOT EXISTS idx_match_profile_levels_profile ON match_profile_levels(profile_id);
CREATE INDEX IF NOT EXISTS idx_contract_files_talent ON contract_files(talent_id);
CREATE INDEX IF NOT EXISTS idx_interviews_talent_job ON interviews(talent_job_id);
CREATE INDEX IF NOT EXISTS idx_interviews_owner ON interviews(owner_id);
CREATE INDEX IF NOT EXISTS idx_interviews_scheduled ON interviews(scheduled_at);
