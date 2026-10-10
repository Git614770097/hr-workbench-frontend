// worker 侧通用小工具（此前每个路由文件都各写一份 genId）
export function genId(): string { return crypto.randomUUID(); }

/**
 * Edge Cache：对高频只读接口做 Workers Cache API 缓存，降低 D1 冷启动影响。
 *
 * 原理：Cloudflare Workers 的 caches.default 是每个边缘节点的本地缓存（免费、零依赖），
 * 首次请求冷启动 D1 查询慢，结果缓存后后续请求直接命中缓存、不碰 D1。
 * TTL 由 Cache-Control max-age 控制，过期后自动失效重新回源。
 *
 * @param ctx      Workers 执行上下文（c.executionCtx），用于 waitUntil 异步写缓存
 * @param cacheKey 缓存 key，必须包含 owner/role 等隔离维度，确保多租户不串数据
 * @param ttl      缓存有效期（秒）
 * @param fn       回源查询函数，仅在缓存未命中时执行
 */
export async function cachedJson<T>(
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  cacheKey: string,
  ttl: number,
  fn: () => Promise<T>
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = await cache.match(new Request(cacheKey));
  if (cached) return cached;

  const data = await fn();
  const resp = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${ttl}`,
    },
  });
  // 异步写入缓存，不阻塞当前响应
  ctx.waitUntil(cache.put(new Request(cacheKey), resp.clone()));
  return resp;
}

/** 失效指定缓存 key（写操作后调用，确保数据变更立即生效） */
export async function invalidateCache(cacheKey: string): Promise<void> {
  try {
    const cache = (caches as unknown as { default: Cache }).default;
    await cache.delete(new Request(cacheKey));
  } catch {
    // 缓存删除失败不影响主流程
  }
}
