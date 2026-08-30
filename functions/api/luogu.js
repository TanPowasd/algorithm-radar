// Cloudflare Pages Function: /api/luogu?pid=XXX
// 洛谷题目信息代抓（与 Vercel 版行为一致）
import { fetchLuoguProblem } from "./_lib.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const pid = url.searchParams.get("pid") || "";
  try {
    const info = await fetchLuoguProblem(pid, context.env);
    return new Response(JSON.stringify(info), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors });
}
