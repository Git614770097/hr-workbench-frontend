-- 人才库批量打标签：talents 表新增 tags 字段（JSON 数组，与 skills 同风格）
-- 存量数据默认 '[]'，不影响现有查询与列表渲染。
ALTER TABLE talents ADD COLUMN tags TEXT DEFAULT '[]';
