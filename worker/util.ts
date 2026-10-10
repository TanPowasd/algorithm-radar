/**
 * 共享类型与白名单清洗（store.py → TS 移植）。
 * TS 里 undefined 等价于旧实现的 MissingNode：一律按缺省值处理。
 */

export interface Sub {
    score: number | null;
    result: string;
    note: string;
    /** v2：本轮洛谷实测时间消耗（ms）。老数据/老表单没有这一项 */
    timeMs?: number | null;
    /** v2：本轮内存使用量（MB）。老数据/老表单没有这一项 */
    memoryMb?: number | null;
}

export interface Rec {
    id: string;
    model: string;
    variant: string;
    agent: string;
    tokenSource: string;
    pid: string;
    title: string;
    thinking: string;
    difficulty: number;
    categories: string[];
    submissions: Sub[];
    minutes: number | null;
    memory: number | null;
    date: string;
    note: string;
    status: string;
    author: string;
    /** 提供者（提交人）用户 id；历史导入数据可能为 null */
    authorId: number | null;
    /** 审核人用户 id（批准该记录的管理员/站长） */
    reviewerId: number | null;
    reviewedAt: string | null;
    /** 软删除时间（回收站）；null = 未删除 */
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ProblemEntry {
    pid: string;
    title: string;
    difficulty: number | null;
    tags: string[];
    categories: string[];
    manual: boolean;
    /** 推荐提示词：管理员为该题配置的统一测试提示词（空 = 用前端拼装的标准模板） */
    prompt: string;
    /** 题面 markdown（抓取自洛谷或管理员手动维护；标准模板会原样嵌入） */
    content: string;
    /** compact 快照省略题面，用此标记区分未加载与确实没有题面。 */
    hasContent?: boolean;
    /** 时间限制（ms）；未知为 null */
    timeLimit: number | null;
    /** 内存限制（MB）；未知为 null */
    memoryLimit: number | null;
    /** 洛谷题目页是否存在附件（复制提示词后前端据此弹下载提醒） */
    hasAttachments: boolean;
    fetchedAt: string;
}

export interface UserRow {
    id: number;
    username: string;
    nickname: string;
    password_hash: string;
    role: string;
    status: string;
    created_at: string;
    approved_at: string | null;
    approved_by: string | null;
}

export const RESULTS = ["AC", "WA", "TLE", "MLE", "RE", "CE", "未解出"] as const;
export const THINKING_LEVELS = ["ultra", "max", "xhigh", "high", "medium", "low", "off"] as const;
export const DEFAULT_THINKING = "max";
export const STATUSES = ["approved", "pending"] as const;
export const DIFFICULTY_NAMES: Record<number, string> = {
    0: "暂无评定", 1: "入门", 2: "普及−", 3: "普及/提高−",
    4: "普及+/提高", 5: "提高+/省选−", 6: "省选/NOI−", 7: "NOI/NOI+/CTSC",
};

export const PID_RE = /^[A-Z]{1,3}_?[A-Z0-9_]{2,20}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_MODEL = 80, MAX_VARIANT = 80, MAX_AGENT = 120, MAX_TOKEN_SOURCE = 120;
export const MAX_TITLE = 200, MAX_NOTE = 1000, MAX_SUB_NOTE = 300, MAX_CATEGORY = 40;
export const MAX_CATEGORIES = 12, MAX_SUBMISSIONS = 40, MAX_RECORDS = 20000, MAX_PROBLEMS = 20000;
export const MAX_TAGS = 30;
/** 题面 markdown 上限（洛谷完整题面含图片链接通常 2–30KB，留足余量） */
export const MAX_CONTENT = 100_000;

export class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export const badRequest = (m: string) => new ApiError(400, m);
export const unauthorized = (m: string) => new ApiError(401, m);
export const forbidden = (m: string) => new ApiError(403, m);
export const notFound = (m: string) => new ApiError(404, m);
export const tooMany = (m: string) => new ApiError(429, m);
export const upstream = (m: string) => new ApiError(502, m);

export function text(value: unknown, limit: number, label: string): string {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" && typeof value !== "number") {
        throw badRequest(`${label} 类型不正确`);
    }
    const s = String(value).replace(/\0/g, "").trim();
    if (label === "题目名称" && s.includes("\uFFFD")) {
        throw badRequest("题目名称包含无效编码字符，请使用 UTF-8 编码后重新提交");
    }
    if (s.length > limit) throw badRequest(`${label} 过长（上限 ${limit} 字）`);
    return s;
}

export function intOrNull(value: unknown, lo: number, hi: number, label: string): number | null {
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        return null;
    }
    const n = Math.round(Number(value));
    if (Number.isNaN(n)) throw badRequest(`${label} 必须是数字`);
    if (n < lo || n > hi) throw badRequest(`${label} 超出范围（${lo}–${hi}）`);
    return n;
}

/** 同 intOrNull，但保留小数（内存这类支持浮点的字段）；精度截到 3 位小数 */
export function numOrNull(value: unknown, lo: number, hi: number, label: string): number | null {
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw badRequest(`${label} 必须是数字`);
    if (n < lo || n > hi) throw badRequest(`${label} 超出范围（${lo}–${hi}）`);
    return Math.round(n * 1000) / 1000;
}

export function nameList(value: unknown, maxCount: number, maxLen: number, label: string): string[] {
    const out: string[] = [];
    if (value === undefined || value === null) return out;
    if (!Array.isArray(value)) throw badRequest(`${label} 格式不正确`);
    const seen = new Set<string>();
    for (const item of value.slice(0, maxCount)) {
        const name = text(item, maxLen, label);
        if (name && !seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    }
    return out;
}

export function nowIso(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function nowLocal(): string {
    // Workers 环境无本地时区，统一 UTC 的「YYYY-MM-DD HH:MM:SS」
    return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export function today(): string {
    return new Date().toISOString().slice(0, 10);
}

export function sanitizeSubmission(raw: any): Sub {
    if (!raw || typeof raw !== "object") throw badRequest("提交轮次格式不正确");
    const result = text(raw.result, 20, "提交结果");
    if (!(RESULTS as readonly string[]).includes(result)) {
        throw badRequest(`提交结果必须是 ${RESULTS.join("/")} 之一`);
    }
    const sub: Sub = {
        score: intOrNull(raw.score, 0, 100, "得分"),
        result,
        note: text(raw.note, MAX_SUB_NOTE, "提交说明"),
    };
    // v2：每轮的时间消耗(ms)/内存使用量(MB)。给了就必须 >0，否则 400；
    // 时间 = 整数毫秒，内存 = 支持小数（MB，服务端截到 3 位小数）。
    // 不提供时保持缺省（老版表单不带这两项，行为完全不变）。
    if (raw.timeMs !== undefined && raw.timeMs !== null) {
        const t = intOrNull(raw.timeMs, 1, 3600000, "时间消耗(ms)");
        if (t === null) throw badRequest("时间消耗（ms）必填，且必须大于 0");
        sub.timeMs = t;
    }
    if (raw.memoryMb !== undefined && raw.memoryMb !== null) {
        const m = numOrNull(raw.memoryMb, 0.001, 1048576, "内存使用量(MB)");
        if (m === null) throw badRequest("内存使用量（MB）必填，且必须大于 0");
        sub.memoryMb = m;
    }
    return sub;
}

/** 把前端传入的记录清洗为白名单结构。existing 非空表示更新（保留 id/创建时间/作者） */
export function sanitizeRecord(raw: any, existing?: Partial<Rec> | null, status?: string): Rec {
    if (!raw || typeof raw !== "object") throw badRequest("记录格式不正确");
    const model = text(raw.model, MAX_MODEL, "AI 名称");
    if (!model) throw badRequest("请填写 AI 名称");
    const pid = text(raw.pid, 24, "题号").toUpperCase();
    if (!PID_RE.test(pid)) throw badRequest("题号格式不正确（示例：P1001 / B2001 / CF10A）");
    const difficulty = intOrNull(raw.difficulty, 0, 7, "难度");
    if (difficulty === null) throw badRequest("请选择难度");
    if (!Array.isArray(raw.submissions) || raw.submissions.length === 0) {
        throw badRequest("至少需要一次提交记录");
    }
    if (raw.submissions.length > MAX_SUBMISSIONS) {
        throw badRequest(`提交轮次过多（上限 ${MAX_SUBMISSIONS} 次）`);
    }
    const submissions = raw.submissions.map(sanitizeSubmission);

    let date = text(raw.date, 10, "日期") || today();
    if (!DATE_RE.test(date)) throw badRequest("日期格式必须是 YYYY-MM-DD");
    let thinking = typeof raw.thinking === "string" ? raw.thinking : DEFAULT_THINKING;
    if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) thinking = DEFAULT_THINKING;

    const st = status && (STATUSES as readonly string[]).includes(status)
        ? status
        : (existing?.status ?? "pending");

    return {
        id: existing?.id || crypto.randomUUID().replace(/-/g, "").slice(0, 16),
        model,
        variant: text(raw.variant, MAX_VARIANT, "版本/策略"),
        agent: text(raw.agent, MAX_AGENT, "Agent"),
        tokenSource: text(raw.tokenSource, MAX_TOKEN_SOURCE, "Token 来源"),
        pid,
        title: text(raw.title, MAX_TITLE, "题目名称"),
        thinking,
        difficulty,
        categories: nameList(raw.categories, MAX_CATEGORIES, MAX_CATEGORY, "算法类别"),
        submissions,
        minutes: intOrNull(raw.minutes, 0, 100000, "用时"),
        memory: numOrNull(raw.memory, 0, 1000000, "内存"),
        date,
        note: text(raw.note, MAX_NOTE, "备注"),
        status: st,
        author: existing?.author ?? "",
        authorId: existing?.authorId ?? null,
        reviewerId: existing?.reviewerId ?? null,
        reviewedAt: existing?.reviewedAt ?? null,
        // 回收站记录恢复/重导入时：清空软删除标记
        deletedAt: existing?.deletedAt ?? null,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
    };
}

export function sanitizeProblem(pidRaw: unknown, raw: any): ProblemEntry | null {
    const pid = String(pidRaw ?? "").trim().toUpperCase();
    if (pid.length > 24 || !PID_RE.test(pid) || !raw || typeof raw !== "object") return null;
    const difficulty = intOrNull(raw.difficulty, 0, 7, "难度");
    return {
        pid,
        title: text(raw.title, MAX_TITLE, "题目名称"),
        difficulty,
        tags: nameList(raw.tags, MAX_TAGS, MAX_CATEGORY, "标签"),
        categories: nameList(raw.categories, MAX_CATEGORIES, MAX_CATEGORY, "算法类别"),
        manual: Boolean(raw.manual),
        prompt: text(raw.prompt, 4000, "推荐提示词"),
        content: text(raw.content, MAX_CONTENT, "题面内容"),
        timeLimit: intOrNull(raw.timeLimit, 1, 86_400_000, "时间限制"),
        memoryLimit: intOrNull(raw.memoryLimit, 1, 1_048_576, "内存限制"),
        hasAttachments: Boolean(raw.hasAttachments),
        fetchedAt: text(raw.fetchedAt, 40, "抓取时间"),
    };
}

/** 兼容旧数据（数字 id / 无 submissions / 无 status），失败返回 null 而不是整体报错 */
export function migrateRecord(raw: any): Rec | null {
    if (!raw || typeof raw !== "object") return null;
    const data: any = { ...raw };
    if (!Array.isArray(data.submissions) || data.submissions.length === 0) {
        const legacy = typeof data.result === "string" ? data.result : "";
        data.submissions = [{
            score: legacy === "AC" ? 100 : null,
            result: (RESULTS as readonly string[]).includes(legacy) ? legacy : "未解出",
            note: "",
        }];
    }
    if (data.difficulty === undefined || data.difficulty === null) data.difficulty = 0;
    const status = (STATUSES as readonly string[]).includes(data.status) ? data.status : "approved";
    const author = typeof data.author === "string" && data.author ? data.author : "admin";
    const existing: Partial<Rec> = {
        id: data.id === undefined || data.id === null || String(data.id).trim() === ""
            ? undefined
            : text(data.id, 40, "id"),
        status,
        author,
        createdAt: text(data.createdAt, 40, "创建时间") || undefined,
    };
    try {
        const rec = sanitizeRecord(data, existing, status);
        const updatedAt = text(data.updatedAt, 40, "更新时间");
        if (updatedAt) rec.updatedAt = updatedAt;
        return rec;
    } catch (e) {
        if (e instanceof ApiError) return null;
        throw e;
    }
}
