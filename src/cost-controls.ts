import type { Env } from "./env";

/**
 * 在数据库、鉴权和上游调用前使用 Cloudflare 原生限流，不引入 Durable Objects。
 * 绑定故障时返回 503；超过 IP/机房额度返回 429，避免故障导致防护失效。
 */
export async function limitRequest(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const login = path === "/api/login" || path === "/api/v1/admin/login";
  const api = path.startsWith("/api/") || path.startsWith("/v1/");
  const binding = login ? env.LOGIN_RATE_LIMIT : api ? env.API_RATE_LIMIT : env.READ_RATE_LIMIT;
  try {
    if (!binding) throw new Error("Rate limit binding missing");
    const key = request.headers.get("CF-Connecting-IP") || "unknown";
    if ((await binding.limit({ key })).success) return null;
    return Response.json({ error: { message: "Too many requests", code: "rate_limit_exceeded" } }, {
      status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("Rate limiter unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

/**
 * 为一条图片 WebSocket 连接分配 10 轮、120 秒的生成预算。
 * active 在上游调用完成后才释放，stop/start 不能制造重叠调用；失败也消耗轮数。
 * @param now 可注入的时钟，测试无需等待真实时间。
 */
export function createGenerationBudget(now: () => number = Date.now) {
  const deadline = now() + 120_000;
  let active = false;
  let remaining = 10;
  return {
    /** 开始一段生成循环；忙碌、轮数耗尽或剩余时间不足时拒绝。 */
    begin(): boolean {
      if (active || remaining <= 0 || deadline - now() < 10_000) return false;
      active = true;
      return true;
    },
    /** 先消耗一轮预算，再返回上游超时；0 表示必须停止。 */
    nextBatch(): number {
      const timeLeft = deadline - now();
      if (!active || remaining <= 0 || timeLeft < 10_000) return 0;
      remaining -= 1;
      return Math.min(60_000, timeLeft);
    },
    /** 仅在上游异步任务退出后释放执行权，不返还额度。 */
    finish(): void { active = false; },
  };
}
