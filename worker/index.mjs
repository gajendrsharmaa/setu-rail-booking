/**
 * Cloudflare Worker entry point for Rail Bandhu.
 *
 * The original project used Express for /api/*. This Worker implements the
 * same routes so the React app can be served as static assets from Cloudflare:
 *
 *   GET  /api/health
 *   GET  /api/fare
 *   GET  /api/availability
 *   POST /api/send-ticket
 *   POST /api/ticket-document
 *   GET  /api/email-preview/:id
 *
 * SMTP cannot be used in the Workers runtime. When EmailJS credentials are
 * configured the ticket is delivered for real; otherwise the rendered email
 * is stored in KV for a few days and the confirmation screen links to it as a
 * test-inbox preview, matching the demo behaviour of the Express version.
 */

import { renderTicketEmail } from "../server/ticketEmail.mjs";
import { renderTicketPdf } from "../server/ticketPdf.mjs";
import { renderItineraryPdf } from "../server/itineraryPdf.mjs";
import {
  buildEscapePlan,
  optimizeJourney,
  predictWaitlist,
} from "../src/lib/yatraiq-engine.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

const PREVIEW_TTL_SECONDS = 60 * 60 * 24 * 7;
const PREVIEW_MEMORY_TTL_MS = 60 * 60 * 1000;

/* In-isolate fallback used when the EMAIL_PREVIEWS KV binding is absent
   (for example `wrangler dev` without a namespace). */
const previewMemory = new Map();

const irctcCache = new Map();
const railradarCache = new Map();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorJson(error) {
  return json(
    {
      success: false,
      code: error.code || "API_ERROR",
      message: error.message || "The request failed.",
    },
    error.status || 500
  );
}

function httpError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function emailMode(env) {
  if (
    env.EMAILJS_SERVICE_ID &&
    env.EMAILJS_TEMPLATE_ID &&
    env.EMAILJS_PUBLIC_KEY
  ) {
    return "emailjs";
  }
  if (String(env.EMAIL_TEST_MODE ?? "true") !== "false") return "preview";
  return "none";
}

/* ------------------------------------------------------------------ */
/* tiny cache (per isolate)                                           */
/* ------------------------------------------------------------------ */

function cached(key, ttlMs, loader) {
  const hit = irctcCache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  return loader().then((value) => {
    irctcCache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  });
}

/* ------------------------------------------------------------------ */
/* IRCTC proxy                                                        */
/* ------------------------------------------------------------------ */

async function irctcFetch(env, pathname, params) {
  if (!env.IRCTC_API_KEY) {
    throw httpError(
      "Real IRCTC fares and availability are not configured. Add the IRCTC_API_KEY secret to the Worker.",
      503,
      "IRCTC_NOT_CONFIGURED"
    );
  }

  const base = env.IRCTC_API_BASE || "https://api.irctc.dev";
  const url = new URL(`${base}${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  });

  let response;
  try {
    response = await fetch(url, {
      headers: { "x-api-key": env.IRCTC_API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw httpError(
      error?.name === "TimeoutError" ? "The IRCTC API timed out." : "Could not reach the IRCTC API.",
      502,
      "IRCTC_NETWORK"
    );
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw httpError(
      "The IRCTC API returned an unexpected response.",
      502,
      "IRCTC_BAD_RESPONSE"
    );
  }

  if (!response.ok || body?.success === false) {
    throw httpError(
      body?.message || body?.error || `IRCTC request failed (HTTP ${response.status}).`,
      response.status === 429 ? 429 : 502,
      body?.code || `IRCTC_HTTP_${response.status}`
    );
  }

  return body;
}

async function handleFare(env, url) {
  const train = url.searchParams.get("train");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const quota = url.searchParams.get("quota") || "GN";
  const travelClass = url.searchParams.get("class") || "all";

  if (!train || !from || !to) {
    return json(
      { success: false, code: "BAD_REQUEST", message: "train, from and to are required." },
      400
    );
  }

  try {
    const body = await cached(
      `fare:${train}:${from}:${to}:${quota}:${travelClass}`,
      12 * 60 * 60 * 1000,
      () =>
        irctcFetch(env, `/api/v1/trains/${encodeURIComponent(train)}/fare`, {
          from,
          to,
          quota,
          class: travelClass,
        })
    );
    return json({ ...body, source: "irctc" });
  } catch (error) {
    return errorJson(error);
  }
}

async function handleAvailability(env, url) {
  const train = url.searchParams.get("train");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const date = url.searchParams.get("date");
  const quota = url.searchParams.get("quota") || "GN";
  const travelClass = url.searchParams.get("class") || "3A";

  if (!train || !from || !to || !date) {
    return json(
      {
        success: false,
        code: "BAD_REQUEST",
        message: "train, from, to and date are required.",
      },
      400
    );
  }

  try {
    const body = await cached(
      `avail:${train}:${from}:${to}:${date}:${quota}:${travelClass}`,
      120 * 1000,
      () =>
        irctcFetch(env, `/api/v1/trains/${encodeURIComponent(train)}/availability`, {
          from,
          to,
          date,
          quota,
          class: travelClass,
        })
    );
    return json({ ...body, source: "irctc" });
  } catch (error) {
    return errorJson(error);
  }
}

/* ------------------------------------------------------------------ */
/* RailRadar proxy (keeps the API key server-side)                    */
/* ------------------------------------------------------------------ */

function railradarTtl(pathname) {
  if (pathname.startsWith("/stations/") && pathname.endsWith("/live")) return 90 * 1000;
  if (pathname.startsWith("/trains/") && pathname.endsWith("/live")) return 45 * 1000;
  if (pathname.startsWith("/trains/") && pathname.endsWith("/coaches")) return 12 * 60 * 60 * 1000;
  if (pathname.startsWith("/trains/between/")) return 6 * 60 * 60 * 1000;
  return 60 * 1000;
}

/* Timetables and coach layouts change rarely. Sharing those responses through
   KV means every visitor does not spend a RailRadar request. Short-lived live
   responses are cached too, so concurrent visitors share one upstream call. */
function railradarPersistentTtl(pathname) {
  if (pathname.startsWith("/trains/between/")) return 6 * 60 * 60;
  if (pathname.startsWith("/trains/") && pathname.endsWith("/coaches")) return 12 * 60 * 60;
  if (pathname.startsWith("/stations/") && pathname.endsWith("/live")) return 5 * 60;
  if (pathname.startsWith("/trains/") && pathname.endsWith("/live")) return 60;
  return 0;
}

/* A long-lived copy kept next to the fresh entry. If RailRadar is rate
   limited or briefly down, visitors still get the last good response instead
   of an error page. */
function railradarStaleTtl(pathname) {
  if (pathname.startsWith("/trains/between/")) return 7 * 24 * 60 * 60;
  if (pathname.startsWith("/trains/") && pathname.endsWith("/coaches")) return 7 * 24 * 60 * 60;
  if (pathname.startsWith("/stations/") && pathname.endsWith("/live")) return 30 * 60;
  if (pathname.startsWith("/trains/") && pathname.endsWith("/live")) return 30 * 60;
  return 0;
}

function staleResponse(stored) {
  const headers = new Headers(stored.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-railradar-stale", "1");
  return new Response(stored.body, { status: 200, headers });
}

async function handleRailRadar(request, env, url) {
  if (request.method !== "GET") {
    return json(
      { success: false, code: "METHOD_NOT_ALLOWED", message: "RailRadar requests must use GET." },
      405
    );
  }

  if (!env.RAILRADAR_API_KEY) {
    return json(
      {
        success: false,
        code: "RAILRADAR_NOT_CONFIGURED",
        message:
          "Live RailRadar data is not configured. Add the RAILRADAR_API_KEY secret to the Worker.",
      },
      503
    );
  }

  const suffix = url.pathname.slice("/api/railradar".length);
  if (!suffix.startsWith("/") || suffix.startsWith("//")) {
    return json(
      { success: false, code: "BAD_REQUEST", message: "Invalid RailRadar path." },
      400
    );
  }

  const base = (env.RAILRADAR_API_BASE || "https://api.railradar.in/v1").replace(/\/+$/, "");
  const target = new URL(`${base}${suffix}`);
  target.search = url.search;

  const ttl = railradarTtl(suffix);
  const cacheKey = target.href;
  const hit = railradarCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return new Response(hit.body, { status: hit.status, headers: new Headers(hit.headers) });
  }

  const persistentTtl = railradarPersistentTtl(suffix);
  const kvKey = `railradar:${target.href}`;
  if (persistentTtl && env.EMAIL_PREVIEWS) {
    const stored = await env.EMAIL_PREVIEWS.get(kvKey, { type: "json" });
    if (stored?.body) {
      railradarCache.set(cacheKey, {
        status: stored.status,
        body: stored.body,
        headers: stored.headers,
        expires: Date.now() + ttl,
      });
      return new Response(stored.body, {
        status: stored.status,
        headers: new Headers(stored.headers),
      });
    }
  }

  const staleTtl = railradarStaleTtl(suffix);
  const staleKey = `railradar:stale:${target.href}`;
  let stale = hit?.body ? hit : null;
  if (staleTtl && env.EMAIL_PREVIEWS) {
    const storedStale = await env.EMAIL_PREVIEWS.get(staleKey, { type: "json" });
    if (storedStale?.body) stale = storedStale;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { "x-api-key": env.RAILRADAR_API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (stale) return staleResponse(stale);
    return json(
      {
        success: false,
        code: "RAILRADAR_NETWORK",
        message:
          error?.name === "TimeoutError"
            ? "The RailRadar API timed out."
            : "Could not reach the RailRadar API.",
      },
      502
    );
  }

  const body = await upstream.text();
  if (upstream.status !== 200 && stale) {
    return staleResponse(stale);
  }
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower === "content-type" ||
      lower === "retry-after" ||
      lower.startsWith("x-ratelimit") ||
      lower.startsWith("ratelimit-")
    ) {
      headers.set(lower, value);
    }
  });
  headers.set("cache-control", "no-store");
  headers.set("x-robots-tag", "noindex");
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");

  const headersArray = Array.from(headers.entries());

  if (upstream.status === 200) {
    railradarCache.set(cacheKey, {
      status: upstream.status,
      body,
      headers: headersArray,
      expires: Date.now() + ttl,
    });

    if (persistentTtl && env.EMAIL_PREVIEWS) {
      await env.EMAIL_PREVIEWS.put(
        kvKey,
        JSON.stringify({ status: upstream.status, body, headers: headersArray }),
        { expirationTtl: persistentTtl }
      );
    }

    if (staleTtl && env.EMAIL_PREVIEWS) {
      await env.EMAIL_PREVIEWS.put(
        staleKey,
        JSON.stringify({ status: upstream.status, body, headers: headersArray }),
        { expirationTtl: staleTtl }
      );
    }
  } else if (upstream.status === 429 || upstream.status >= 500) {
    /* Do not hammer a rate-limited or failing upstream on every page view.
       The error is retried after a minute. */
    railradarCache.set(cacheKey, {
      status: upstream.status,
      body,
      headers: headersArray,
      expires: Date.now() + 60 * 1000,
    });
  }

  return new Response(body, { status: upstream.status, headers });
}

/* ------------------------------------------------------------------ */
/* Ticket document                                                    */
/* ------------------------------------------------------------------ */

async function readTicketBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw httpError("The request body must be valid JSON.", 400, "BAD_JSON");
  }
  const ticket = body?.ticket;
  if (!ticket || !ticket.pnr || !ticket.train) {
    throw httpError("Ticket details are missing.", 400, "BAD_TICKET");
  }
  return { body, ticket };
}

async function handleTicketDocument(request) {
  let ticket;
  try {
    ({ ticket } = await readTicketBody(request));
  } catch (error) {
    return errorJson(error);
  }

  let pdf;
  try {
    pdf = await renderTicketPdf(ticket);
  } catch (error) {
    return json(
      {
        success: false,
        code: "PDF_FAILED",
        message: "The ticket PDF could not be generated.",
      },
      500
    );
  }

  const safePnr = String(ticket.pnr).replace(/[^A-Za-z0-9-]/g, "");
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="RailBandhu-Ticket-${safePnr}.pdf"`,
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

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

async function handleOptimize(request, url) {
  let raw = {};
  if (request.method === "POST") {
    try {
      raw = await request.json();
    } catch {
      return json(
        { success: false, code: "BAD_JSON", message: "The request body must be valid JSON." },
        400
      );
    }
  } else {
    raw = Object.fromEntries(url.searchParams.entries());
  }

  try {
    return json(optimizeJourney(normalizeOptimizeInput(raw)));
  } catch (error) {
    return json(
      {
        success: false,
        code: "OPTIMIZE_FAILED",
        message: error?.message || "The journey could not be optimised.",
      },
      500
    );
  }
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    throw httpError("The request body must be valid JSON.", 400, "BAD_JSON");
  }
}

async function handleWaitlistPredict(request) {
  try {
    const body = await readJsonBody(request);
    return json(predictWaitlist(body || {}));
  } catch (error) {
    return errorJson(error);
  }
}

async function handleWaitlistEscape(request) {
  try {
    const body = await readJsonBody(request);
    return json(buildEscapePlan(body || {}));
  } catch (error) {
    return errorJson(error);
  }
}

async function handleItineraryPdf(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return errorJson(error);
  }

  const itinerary = body?.itinerary;
  if (!itinerary || !Array.isArray(itinerary.legs) || itinerary.legs.length === 0) {
    return json(
      {
        success: false,
        code: "BAD_ITINERARY",
        message: "A valid itinerary with at least one leg is required.",
      },
      400
    );
  }

  let pdf;
  try {
    pdf = await renderItineraryPdf({ itinerary, notes: body?.notes });
  } catch {
    return json(
      {
        success: false,
        code: "PDF_FAILED",
        message: "The itinerary PDF could not be generated.",
      },
      500
    );
  }

  const first = itinerary.legs[0];
  const last = itinerary.legs[itinerary.legs.length - 1];
  const safeName = `${first?.from?.code ?? "Yatra"}-${last?.to?.code ?? "IQ"}`.replace(
    /[^A-Za-z0-9-]/g,
    ""
  );
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="RailBandhu-YatraIQ-${safeName}.pdf"`,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-robots-tag": "noindex",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Email delivery / preview inbox                                     */
/* ------------------------------------------------------------------ */

async function sendWithEmailJs(env, { to, subject, html, text }) {
  let response;
  try {
    response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: env.EMAILJS_SERVICE_ID,
        template_id: env.EMAILJS_TEMPLATE_ID,
        user_id: env.EMAILJS_PUBLIC_KEY,
        accessToken: env.EMAILJS_PRIVATE_KEY || undefined,
        template_params: {
          to_email: to,
          subject,
          message_html: html,
          message_text: text,
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw httpError(
      error?.name === "TimeoutError"
        ? "EmailJS did not respond within 20 seconds."
        : "Could not reach EmailJS.",
      502,
      "EMAIL_SEND_FAILED"
    );
  }

  if (!response.ok) {
    const detail = await response.text();
    throw httpError(
      `EmailJS rejected the message (HTTP ${response.status}): ${detail.slice(0, 300)}`,
      502,
      "EMAIL_SEND_FAILED"
    );
  }
}

async function storePreview(env, html) {
  const id = crypto.randomUUID();
  if (env.EMAIL_PREVIEWS) {
    await env.EMAIL_PREVIEWS.put(`preview:${id}`, html, {
      expirationTtl: PREVIEW_TTL_SECONDS,
    });
  } else {
    previewMemory.set(id, { html, expires: Date.now() + PREVIEW_MEMORY_TTL_MS });
  }
  return id;
}

function withPreviewBanner(html) {
  const banner =
    '<div style="background:#fdf4e3;border-bottom:1px solid #f3d9a5;color:#7a4e00;' +
    'font:13px/1.5 Arial,Helvetica,sans-serif;padding:10px 16px;text-align:center;">' +
    "<strong>Test inbox preview.</strong> This email was rendered and captured for the demo. " +
    "It was not delivered to the passenger's real address. Configure EmailJS to send real mail." +
    "</div>";
  return html.includes("<body")
    ? html.replace(/<body([^>]*)>/i, `<body$1>${banner}`)
    : `${banner}${html}`;
}

async function handleSendTicket(request, env) {
  let ticket;
  let to;
  try {
    const parsed = await readTicketBody(request);
    ticket = parsed.ticket;
    to = parsed.body?.to;
    if (!to || typeof to !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw httpError("A valid recipient email is required.", 400, "BAD_EMAIL");
    }
  } catch (error) {
    return errorJson(error);
  }

  const { subject, html, text } = renderTicketEmail(ticket);

  try {
    if (emailMode(env) === "emailjs") {
      await sendWithEmailJs(env, { to, subject, html, text });
      return json({
        success: true,
        mode: "emailjs",
        message: `Ticket emailed to ${to}.`,
      });
    }

    if (emailMode(env) === "preview") {
      const id = await storePreview(env, html);
      const previewUrl = `${new URL(request.url).origin}/api/email-preview/${id}`;
      return json({
        success: true,
        mode: "preview",
        message: `Test email captured for ${to}. Open the preview to view the ticket and invoice.`,
        previewUrl,
        messageId: id,
      });
    }

    return json(
      {
        success: false,
        code: "EMAIL_NOT_CONFIGURED",
        message:
          "Email delivery is not configured. Add EmailJS credentials as Worker secrets, or set EMAIL_TEST_MODE=true for the test inbox.",
      },
      503
    );
  } catch (error) {
    return errorJson(error);
  }
}

async function handleEmailPreview(env, url) {
  const match = url.pathname.match(/^\/api\/email-preview\/([0-9a-f-]{36})$/i);
  if (!match) return new Response("Not found", { status: 404 });

  const id = match[1];
  let html = null;

  if (env.EMAIL_PREVIEWS) {
    html = await env.EMAIL_PREVIEWS.get(`preview:${id}`);
  } else {
    const entry = previewMemory.get(id);
    if (entry && entry.expires > Date.now()) html = entry.html;
  }

  if (!html) {
    return new Response(
      "<!doctype html><title>Preview expired</title><body style=\"font-family:Arial,sans-serif;padding:40px;text-align:center;color:#334155\"><h1 style=\"font-size:20px\">This test email preview has expired</h1><p>Previews are kept for 7 days. Book again to generate a new one.</p></body>",
      {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      }
    );
  }

  return new Response(withPreviewBanner(html), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, accept",
      },
    });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    const mode = emailMode(env);
    return json({
      ok: true,
      irctc: Boolean(env.IRCTC_API_KEY),
      railradar: Boolean(env.RAILRADAR_API_KEY),
      email: mode !== "none",
      emailMode: mode,
      time: new Date().toISOString(),
    });
  }

  if (url.pathname === "/api/railradar" || url.pathname.startsWith("/api/railradar/")) {
    return handleRailRadar(request, env, url);
  }

  if (url.pathname === "/api/fare" && request.method === "GET") {
    return handleFare(env, url);
  }

  if (url.pathname === "/api/availability" && request.method === "GET") {
    return handleAvailability(env, url);
  }

  if (
    url.pathname === "/api/optimize" &&
    (request.method === "GET" || request.method === "POST")
  ) {
    return handleOptimize(request, url);
  }

  if (url.pathname === "/api/waitlist/predict" && request.method === "POST") {
    return handleWaitlistPredict(request);
  }

  if (url.pathname === "/api/waitlist/escape" && request.method === "POST") {
    return handleWaitlistEscape(request);
  }

  if (url.pathname === "/api/itinerary/pdf" && request.method === "POST") {
    return handleItineraryPdf(request);
  }

  if (url.pathname === "/api/ticket-document" && request.method === "POST") {
    return handleTicketDocument(request);
  }

  if (url.pathname === "/api/send-ticket" && request.method === "POST") {
    return handleSendTicket(request, env);
  }

  if (url.pathname.startsWith("/api/email-preview/") && request.method === "GET") {
    return handleEmailPreview(env, url);
  }

  return json({ success: false, code: "NOT_FOUND", message: "Unknown API route." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    const response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      /* Always revalidate the app shell so a new deployment is picked up on
         the next navigation instead of serving a stale bundle from cache. */
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store, no-cache, must-revalidate");
      headers.set("pragma", "no-cache");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
};
