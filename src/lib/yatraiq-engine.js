/* ==================================================================
   YatraIQ decision engine
   ------------------------------------------------------------------
   Pure functions used by the browser, the Express server and the
   Cloudflare Worker. No network calls, no API keys, no quota use.

   The engine answers one question:
     "What is the best journey I can actually complete?"
   It combines split-ticket search, waitlist probability, transfer
   risk and alternate-date planning into one ranked answer.
   ================================================================== */

import {
  CLASS_META,
  CLASS_DOWNGRADE,
  QUOTA_META,
  PRIORITIES,
  STATIONS,
  SUPPORTED_STATIONS,
  TRANSFER_LINKS,
  SERVICES,
  ENGINE_VERSION,
  dateAdd,
  daysBetween,
  isWeekend,
  festivalPressure,
  serviceRunsOn,
  stationByCode,
  serviceByNumber,
} from "./yatraiq-data.js";

const DAY = 1440;

const CLASS_CONFIRMATION_BONUS = {
  SL: 0.04,
  "3A": 0.01,
  "3E": 0.02,
  "2A": -0.03,
  "1A": -0.06,
  CC: 0.03,
  EC: -0.01,
  "2S": 0.05,
};

const PRIORITY_WEIGHTS = {
  best: { price: 0.3, duration: 0.15, uncertainty: 0.4, risk: 0.15 },
  cheapest: { price: 0.6, duration: 0.15, uncertainty: 0.2, risk: 0.05 },
  fastest: { price: 0.15, duration: 0.6, uncertainty: 0.2, risk: 0.05 },
  safest: { price: 0.1, duration: 0.15, uncertainty: 0.25, risk: 0.5 },
  certainty: { price: 0.1, duration: 0.1, uncertainty: 0.7, risk: 0.1 },
};

/* ---------------- small helpers ---------------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function clockToMinutes(clock) {
  const [hours, minutes] = String(clock).split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToClock(minutes) {
  const normalized = ((minutes % DAY) + DAY) % DAY;
  return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function stationName(code) {
  return STATIONS[code]?.name ?? code;
}

function stationCity(code) {
  return STATIONS[code]?.city ?? code;
}

/* ---------------- fares ---------------- */

function distanceTaper(distance) {
  return 1 - Math.min(0.28, distance / 6000);
}

export function fareForSegment(distance, classCode, quota, service, date, festivalOverride) {
  const meta = CLASS_META[classCode];
  if (!meta) return 0;
  const quotaMeta = QUOTA_META[quota] ?? QUOTA_META.general;
  const base = Math.max(
    meta.minFare,
    distance * meta.perKm * distanceTaper(distance) + meta.reservationFee
  );
  const festival = festivalPressure(date, festivalOverride);
  const flexi = service.flexi ? 1 + service.demand * 0.22 + festival * 0.12 : 1;
  return Math.round((base * flexi * quotaMeta.multiplier) / 5) * 5;
}

/* ---------------- availability model ---------------- */

export function availabilityFor(service, date, classCode, quota, from, to, distance, passengers, options = {}) {
  const quotaMeta = QUOTA_META[quota] ?? QUOTA_META.general;
  const random = seededRandom(hashString(`${service.number}|${date}|${classCode}|${from}|${to}|${quota}`));

  if (quota === "tatkal" || quota === "premium") {
    return {
      status: "Available",
      count: 18 + Math.floor(random() * 42),
      wlPosition: 0,
      source: "model",
    };
  }

  const today = options.today ?? todayIso();
  const daysToDeparture = Math.max(0, daysBetween(today, date));
  const daysFactor = clamp(1 - daysToDeparture / 30, 0, 1);
  const festival = festivalPressure(date, options.festivalOverride);
  const fromPopularity = STATIONS[from]?.popularity ?? 0.5;
  const toPopularity = STATIONS[to]?.popularity ?? 0.5;
  const routePressure = (fromPopularity + toPopularity) / 2;
  const lengthFactor = clamp(distance / 1200, 0.3, 1);
  const quotaRelief = Math.min(0, quotaMeta.demandModifier);

  let load =
    service.demand * 1.0 +
    routePressure * 0.16 +
    festival * 0.18 +
    (isWeekend(date) ? 0.05 : 0) +
    random() * 0.1 -
    daysFactor * 0.2 +
    (service.flexi ? 0.15 : 0) +
    quotaRelief;

  /* Shorter segments are easier to confirm. This is what makes a split
     ticket useful when the through train is waitlisted. */
  load *= 0.55 + 0.45 * lengthFactor;
  load += (passengers - 1) * 0.015;

  if (load > 0.86) {
    const wlPosition = Math.max(1, Math.round(2 + (load - 0.86) * 120 + random() * 4));
    return { status: "Waitlist", count: wlPosition, wlPosition, source: "model" };
  }
  if (load > 0.72) {
    return {
      status: "RAC",
      count: 1 + Math.floor(random() * 20),
      wlPosition: 0,
      source: "model",
    };
  }
  return {
    status: "Available",
    count: 6 + Math.floor(random() * 58),
    wlPosition: 0,
    source: "model",
  };
}

/* ---------------- waitlist oracle ---------------- */

export function predictWaitlist(input = {}) {
  const wlPosition = Math.max(1, Math.round(Number(input.wlPosition) || 1));
  const classCode = CLASS_META[input.classCode] ? input.classCode : "SL";
  const quota = QUOTA_META[input.quota] ? input.quota : "general";
  const daysToDeparture = Math.max(0, Number(input.daysToDeparture ?? 10));
  const trainDemand = clamp(Number(input.trainDemand ?? 0.8), 0, 1);
  const festival = clamp(Number(input.festivalPressure ?? 0), 0, 1);
  const historicalClearance = clamp(Number(input.historicalClearance ?? 0.55), 0, 1);
  const passengers = Math.max(1, Math.round(Number(input.passengers) || 1));

  const wlFactor = clamp(1 - Math.log1p(wlPosition) / Math.log1p(150), 0, 1);
  const timeFactor = clamp(daysToDeparture / 30, 0, 1);
  const classBonus = CLASS_CONFIRMATION_BONUS[classCode] ?? 0;
  const quotaBonus = QUOTA_META[quota].confirmationBonus;

  let z =
    -1.2 +
    wlFactor * 2.4 +
    timeFactor * 0.9 +
    historicalClearance * 1.2 +
    classBonus * 2 +
    quotaBonus * 2 -
    trainDemand * 1.1 -
    festival * 1.0 -
    (passengers - 1) * 0.15;

  if (wlPosition <= 3) z += 0.3;
  if (wlPosition <= 10) z += 0.1;

  const probability = clamp(1 / (1 + Math.exp(-z)), 0.02, 0.97);
  const confidenceScore = clamp(
    0.42 +
      (daysToDeparture <= 7 ? 0.2 : daysToDeparture <= 15 ? 0.1 : 0) +
      (wlPosition <= 20 ? 0.12 : 0) +
      historicalClearance * 0.2,
    0.3,
    0.93
  );
  const confidenceLabel =
    confidenceScore >= 0.75 ? "High" : confidenceScore >= 0.55 ? "Medium" : "Low";
  const expectedStatus =
    probability >= 0.8
      ? "Likely confirmed"
      : probability >= 0.55
        ? "Borderline"
        : probability >= 0.3
          ? "Uncertain"
          : "Likely not confirmed";

  const factors = [
    {
      label: "Waitlist position",
      impact: wlPosition <= 15 ? "positive" : "negative",
      detail: `WL ${wlPosition}${wlPosition <= 10 ? " is close to the front of the queue" : " still has a long queue ahead"}.`,
      weight: Math.round(wlFactor * 100),
    },
    {
      label: "Days to departure",
      impact: daysToDeparture >= 7 ? "positive" : "negative",
      detail: `${daysToDeparture} day${daysToDeparture === 1 ? "" : "s"} left; ${daysToDeparture >= 7 ? "enough time for a second chart to clear" : "very little time for cancellations to appear"}.`,
      weight: Math.round(timeFactor * 100),
    },
    {
      label: "Historical clearance",
      impact: historicalClearance >= 0.55 ? "positive" : "negative",
      detail: `${Math.round(historicalClearance * 100)}% of similar waitlists cleared on this train in the seeded history.`,
      weight: Math.round(historicalClearance * 100),
    },
    {
      label: "Train demand",
      impact: trainDemand >= 0.75 ? "negative" : "positive",
      detail: `Demand index ${Math.round(trainDemand * 100)}/100 for this train and class.`,
      weight: Math.round(trainDemand * 100),
    },
    {
      label: "Festival / season",
      impact: festival >= 0.25 ? "negative" : "positive",
      detail:
        festival >= 0.25
          ? `${Math.round(festival * 100)}% seasonal pressure; cancellations are rarer.`
          : "No major festival pressure around this date.",
      weight: Math.round(festival * 100),
    },
    {
      label: "Quota",
      impact: quotaBonus > 0 ? "positive" : "neutral",
      detail: `${QUOTA_META[quota].label} quota${quotaBonus > 0 ? ` adds a ${Math.round(quotaBonus * 100)}% confirmation edge` : " behaves like general quota"}.`,
      weight: Math.round(quotaBonus * 100),
    },
  ];

  if (passengers > 1) {
    factors.push({
      label: "Passenger count",
      impact: "negative",
      detail: `${passengers} passengers need ${passengers} berths together, which is harder to clear.`,
      weight: (passengers - 1) * 8,
    });
  }

  const explanation = `${Math.round(probability * 100)}% confirmation for WL ${wlPosition} in ${CLASS_META[classCode].label} (${QUOTA_META[quota].label}). The biggest ${
    probability >= 0.55 ? "positive" : "negative"
  } factor is ${factors
    .slice()
    .sort((a, b) => (b.impact === "negative" ? b.weight : -b.weight) - (a.impact === "negative" ? a.weight : -a.weight))[0].label.toLowerCase()}.`;

  return {
    probability,
    percent: Math.round(probability * 100),
    confidence: confidenceScore,
    confidenceLabel,
    expectedStatus,
    factors,
    explanation,
    inputs: {
      wlPosition,
      classCode,
      quota,
      daysToDeparture,
      trainDemand,
      festivalPressure: festival,
      historicalClearance,
      passengers,
    },
  };
}

/* ---------------- transfer risk ---------------- */

export function transferRiskFor({
  bufferMin,
  stationCode,
  leg1Punctuality = 0.7,
  sameStation = true,
  stationChangeMinutes = 0,
  arrivalHour = 12,
}) {
  const station = STATIONS[stationCode];
  const transferMinutes = sameStation ? station?.transferMinutes ?? 12 : stationChangeMinutes;
  const requiredMinutes = transferMinutes + 8;
  const slack = bufferMin - requiredMinutes;
  const base = 1 / (1 + Math.exp(slack / 10));
  const punctualityPenalty = 1 - clamp(leg1Punctuality, 0, 1) * 0.65;
  const nightPenalty = arrivalHour >= 23 || arrivalHour <= 4 ? 0.03 : 0;
  const changePenalty = sameStation ? 0 : 0.05;
  const risk = clamp(base * punctualityPenalty + nightPenalty + changePenalty, 0.01, 0.65);
  const label = risk < 0.08 ? "Low" : risk < 0.18 ? "Medium" : "High";

  return {
    risk,
    success: 1 - risk,
    label,
    bufferMin,
    requiredMinutes,
    transferMinutes,
    slackMin: slack,
    sameStation,
    stationCode,
  };
}

/* ---------------- segment builder ---------------- */

const STOP_INDEX = new Map();
for (const service of SERVICES) {
  service.stops.forEach((stop, index) => {
    if (!STOP_INDEX.has(stop.code)) STOP_INDEX.set(stop.code, []);
    STOP_INDEX.get(stop.code).push({ service, index });
  });
}

function buildSegment(service, fromIndex, toIndex, serviceDate, baseDate, classCode, quota, passengers, options) {
  if (!service.classes.includes(classCode)) return null;
  const fromStop = service.stops[fromIndex];
  const toStop = service.stops[toIndex];
  if (!fromStop || !toStop || toStop.km <= fromStop.km) return null;
  if (!fromStop.dep || !toStop.arr) return null;
  if (!serviceRunsOn(service, serviceDate)) return null;

  const depDate = dateAdd(serviceDate, fromStop.day);
  const arrDate = dateAdd(serviceDate, toStop.day);
  const depAbs = daysBetween(baseDate, depDate) * DAY + clockToMinutes(fromStop.dep);
  const arrAbs = daysBetween(baseDate, arrDate) * DAY + clockToMinutes(toStop.arr);
  const durationMin = arrAbs - depAbs;
  if (durationMin <= 0) return null;

  const distance = toStop.km - fromStop.km;
  const price = fareForSegment(distance, classCode, quota, service, depDate, options.festivalOverride);
  const availability = availabilityFor(
    service,
    depDate,
    classCode,
    quota,
    fromStop.code,
    toStop.code,
    distance,
    passengers,
    options
  );

  const today = options.today ?? todayIso();
  const daysToDeparture = Math.max(0, daysBetween(today, depDate));
  const festival = festivalPressure(depDate, options.festivalOverride);

  let waitlist = null;
  let confirmation = 1;
  if (availability.status === "Available") {
    confirmation = 0.99;
  } else if (availability.status === "RAC") {
    confirmation = 0.9;
  } else {
    waitlist = predictWaitlist({
      wlPosition: availability.wlPosition,
      classCode,
      quota,
      daysToDeparture,
      trainDemand: service.demand,
      festivalPressure: festival,
      historicalClearance: service.clearance,
      passengers,
    });
    confirmation = waitlist.probability;
  }

  return {
    serviceNumber: service.number,
    serviceName: service.name,
    serviceType: service.type,
    from: { code: fromStop.code, name: stationName(fromStop.code), city: stationCity(fromStop.code) },
    to: { code: toStop.code, name: stationName(toStop.code), city: stationCity(toStop.code) },
    depDate,
    arrDate,
    depClock: fromStop.dep,
    arrClock: toStop.arr,
    depAbs,
    arrAbs,
    durationMin,
    distance,
    classCode,
    classLabel: CLASS_META[classCode].label,
    quota,
    quotaLabel: QUOTA_META[quota]?.label ?? "General",
    price,
    availability,
    confirmation,
    waitlist,
    punctuality: service.punctuality,
    flexi: service.flexi,
    /* Alternate-date searches set this on the itinerary, not on the leg.
       A train that started yesterday but boards today is still today's
       journey for the passenger. */
    dateOffset: 0,
  };
}

const SEGMENT_CACHE = new Map();

function segmentInstances(service, fromIndex, toIndex, baseDate, classCode, quota, passengers, options) {
  const key = `${service.number}|${fromIndex}|${toIndex}|${baseDate}|${classCode}|${quota}|${passengers}`;
  if (SEGMENT_CACHE.has(key)) return SEGMENT_CACHE.get(key);

  const instances = [];
  for (let offset = -1; offset <= 2; offset += 1) {
    const serviceDate = dateAdd(baseDate, offset);
    const segment = buildSegment(
      service,
      fromIndex,
      toIndex,
      serviceDate,
      baseDate,
      classCode,
      quota,
      passengers,
      options
    );
    if (segment) instances.push(segment);
  }
  instances.sort((a, b) => a.depAbs - b.depAbs);
  SEGMENT_CACHE.set(key, instances);
  if (SEGMENT_CACHE.size > 12000) SEGMENT_CACHE.clear();
  return instances;
}

function pickSegment(instances, earliestAbs) {
  return instances.find((segment) => segment.depAbs >= earliestAbs) ?? null;
}

/* ---------------- itinerary assembly ---------------- */

function buildItinerary(legs, transfers, meta) {
  if (legs.length === 0) return null;
  const first = legs[0];
  const last = legs[legs.length - 1];
  const pricePerPassenger = legs.reduce((sum, leg) => sum + leg.price, 0);
  const totalPrice = pricePerPassenger * meta.passengers;
  const totalDurationMin = last.arrAbs - first.depAbs;
  if (totalDurationMin <= 0) return null;

  let confirmation = 1;
  for (const leg of legs) confirmation *= leg.confirmation;
  for (const transfer of transfers) confirmation *= transfer.success;
  confirmation = clamp(confirmation, 0.01, 0.99);

  const transferRisk = 1 - transfers.reduce((product, transfer) => product * transfer.success, 1);
  const signature = legs
    .map((leg) => `${leg.serviceNumber}:${leg.from.code}-${leg.to.code}:${leg.depDate}`)
    .join("|");

  return {
    id: signature,
    signature,
    legs,
    transfers,
    legCount: legs.length,
    isSplit: legs.length > 1,
    totalPrice,
    pricePerPassenger,
    totalDurationMin,
    departure: first.depClock,
    arrival: last.arrClock,
    arrivalDayOffset: Math.floor(last.arrAbs / DAY),
    dateOffset: first.dateOffset,
    confirmation,
    confirmationPercent: Math.round(confirmation * 100),
    transferRisk,
    transferRiskPercent: Math.round(transferRisk * 100),
    classCode: meta.classCode,
    classLabel: CLASS_META[meta.classCode].label,
    quota: meta.quota,
    quotaLabel: QUOTA_META[meta.quota]?.label ?? "General",
    passengers: meta.passengers,
    summary: "",
    reasons: [],
    tags: [],
    score: 0,
    recommended: false,
    pareto: false,
  };
}

/* ---------------- formatting helpers ---------------- */

export function formatINR(amount) {
  const value = Number(amount) || 0;
  return `₹${new Intl.NumberFormat("en-IN").format(Math.round(value))}`;
}

export function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder}m`;
  return `${hours}h ${String(remainder).padStart(2, "0")}m`;
}

export function formatDateLabel(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function riskLabel(risk) {
  if (risk < 0.08) return "Low";
  if (risk < 0.18) return "Medium";
  return "High";
}

/* ---------------- Pareto frontier ---------------- */

function paretoFrontier(options) {
  const sorted = [...options].sort(
    (a, b) => a.totalPrice - b.totalPrice || b.confirmation - a.confirmation
  );
  const ids = [];
  let bestConfirmation = -1;
  for (const option of sorted) {
    if (option.confirmation > bestConfirmation + 0.0001) {
      ids.push(option.id);
      bestConfirmation = option.confirmation;
    }
  }
  return ids;
}

/* ---------------- ranking ---------------- */

function decorateOptions(options, priority) {
  if (options.length === 0) {
    return {
      options: [],
      recommendedId: null,
      paretoIds: [],
      stats: {
        total: 0,
        direct: 0,
        split: 0,
        cheapest: null,
        fastest: null,
        mostCertain: null,
        bestDirect: null,
        fastestDirect: null,
        premiumDirect: null,
        maxSaving: 0,
        maxSavingVsPremium: 0,
      },
    };
  }

  const prices = options.map((option) => option.totalPrice);
  const durations = options.map((option) => option.totalDurationMin);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  const weights = PRIORITY_WEIGHTS[priority] ?? PRIORITY_WEIGHTS.best;

  const cheapest = options.reduce((best, option) =>
    option.totalPrice < best.totalPrice ? option : best
  );
  const fastest = options.reduce((best, option) =>
    option.totalDurationMin < best.totalDurationMin ? option : best
  );
  const mostCertain = options.reduce((best, option) =>
    option.confirmation > best.confirmation ? option : best
  );
  const safest = options.reduce((best, option) =>
    option.transferRisk < best.transferRisk ? option : best
  );
  const directOptions = options.filter((option) => !option.isSplit);
  const bestDirect =
    directOptions.length > 0
      ? directOptions.reduce((best, option) =>
          option.totalPrice < best.totalPrice ? option : best
        )
      : null;
  const fastestDirect =
    directOptions.length > 0
      ? directOptions.reduce((best, option) =>
          option.totalDurationMin < best.totalDurationMin ? option : best
        )
      : null;
  const premiumDirect =
    directOptions.length > 0
      ? directOptions.reduce((best, option) =>
          option.totalPrice > best.totalPrice ? option : best
        )
      : null;

  for (const option of options) {
    /* Relative, not min-max: a Rs 110 difference should stay small even
       when the candidate set happens to be narrow. */
    const priceNorm = minPrice > 0 ? (option.totalPrice - minPrice) / minPrice : 0;
    const durationNorm =
      minDuration > 0 ? (option.totalDurationMin - minDuration) / minDuration : 0;
    const uncertainty = 1 - option.confirmation;

    option.score =
      weights.price * priceNorm +
      weights.duration * durationNorm +
      weights.uncertainty * uncertainty +
      weights.risk * option.transferRisk +
      (option.legCount - 1) * 0.04 +
      Math.abs(option.dateOffset) * 0.06;

    option.tags = [];
    if (option === cheapest) option.tags.push("Cheapest");
    if (option === fastest) option.tags.push("Fastest");
    if (option === mostCertain) option.tags.push("Most certain");
    if (option === safest && option.isSplit) option.tags.push("Safest transfer");
    option.tags.push(option.isSplit ? (option.legCount === 3 ? "3 trains" : "Split ticket") : "Direct");
    if (option.dateOffset > 0) option.tags.push("Next day");
    if (option.dateOffset < 0) option.tags.push("Previous day");

    option.summary = option.isSplit
      ? `Split at ${option.transfers.map((transfer) => transfer.station).join(" + ")} · ${option.legCount} trains`
      : `Direct · ${option.legs[0].serviceName}`;

    option.reasons = [];
    if (option.isSplit) {
      option.reasons.push(
        `Two-ticket plan via ${option.transfers
          .map((transfer) => transfer.stationName)
          .join(" and ")}.`
      );
    }
    if (option.transfers.length === 1) {
      const transfer = option.transfers[0];
      option.reasons.push(
        `${transfer.bufferMin}m buffer; ${Math.round(
          transfer.success * 100
        )}% connection success (${transfer.label.toLowerCase()} risk).`
      );
    }
    const waitlistedLeg = option.legs.find((leg) => leg.waitlist);
    if (waitlistedLeg) {
      option.reasons.push(
        `${waitlistedLeg.serviceNumber} is WL ${waitlistedLeg.availability.wlPosition} at ${Math.round(
          waitlistedLeg.confirmation * 100
        )}% confirmation.`
      );
    }
    if (option === cheapest) option.reasons.push("Cheapest total fare in this search.");
    if (option === fastest) option.reasons.push("Fastest journey in this search.");
    if (option === mostCertain) {
      option.reasons.push("Highest confirmation chance in this search.");
    }
    if (!option.isSplit) {
      option.reasons.push("One train end to end, so there is no missed-connection risk.");
    }
    if (option.dateOffset !== 0) {
      option.reasons.push(
        `Travel ${option.dateOffset > 0 ? "one day later" : "one day earlier"} to improve the odds.`
      );
    }
    if (bestDirect && option.isSplit) {
      const extra = option.totalPrice - bestDirect.totalPrice;
      const gain = option.confirmation - bestDirect.confirmation;
      if (extra < 0) {
        option.reasons.push(
          `Saves ${formatINR(-extra)} vs the cheapest direct option.`
        );
      } else if (extra > 0 && gain > 0.03) {
        option.reasons.push(
          `${formatINR(extra)} more than the cheapest direct, for +${Math.round(
            gain * 100
          )} points of certainty.`
        );
      }
    }
    if (
      premiumDirect &&
      option.isSplit &&
      option.totalPrice < premiumDirect.totalPrice
    ) {
      option.reasons.push(
        `Saves ${formatINR(
          premiumDirect.totalPrice - option.totalPrice
        )} vs the premium direct train.`
      );
    }
    option.reasons = option.reasons.slice(0, 4);
  }

  options.sort((a, b) => a.score - b.score || a.totalPrice - b.totalPrice);
  const paretoIds = paretoFrontier(options);
  options.forEach((option) => {
    option.pareto = paretoIds.includes(option.id);
  });

  const recommended = options[0] ?? null;
  if (recommended) recommended.recommended = true;

  return {
    options,
    recommendedId: recommended?.id ?? null,
    paretoIds,
    stats: {
      total: options.length,
      direct: directOptions.length,
      split: options.length - directOptions.length,
      cheapest: cheapest ? { id: cheapest.id, price: cheapest.totalPrice } : null,
      fastest: fastest ? { id: fastest.id, durationMin: fastest.totalDurationMin } : null,
      mostCertain: mostCertain
        ? { id: mostCertain.id, confirmation: mostCertain.confirmation }
        : null,
      bestDirect: bestDirect ? { id: bestDirect.id, price: bestDirect.totalPrice } : null,
      fastestDirect: fastestDirect
        ? { id: fastestDirect.id, durationMin: fastestDirect.totalDurationMin }
        : null,
      premiumDirect: premiumDirect
        ? { id: premiumDirect.id, price: premiumDirect.totalPrice }
        : null,
      maxSaving: bestDirect ? Math.max(0, bestDirect.totalPrice - cheapest.totalPrice) : 0,
      maxSavingVsPremium: premiumDirect
        ? Math.max(0, premiumDirect.totalPrice - cheapest.totalPrice)
        : 0,
    },
  };
}

/* ---------------- optimiser ---------------- */

export function optimizeJourney(input = {}) {
  const from = String(input.from || "").toUpperCase();
  const to = String(input.to || "").toUpperCase();
  const baseDate = input.date || dateAdd(todayIso(), 1);
  const classCode = CLASS_META[input.classCode] ? input.classCode : "SL";
  const quota = QUOTA_META[input.quota] ? input.quota : "general";
  const passengers = Math.max(1, Math.min(6, Math.round(Number(input.passengers) || 1)));
  const priority = PRIORITY_WEIGHTS[input.priority] ? input.priority : "best";
  const maxLegs = Math.max(1, Math.min(3, Math.round(Number(input.maxLegs) || 3)));
  const today = input.today ?? todayIso();
  const searchOptions = {
    today,
    festivalOverride: input.festivalOverride,
  };
  const meta = { classCode, quota, passengers };

  const query = {
    from,
    to,
    date: baseDate,
    classCode,
    quota,
    passengers,
    priority,
    maxLegs,
    classLabel: CLASS_META[classCode].label,
    quotaLabel: QUOTA_META[quota].label,
    fromName: stationName(from),
    toName: stationName(to),
  };

  const notes = [
    "Fares, availability and waitlist positions are modelled estimates, not live IRCTC data.",
    "The demo network covers 59 major stations and 50 real-world inspired services.",
    "Split tickets are booked as separate PNRs; each leg has its own reservation fee.",
    "Transfer risk uses the first train's punctuality, station walking time and buffer.",
    "Waitlist probabilities are explainable model outputs, not guarantees.",
  ];

  if (!STATIONS[from] || !STATIONS[to]) {
    return {
      engine: ENGINE_VERSION,
      query,
      options: [],
      recommendedId: null,
      paretoIds: [],
      stats: decorateOptions([], priority).stats,
      message: `YatraIQ's demo network covers ${SUPPORTED_STATIONS.length} major stations. Try Raipur → New Delhi, Delhi → Patna, Mumbai → Delhi or another highlighted corridor.`,
      notes,
      generatedAt: new Date().toISOString(),
    };
  }
  if (from === to) {
    return {
      engine: ENGINE_VERSION,
      query,
      options: [],
      recommendedId: null,
      paretoIds: [],
      stats: decorateOptions([], priority).stats,
      message: "Origin and destination must be different.",
      notes,
      generatedAt: new Date().toISOString(),
    };
  }
  if (baseDate < today) {
    return {
      engine: ENGINE_VERSION,
      query,
      options: [],
      recommendedId: null,
      paretoIds: [],
      stats: decorateOptions([], priority).stats,
      message: "Journey date cannot be in the past.",
      notes,
      generatedAt: new Date().toISOString(),
    };
  }

  SEGMENT_CACHE.clear();

  function collect(searchBaseDate) {
    const found = new Map();
    const add = (itinerary) => {
      if (itinerary && !found.has(itinerary.signature)) {
        found.set(itinerary.signature, itinerary);
      }
    };

    const segmentsFor = (service, fromIndex, toIndex) =>
      segmentInstances(
        service,
        fromIndex,
        toIndex,
        searchBaseDate,
        classCode,
        quota,
        passengers,
        searchOptions
      );

    /* direct trains */
    for (const entry of STOP_INDEX.get(from) ?? []) {
      const service = entry.service;
      for (let j = entry.index + 1; j < service.stops.length; j += 1) {
        if (service.stops[j].code !== to) continue;
        const leg = pickSegment(segmentsFor(service, entry.index, j), 0);
        if (!leg) continue;
        add(buildItinerary([leg], [], meta));
      }
    }

    /* two-leg splits */
    if (maxLegs >= 2) {
      for (const entry of STOP_INDEX.get(from) ?? []) {
        const first = entry.service;
        for (let j = entry.index + 1; j < first.stops.length; j += 1) {
          const transferCode = first.stops[j].code;
          if (transferCode === from || transferCode === to) continue;
          const leg1 = pickSegment(segmentsFor(first, entry.index, j), 0);
          if (!leg1) continue;

          const arrivalHour = Math.floor((leg1.arrAbs % DAY) / 60);
          const minBuffer = (STATIONS[transferCode]?.transferMinutes ?? 12) + 10;
          const earliest = leg1.arrAbs + minBuffer;

          for (const next of STOP_INDEX.get(transferCode) ?? []) {
            const second = next.service;
            if (second.number === first.number) continue;
            for (let l = next.index + 1; l < second.stops.length; l += 1) {
              if (second.stops[l].code !== to) continue;
              const leg2 = pickSegment(segmentsFor(second, next.index, l), earliest);
              if (!leg2) continue;
              const buffer = leg2.depAbs - leg1.arrAbs;
              if (buffer < minBuffer) continue;
              const transfer = transferRiskFor({
                bufferMin: buffer,
                stationCode: transferCode,
                leg1Punctuality: leg1.punctuality,
                arrivalHour,
              });
              add(
                buildItinerary(
                  [leg1, leg2],
                  [
                    {
                      ...transfer,
                      station: transferCode,
                      stationName: stationName(transferCode),
                      fromStation: transferCode,
                      toStation: transferCode,
                      sameStation: true,
                    },
                  ],
                  meta
                )
              );
            }
          }

          /* nearby-station changes (NDLS/NZM, CSMT/MMCT, SC/HYB, ...) */
          for (const link of TRANSFER_LINKS) {
            let otherCode = null;
            if (link.a === transferCode) otherCode = link.b;
            else if (link.b === transferCode) otherCode = link.a;
            if (!otherCode) continue;

            const changeBuffer = link.minutes + 8;
            const changeEarliest = leg1.arrAbs + changeBuffer;
            for (const next of STOP_INDEX.get(otherCode) ?? []) {
              const second = next.service;
              if (second.number === first.number) continue;
              for (let l = next.index + 1; l < second.stops.length; l += 1) {
                if (second.stops[l].code !== to) continue;
                const leg2 = pickSegment(segmentsFor(second, next.index, l), changeEarliest);
                if (!leg2) continue;
                const buffer = leg2.depAbs - leg1.arrAbs;
                if (buffer < changeBuffer) continue;
                const transfer = transferRiskFor({
                  bufferMin: buffer,
                  stationCode: otherCode,
                  leg1Punctuality: leg1.punctuality,
                  sameStation: false,
                  stationChangeMinutes: link.minutes,
                  arrivalHour,
                });
                add(
                  buildItinerary(
                    [leg1, leg2],
                    [
                      {
                        ...transfer,
                        station: `${transferCode} → ${otherCode}`,
                        stationName: `${stationName(transferCode)} → ${stationName(otherCode)}`,
                        fromStation: transferCode,
                        toStation: otherCode,
                        sameStation: false,
                      },
                    ],
                    meta
                  )
                );
              }
            }
          }
        }
      }
    }

    /* three-leg splits, limited to major hubs for speed */
    if (maxLegs >= 3) {
      const hubs = new Set(
        SUPPORTED_STATIONS.filter(
          (station) => station.tier <= 2 || station.popularity >= 0.55
        ).map((station) => station.code)
      );
      const pairSeen = new Set();
      let created = 0;

      outer: for (const entry of STOP_INDEX.get(from) ?? []) {
        const first = entry.service;
        for (let j = entry.index + 1; j < first.stops.length; j += 1) {
          const firstTransfer = first.stops[j].code;
          if (!hubs.has(firstTransfer) || firstTransfer === to || firstTransfer === from) {
            continue;
          }
          const leg1 = pickSegment(segmentsFor(first, entry.index, j), 0);
          if (!leg1) continue;

          const minBuffer1 = (STATIONS[firstTransfer]?.transferMinutes ?? 12) + 10;
          const earliest1 = leg1.arrAbs + minBuffer1;
          const arrivalHour1 = Math.floor((leg1.arrAbs % DAY) / 60);

          for (const next of STOP_INDEX.get(firstTransfer) ?? []) {
            const second = next.service;
            if (second.number === first.number) continue;
            for (let l = next.index + 1; l < second.stops.length; l += 1) {
              const secondTransfer = second.stops[l].code;
              if (
                !hubs.has(secondTransfer) ||
                secondTransfer === to ||
                secondTransfer === from ||
                secondTransfer === firstTransfer
              ) {
                continue;
              }
              const leg2 = pickSegment(segmentsFor(second, next.index, l), earliest1);
              if (!leg2) continue;
              const buffer1 = leg2.depAbs - leg1.arrAbs;
              if (buffer1 < minBuffer1) continue;

              const minBuffer2 = (STATIONS[secondTransfer]?.transferMinutes ?? 12) + 10;
              const earliest2 = leg2.arrAbs + minBuffer2;
              const arrivalHour2 = Math.floor((leg2.arrAbs % DAY) / 60);

              for (const third of STOP_INDEX.get(secondTransfer) ?? []) {
                const last = third.service;
                if (last.number === first.number || last.number === second.number) continue;
                for (let m = third.index + 1; m < last.stops.length; m += 1) {
                  if (last.stops[m].code !== to) continue;
                  const pairKey = `${firstTransfer}|${secondTransfer}|${last.number}`;
                  if (pairSeen.has(pairKey)) continue;
                  const leg3 = pickSegment(segmentsFor(last, third.index, m), earliest2);
                  if (!leg3) continue;
                  const buffer2 = leg3.depAbs - leg2.arrAbs;
                  if (buffer2 < minBuffer2) continue;

                  pairSeen.add(pairKey);
                  const transfer1 = transferRiskFor({
                    bufferMin: buffer1,
                    stationCode: firstTransfer,
                    leg1Punctuality: leg1.punctuality,
                    arrivalHour: arrivalHour1,
                  });
                  const transfer2 = transferRiskFor({
                    bufferMin: buffer2,
                    stationCode: secondTransfer,
                    leg1Punctuality: leg2.punctuality,
                    arrivalHour: arrivalHour2,
                  });
                  add(
                    buildItinerary(
                      [leg1, leg2, leg3],
                      [
                        {
                          ...transfer1,
                          station: firstTransfer,
                          stationName: stationName(firstTransfer),
                          fromStation: firstTransfer,
                          toStation: firstTransfer,
                          sameStation: true,
                        },
                        {
                          ...transfer2,
                          station: secondTransfer,
                          stationName: stationName(secondTransfer),
                          fromStation: secondTransfer,
                          toStation: secondTransfer,
                          sameStation: true,
                        },
                      ],
                      meta
                    )
                  );
                  created += 1;
                  if (created >= 300) break outer;
                }
              }
            }
          }
        }
      }
    }

    /* Keep at most two transfer points per train combination. This preserves
       meaningful alternatives (for example Bhopal vs Jhansi) without showing
       the same two trains five times. */
    const grouped = new Map();
    for (const itinerary of found.values()) {
      const key = itinerary.legs.map((leg) => leg.serviceNumber).join("+");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(itinerary);
    }
    const result = [];
    for (const list of grouped.values()) {
      list.sort(
        (a, b) =>
          a.totalDurationMin +
          (1 - a.confirmation) * 400 +
          a.transferRisk * 300 -
          (b.totalDurationMin + (1 - b.confirmation) * 400 + b.transferRisk * 300)
      );
      result.push(...list.slice(0, 2));
    }
    return result;
  }

  const all = collect(baseDate);

  /* alternate dates: keep the best few so the list stays readable */
  if (input.includeAlternateDates !== false) {
    for (const offset of [-1, 1]) {
      const alternateDate = dateAdd(baseDate, offset);
      if (alternateDate < today) continue;
      const alternate = collect(alternateDate)
        .sort((a, b) => b.confirmation - a.confirmation || a.totalPrice - b.totalPrice)
        .slice(0, 2);
      for (const itinerary of alternate) {
        itinerary.dateOffset = offset;
        itinerary.legs.forEach((leg) => {
          leg.depAbs += offset * DAY;
          leg.arrAbs += offset * DAY;
        });
        itinerary.arrivalDayOffset = Math.floor(
          itinerary.legs[itinerary.legs.length - 1].arrAbs / DAY
        );
        itinerary.id = `${itinerary.signature}|alt${offset}`;
        itinerary.signature = itinerary.id;
        all.push(itinerary);
      }
    }
  }

  /* Keep every direct option for comparison, then the best split options.
     Without this, an expensive Rajdhani can disappear behind 100 splits. */
  const candidateScore = (itinerary) =>
    itinerary.totalPrice +
    (1 - itinerary.confirmation) * 4000 +
    itinerary.totalDurationMin * 0.6;
  const directCandidates = all.filter((itinerary) => !itinerary.isSplit);
  const splitCandidates = all
    .filter((itinerary) => itinerary.isSplit)
    .sort((a, b) => candidateScore(a) - candidateScore(b))
    .slice(0, 110);
  const trimmed = [...directCandidates, ...splitCandidates].sort(
    (a, b) => candidateScore(a) - candidateScore(b)
  );

  const decorated = decorateOptions(trimmed, priority);

  return {
    engine: ENGINE_VERSION,
    query,
    ...decorated,
    message: decorated.options.length
      ? null
      : "No viable itinerary was found for this date and class. Try another class, date or corridor.",
    notes,
    generatedAt: new Date().toISOString(),
  };
}

/* ---------------- waitlist escape plan ---------------- */

export function buildEscapePlan(input = {}) {
  const from = String(input.from || "").toUpperCase();
  const to = String(input.to || "").toUpperCase();
  const date = input.date || dateAdd(todayIso(), 1);
  const classCode = CLASS_META[input.classCode] ? input.classCode : "SL";
  const quota = QUOTA_META[input.quota] ? input.quota : "general";
  const passengers = Math.max(1, Math.min(6, Math.round(Number(input.passengers) || 1)));
  const today = input.today ?? todayIso();
  const service = input.trainNumber ? serviceByNumber(input.trainNumber) : null;
  const wlPosition = Math.max(1, Math.round(Number(input.wlPosition) || 12));
  const daysToDeparture = Math.max(0, daysBetween(today, date));

  const currentPrediction = predictWaitlist({
    wlPosition,
    classCode,
    quota,
    daysToDeparture,
    trainDemand: service?.demand ?? 0.85,
    festivalPressure: festivalPressure(date, input.festivalOverride),
    historicalClearance: service?.clearance ?? 0.55,
    passengers,
  });

  const currentPrice = service
    ? fareForSegment(service.distance, classCode, quota, service, date, input.festivalOverride)
    : null;

  const current = {
    ...currentPrediction,
    trainNumber: service?.number ?? input.trainNumber ?? null,
    trainName: service?.name ?? null,
    price: currentPrice,
    classCode,
    classLabel: CLASS_META[classCode].label,
    quota,
    quotaLabel: QUOTA_META[quota].label,
    date,
  };

  const actions = [];
  const seen = new Set();

  function addAction(type, title, description, itinerary, extra = {}) {
    if (!itinerary || seen.has(itinerary.signature)) return;
    seen.add(itinerary.signature);
    actions.push({
      id: itinerary.signature,
      type,
      title,
      description,
      price: itinerary.totalPrice,
      priceDelta: currentPrice == null ? null : itinerary.totalPrice - currentPrice,
      confirmation: itinerary.confirmation,
      confirmationPercent: itinerary.confirmationPercent,
      gain: itinerary.confirmation - currentPrediction.probability,
      risk: itinerary.transferRisk,
      itinerary,
      ...extra,
    });
  }

  const sameDate = optimizeJourney({
    ...input,
    from,
    to,
    date,
    classCode,
    quota,
    passengers,
    today,
    includeAlternateDates: true,
    priority: "certainty",
  });

  const routeSeen = new Set();
  const ranked = [...sameDate.options].sort(
    (a, b) =>
      Math.abs(a.dateOffset) - Math.abs(b.dateOffset) ||
      b.confirmation - a.confirmation
  );
  for (const option of ranked) {
    if (option.confirmation < currentPrediction.probability + 0.05) continue;
    const routeKey = option.legs
      .map((leg) => `${leg.serviceNumber}:${leg.from.code}-${leg.to.code}`)
      .join("|");
    if (routeSeen.has(routeKey)) continue;
    routeSeen.add(routeKey);

    const when =
      option.dateOffset === 0
        ? ""
        : option.dateOffset > 0
          ? " (next day)"
          : " (previous day)";

    if (option.isSplit) {
      addAction(
        "split",
        `Split via ${option.transfers.map((transfer) => transfer.station).join(" + ")}${when}`,
        `${option.legCount} trains, ${option.confirmationPercent}% confirmation, ${formatDuration(
          option.totalDurationMin
        )} total.`,
        option
      );
    } else {
      addAction(
        "train",
        `Alternate train ${option.legs[0].serviceNumber}${when}`,
        `${option.legs[0].serviceName} at ${option.confirmationPercent}% confirmation.`,
        option
      );
    }
  }

  const lowerClass = CLASS_DOWNGRADE[classCode];
  if (lowerClass) {
    const lowerPlan = optimizeJourney({
      ...input,
      from,
      to,
      date,
      classCode: lowerClass,
      quota,
      passengers,
      today,
      includeAlternateDates: false,
      priority: "certainty",
    });
    for (const option of lowerPlan.options.slice(0, 2)) {
      if (option.confirmation < currentPrediction.probability + 0.05) continue;
      addAction(
        "class",
        `Switch to ${CLASS_META[lowerClass].label}`,
        `${option.confirmationPercent}% confirmation in ${CLASS_META[lowerClass].label}; fare ${formatINR(
          option.totalPrice
        )}.`,
        option
      );
    }
  }

  if (quota !== "tatkal" && quota !== "premium") {
    const tatkalPlan = optimizeJourney({
      ...input,
      from,
      to,
      date,
      classCode,
      quota: "tatkal",
      passengers,
      today,
      includeAlternateDates: false,
      priority: "certainty",
    });
    for (const option of tatkalPlan.options.slice(0, 2)) {
      addAction(
        "quota",
        `Tatkal on ${option.legs[0].serviceNumber}`,
        `Pay a premium for a ${option.confirmationPercent}% confirmation chance.`,
        option
      );
    }
  }

  actions.sort((a, b) => b.gain - a.gain || a.price - b.price);
  const top = actions.slice(0, 5);

  if (top.length === 0) {
    top.push({
      id: "book-both",
      type: "strategy",
      title: "Book both, cancel one",
      description:
        "Book the waitlisted ticket and a refundable backup on the split route. Cancel the backup if the waitlist clears. This is a strategy, not a guaranteed seat.",
      price: null,
      priceDelta: null,
      confirmation: currentPrediction.probability,
      confirmationPercent: currentPrediction.percent,
      gain: 0,
      risk: 0,
      itinerary: null,
    });
  }

  return {
    current,
    actions: top,
    note:
      "Escape plans are ranked by confirmation gain first, then price. All probabilities are model estimates, not IRCTC guarantees.",
  };
}

export {
  ENGINE_VERSION,
  STATIONS,
  SUPPORTED_STATIONS,
  SERVICES,
  PRIORITIES,
  CLASS_META,
  CLASS_DOWNGRADE,
  QUOTA_META,
  festivalPressure,
};

