// Cloudflare Pages Function: /api/ping
// 健康检查：前端 checkServer() 用它判断服务可用
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestGet() {
  return new Response(JSON.stringify({
    ok: true,
    app: "算法雷达站",
    time: new Date().toISOString().slice(0, 19).replace("T", " "),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors });
}
