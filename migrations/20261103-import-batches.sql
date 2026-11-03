-- 导入记录：让「上次那 20 份为什么只进来 13 份」有据可查。
--
-- 为什么必须建表而不能靠现有数据推：
-- 导入是纯前端编排的——每份简历单独调一次 /talents/import，解析失败、去重跳过、
-- 录入报错这些状态只活在 React state 里，弹窗一关就没了。audit_logs 只记「成功写入」
-- 的 talent，既不知道解析失败过几份，也没法把一次上传会话归成一个批次。
--
-- 计数不冗余存表头，一律从明细 GROUP BY 现算：表头与明细永远一致，不会出现
-- 「显示录入 13 份但详情里只有 11 行」这种对不上的情况。

CREATE TABLE IF NOT EXISTS import_batches (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  user_name   TEXT,
  -- 本批统一选择的来源渠道（弹窗里选一次应用到全批），未选为 NULL
  source      TEXT,
  -- 本批是否开启自动去重（1/0），回溯时能解释「为什么这 7 份被跳过」
  dedup       INTEGER NOT NULL DEFAULT 1,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- 批次结束时间：全部处理完 / 用户关闭弹窗时写入；中途关浏览器则留空
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_batches_user ON import_batches(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_import_batches_started ON import_batches(started_at);

-- 逐份明细：每个上传的文件一行，状态变化时原地 UPDATE，不追加历史版本。
-- status 四态覆盖「上传 N 份 = 录入 + 重复 + 失败 + 未处理」，四数相加恒等于上传数。
--   pending   已解析待处理（含用户主动移除 / 中途关闭弹窗）
--   imported  已录入人才库
--   duplicate 命中判重被跳过（不算失败，是有意的保护）
--   failed    解析失败或录入报错，原因在 error
CREATE TABLE IF NOT EXISTS import_batch_items (
  id           TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  file_name    TEXT,
  file_size    INTEGER,
  -- 录入成功后的 talent id。人才被删后这里会悬空，查询时 LEFT JOIN 判断是否还在
  talent_id    TEXT,
  talent_name  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  error        TEXT,
  -- 解析来源 ai / local。线上 AI 长期不可用时，这个字段是唯一的实测证据
  parse_source TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_items_batch ON import_batch_items(batch_id);
