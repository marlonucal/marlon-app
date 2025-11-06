// server/src/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
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
  console.error("Lipsește ONFIDO_API_TOKEN în server/.env");
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Health
app.get("/healthz", (_req, res) => res.send("ok"));

// Helper Onfido
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
    const msg = json?.error?.message || json?.message || JSON.stringify(json);
    const err = new Error(msg || `Onfido error ${res.status}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

/**
 * POST /api/applicants
 * Body: { first_name, last_name, email }
 */
app.post("/api/applicants", async (req, res) => {
  try {
    const { first_name, last_name, email } = req.body || {};
    const payload = { first_name, last_name, email };
    const applicant = await onfidoFetch(`/applicants`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    res.json(applicant);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

/**
 * POST /api/workflow_runs
 * Body: { workflow_id, applicant_id }
 * Returnează inclusiv sdk_token
 */
app.post("/api/workflow_runs", async (req, res) => {
  try {
    const { workflow_id, applicant_id } = req.body || {};
    const run = await onfidoFetch(`/workflow_runs`, {
      method: "POST",
      body: JSON.stringify({ workflow_id, applicant_id }),
    });
    res.json(run);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

/**
 * GET /api/workflow_runs/:id
 * Combină status + output cu numele applicantului
 */
app.get("/api/workflow_runs/:id", async (req, res) => {
  try {
    const runId = req.params.id;
    const run = await onfidoFetch(`/workflow_runs/${encodeURIComponent(runId)}`, {
      method: "GET",
    });

    const status = run?.status || null;
    const output = run?.output || {};
    const applicantId = run?.applicant_id || null;

    let firstName = null;
    let lastName = null;

    if (applicantId) {
      try {
        const applicant = await onfidoFetch(`/applicants/${encodeURIComponent(applicantId)}`, {
          method: "GET",
        });
        firstName = applicant?.first_name || null;
        lastName = applicant?.last_name || null;
      } catch {}
    }

    const mapped = {
      status,
      first_name: firstName,
      last_name: lastName,
      gender: output?.gender ?? null,
      date_of_birth: output?.dob ?? null,
      document_type: output?.document_type ?? null,
      document_number: output?.document_number ?? null,
      date_expiry: output?.date_expiry ?? null,
      workflow_run_id: run?.id || runId,
      applicant_id: applicantId,
      dashboard_url: run?.dashboard_url || null,
    };

    res.json(mapped);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

/**
 * Static frontend în producție
 * Dacă există client/dist, îl servim pe același domeniu
 */
const clientDist = path.resolve(__dirname, "../../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`API pornit pe http://localhost:${PORT}`);
});
