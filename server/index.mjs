import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renderTicketEmail } from "./ticketEmail.mjs";
import { renderTicketPdf } from "./ticketPdf.mjs";
import { renderItineraryPdf } from "./itineraryPdf.mjs";
import {
  buildEscapePlan,
  optimizeJourney,
  predictWaitlist,
} from "../src/lib/yatraiq-engine.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8787);

const IRCTC_API_KEY = process.env.IRCTC_API_KEY || "";
const IRCTC_BASE = process.env.IRCTC_API_BASE || "https://api.irctc.dev";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false") === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || "Rail Bandhu <no-reply@railbandhu.demo>";

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || "";
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || "";
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || "";
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || "";

const EMAIL_TEST_MODE = String(process.env.EMAIL_TEST_MODE || "true") !== "false";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ------------------------------------------------------------------ */
/* tiny in-memory cache                                               */
/* ------------------------------------------------------------------ */

const cache = new Map();

function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  return loader().then((value) => {
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  });
}

/* ------------------------------------------------------------------ */
/* health                                                             */
/* ------------------------------------------------------------------ */

function emailMode() {
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) return "smtp";
  if (EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY) return "emailjs";
  if (EMAIL_TEST_MODE) return "ethereal";
  return "none";
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    irctc: Boolean(IRCTC_API_KEY),
    email: emailMode() !== "none",
    emailMode: emailMode(),
    time: new Date().toISOString(),
  });
});

/* ------------------------------------------------------------------ */
/* IRCTC proxy: real fares + real seat availability                   */
/* ------------------------------------------------------------------ */

async function irctcFetch(pathname, params) {
  if (!IRCTC_API_KEY) {
    const error = new Error(
      "Real IRCTC fares and availability are not configured. Add IRCTC_API_KEY to .env (free key at https://irctc.dev/dashboard)."
    );
    error.status = 503;
    error.code = "IRCTC_NOT_CONFIGURED";
    throw error;
  }

  const url = new URL(`${IRCTC_BASE}${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch(url, {
      headers: { "x-api-key": IRCTC_API_KEY, accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    const failure = new Error(
      error.name === "AbortError" ? "The IRCTC API timed out." : "Could not reach the IRCTC API."
    );
    failure.status = 502;
    failure.code = "IRCTC_NETWORK";
    throw failure;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    const failure = new Error("The IRCTC API returned an unexpected response.");
    failure.status = 502;
    failure.code = "IRCTC_BAD_RESPONSE";
    throw failure;
  }

  if (!response.ok || body?.success === false) {
    const failure = new Error(
      body?.message || body?.error || `IRCTC request failed (HTTP ${response.status}).`
    );
    failure.status = response.status === 429 ? 429 : 502;
    failure.code = body?.code || `IRCTC_HTTP_${response.status}`;
    throw failure;
  }

  return body;
}

app.get("/api/fare", async (req, res) => {
  const { train, from, to, quota = "GN", class: travelClass = "all" } = req.query;
  if (!train || !from || !to) {
    return res.status(400).json({ success: false, code: "BAD_REQUEST", message: "train, from and to are required." });
  }
  try {
    const body = await cached(`fare:${train}:${from}:${to}:${quota}:${travelClass}`, 12 * 60 * 60 * 1000, () =>
      irctcFetch(`/api/v1/trains/${encodeURIComponent(train)}/fare`, {
        from,
        to,
        quota,
        class: travelClass,
      })
    );
    res.json({ ...body, source: "irctc" });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      code: error.code || "IRCTC_ERROR",
      message: error.message,
    });
  }
});

app.get("/api/availability", async (req, res) => {
  const { train, from, to, date, quota = "GN", class: travelClass = "3A" } = req.query;
  if (!train || !from || !to || !date) {
    return res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      message: "train, from, to and date are required.",
    });
  }
  try {
    const body = await cached(
      `avail:${train}:${from}:${to}:${date}:${quota}:${travelClass}`,
      120 * 1000,
      () =>
        irctcFetch(`/api/v1/trains/${encodeURIComponent(train)}/availability`, {
          from,
          to,
          date,
          quota,
          class: travelClass,
        })
    );
    res.json({ ...body, source: "irctc" });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      code: error.code || "IRCTC_ERROR",
      message: error.message,
    });
  }
});

/* ------------------------------------------------------------------ */
/* YatraIQ decision engine                                            */
/* ------------------------------------------------------------------ */

function normalizeOptimizeInput(raw = {}) {
  const alternate = raw.includeAlternateDates ?? raw.alternate;
  const festival = raw.festivalOverride ?? raw.festival;
  return {
    from: raw.from,
    to: raw.to,
    date: raw.date,
    classCode: raw.classCode ?? raw.class,
    quota: raw.quota,
    passengers: raw.passengers ? Number(raw.passengers) : undefined,
    priority: raw.priority,
    maxLegs: raw.maxLegs ? Number(raw.maxLegs) : undefined,
    includeAlternateDates:
      alternate === undefined ? undefined : String(alternate) !== "false",
    festivalOverride:
      festival === undefined || festival === "" ? undefined : Number(festival),
  };
}

function runOptimize(raw) {
  try {
    return { ok: true, result: optimizeJourney(normalizeOptimizeInput(raw)) };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      body: {
        success: false,
        code: "OPTIMIZE_FAILED",
        message: error?.message || "The journey could not be optimised.",
      },
    };
  }
}

app.get("/api/optimize", (req, res) => {
  const outcome = runOptimize(req.query);
  if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
  res.json(outcome.result);
});

app.post("/api/optimize", (req, res) => {
  const outcome = runOptimize(req.body || {});
  if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
  res.json(outcome.result);
});

app.post("/api/waitlist/predict", (req, res) => {
  res.json(predictWaitlist(req.body || {}));
});

app.post("/api/waitlist/escape", (req, res) => {
  res.json(buildEscapePlan(req.body || {}));
});

app.post("/api/itinerary/pdf", async (req, res) => {
  const { itinerary, notes } = req.body || {};
  if (!itinerary || !Array.isArray(itinerary.legs) || itinerary.legs.length === 0) {
    return res.status(400).json({
      success: false,
      code: "BAD_ITINERARY",
      message: "A valid itinerary with at least one leg is required.",
    });
  }

  let pdf;
  try {
    pdf = await renderItineraryPdf({ itinerary, notes });
  } catch {
    return res.status(500).json({
      success: false,
      code: "PDF_FAILED",
      message: "The itinerary PDF could not be generated.",
    });
  }

  const first = itinerary.legs[0];
  const last = itinerary.legs[itinerary.legs.length - 1];
  const safeName = `${first?.from?.code ?? "Yatra"}-${last?.to?.code ?? "IQ"}`.replace(
    /[^A-Za-z0-9-]/g,
    ""
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="RailBandhu-YatraIQ-${safeName}.pdf"`
  );
  res.send(Buffer.from(pdf));
});

/* ------------------------------------------------------------------ */
/* Ticket document download (ticket + invoice as one PDF)              */
/* ------------------------------------------------------------------ */

app.post("/api/ticket-document", async (req, res) => {
  const { ticket } = req.body || {};
  if (!ticket || !ticket.pnr || !ticket.train) {
    return res
      .status(400)
      .json({ success: false, code: "BAD_TICKET", message: "Ticket details are missing." });
  }

  const pdf = await renderTicketPdf(ticket);
  const safePnr = String(ticket.pnr).replace(/[^A-Za-z0-9-]/g, "");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="RailBandhu-Ticket-${safePnr}.pdf"`
  );
  res.send(Buffer.from(pdf));
});

/* ------------------------------------------------------------------ */
/* Email delivery                                                     */
/* ------------------------------------------------------------------ */

let smtpTransport = null;
let etherealAccount = null;

function getTransport() {
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    if (!smtpTransport) {
      smtpTransport = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      });
    }
    return Promise.resolve({ transport: smtpTransport, mode: "smtp" });
  }

  if (EMAIL_TEST_MODE) {
    if (!etherealAccount) {
      etherealAccount = nodemailer.createTestAccount().then((account) => {
        const transport = nodemailer.createTransport({
          host: account.smtp.host,
          port: account.smtp.port,
          secure: account.smtp.secure,
          auth: { user: account.user, pass: account.pass },
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 30000,
        });
        return { transport, account };
      });
    }
    return etherealAccount.then(({ transport }) => ({ transport, mode: "ethereal" }));
  }

  return Promise.resolve({ transport: null, mode: "none" });
}

/* Create the Ethereal account at startup so the first real booking does
   not wait for account provisioning. */
function warmUpEmail() {
  const mode = emailMode();
  if (mode === "ethereal") {
    void getTransport().catch(() => {
      /* ignore — retried on the next send */
    });
  }
}

async function sendWithEmailJs({ to, subject, html, text }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY || undefined,
        template_params: {
          to_email: to,
          subject,
          message_html: html,
          message_text: text,
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      error.name === "AbortError"
        ? "EmailJS did not respond within 20 seconds."
        : "Could not reach EmailJS."
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`EmailJS rejected the message (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }
}

app.post("/api/send-ticket", async (req, res) => {
  const { to, ticket } = req.body || {};
  if (!to || typeof to !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ success: false, code: "BAD_EMAIL", message: "A valid recipient email is required." });
  }
  if (!ticket || !ticket.pnr || !ticket.train) {
    return res.status(400).json({ success: false, code: "BAD_TICKET", message: "Ticket details are missing." });
  }

  const { subject, html, text } = renderTicketEmail(ticket);

  try {
    if (EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY) {
      await sendWithEmailJs({ to, subject, html, text });
      return res.json({ success: true, mode: "emailjs", message: `Ticket emailed to ${to}.` });
    }

    const { transport, mode } = await getTransport();
    if (!transport) {
      return res.status(503).json({
        success: false,
        code: "EMAIL_NOT_CONFIGURED",
        message:
          "Email delivery is not configured. Add SMTP_HOST/SMTP_USER/SMTP_PASS or EmailJS keys to .env.",
      });
    }

    const info = await transport.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text,
      html,
      attachments: [
        {
          filename: `RailBandhu-Ticket-${ticket.pnr}.html`,
          content: html,
          contentType: "text/html",
        },
      ],
    });

    const previewUrl = mode === "ethereal" ? nodemailer.getTestMessageUrl(info) : null;
    return res.json({
      success: true,
      mode,
      message:
        mode === "ethereal"
          ? "Test email captured by Ethereal (configure SMTP for real inbox delivery)."
          : `Ticket emailed to ${to}.`,
      previewUrl,
      messageId: info.messageId,
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      code: "EMAIL_SEND_FAILED",
      message: error.message || "The email could not be sent.",
    });
  }
});

/* ------------------------------------------------------------------ */
/* static production build                                            */
/* ------------------------------------------------------------------ */

const dist = path.join(root, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
}

const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`Rail Bandhu API on http://${HOST}:${PORT}`);
  console.log(`  IRCTC fares/availability: ${IRCTC_API_KEY ? "enabled" : "not configured"}`);
  console.log(`  Email mode: ${emailMode()}`);
  warmUpEmail();
});
