// Margins AI function (Supabase Edge Function "smart-task"). Reference copy of the deployed code.
// The OpenRouter key lives only in Supabase secrets (OPENROUTER_API_KEY); it never reaches the browser or GitHub.
// "Verify JWT" is off in the dashboard; this code checks sign-in itself by calling use_ai_call() with the caller's token.

const ALLOWED_ORIGINS = [
  "https://building-with-ai-f26.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];
const DAILY_LIMIT = 30;
const MAX_PROMPT = 90_000; // characters
const MODEL = "openai/gpt-4o-mini";

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const ok = ALLOWED_ORIGINS.includes(origin);
  const headers = { ...(ok ? cors(origin) : {}), "Content-Type": "application/json" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

  if (req.method === "OPTIONS") return new Response(ok ? "ok" : null, { status: ok ? 200 : 403, headers });
  if (origin && !ok) return reply(403, { error: "This site isn't allowed to use Margins AI." });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  // 1. Signed in? Count the call against today's limit.
  const auth = req.headers.get("authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  if (!auth.startsWith("Bearer ") || !apikey) return reply(401, { error: "Please sign in again to use AI." });
  const rpc = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/use_ai_call`, {
    method: "POST",
    headers: { Authorization: auth, apikey, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!rpc.ok) return reply(401, { error: "Please sign in again to use AI." });
  const used = Number(await rpc.json());
  if (used > DAILY_LIMIT) return reply(429, { error: `You've used today's ${DAILY_LIMIT} AI requests. They reset tomorrow; the free rule checks still work.` });

  // 2. Check the request.
  let prompt = "";
  try { prompt = String((await req.json()).prompt ?? ""); } catch { /* bad JSON */ }
  if (!prompt.trim()) return reply(400, { error: "Nothing to review." });
  if (prompt.length > MAX_PROMPT) return reply(413, { error: "This text is too long for one AI request. Review a few chapters at a time." });

  // 3. Ask the model.
  const t0 = Date.now();
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.2, usage: { include: true } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return reply(502, { error: "The AI service didn't answer. Try again in a minute." });
  return reply(200, {
    text: d.choices?.[0]?.message?.content ?? "",
    model: d.model ?? MODEL,
    tokens_in: d.usage?.prompt_tokens ?? null,
    tokens_out: d.usage?.completion_tokens ?? null,
    cost_usd: d.usage?.cost ?? null,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    used,
    limit: DAILY_LIMIT,
  });
});
