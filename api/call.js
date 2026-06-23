/* ============================================================
   Knowlarity call proxy (Vercel serverless function)
   ------------------------------------------------------------
   Why this exists: Knowlarity's otpcall endpoint rejects the
   browser CORS preflight (OPTIONS -> 403), so the frontend can't
   call it directly. This function runs server-side (no CORS) and
   forwards the call, keeping the SR key + x-api-key out of the
   browser.

   Frontend POSTs JSON:
     {
       "endpoint": "otpcall" | "makecall",   // default otpcall
       "ivr_id": "1000138983",               // otpcall only
       "k_number": "+918044927353",          // SR number
       "customer_number": "+919779868855",
       "caller_id": "+918044927353",         // optional
       "agent_number": "+91...",             // makecall only
       "is_promotional": false               // otpcall only
     }
   Credentials come from env (KNOWLARITY_SR_KEY / KNOWLARITY_API_KEY)
   with the current account values as fallback so it works out of the box.
   ============================================================ */

const SR_KEY = process.env.KNOWLARITY_SR_KEY || "d977df7e-b32d-47de-a82a-566b5e0b9022";
const API_KEY = process.env.KNOWLARITY_API_KEY || "QdQa83awS05tyB0KAVATX7tvm3WuBXz16QEluhix";
const CHANNEL = process.env.KNOWLARITY_CHANNEL || "Basic";
const BASE = `https://kpi.knowlarity.com/${CHANNEL}/v1/account`;

function enc(v) { return encodeURIComponent(String(v)); }

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }
  // Vercel parses JSON bodies automatically; guard for string bodies too.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const endpoint = body.endpoint || "otpcall";
  const headers = {
    "Authorization": SR_KEY,
    "x-api-key": API_KEY,
    "content-type": "application/json",
  };

  try {
    let url, method, init;

    if (endpoint === "makecall") {
      if (!body.k_number || !body.agent_number || !body.customer_number) {
        res.status(400).json({ error: "makecall needs k_number, agent_number, customer_number" });
        return;
      }
      url = `${BASE}/call/makecall`;
      method = "POST";
      const payload = {
        k_number: body.k_number,
        agent_number: body.agent_number,
        customer_number: body.customer_number,
      };
      if (body.caller_id) payload.caller_id = body.caller_id;
      init = { method, headers, body: JSON.stringify(payload) };
    } else {
      // otpcall (default) — GET with query params, numbers URL-encoded.
      if (!body.ivr_id || !body.k_number || !body.customer_number) {
        res.status(400).json({ error: "otpcall needs ivr_id, k_number, customer_number" });
        return;
      }
      const q = [
        `ivr_id=${enc(body.ivr_id)}`,
        `k_number=${enc(body.k_number)}`,
        `customer_number=${enc(body.customer_number)}`,
      ];
      if (body.caller_id) q.push(`caller_id=${enc(body.caller_id)}`);
      q.push(`is_promotional=${body.is_promotional ? "true" : "false"}`);
      if (body.channel) q.push(`channel=${enc(body.channel)}`);
      url = `${BASE}/otpcall?${q.join("&")}`;
      method = "GET";
      init = { method, headers };
    }

    const kr = await fetch(url, init);
    let data; try { data = await kr.json(); } catch { data = { raw: await kr.text() }; }
    res.status(kr.status).json(data);
  } catch (e) {
    res.status(502).json({ error: "Proxy failed to reach Knowlarity: " + e.message });
  }
};
