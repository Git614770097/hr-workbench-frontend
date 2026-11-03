-- 出生日期成为「年龄」的唯一事实源
--
-- 原来 age 是一个独立存储的整数。问题有两层：
--   1. 简历里常写「28 岁」而不是生日，录进去的是快照，跨年就是错的；
--   2. 有些人只写「1996 年」，没有月日，算年龄需要按当年 1 月 1 日近似。
-- 所以补一列精度标记，让 UI 能诚实地显示「28 岁（据年龄推算）」而不是假装精确。
--
-- 历史数据反推：有 age 无 birth_date 的，按「今年 - age 年的 1 月 1 日」补上，
-- 精度标 estimated。误差最多 1 年（生日在补的那天之后），但比留空强——
-- 留空会导致这批人永远筛不进「25-30 岁」，而反推后至少量级正确。

ALTER TABLE talents ADD COLUMN birth_date_precision TEXT;

UPDATE talents
SET birth_date = printf(
      '%04d-01-01',
      CAST(strftime('%Y', 'now') AS INTEGER) - age
    ),
    birth_date_precision = 'estimated'
WHERE (birth_date IS NULL OR birth_date = '')
  AND age IS NOT NULL
  AND age BETWEEN 16 AND 80;
