import express from "express";
import cors from "cors";
import dotenv from "dotenv";
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

app.use(cors());

// ============================================
//  WEBHOOK Onfido (fără secret) — răspunde 200
// ============================================
const webhookStore = new Map();

app.post("/webhook/onfido", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(String(req.body || ""), "utf8");

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
      resrc?.id || payload?.payload?.object?.id || payload?.object?.id || null;

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
      console.log("✅ Webhook primit pentru run:", runId, mapped.status);
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Eroare webhook:", err);
    res.status(200).send("ok");
  }
});

app.get("/api/webhook_runs/:id", (req, res) => {
  const data = webhookStore.get(req.params.id);
  if (!data) return res.status(404).json({ message: "not found" });
  res.json(data);
});

// ============================================
//  API Onfido
// ============================================
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
    throw new Error(json?.error?.message || json?.message || `Onfido ${res.status}`);
  }
  return json;
}

app.post("/api/applicants", async (req, res) => {
  try {
    const applicant = await onfidoFetch("/applicants", {
      method: "POST",
      body: JSON.stringify(req.body),
    });
    res.json(applicant);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/workflow_runs", async (req, res) => {
  try {
    const run = await onfidoFetch("/workflow_runs", {
      method: "POST",
      body: JSON.stringify(req.body),
    });
    res.json(run);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/workflow_runs/:id", async (req, res) => {
  try {
    const runId = req.params.id;
    const run = await onfidoFetch(`/workflow_runs/${encodeURIComponent(runId)}`);
    const output = run?.output || {};
    res.json({
      workflow_run_id: run.id,
      status: run.status,
      applicant_id: run.applicant_id,
      document_type: output?.document_type,
      document_number: output?.document_number,
      date_of_birth: output?.dob,
      date_expiry: output?.date_expiry,
      gender: output?.gender,
      dashboard_url: run.dashboard_url,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server pornit pe http://localhost:${PORT}`));
