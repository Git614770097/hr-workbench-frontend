-- 人才录入方式标记：区分「手动录入 / 简历导入 / 平台同步」
-- manual = 网页端表单手动新增（默认）
-- import = 导入弹窗批量导入简历（后端写死，不依赖前端传值）
-- sync   = Chrome 插件从招聘平台同步（由插件显式传值）
ALTER TABLE talents ADD COLUMN entry_type TEXT DEFAULT 'manual';

-- 存量回填：插件会传 source='boss'，历史数据据此判定为平台同步
UPDATE talents SET entry_type = 'sync' WHERE source IN ('boss', 'BOSS直聘');

-- 顺带把 source 归一到字典标准值（插件早期写死 'boss'，列表里会显示成 boss）
UPDATE talents SET source = 'BOSS直聘' WHERE source = 'boss';
