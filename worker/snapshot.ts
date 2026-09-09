/**
 * 数据快照：把全库（记录/题目/模型）序列化为 JSON 存入 R2。
 * 每天一个 key（snapshots/<日期>/rev-<revision>.json）+ 固定 latest.json；
 * 保留期 90 天，过期对象在每次快照后顺手清理。R2 免费额度 10GB，每日 ~100KB 远低于限额。
 */
import type { Env } from "./router";
import * as store from "./store";

const RETENTION_DAYS = 90;

export function snapshotDate(now = new Date()): string {
    return now.toISOString().slice(0, 10);
}

/** 手动触发（POST /api/admin/snapshot）与 Cron 共用；未配置 R2 绑定时抛错（本地 dev 仍可用模拟桶）。
 *  `cleanup: false` 只写快照，把 90 天过期清理交给调用方 waitUntil —— 手动触发不必等分页删除。 */
export async function runSnapshot(
    env: Env,
    now = new Date(),
    opts: { cleanup?: boolean } = {},
): Promise<{ key: string; revision: number }> {
    const bucket = env.SNAPSHOT_BUCKET;
    if (!bucket) throw new Error("未配置 SNAPSHOT_BUCKET（R2）绑定");
    const snap = await store.exportBundle(env.DB);
    const body = JSON.stringify({
        app: "AI vs 洛谷", version: 3, scope: "snapshot",
        exportedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        revision: snap.revision, updatedAt: snap.updatedAt,
        records: snap.records, problems: snap.problems, models: snap.models,
    });
    const key = `snapshots/${snapshotDate(now)}/rev-${snap.revision}.json`;
    await bucket.put(key, body);
    await bucket.put("snapshots/latest.json", body);
    if (opts.cleanup !== false) await cleanupExpired(bucket);
    return { key, revision: snap.revision };
}

/** 清理超过保留期的按天快照（latest.json 与当日对象不受影响）。
 *  旧实现逐条 `await bucket.delete(key)`；R2 支持批量删除，一次最多 1000 个 key。 */
export async function cleanupExpired(bucket: R2Bucket): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    let cursor: string | undefined;
    try {
        do {
            const page = await bucket.list({ prefix: "snapshots/", cursor });
            const doomed: string[] = [];
            for (const obj of page.objects) {
                const m = obj.key.match(/^snapshots\/(\d{4}-\d{2}-\d{2})\//);
                if (m && Date.parse(`${m[1]}T00:00:00Z`) < cutoff) doomed.push(obj.key);
            }
            for (let i = 0; i < doomed.length; i += 1000) {
                await bucket.delete(doomed.slice(i, i + 1000));
            }
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
    } catch (e) {
        // 清理失败不影响快照本身
        console.warn("[snapshot] 过期清理失败：", e instanceof Error ? e.message : e);
    }
}
