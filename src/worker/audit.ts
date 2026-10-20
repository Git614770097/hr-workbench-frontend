// 操作审计：写入审计日志（fire-and-forget，失败不影响主流程）。
//
// 为什么单独一个文件：所有埋点入口（中间件自动记写操作 + 敏感读操作显式调用）
// 都走这里，避免散进各路由漏写。
//
// 设计取舍：
//  - 不依赖事务、不阻塞响应——直接 await 写一条（D1 写入成本极低）；
//    若日后请求量上来，可改用 c.executionCtx.waitUntil 异步化。
//  - session 可能为 null（登录/注册等尚无会话的操作），此时 user_id/user_name 落空，
//    但 role/action/target 仍能暴露「发生了什么」。
//  - detail 统一 JSON 化，前端按 action 决定展示方式（如 update 展示改了哪些字段）。

import type { Env } from "./index";
import type { SessionInfo } from "./routes/auth";

export interface AuditInput {
  /** 操作类型：create/update/delete/view/export/login/logout/grant/verify/approve/reset */
  action: string;
  /** 对象类型：talent/job/contract/resume/bgcheck/user/role/template/system */
  targetType: string;
  /** 对象 id（有则填） */
  targetId?: string | null;
  /** 对象名称（如候选人姓名、岗位名）——方便人读，可选 */
  targetName?: string | null;
  /** 补充上下文，任意结构，会被 JSON 化 */
  detail?: unknown;
  /** 请求 IP（中间件从 cf-connecting-ip 取） */
  ip?: string;
  /** 请求 UA */
  ua?: string;
}

export async function writeAudit(
  env: Env,
  session: SessionInfo | null,
  input: AuditInput
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, ts, user_id, user_name, role, action, target_type, target_id, target_name, detail, ip, ua)
       VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        session?.userId ?? null,
        session?.name ?? null,
        session?.role ?? null,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.targetName ?? null,
        input.detail == null ? null : JSON.stringify(input.detail),
        input.ip ?? "",
        input.ua ?? ""
      )
      .run();
  } catch {
    // 审计写失败不影响主流程
  }
}
