// 腹ぱんぐらむ: shop search through the Hot Pepper Gourmet Web Service.
// The API key stays here as the secret HOTPEPPER_KEY; the page never sees it.
// Only signed-in users can call this (keep "Verify JWT" on).
const KEY = Deno.env.get("HOTPEPPER_KEY") ?? "";
const ORIGINS = ["https://ruikougyo.github.io", "http://localhost:8787"];
const API = "https://webservice.recruit.co.jp/hotpepper/gourmet/v1/";

function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "access-control-allow-origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "origin",
  };
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...h, "content-type": "application/json" } });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!KEY) return json({ error: "no_key" }, 503);
  // {q}: shop name ("ココス"), or name plus place words ("ココス 国領") searched as keywords
  // {lat, lng}: shops within about 1 km of that point, nearest first
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const params: Record<string, string> = { key: KEY, format: "json" };
  const lat = Number(body.lat), lng = Number(body.lng);
  if (body.lat != null && Number.isFinite(lat) && Number.isFinite(lng) && lat > 20 && lat < 46.5 && lng > 122 && lng < 154) {
    Object.assign(params, { lat: lat.toFixed(5), lng: lng.toFixed(5), range: "3", count: "15" });
  } else {
    const q = String(body.q ?? "").trim().replace(/\s+/g, " ");
    if (q.length < 2 || q.length > 40) return json({ shops: [] });
    Object.assign(params, q.includes(" ") ? { keyword: q, count: "20" } : { name_any: q, count: "8" });
  }
  const u = new URL(API);
  u.search = new URLSearchParams(params).toString();
  let d: Record<string, any>;
  try {
    const r = await fetch(u);
    if (!r.ok) return json({ error: "upstream", status: r.status }, 502);
    d = await r.json();
  } catch { return json({ error: "upstream" }, 502); }
  if (d?.results?.error) return json({ error: "upstream" }, 502);
  const shops = (d?.results?.shop ?? []).map((s: Record<string, any>) => ({
    id: s.id, name: s.name, kana: s.name_kana, address: s.address, lat: s.lat, lng: s.lng,
    open: s.open, genre: s.genre?.name, budget: s.budget?.average, url: s.urls?.pc,
  }));
  return json({ shops }, 200);
});
