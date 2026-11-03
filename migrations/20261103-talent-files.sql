-- 人才附件（作品集 / 证书 / 其他材料）
--
-- 为什么不复用 talents.resume_url：那个字段是「简历主文件」，语义上只有一份，
-- 上传新简历时会先删掉旧的（见 POST /talents/resume）。作品集可能有多份，
-- 塞进去会互相覆盖。
--
-- 存储仍走 KV（RESUMES 命名空间）：附件限制 10MB，KV 单值上限 25MB，够用。
-- 如果以后要放视频，再换 R2——届时只需改 storage_key 的取值方式，表结构不变。

CREATE TABLE IF NOT EXISTS talent_files (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  kind TEXT DEFAULT 'other',   -- portfolio=作品集 / certificate=证书 / other=其他
  name TEXT NOT NULL,          -- 原始文件名（展示用）
  size INTEGER,                -- 字节数（前端据此提示大小）
  mime TEXT,                   -- MIME 类型（下载时回填 Content-Type）
  storage_key TEXT NOT NULL,   -- KV key: file:{talent_id}:{uuid}.{ext}
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_talent_files_talent ON talent_files(talent_id);
