#!/usr/bin/env node
/**
 * 本地种子脚本：等待 wrangler pages dev 就绪 → 初始化站长 → 导入历史数据 JSON。
 *
 * 用法：
 *   npm run seed                       # 使用默认数据文件（根目录 算法雷达站数据*.json / data.json）
 *   SEED_BASE=http://127.0.0.1:8788 npm run seed
 *   SEED_OWNER_USER=你的用户名 SEED_OWNER_PASSWORD=至少8位 npm run seed
 *
 * 站长口令从环境变量读取（不写入任何源码）；未提供时随机生成并只在终端打印一次。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.SEED_BASE || "http://127.0.0.1:8788";
const OWNER_USER = process.env.SEED_OWNER_USER || "TanPowasd";
const OWNER_NICKNAME = process.env.SEED_OWNER_NICKNAME || OWNER_USER;
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD || randomBytes(9).toString("base64url") + "aA1";

function findDataFile() {
    if (process.env.SEED_FILE) return process.env.SEED_FILE;
    const candidates = ["data.json"];
    for (const name of readdirSync(ROOT).sort()) {
        if (name.startsWith("算法雷达站数据") && name.toLowerCase().endsWith(".json")) candidates.push(name);
    }
    for (const name of candidates) {
        const p = join(ROOT, name);
        if (existsSync(p)) return p;
    }
    return null;
}

// 简易 Cookie 罐（radar_csrf + radar_session 双 Cookie 跟随）
const jar = new Map();

function takeCookies(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of list) {
        const pair = line.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
}

function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function api(path, { method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (jar.size) headers["Cookie"] = cookieHeader();
    if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = jar.get("radar_csrf") || "";
    const res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    takeCookies(res);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
    return { status: res.status, data };
}

async function waitServer() {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(BASE + "/api/ping", { signal: AbortSignal.timeout(2000) });
            if (res.ok) return true;
        } catch { /* 未就绪继续等 */ }
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

async function main() {
    console.log(`等待本地服务 ${BASE} ...`);
    if (!(await waitServer())) {
        console.error("服务未就绪。请先启动：npm run dev（另开终端）");
        process.exit(1);
    }
    console.log("服务已就绪 ✓");

    // 1) 初始化站长（若未配置）；已配置则尝试登录
    let session = await api("/api/session");
    if (session.data.configured) {
        console.log("站长账号已存在，尝试登录 ...");
        const login = await api("/api/login", { method: "POST", body: { username: OWNER_USER, password: OWNER_PASSWORD } });
        if (login.status !== 200) {
            console.error(`登录失败：${login.data.error || "?"}`);
            console.error("提示：库中已有账号但口令与 SEED_OWNER_PASSWORD 不符。可删除 .wrangler/state 重置后重新 seed。");
            process.exit(1);
        }
    } else {
        const setup = await api("/api/setup", {
            method: "POST",
            body: { username: OWNER_USER, nickname: OWNER_NICKNAME, password: OWNER_PASSWORD },
        });
        if (setup.status !== 200) {
            console.error(`初始化站长失败：${setup.data.error || "?"}`);
            process.exit(1);
        }
        console.log(`站长已创建：${OWNER_USER}（昵称：${OWNER_NICKNAME}）`);
        console.log(`站长口令（仅本次打印，请妥善保存）：${OWNER_PASSWORD}`);
    }

    // 2) 导入历史数据
    const file = findDataFile();
    if (!file) {
        console.log("未找到历史数据 JSON（根目录 算法雷达站数据*.json / data.json），跳过导入。");
        return;
    }
    const bundle = JSON.parse(readFileSync(file, "utf-8"));
    const mode = process.env.SEED_MODE || "replace";
    const imported = await api("/api/import", { method: "POST", body: { mode, data: bundle } });
    if (imported.status !== 200) {
        console.error(`导入失败：${imported.data.error || "?"}`);
        process.exit(1);
    }
    console.log(`已从 ${file.split(/[\\/]/).pop()} 导入 ${imported.data.imported} 条测评记录（mode=${mode}）✓`);

    // 3) 验证
    const check = await api("/api/data");
    console.log(`当前游客可见：records=${(check.data.records || []).length} problems=${Object.keys(check.data.problems || {}).length} revision=${check.data.revision}`);
    console.log("种子完成 ✓");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
