import express from "express";
import dotenv from "dotenv";

// Node 18+ are fetch nativ
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Onfido
const ONFIDO_API_TOKEN = process.env.ONFIDO_API_TOKEN;
const ONFIDO_API_BASE = process.env.ONFIDO_API_BASE || "https://api.us.onfido.com";
const ONFIDO_API_VERSION = "v3.6";

if (!ONFIDO_API_TOKEN) {
  console.error("❌ Lipsă ONFIDO_API_TOKEN în .env");
  process.exit(1);
}

/* ============================
   CORS pentru Netlify + .env
   ============================ */
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Middleware CORS (înainte de orice JSON/body parser)
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  let allow = false;

  // permite *.netlify.app (prod + deploy previews)
  try {
    const host = new URL(origin).hostname;
    if (/\.netlify\.app$/i.test(host)) allow = true;
  } catch {
    // origin poate lipsi (ex: curl)
  }

  // permite origini explicite din .env
  if (!allow && CORS_ORIGIN.length) {
    if (CORS_ORIGIN.includes("*") || CORS_ORIGIN.includes(origin)) allow = true;
  }

  if (allow) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // dacă folosești cookie-uri, deblochează credențialele:
  // res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ============================
   Health
   ============================ */
app.get("/healthz", (_req, res) => res.send("ok"));

/* ============================
   WEBHOOK Onfido — fără secret
   IMPORTANT: trebuie body RAW, deci îl punem
   ÎNAINTE de express.json()
   ============================ */
const webhookStore = new Map(); // in-memory: runId -> payload esențial

app.post("/webhook/onfido", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8");

    let payload = {};
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      console.warn("⚠️ Webhook JSON invalid");
      return res.status(200).send("ok");
    }

    const resrc = payload?.payload?.resource || {};
    const output = resrc?.output || {};
    const runId =
      resrc?.id ||
      payload?.payload?.object?.id ||
      payload?.object?.id ||
      null;

    const mapped = {
      workflow_run_id: runId,
      status: resrc?.status || payload?.payload?.object?.status || null,
      gender: output?.gender ?? null,
      date_of_birth: output?.dob ?? null,
      document_type: output?.document_type ?? null,
      document_number: output?.document_number ?? null,
      date_expiry: output?.date_expiry ?? null,
      applicant_id: resrc?.applicant_id || null,
      received_at: new Date().toISOString(),
    };

    if (runId) {
      webhookStore.set(runId, mapped);
      console.log("✅ Webhook primit:", runId, "status:", mapped.status);
    } else {
      console.log("⚠️ Webhook fără run id");
    }

    // Onfido așteaptă 200 rapid
    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Eroare webhook:", err);
    // trimitem tot 200 ca să nu reîncerce agresiv
    res.status(200).send("ok");
  }
});

// Debug: vezi ce a ajuns în webhook
app.get("/api/webhook_runs/:id", (req, res) => {
  const data = webhookStore.get(req.params.id);
  if (!data) return res.status(404).json({ message: "not found" });
  res.json(data);
});

/* ============================
   API JSON normal
   ============================ */
app.use(express.json({ limit: "2mb" }));

async function onfidoFetch(pathname, opts = {}) {
  const url = `${ONFIDO_API_BASE}/${ONFIDO_API_VERSION}${pathname}`;
  const headers = {
    Authorization: `Token token=${ONFIDO_API_TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `Onfido ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// creează applicant
app.post("/api/applicants", async (req, res) => {
  try {
    const applicant = await onfidoFetch(`/applicants`, {
      method: "POST",
      body: JSON.stringify(req.body || {}),
    });
    res.json(applicant);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

// creează workflow_run (returnează și sdk_token)
app.post("/api/workflow_runs", async (req, res) => {
  try {
    const run = await onfidoFetch(`/workflow_runs`, {
      method: "POST",
      body: JSON.stringify(req.body || {}),
    });
    res.json(run);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

// ia statusul + output mapat pentru UI
app.get("/api/workflow_runs/:id", async (req, res) => {
  try {
    const runId = req.params.id;
    const run = await onfidoFetch(`/workflow_runs/${encodeURIComponent(runId)}`, { method: "GET" });

    const status = run?.status || null;
    const output = run?.output || {};

    res.json({
      workflow_run_id: run?.id || runId,
      status,
      applicant_id: run?.applicant_id || null,
      document_type: output?.document_type ?? null,
      document_number: output?.document_number ?? null,
      date_of_birth: output?.dob ?? null,
      date_expiry: output?.date_expiry ?? null,
      gender: output?.gender ?? null,
      dashboard_url: run?.dashboard_url || null,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server pornit pe http://localhost:${PORT}`);
});
