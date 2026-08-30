// Cloudflare Pages Function: /api/sync
// 多设备数据同步：代理读写 JSONBin（环境变量 JSONBIN_API_KEY / JSONBIN_BIN_ID）
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestGet(context) {
  const { JSONBIN_API_KEY, JSONBIN_BIN_ID } = context.env;
  if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) {
    return new Response(JSON.stringify({ error: "sync not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  }
  try {
    const resp = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_API_KEY, Accept: "application/json" },
    });
    if (!resp.ok) throw new Error("jsonbin read " + resp.status);
    const data = await resp.json();
    return new Response(JSON.stringify(data.record || {}), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "sync failed: " + e.message }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  }
}

export async function onRequestPost(context) {
  const { JSONBIN_API_KEY, JSONBIN_BIN_ID } = context.env;
  if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) {
    return new Response(JSON.stringify({ error: "sync not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  }
  try {
    const payload = await context.request.text();
    const resp = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
      method: "PUT",
      headers: {
        "X-Master-Key": JSONBIN_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: payload,
    });
    if (!resp.ok) throw new Error("jsonbin write " + resp.status);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "sync failed: " + e.message }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors });
}
