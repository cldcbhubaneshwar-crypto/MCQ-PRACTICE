import { getStore } from "@netlify/blobs";
import questions from "./questions.json" with { type: "json" };

const store = () => getStore({ name: "quiz", consistency: "strong" });
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const pick = (st) => (st.ids || []).map((i) => questions[i]).filter(Boolean);
const adminPw = () => Netlify.env.get("ADMIN_PASSWORD");
const isAdmin = (req) => !!adminPw() && req.headers.get("x-admin") === adminPw();
const getState = async () => (await store().get("state", { type: "json" })) || { status: "waiting", endsAt: 0 };

export default async (req) => {
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const s = store();
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (route === "state") {
    const st = await getState();
    if (st.status === "running" && Date.now() > st.endsAt) st.status = "ended";
    return json({ status: st.status, endsAt: st.endsAt, now: Date.now(), total: (st.ids || []).length });
  }

  if (route === "join" && req.method === "POST") {
    const st = await getState();
    if (st.status !== "running" || Date.now() > st.endsAt) return json({ error: "Quiz is not open right now." }, 403);
    const name = String(body.name || "").trim().slice(0, 40);
    const ref = String(body.ref || "").trim().slice(0, 30);
    if (!name) return json({ error: "Enter your name." }, 400);
    const id = (ref || name).toLowerCase().replace(/[^a-z0-9]/g, "") ;
    if (!id) return json({ error: "Invalid name." }, 400);
    const existing = await s.get("res-" + id, { type: "json" });
    if (existing) return json({ error: "You already submitted. Use a different name/ID.", done: true }, 409);
    let joined = await s.get("join-" + id, { type: "json" });
    if (joined && joined.at < (st.startedAt || 0)) joined = null;
    if (!joined) await s.setJSON("join-" + id, { name, ref, at: Date.now() });
    return json({ id, name, startedAt: joined?.at || Date.now(),
      questions: pick(st).map(({ q, options, topic }) => ({ q, options, topic })) });
  }

  if (route === "submit" && req.method === "POST") {
    const st = await getState();
    if (st.status !== "running" || Date.now() > st.endsAt + 15000) return json({ error: "Quiz has ended." }, 403);
    const id = String(body.id || "");
    const joined = await s.get("join-" + id, { type: "json" });
    if (!joined || joined.at < (st.startedAt || 0)) return json({ error: "Not joined." }, 400);
    if (await s.get("res-" + id, { type: "json" })) return json({ error: "Already submitted." }, 409);
    const a = Array.isArray(body.answers) ? body.answers : [];
    const qs = pick(st);
    let score = 0;
    const byTopic = {};
    qs.forEach((q, i) => {
      const t = (byTopic[q.topic] ||= [0, 0]); t[1]++;
      if (a[i] === q.answer) { score++; t[0]++; }
    });
    const timeMs = Date.now() - joined.at;
    await s.setJSON("res-" + id, { id, name: joined.name, ref: joined.ref, score, total: qs.length, timeMs, byTopic });
    return json({ score, total: qs.length });
  }

  // ---- admin routes ----
  if (!adminPw()) return json({ error: "Admin password is not configured. Set ADMIN_PASSWORD in the Netlify environment variables and redeploy." }, 500);
  if (!isAdmin(req)) return json({ error: "Wrong admin password" }, 401);

  if (route === "admin/start") {
    const mins = Number(body.minutes) || 60;
    const want = Array.isArray(body.topics) && body.topics.length ? body.topics : null;
    const ids = [...questions.keys()].filter((i) => !want || want.includes(questions[i].topic));
    if (!ids.length) return json({ error: "No questions for the selected topics." }, 400);
    const count = Math.min(Number(body.count) || 50, ids.length);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    await s.setJSON("state", { status: "running", startedAt: Date.now(), endsAt: Date.now() + mins * 60000, ids: ids.slice(0, count) });
    return json({ ok: true });
  }
  if (route === "admin/topics") {
    const c = {};
    questions.forEach((q) => { c[q.topic] = (c[q.topic] || 0) + 1; });
    return json({ topics: Object.entries(c).map(([name, n]) => ({ name, n })) });
  }
  if (route === "admin/stop") {
    await s.setJSON("state", { status: "ended", endsAt: 0 });
    return json({ ok: true });
  }
  if (route === "admin/reset") {
    const { blobs } = await s.list();
    await Promise.all(blobs.map((b) => s.delete(b.key)));
    return json({ ok: true });
  }
  if (route === "admin/results") {
    const { blobs } = await s.list({ prefix: "res-" });
    const rows = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
    rows.sort((x, y) => y.score - x.score || x.timeMs - y.timeMs);
    const joined = (await s.list({ prefix: "join-" })).blobs.length;
    return json({ rows, joined });
  }
  return json({ error: "Not found" }, 404);
};

export const config = { path: "/api/*" };
