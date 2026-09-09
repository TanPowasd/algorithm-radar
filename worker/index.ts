/**
 * Worker 入口：/api/* 交路由处理，其余交给静态资产（ASSETS 兜底含 SPA 回退与 _headers/_redirects）。
 * Cron（每日 UTC 21:00）触发数据快照到 R2。
 */
import { handleApi, type Env } from "./router";
import { runSnapshot } from "./snapshot";

export default {
    async fetch(req, env, ctx): Promise<Response> {
        // pathname 大小写归一：否则 /API/data 会绕过 API 分支落到静态资产的 SPA 回退（返回 200 HTML）
        const { pathname } = new URL(req.url);
        if (pathname.toLowerCase() === "/api" || pathname.toLowerCase().startsWith("/api/")) {
            return handleApi(req, env, (task) => ctx.waitUntil(task));
        }
        return env.ASSETS.fetch(req);
    },
    async scheduled(_event, env, ctx): Promise<void> {
        ctx.waitUntil(
            runSnapshot(env)
                .then((r) => console.log(`[snapshot] 已写入 ${r.key}（revision ${r.revision}）`))
                .catch((e) => console.error("[snapshot] 失败：", e instanceof Error ? e.message : e)),
        );
    },
} satisfies ExportedHandler<Env>;
