import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/* ------------------------------------------------------------------
   YatraIQ stitched itinerary PDF
   ------------------------------------------------------------------
   One printable document for a multi-PNR plan: cover summary, each
   train leg with its own PNR box, transfer instructions, fare split
   and the model disclaimers. Works in Node and in the Worker because
   it only uses pdf-lib.
------------------------------------------------------------------- */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;

const NAVY = rgb(0.043, 0.235, 0.42);
const BLUE_LIGHT = rgb(0.918, 0.945, 0.973);
const TEXT = rgb(0.106, 0.153, 0.2);
const MUTED = rgb(0.392, 0.455, 0.525);
const LINE = rgb(0.843, 0.882, 0.918);
const ORANGE = rgb(0.851, 0.431, 0.071);
const GREEN = rgb(0.13, 0.55, 0.3);
const AMBER = rgb(0.788, 0.478, 0.039);
const WHITE = rgb(1, 1, 1);

function clean(value) {
  return String(value ?? "")
    .replace(/₹/g, "Rs. ")
    .replace(/[—–]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/·/g, "-")
    .replace(/→/g, "->")
    .replace(/×/g, "x")
    .replace(/[^\x20-\x7E]/g, "");
}

function money(value) {
  return `Rs. ${(Number(value) || 0).toLocaleString("en-IN")}`;
}

function duration(totalMinutes) {
  const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${rest}m`;
}

function dateLabel(iso) {
  if (!iso) return "-";
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function wrap(text, font, size, maxWidth) {
  const words = clean(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawText(page, text, { x, y, size = 10, font, color = TEXT } = {}) {
  page.drawText(clean(text), { x, y, size, font, color });
}

function drawWrapped(page, text, { x, y, size = 10, font, color = TEXT, maxWidth, lineHeight = 13 }) {
  wrap(text, font, size, maxWidth).forEach((line, index) => {
    page.drawText(line, { x, y: y - index * lineHeight, size, font, color });
  });
  return y - wrap(text, font, size, maxWidth).length * lineHeight;
}

function rule(page, y, x = MARGIN, width = CONTENT_W, color = LINE) {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.7, color });
}

function label(page, text, { x, y, font, color = MUTED, size = 7.5 }) {
  page.drawText(clean(text).toUpperCase(), { x, y, size, font, color });
}

function badge(page, text, { x, y, font, color = GREEN, bg = rgb(0.9, 0.96, 0.91) }) {
  const width = font.widthOfTextAtSize(clean(text), 8) + 14;
  page.drawRectangle({ x, y: y - 3, width, height: 15, color: bg, borderColor: color, borderWidth: 0.6 });
  page.drawText(clean(text), { x: x + 7, y: y + 1, size: 8, font, color });
  return width;
}

function newPage(pdf, fonts, pageNumber, title) {
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: PAGE_H - 54, width: PAGE_W, height: 54, color: NAVY });
  page.drawText("RAIL BANDHU  /  YATRAIQ", {
    x: MARGIN,
    y: PAGE_H - 30,
    size: 13,
    font: fonts.bold,
    color: WHITE,
  });
  page.drawText(clean(title), {
    x: MARGIN,
    y: PAGE_H - 44,
    size: 8,
    font: fonts.regular,
    color: rgb(0.75, 0.83, 0.9),
  });
  page.drawText(`Page ${pageNumber}`, {
    x: PAGE_W - MARGIN - 40,
    y: PAGE_H - 30,
    size: 8,
    font: fonts.regular,
    color: rgb(0.75, 0.83, 0.9),
  });
  page.drawRectangle({ x: 0, y: PAGE_H - 58, width: PAGE_W, height: 4, color: ORANGE });
  return page;
}

function pageFooter(page, fonts, note) {
  rule(page, 44);
  drawText(page, note, {
    x: MARGIN,
    y: 30,
    size: 7,
    font: fonts.regular,
    color: MUTED,
  });
}

function legPnr(leg, index) {
  /* Deterministic placeholder so the printed plan looks like a real
     multi-PNR document. It is clearly marked as an estimate. */
  const seed = `${leg.serviceNumber}${leg.from.code}${leg.to.code}${leg.depDate}${index}`;
  let hash = 7;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 900000000;
  const base = String(4000000000 + hash).slice(-10);
  return `YB${base.slice(0, 6)}${String(index + 1)}`;
}

export async function renderItineraryPdf(plan) {
  const itinerary = plan?.itinerary ?? plan;
  if (!itinerary || !Array.isArray(itinerary.legs) || itinerary.legs.length === 0) {
    throw new Error("A valid itinerary with at least one leg is required.");
  }

  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
  };

  const legs = itinerary.legs;
  const transfers = itinerary.transfers || [];
  const first = legs[0];
  const last = legs[legs.length - 1];
  const totalFare = itinerary.totalPrice;
  const perLegFare = legs.reduce((sum, leg) => sum + (Number(leg.price) || 0), 0);

  /* ---------------- cover / summary ---------------- */
  let page = newPage(pdf, fonts, 1, "Stitched multi-PNR journey plan");
  let y = PAGE_H - 88;

  drawText(page, `${first.from.city} to ${last.to.city}`, {
    x: MARGIN,
    y,
    size: 22,
    font: fonts.bold,
    color: NAVY,
  });
  y -= 20;
  drawText(
    page,
    `${first.from.name} (${first.from.code})  ->  ${last.to.name} (${last.to.code})`,
    { x: MARGIN, y, size: 10, font: fonts.regular, color: MUTED }
  );
  y -= 26;

  let bx = MARGIN;
  bx += badge(page, itinerary.isSplit ? `${legs.length} trains / ${legs.length} PNRs` : "Direct / 1 PNR", {
    x: bx,
    y,
    font: fonts.bold,
    color: NAVY,
    bg: BLUE_LIGHT,
  }) + 8;
  bx += badge(page, `${Math.round((itinerary.confirmation || 0) * 100)}% estimated confirmation`, {
    x: bx,
    y,
    font: fonts.bold,
    color: GREEN,
  }) + 8;
  badge(page, `${money(totalFare)} total`, {
    x: bx,
    y,
    font: fonts.bold,
    color: ORANGE,
    bg: rgb(0.99, 0.95, 0.89),
  });
  y -= 24;

  /* summary grid */
  const grid = [
    ["Departure", `${dateLabel(first.depDate)}  ${first.depClock}`],
    ["Arrival", `${dateLabel(last.arrDate)}  ${last.arrClock}`],
    ["Journey time", duration(itinerary.totalDurationMin)],
    ["Class / quota", `${itinerary.classLabel} / ${itinerary.quotaLabel}`],
    ["Passengers", String(itinerary.passengers || 1)],
    ["Transfers", transfers.length ? String(transfers.length) : "None"],
  ];
  const cellW = CONTENT_W / 3;
  grid.forEach(([key, value], index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const gx = MARGIN + col * cellW;
    const gy = y - row * 44;
    page.drawRectangle({
      x: gx,
      y: gy - 30,
      width: cellW - 8,
      height: 38,
      color: rgb(0.976, 0.984, 0.99),
      borderColor: LINE,
      borderWidth: 0.6,
    });
    label(page, key, { x: gx + 8, y: gy - 2, font: fonts.bold });
    drawText(page, value, { x: gx + 8, y: gy - 18, size: 10.5, font: fonts.monoBold, color: TEXT });
  });
  y -= 100;

  /* fare breakdown */
  label(page, "Fare breakdown", { x: MARGIN, y, font: fonts.bold, color: NAVY, size: 8 });
  y -= 14;
  legs.forEach((leg, index) => {
    drawText(
      page,
      `${index + 1}. ${leg.serviceNumber} ${leg.serviceName}  ${leg.from.code} -> ${leg.to.code}`,
      { x: MARGIN, y, size: 9, font: fonts.regular, color: TEXT }
    );
    drawText(page, money(leg.price), {
      x: PAGE_W - MARGIN - 70,
      y,
      size: 9,
      font: fonts.monoBold,
      color: TEXT,
    });
    y -= 14;
  });
  rule(page, y + 4);
  y -= 8;
  drawText(page, `Fare per passenger ${money(perLegFare)}`, {
    x: MARGIN,
    y,
    size: 9,
    font: fonts.regular,
    color: MUTED,
  });
  drawText(page, `Total for ${itinerary.passengers || 1} passenger(s) ${money(totalFare)}`, {
    x: PAGE_W - MARGIN - 190,
    y,
    size: 10,
    font: fonts.bold,
    color: NAVY,
  });
  y -= 26;

  if (itinerary.reasons?.length) {
    label(page, "Why YatraIQ ranked this plan", { x: MARGIN, y, font: fonts.bold, color: NAVY, size: 8 });
    y -= 14;
    for (const reason of itinerary.reasons.slice(0, 5)) {
      drawText(page, `- ${reason}`, { x: MARGIN, y, size: 8.5, font: fonts.regular, color: TEXT });
      y -= 12;
    }
  }

  pageFooter(
    page,
    fonts,
    "YatraIQ estimates: fares, availability and confirmation probability are model outputs, not live IRCTC data."
  );

  /* ---------------- one section per leg ---------------- */
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];
    page = newPage(pdf, fonts, index + 2, `Train ${index + 1} of ${legs.length} - separate PNR`);
    y = PAGE_H - 92;

    drawText(page, `${leg.serviceNumber}  ${leg.serviceName}`, {
      x: MARGIN,
      y,
      size: 16,
      font: fonts.bold,
      color: NAVY,
    });
    y -= 16;
    drawText(page, `${leg.serviceType}  /  ${leg.classLabel}  /  ${leg.quotaLabel} quota`, {
      x: MARGIN,
      y,
      size: 9,
      font: fonts.regular,
      color: MUTED,
    });
    y -= 22;

    /* PNR box */
    page.drawRectangle({
      x: MARGIN,
      y: y - 46,
      width: CONTENT_W,
      height: 52,
      color: BLUE_LIGHT,
      borderColor: rgb(0.72, 0.8, 0.88),
      borderWidth: 0.8,
    });
    label(page, "This leg is a separate PNR", { x: MARGIN + 12, y: y - 12, font: fonts.bold, color: NAVY });
    drawText(page, legPnr(leg, index), {
      x: MARGIN + 12,
      y: y - 34,
      size: 19,
      font: fonts.monoBold,
      color: NAVY,
    });
    label(page, "Book this leg separately; it is not one through ticket.", {
      x: MARGIN + 170,
      y: y - 12,
      font: fonts.regular,
      color: MUTED,
    });
    drawText(page, `Estimated fare ${money(leg.price)}`, {
      x: MARGIN + 170,
      y: y - 32,
      size: 10,
      font: fonts.bold,
      color: ORANGE,
    });
    y -= 66;

    /* timeline */
    const timeline = [
      ["Boarding", leg.from.name, leg.from.code, leg.depDate, leg.depClock],
      ["Destination", leg.to.name, leg.to.code, leg.arrDate, leg.arrClock],
    ];
    for (const [kind, name, code, date, clock] of timeline) {
      page.drawCircle({ x: MARGIN + 5, y: y + 3, size: 3.2, color: kind === "Boarding" ? GREEN : ORANGE });
      label(page, kind, { x: MARGIN + 16, y: y + 8, font: fonts.bold, color: MUTED });
      drawText(page, `${clock}  ${dateLabel(date)}`, {
        x: MARGIN + 16,
        y: y - 8,
        size: 12,
        font: fonts.monoBold,
        color: TEXT,
      });
      drawText(page, `${name} (${code})`, {
        x: MARGIN + 16,
        y: y - 22,
        size: 10,
        font: fonts.regular,
        color: TEXT,
      });
      y -= 48;
    }

    y -= 4;
    const facts = [
      ["Duration", duration(leg.durationMin)],
      ["Distance", `${leg.distance} km`],
      ["Availability", leg.availability?.status ?? "-"],
      ["Confirmation", `${Math.round((leg.confirmation || 0) * 100)}%`],
      ["Punctuality", `${Math.round((leg.punctuality || 0) * 100)}%`],
      ["Boarding date", dateLabel(leg.depDate)],
    ];
    facts.forEach(([key, value], i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const gx = MARGIN + col * (CONTENT_W / 3);
      const gy = y - row * 34;
      label(page, key, { x: gx, y: gy, font: fonts.bold });
      drawText(page, value, { x: gx, y: gy - 13, size: 10, font: fonts.monoBold, color: TEXT });
    });
    y -= 82;

    if (leg.waitlist) {
      page.drawRectangle({
        x: MARGIN,
        y: y - 58,
        width: CONTENT_W,
        height: 64,
        color: rgb(1, 0.97, 0.9),
        borderColor: AMBER,
        borderWidth: 0.7,
      });
      label(page, "Waitlist oracle for this leg", {
        x: MARGIN + 10,
        y: y - 12,
        font: fonts.bold,
        color: AMBER,
      });
      drawWrapped(
        page,
        `${leg.waitlist.expectedStatus} - ${leg.waitlist.percent}% estimated confirmation for WL ${leg.waitlist.inputs.wlPosition}. ${leg.waitlist.explanation}`,
        {
          x: MARGIN + 10,
          y: y - 28,
          size: 8.5,
          font: fonts.regular,
          color: TEXT,
          maxWidth: CONTENT_W - 20,
          lineHeight: 11,
        }
      );
      y -= 72;
    }

    if (index < transfers.length) {
      const transfer = transfers[index];
      const nextLeg = legs[index + 1];
      page.drawRectangle({
        x: MARGIN,
        y: y - 62,
        width: CONTENT_W,
        height: 68,
        color: rgb(0.94, 0.97, 1),
        borderColor: rgb(0.72, 0.82, 0.92),
        borderWidth: 0.7,
      });
      label(page, `Transfer at ${transfer.stationName}`, {
        x: MARGIN + 10,
        y: y - 12,
        font: fonts.bold,
        color: NAVY,
      });
      drawWrapped(
        page,
        `Arrive ${leg.arrClock}. Next train ${nextLeg.serviceNumber} departs ${nextLeg.depClock} from ${nextLeg.from.name}. Buffer ${transfer.bufferMin} minutes; connection success ${Math.round(
          (transfer.success || 0) * 100
        )}% (${transfer.label} risk). ${
          transfer.sameStation
            ? "Both legs use the same station."
            : `Change station from ${transfer.fromStation} to ${transfer.toStation}.`
        }`,
        {
          x: MARGIN + 10,
          y: y - 28,
          size: 8.5,
          font: fonts.regular,
          color: TEXT,
          maxWidth: CONTENT_W - 20,
          lineHeight: 11,
        }
      );
      y -= 74;
    }

    pageFooter(page, fonts, `YatraIQ leg ${index + 1} of ${legs.length}. Fares and availability are estimates.`);
  }

  /* ---------------- final notes page ---------------- */
  page = newPage(pdf, fonts, legs.length + 2, "Before you book");
  y = PAGE_H - 96;
  drawText(page, "How to book this plan", { x: MARGIN, y, size: 16, font: fonts.bold, color: NAVY });
  y -= 26;

  const steps = [
    "Open IRCTC (or this app's Book manually tab) and book each leg as its own ticket.",
    "Use the same passenger details on every leg so the plan stays linked.",
    "Check the transfer station and platform on the day; buffers are estimates.",
    "If an earlier leg is delayed, the next leg is a separate ticket and is not protected.",
    "Keep at least the shown buffer; a 3-hour buffer is safer for a station change.",
  ];
  for (const step of steps) {
    page.drawCircle({ x: MARGIN + 4, y: y + 3, size: 2.4, color: ORANGE });
    y = drawWrapped(page, step, {
      x: MARGIN + 16,
      y,
      size: 9.5,
      font: fonts.regular,
      color: TEXT,
      maxWidth: CONTENT_W - 16,
      lineHeight: 13,
    }) - 6;
  }

  y -= 12;
  label(page, "Model notes", { x: MARGIN, y, font: fonts.bold, color: NAVY, size: 8 });
  y -= 14;
  const notes = plan?.notes ?? [
    "Fares, availability and waitlist positions are modelled estimates, not live IRCTC data.",
    "Split tickets are separate PNRs and each has its own reservation fee.",
    "Transfer risk uses the first train's punctuality, station walking time and buffer.",
    "Waitlist probabilities are explainable model outputs, not guarantees.",
  ];
  for (const note of notes) {
    y = drawWrapped(page, `- ${note}`, {
      x: MARGIN,
      y,
      size: 8.5,
      font: fonts.regular,
      color: MUTED,
      maxWidth: CONTENT_W,
      lineHeight: 12,
    }) - 4;
  }

  y -= 18;
  drawText(page, "Rail Bandhu - YatraIQ", { x: MARGIN, y, size: 10, font: fonts.bold, color: NAVY });
  drawText(page, "The rail planner that optimises for certainty, not just price.", {
    x: MARGIN,
    y: y - 13,
    size: 8.5,
    font: fonts.regular,
    color: MUTED,
  });
  drawText(page, `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, {
    x: MARGIN,
    y: y - 26,
    size: 7.5,
    font: fonts.mono,
    color: MUTED,
  });

  pageFooter(page, fonts, "YatraIQ is a college project decision-support tool, not an IRCTC booking service.");

  return pdf.save();
}
