// Vercel serverless function: POST /api/run
// action "start" -> signed run token
// action "claim" -> verifies the run, creates a single-use Whop promo code, returns it
const crypto = require("crypto");

const SECRET = process.env.GW_SECRET;
const KEY = process.env.WHOP_API_KEY;
const COMPANY = process.env.WHOP_COMPANY_ID; // biz_...
const PRODUCT = process.env.WHOP_PRODUCT_ID; // optional prod_... (limits codes to your product)
const CURRENCY = (process.env.WHOP_CURRENCY || "usd").toLowerCase();
const TTL_HOURS = Number(process.env.CODE_TTL_HOURS) || 24;
const PROMO_MONTHS = Number(process.env.PROMO_MONTHS) || 1;

// Keep in sync with CFG.tiers in index.html
const TIERS = [{ min: 100, pct: 5 }, { min: 350, pct: 10 }, { min: 800, pct: 20 }];
const MIN_RUN_MS = 20000;
const MAX_RUN_MS = 10 * 60 * 1000;

const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("hex");

// Same scoring as the game: 0 brick, 1 green, 2 perfect, 3 rim-out
function scoreOf(results) {
  let streak = 0, total = 0;
  for (const r of results) {
    const mult = Math.min(5, 1 + streak);
    if (r === 2) { total += 30 * mult; streak++; }
    else if (r === 1) { total += 20 * mult; streak++; }
    else if (r === 3) { total += 5; streak = 0; }
    else streak = 0;
  }
  return total;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const fail = (code, error) => res.status(code).json({ error });
  if (req.method !== "POST") return fail(405, "POST only");
  if (!SECRET || !KEY || !COMPANY) return fail(500, "Server not configured");

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  if (body.action === "start") {
    const payload = `${crypto.randomBytes(8).toString("hex")}.${Date.now()}`;
    return res.status(200).json({ token: `${payload}.${sign(payload)}` });
  }

  if (body.action === "claim") {
    const parts = String(body.token || "").split(".");
    if (parts.length !== 3) return fail(400, "bad token");
    const payload = `${parts[0]}.${parts[1]}`;
    const good = sign(payload);
    if (parts[2].length !== good.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(good))) return fail(400, "bad token");
    const age = Date.now() - Number(parts[1]);
    if (!(age >= MIN_RUN_MS && age <= MAX_RUN_MS)) return fail(400, "run too fast or too old");

    const results = body.results;
    if (!Array.isArray(results) || results.length !== 10 || !results.every((r) => Number.isInteger(r) && r >= 0 && r <= 3)) return fail(400, "bad results");

    const score = scoreOf(results);
    let tier = null;
    for (const t of TIERS) if (score >= t.min) tier = t;
    if (!tier) return res.status(200).json({ score, code: null });

    // Deterministic per run: replaying the same token can't mint a second, different code
    const code = `DP${tier.pct}-${sign(`${payload}:${tier.pct}`).slice(0, 6).toUpperCase()}`;
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();

    const out = {
      code,
      account_id: COMPANY,
      amount_off: tier.pct,
      base_currency: CURRENCY,
      promo_type: "percentage",
      new_users_only: false,
      promo_duration_months: PROMO_MONTHS,
      one_per_customer: true,
      unlimited_stock: false,
      stock: 1,
      expires_at: expiresAt,
    };
    if (PRODUCT) out.product_id = PRODUCT;

    const r = await fetch("https://api.whop.com/api/v1/promo_codes", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(out),
    });
    if (!r.ok) {
      console.error("Whop error", r.status, (await r.text()).slice(0, 500));
      return fail(502, "could not create code");
    }
    return res.status(200).json({ score, pct: tier.pct, code, expiresAt });
  }

  return fail(400, "unknown action");
};
