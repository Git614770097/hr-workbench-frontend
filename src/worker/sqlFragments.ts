/**
 * 高频 SQL 片段常量。
 *
 * 为什么要有这个文件：全库 368 处 prepare 里，有一些 JOIN / 单表查询在不同路由里
 * 被逐字重复了十几次（例如 talent_jobs 关联 talents 就有 12 处）。它们本身不长，
 * 真正的风险是「改一处漏一处」——比如给 talent_jobs 加软删除标记时，只要有任何一个
 * 查询没带上条件，就会出现数据漏筛/多筛。
 *
 * 使用纪律（很重要）：
 *   ① 这里只放**不含任何用户输入**的静态片段；所有值一律走 bind 占位符，
 *      禁止把外部字符串拼进来（D1 是 SQLite，拼串就等于把注入面打开）。
 *   ② 别名是契约：tj = talent_jobs、t = talents、j = jobs、iv = interviews。
 *      引用这些常量的查询必须沿用同一套别名，否则 SQL 直接报错。
 *      （面试路由的 SELECT_SQL 是本仓库既有的同类先例，这里只是把它推广开。）
 */

/** talent_jobs(tj) 关联人才(t)：取人才字段必带 */
export const JOIN_TALENT_T = "JOIN talents t ON tj.talent_id = t.id";

/** talent_jobs(tj) 左关联岗位(j)：岗位可能为空（纯人才入库无投递），故用 LEFT JOIN */
export const LEFT_JOIN_JOB_J = "LEFT JOIN jobs j ON tj.job_id = j.id";

/** talent_jobs(tj) 左关联阶段日志(l)：取「曾到达」流转轨迹 */
export const LEFT_JOIN_STAGE_LOG_L = "LEFT JOIN job_stage_logs l ON l.talent_job_id = tj.id";

/**
 * 投递上下文查询：一次拿到「改阶段 + 写日志 + 联动入职」三件事所需的全部字段
 * （旧阶段、人才 id/姓名、岗位 id、数据归属人）。
 * 看板单卡流转、批量流转、系统自动推进、面试/审批联动都用它 —— 四处原本各写一份。
 */
export const SELECT_LINK_CTX =
  `SELECT tj.id, tj.stage as old_stage, tj.talent_id, tj.job_id, t.name as talent_name, t.owner_id
     FROM talent_jobs tj ${JOIN_TALENT_T} WHERE tj.id = ?`;

/** 只要归属人（权限校验用）：日志等只读接口不必拖出整份上下文 */
export const SELECT_LINK_OWNER =
  `SELECT tj.id, t.owner_id FROM talent_jobs tj ${JOIN_TALENT_T} WHERE tj.id = ?`;
