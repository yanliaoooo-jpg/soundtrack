/**
 * 声轨 SoundTrace — 后端 Worker v3（无需 R2、无需付款）
 *   路径 A：贴平台链接（YouTube/抖音/B站）自动识别
 *   路径 B：上传本地文件 → Worker 直接转发给 ACRCloud 识别（≤100MB；大文件浏览器先提音频压小）
 *
 * ┌─ Cloudflare 只需配置两个变量（不需要 R2）：
 * │     ACR_TOKEN         ACRCloud Console API Personal Access Token（Bearer）
 * │     ACR_CONTAINER_ID  File Scanning 容器 ID（如 32651）
 * │     ALLOW_ORIGIN      （可选）允许的前端域名，默认 *
 * └─
 *
 * 路由：
 *   POST /scan        {url}                          → {fileId}      平台链接/直链识别
 *   POST /upload-scan （二进制body，头 X-Filename）   → {fileId}      上传文件直接识别
 *   GET  /result?fileId=123                          → {state,songs} 查询结果
 *
 * ⚠️ ACRCloud 接口字段以官方文档为准：https://docs.acrcloud.com/reference/console-api/file-scanning
 */

const ACR_API = "https://api-v2.acrcloud.com";

export default {
  async fetch(request, env) {
    const allow = env.ALLOW_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Filename",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (!env.ACR_TOKEN || !env.ACR_CONTAINER_ID) {
      return json({ error: "服务端未配置 ACR_TOKEN / ACR_CONTAINER_ID" }, 500);
    }
    const u = new URL(request.url);
    const cid = env.ACR_CONTAINER_ID;
    const auth = { Authorization: `Bearer ${env.ACR_TOKEN}` };
    const createUrl = `${ACR_API}/api/fs-containers/${cid}/files`;

    const pickId = (data) => data?.data?.id ?? data?.id ?? data?.file_id;

    try {
      // ---- 路径A：链接识别 ----
      if (request.method === "POST" && u.pathname === "/scan") {
        const body = await request.json().catch(() => ({}));
        const videoUrl = (body.url || "").trim();
        if (!videoUrl) return json({ error: "缺少 url" }, 400);
        const isPlatform = /(youtube\.com|youtu\.be|tiktok\.com|douyin\.com|bilibili\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|vimeo\.com)/i.test(videoUrl);
        const data_type = isPlatform ? "platforms" : "audio_url";
        const r = await fetch(createUrl, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ data_type, url: videoUrl }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "创建扫描任务失败", status: r.status, detail: data }, 200);
        const fileId = pickId(data);
        if (!fileId) return json({ error: "未拿到 fileId", detail: data }, 502);
        return json({ fileId });
      }

      // ---- 路径B：上传文件直接转发给 ACRCloud（multipart, data_type=audio） ----
      if (request.method === "POST" && u.pathname === "/upload-scan") {
        const name = decodeURIComponent(request.headers.get("X-Filename") || "audio");
        const ct = request.headers.get("Content-Type") || "application/octet-stream";
        const bytes = await request.arrayBuffer();
        const form = new FormData();
        form.append("data_type", "audio");
        form.append("name", name);
        form.append("file", new Blob([bytes], { type: ct }), name);
        const r = await fetch(createUrl, { method: "POST", headers: auth, body: form });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "上传识别失败", status: r.status, detail: data }, 200);
        const fileId = pickId(data);
        if (!fileId) return json({ error: "未拿到 fileId", detail: data }, 502);
        return json({ fileId });
      }

      // ---- 查询结果 ----
      if (request.method === "GET" && u.pathname === "/result") {
        const fileId = u.searchParams.get("fileId");
        if (!fileId) return json({ error: "缺少 fileId" }, 400);
        const r = await fetch(`${createUrl}/${fileId}`, { headers: auth });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "查询失败", detail: data }, r.status);
        const file = data?.data ?? data;
        const state = normState(file?.state);
        const songs = state === "ready" ? parseResults(file) : [];
        return json({ state, songs, rawState: file?.state });
      }

      return json({ error: "未知路由" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};

function normState(s) {
  if (s === 1 || s === "1" || s === "ready" || s === "done") return "ready";
  if (s === -1 || s === "error" || s === "failed") return "error";
  return "processing";
}

function parseResults(file) {
  const out = [];
  let items = file?.results || file?.result || file?.data?.results || [];
  if (!Array.isArray(items)) {
    items = [].concat(file?.results?.music || []).concat(file?.results?.cover_songs || []);
  }
  for (const it of items) {
    const startMs =
      it.db_begin_time_offset_ms ?? it.sample_begin_time_offset_ms ?? it.play_offset_ms ??
      (it.offset != null ? it.offset * 1000 : null);
    const endMs =
      it.db_end_time_offset_ms ?? it.sample_end_time_offset_ms ??
      (startMs != null && it.played_duration_ms != null ? startMs + it.played_duration_ms : null);
    const meta = it.result?.music?.[0] || it.music?.[0] || it.result || it;
    const title = meta?.title || meta?.name;
    if (title == null) continue;
    const artist =
      (meta?.artists || meta?.artist || []).map?.((a) => a.name || a).join(" / ") || meta?.artists_name || "";
    out.push({
      start: startMs != null ? Math.round(startMs / 1000) : 0,
      end: endMs != null ? Math.round(endMs / 1000) : null,
      title: String(title),
      artist: String(artist || ""),
    });
  }
  if (out.length === 0) console.log("PARSE_EMPTY_RAW", JSON.stringify(file).slice(0, 4000));
  out.sort((a, b) => a.start - b.start);
  return out;
}
