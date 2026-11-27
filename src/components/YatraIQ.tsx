import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  Gauge,
  GitBranch,
  Info,
  Loader2,
  MapPin,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  Ticket,
  TrainFront,
  TrendingUp,
  Users,
  Wand2,
  Zap,
} from "lucide-react";
import {
  CLASS_META,
  PRIORITIES,
  QUOTA_META,
  SERVICES,
  SUPPORTED_STATIONS,
  buildEscapePlan,
  festivalPressure,
  formatDateLabel,
  formatDuration,
  formatINR,
  optimizeJourney,
  predictWaitlist,
  todayIso,
  type ClassCode,
  type EscapePlan,
  type Itinerary,
  type OptimizeResult,
  type PriorityId,
  type QuotaId,
} from "@/lib/yatraiq-engine";
import { ItineraryPdfError, downloadItineraryPdf } from "@/lib/yatraiqPdf";
import {
  AMBER,
  BLUE,
  BLUE_DARK,
  BLUE_LIGHT,
  FONT_BODY,
  FONT_MONO,
  GREEN,
  LINE,
  MUTED,
  ORANGE,
  RED,
  TEXT,
} from "@/theme";

/* ==================================================================
   YatraIQ - certainty-first journey planner
   ------------------------------------------------------------------
   The optimiser itself lives in lib/yatraiq-engine.js and runs locally,
   so this screen never spends RailRadar quota. The UI explains the
   recommendation, draws the Pareto frontier and lets the student demo
   waitlist probabilities and escape plans live.
   ================================================================== */

export interface YatraIQProps {
  onBookManually: (prefill: { from: string; to: string; date: string; cls: ClassCode }) => void;
  onBookLeg: (leg: Itinerary["legs"][number]) => void;
}

interface IqForm {
  from: string;
  to: string;
  date: string;
  classCode: ClassCode;
  quota: QuotaId;
  passengers: number;
  priority: PriorityId;
  maxLegs: number;
  alternate: boolean;
  festival?: number;
}

const CLASS_CHOICES: ClassCode[] = ["SL", "3A", "3E", "2A", "1A", "CC", "EC", "2S"];

const QUICK_ROUTES = [
  { from: "R", to: "NDLS", label: "Raipur → New Delhi" },
  { from: "BSP", to: "NDLS", label: "Bilaspur → New Delhi" },
  { from: "NDLS", to: "PNBE", label: "New Delhi → Patna" },
  { from: "MMCT", to: "NDLS", label: "Mumbai → New Delhi" },
  { from: "HWH", to: "NDLS", label: "Howrah → New Delhi" },
  { from: "BSP", to: "BBS", label: "Bilaspur → Bhubaneswar" },
];

const STATION_OPTIONS = [...SUPPORTED_STATIONS].sort((a, b) =>
  a.name.localeCompare(b.name)
);

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysFromToday(iso: string) {
  if (!iso) return 0;
  return Math.max(
    0,
    Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86400000)
  );
}

function confirmationColor(value: number) {
  if (value >= 0.8) return GREEN;
  if (value >= 0.55) return AMBER;
  return RED;
}

function riskColor(value: number) {
  if (value < 0.08) return GREEN;
  if (value < 0.18) return AMBER;
  return RED;
}

function stationLabel(code: string) {
  const station = SUPPORTED_STATIONS.find((item) => item.code === code);
  return station ? `${station.name} (${station.code})` : code;
}

function Tag({ children, tone = "blue" }: { children: ReactNode; tone?: "blue" | "green" | "orange" | "grey" | "red" }) {
  const tones = {
    blue: { bg: BLUE_LIGHT, fg: BLUE_DARK, border: "#C9DCEC" },
    green: { bg: "#EAF6EE", fg: GREEN, border: "#C6E4D0" },
    orange: { bg: "#FDF1E6", fg: "#A85A0B", border: "#F3D5B5" },
    grey: { bg: "#F2F5F8", fg: MUTED, border: LINE },
    red: { bg: "#FBECEC", fg: RED, border: "#EFC9C9" },
  } as const;
  const palette = tones[tone];
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: ".04em",
        textTransform: "uppercase",
        padding: "3px 7px",
        borderRadius: 4,
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/* ---------------- Pareto frontier chart ---------------- */

function ParetoChart({
  options,
  selectedId,
  recommendedId,
  onSelect,
}: {
  options: Itinerary[];
  selectedId: string | null;
  recommendedId: string | null;
  onSelect: (id: string) => void;
}) {
  const pareto = options.filter((option) => option.pareto);
  if (pareto.length < 2) return null;

  const prices = pareto.map((option) => option.totalPrice);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const width = 520;
  const height = 190;
  const left = 52;
  const right = 18;
  const top = 16;
  const bottom = 34;

  const cx = (price: number) =>
    left + ((price - minPrice) / (maxPrice - minPrice || 1)) * (width - left - right);
  const cy = (confirmation: number) =>
    top + (1 - confirmation) * (height - top - bottom);

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Price versus estimated confirmation frontier"
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={left}
              x2={width - right}
              y1={cy(tick)}
              y2={cy(tick)}
              stroke={LINE}
              strokeWidth={0.7}
              strokeDasharray={tick === 0 ? "0" : "3 4"}
            />
            <text x={left - 8} y={cy(tick) + 3} textAnchor="end" fontSize={9} fill={MUTED}>
              {Math.round(tick * 100)}%
            </text>
          </g>
        ))}
        {[minPrice, Math.round((minPrice + maxPrice) / 2), maxPrice].map((price) => (
          <text
            key={price}
            x={cx(price)}
            y={height - 12}
            textAnchor="middle"
            fontSize={9}
            fill={MUTED}
          >
            {formatINR(price)}
          </text>
        ))}
        <text x={left} y={height - 1} fontSize={8} fill={MUTED}>
          total fare →
        </text>
        <text x={10} y={top + 4} fontSize={8} fill={MUTED}>
          confirmation
        </text>

        {pareto.map((option) => {
          const isSelected = option.id === selectedId;
          const isRecommended = option.id === recommendedId;
          return (
            <g key={option.id} style={{ cursor: "pointer" }} onClick={() => onSelect(option.id)}>
              <circle
                cx={cx(option.totalPrice)}
                cy={cy(option.confirmation)}
                r={isSelected ? 7 : isRecommended ? 6 : 4.5}
                fill={isRecommended ? ORANGE : isSelected ? BLUE : GREEN}
                stroke={isSelected ? BLUE_DARK : "#fff"}
                strokeWidth={isSelected ? 2.5 : 1.4}
                opacity={0.95}
              >
                <title>
                  {option.summary} · {formatINR(option.totalPrice)} · {option.confirmationPercent}% confirmation
                </title>
              </circle>
              {isRecommended && (
                <text
                  x={cx(option.totalPrice) + 9}
                  y={cy(option.confirmation) - 7}
                  fontSize={8}
                  fill={ORANGE}
                  fontWeight={700}
                >
                  pick
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 10, color: MUTED, display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
        <span>
          <span style={{ color: ORANGE }}>●</span> YatraIQ pick
        </span>
        <span>
          <span style={{ color: GREEN }}>●</span> Pareto-optimal (nothing is both cheaper and more certain)
        </span>
        <span>Click a point to inspect it.</span>
      </div>
    </div>
  );
}

/* ---------------- one itinerary row ---------------- */

function OptionRow({
  option,
  selected,
  onSelect,
  onBookLeg,
}: {
  option: Itinerary;
  selected: boolean;
  onSelect: () => void;
  onBookLeg: (leg: Itinerary["legs"][number]) => void;
}) {
  const [open, setOpen] = useState(selected);
  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);

  const confirmation = option.confirmation;
  const confTone = confirmation >= 0.8 ? "green" : confirmation >= 0.55 ? "orange" : "red";

  return (
    <div
      className="card card-hover"
      style={{
        padding: 14,
        borderColor: selected ? BLUE_DARK : option.recommended ? ORANGE : LINE,
        borderWidth: selected || option.recommended ? 1.6 : 1,
        background: selected ? "#FBFDFF" : "#fff",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        style={{ cursor: "pointer", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}
      >
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>
            {option.recommended && <Tag tone="orange">YatraIQ pick</Tag>}
            {option.tags.map((tag) => (
              <Tag key={tag} tone={tag === "Split ticket" || tag === "3 trains" ? "blue" : tag === "Direct" ? "grey" : "green"}>
                {tag}
              </Tag>
            ))}
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 700, color: BLUE_DARK }}>
            {option.departure} <span style={{ color: MUTED, fontWeight: 400 }}>→</span> {option.arrival}
            {option.arrivalDayOffset > 0 && (
              <span style={{ fontSize: 10, color: MUTED, marginLeft: 5 }}>+{option.arrivalDayOffset}d</span>
            )}
            <span style={{ fontFamily: FONT_BODY, fontSize: 11, fontWeight: 400, color: MUTED, marginLeft: 10 }}>
              {formatDuration(option.totalDurationMin)}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: TEXT, marginTop: 3 }}>
            {option.isSplit
              ? option.legs.map((leg) => `${leg.serviceNumber} ${leg.serviceName}`).join("  +  ")
              : `${option.legs[0].serviceNumber} ${option.legs[0].serviceName}`}
          </div>
          <div style={{ fontSize: 10.5, color: MUTED, marginTop: 3 }}>
            {option.dateOffset === 0 ? formatDateLabel(option.legs[0].depDate) : `${formatDateLabel(option.legs[0].depDate)} · shifted date`}
            {option.transfers.length > 0 && ` · ${option.summary}`}
          </div>
        </div>

        <div style={{ textAlign: "right", flex: "0 0 auto" }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: TEXT }}>
            {formatINR(option.totalPrice)}
          </div>
          <div style={{ fontSize: 9.5, color: MUTED }}>for {option.passengers} pax</div>
          <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", marginTop: 6, flexWrap: "wrap" }}>
            <Tag tone={confTone}>{option.confirmationPercent}% confirmed</Tag>
            {option.transfers.length > 0 && (
              <Tag tone={option.transferRisk < 0.08 ? "green" : option.transferRisk < 0.18 ? "orange" : "red"}>
                {option.transferRiskPercent}% miss risk
              </Tag>
            )}
          </div>
        </div>

        <button
          type="button"
          className="btn-ghost"
          aria-label={open ? "Hide itinerary details" : "Show itinerary details"}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          style={{ padding: 6, borderRadius: 6 }}
        >
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${LINE}`, paddingTop: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {option.legs.map((leg, index) => (
              <div
                key={`${leg.serviceNumber}-${index}`}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                  background: "#F8FBFD",
                  border: `1px solid ${LINE}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                }}
              >
                <div style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, color: BLUE_DARK, minWidth: 52 }}>
                  {leg.depClock}
                </div>
                <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: TEXT }}>
                    <strong>{leg.from.name}</strong> → <strong>{leg.to.name}</strong>
                  </div>
                  <div style={{ fontSize: 10.5, color: MUTED }}>
                    {leg.serviceNumber} · {leg.serviceName} · {leg.classLabel} ·{" "}
                    {leg.availability.status === "Waitlist"
                      ? `WL ${leg.availability.wlPosition}`
                      : leg.availability.status}
                  </div>
                </div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: TEXT }}>{formatINR(leg.price)}</div>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => onBookLeg(leg)}
                  style={{ fontSize: 10.5, padding: "5px 9px" }}
                  title="Open this leg in the manual booking flow"
                >
                  Book leg
                </button>
              </div>
            ))}
          </div>

          {option.transfers.map((transfer, index) => (
            <div
              key={`${transfer.station}-${index}`}
              style={{
                marginTop: 8,
                fontSize: 11,
                color: transfer.risk < 0.08 ? GREEN : transfer.risk < 0.18 ? AMBER : RED,
                display: "flex",
                gap: 6,
                alignItems: "flex-start",
              }}
            >
              <GitBranch size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />
              <span>
                Transfer at <strong>{transfer.stationName}</strong> · {transfer.bufferMin}m buffer ·{" "}
                {Math.round(transfer.success * 100)}% connection success
                {transfer.sameStation ? " (same station)" : ` (change ${transfer.fromStation} → ${transfer.toStation})`}
              </span>
            </div>
          ))}

          {option.reasons.length > 0 && (
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 11, color: MUTED, lineHeight: 1.55 }}>
              {option.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          {option.legs.some((leg) => leg.waitlist) && (
            <div style={{ marginTop: 10, fontSize: 10.5, color: MUTED, display: "flex", gap: 6 }}>
              <Info size={12} style={{ flex: "0 0 auto", marginTop: 1 }} />
              Waitlist probabilities are model estimates. The split legs are separate PNRs and are not
              protected if an earlier train is delayed.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function YatraIQ({ onBookManually, onBookLeg }: YatraIQProps) {
  const [form, setForm] = useState<IqForm>({
    from: "R",
    to: "NDLS",
    date: addDays(todayIso(), 2),
    classCode: "3A",
    quota: "general",
    passengers: 1,
    priority: "best",
    maxLegs: 3,
    alternate: true,
  });
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfMessage, setPdfMessage] = useState("");
  const [escape, setEscape] = useState<EscapePlan | null>(null);
  const [escapeBusy, setEscapeBusy] = useState(false);
  const [wlPosition, setWlPosition] = useState(18);
  const [oracleTrain, setOracleTrain] = useState("");
  const [festivalPct, setFestivalPct] = useState(0);
  const [dateRows, setDateRows] = useState<
    Array<{ date: string; percent: number; price: number; trains: number }>
  >([]);
  const [dateBusy, setDateBusy] = useState(false);

  const festivalOverride = festivalPct > 0 ? festivalPct / 100 : undefined;

  function runSearch(overrides: Partial<IqForm> = {}) {
    const next = { ...form, ...overrides };
    setForm(next);
    setLoading(true);
    setError("");
    setEscape(null);
    setShowAll(false);
    setPdfMessage("");
    window.setTimeout(() => {
      try {
        const output = optimizeJourney({
          from: next.from,
          to: next.to,
          date: next.date,
          classCode: next.classCode,
          quota: next.quota,
          passengers: next.passengers,
          priority: next.priority,
          maxLegs: next.maxLegs,
          includeAlternateDates: next.alternate,
          festivalOverride,
        });
        setResult(output);
        setSelectedId(output.recommendedId ?? output.options[0]?.id ?? null);
        if (output.message) setError(output.message);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The optimiser could not run.");
        setResult(null);
      } finally {
        setLoading(false);
      }
    }, 40);
  }

  /* Run once with the demo defaults so the screen is never empty. */
  useEffect(() => {
    runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => result?.options.find((option) => option.id === selectedId) ?? result?.options[0] ?? null,
    [result, selectedId]
  );
  const bestDirect = useMemo(
    () => result?.options.find((option) => option.id === result.stats.bestDirect?.id) ?? null,
    [result]
  );
  const visibleOptions = showAll
    ? result?.options ?? []
    : (result?.options ?? []).slice(0, 6);

  const directTrains = useMemo(() => {
    const seen = new Map<string, { number: string; name: string }>();
    for (const option of result?.options ?? []) {
      if (option.isSplit) continue;
      const leg = option.legs[0];
      if (leg && !seen.has(leg.serviceNumber)) {
        seen.set(leg.serviceNumber, { number: leg.serviceNumber, name: leg.serviceName });
      }
    }
    return [...seen.values()];
  }, [result]);

  const activeTrain = oracleTrain || directTrains[0]?.number || "";
  const trainMeta = SERVICES.find((service) => service.number === activeTrain);
  const pressure = festivalPct > 0 ? festivalPct / 100 : form.date ? festivalPressure(form.date) : 0;
  const prediction = predictWaitlist({
    wlPosition,
    classCode: form.classCode,
    quota: form.quota,
    daysToDeparture: daysFromToday(form.date),
    trainDemand: trainMeta?.demand ?? 0.85,
    festivalPressure: pressure,
    historicalClearance: trainMeta?.clearance ?? 0.55,
    passengers: form.passengers,
  });

  const comparison = useMemo(() => {
    if (!selected || !bestDirect || selected.id === bestDirect.id) return null;
    return {
      priceDelta: selected.totalPrice - bestDirect.totalPrice,
      confDelta: Math.round((selected.confirmation - bestDirect.confirmation) * 100),
    };
  }, [selected, bestDirect]);

  function bookManually() {
    const first = selected?.legs[0];
    onBookManually({
      from: first?.from.code ?? form.from,
      to: first?.to.code ?? form.to,
      date: first?.depDate ?? form.date,
      cls: form.classCode,
    });
  }

  async function downloadPdf() {
    if (!selected) return;
    setPdfBusy(true);
    setPdfMessage("");
    try {
      await downloadItineraryPdf(selected, result?.notes);
      setPdfMessage("Stitched itinerary PDF downloaded.");
    } catch (cause) {
      setPdfMessage(
        cause instanceof ItineraryPdfError ? cause.message : "The itinerary PDF could not be created."
      );
    } finally {
      setPdfBusy(false);
    }
  }

  function runEscape() {
    setEscapeBusy(true);
    window.setTimeout(() => {
      try {
        const plan = buildEscapePlan({
          from: form.from,
          to: form.to,
          date: form.date,
          classCode: form.classCode,
          quota: form.quota,
          passengers: form.passengers,
          wlPosition,
          trainNumber: activeTrain || undefined,
          festivalOverride,
          today: todayIso(),
        });
        setEscape(plan);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The escape plan could not be built.");
      } finally {
        setEscapeBusy(false);
      }
    }, 40);
  }

  function compareDates() {
    if (!form.date) return;
    setDateBusy(true);
    window.setTimeout(() => {
      const rows: Array<{ date: string; percent: number; price: number; trains: number }> = [];
      for (let offset = 0; offset <= 3; offset += 1) {
        const date = addDays(form.date, offset);
        try {
          const output = optimizeJourney({
            from: form.from,
            to: form.to,
            date,
            classCode: form.classCode,
            quota: form.quota,
            passengers: form.passengers,
            priority: form.priority,
            maxLegs: form.maxLegs,
            includeAlternateDates: false,
            festivalOverride,
          });
          const best = output.options[0];
          if (best) {
            rows.push({
              date,
              percent: best.confirmationPercent,
              price: best.totalPrice,
              trains: best.legCount,
            });
          }
        } catch {
          /* Skip a date that cannot be optimised. */
        }
      }
      setDateRows(rows);
      setDateBusy(false);
    }, 40);
  }

  return (
    <div style={{ padding: "20px 20px 0" }}>
      {/* ---------------- hero ---------------- */}
      <section
        style={{
          background: `linear-gradient(145deg, ${BLUE_DARK}, ${BLUE})`,
          borderRadius: 10,
          padding: "24px 22px 28px",
          color: "#fff",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <Route
          size={190}
          color="rgba(255,255,255,.06)"
          style={{ position: "absolute", right: -40, bottom: -50 }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Sparkles size={16} color={ORANGE} />
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10.5,
              letterSpacing: ".14em",
              color: "#F7C08A",
              fontWeight: 600,
            }}
          >
            YATRAIQ · CERTAINTY-FIRST PLANNER
          </span>
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: "clamp(24px, 4vw, 34px)",
            lineHeight: 1.12,
            fontWeight: 700,
            maxWidth: 640,
            letterSpacing: "-.01em",
          }}
        >
          Book the journey you will actually complete.
        </h1>
        <p style={{ margin: "10px 0 0", fontSize: 13, color: "#D6E4F0", maxWidth: 660, lineHeight: 1.55 }}>
          One search compares direct trains, split tickets, waitlist odds and transfer risk — then
          recommends the plan with the best chance of a confirmed seat, not just the lowest fare.
        </p>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 16, fontSize: 10.5, color: "#BFD3E6" }}>
          <span>
            <strong style={{ color: "#fff" }}>{SUPPORTED_STATIONS.length}</strong> stations
          </span>
          <span>
            <strong style={{ color: "#fff" }}>{SERVICES.length}</strong> services
          </span>
          <span>
            <strong style={{ color: "#fff" }}>0</strong> API calls per search
          </span>
          <span>
            <strong style={{ color: "#fff" }}>100%</strong> explainable
          </span>
        </div>
      </section>

      {/* ---------------- search ---------------- */}
      <section
        className="card"
        style={{ padding: 16, marginTop: -16, position: "relative", zIndex: 2 }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            runSearch();
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <label htmlFor="iq-from" style={{ fontSize: 12, color: MUTED, display: "block", marginBottom: 4 }}>
                From
              </label>
              <select
                id="iq-from"
                className="field"
                value={form.from}
                onChange={(event) => setForm((prev) => ({ ...prev, from: event.target.value }))}
              >
                {STATION_OPTIONS.map((station) => (
                  <option key={station.code} value={station.code}>
                    {station.name} ({station.code})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setForm((prev) => ({ ...prev, from: prev.to, to: prev.from }))}
              aria-label="Swap stations"
              title="Swap stations"
              style={{ padding: 10, height: 42 }}
            >
              <ArrowLeftRight size={16} />
            </button>
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <label htmlFor="iq-to" style={{ fontSize: 12, color: MUTED, display: "block", marginBottom: 4 }}>
                To
              </label>
              <select
                id="iq-to"
                className="field"
                value={form.to}
                onChange={(event) => setForm((prev) => ({ ...prev, to: event.target.value }))}
              >
                {STATION_OPTIONS.map((station) => (
                  <option key={station.code} value={station.code}>
                    {station.name} ({station.code})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <div style={{ flex: "1 1 150px", minWidth: 140 }}>
              <label htmlFor="iq-date" style={{ fontSize: 12, color: MUTED, display: "block", marginBottom: 4 }}>
                Journey date
              </label>
              <input
                id="iq-date"
                type="date"
                className="field"
                min={todayIso()}
                value={form.date}
                onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
              />
            </div>
            <div style={{ flex: "1 1 110px" }}>
              <label htmlFor="iq-class" style={{ fontSize: 12, color: MUTED, display: "block", marginBottom: 4 }}>
                Class
              </label>
              <select
                id="iq-class"
                className="field"
                value={form.classCode}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, classCode: event.target.value as ClassCode }))
                }
              >
                {CLASS_CHOICES.map((code) => (
                  <option key={code} value={code}>
                    {code} · {CLASS_META[code].label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: "1 1 110px" }}>
              <label htmlFor="iq-quota" style={{ fontSize: 12, color: MUTED, display: "block", marginBottom: 4 }}>
                Quota
              </label>
              <select
                id="iq-quota"
                className="field"
                value={form.quota}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, quota: event.target.value as QuotaId }))
                }
              >
                {Object.values(QUOTA_META).map((quota) => (
                  <option key={quota.id} value={quota.id}>
                    {quota.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: "1 1 90px" }}>
              <label htmlFor="iq-pax" style={{ fontSize: 12, color: MUTED, display: "block", marginBottom: 4 }}>
                Passengers
              </label>
              <select
                id="iq-pax"
                className="field"
                value={form.passengers}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, passengers: Number(event.target.value) }))
                }
              >
                {[1, 2, 3, 4, 5, 6].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: "1 1 120px" }}>
              <label htmlFor="iq-legs" style={{ fontSize: 12, color: MUTED, display: "block", marginBottom: 4 }}>
                Max trains
              </label>
              <select
                id="iq-legs"
                className="field"
                value={form.maxLegs}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, maxLegs: Number(event.target.value) }))
                }
              >
                <option value={1}>Direct only</option>
                <option value={2}>Up to 2</option>
                <option value={3}>Up to 3</option>
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: TEXT }}>
              <input
                type="checkbox"
                checked={form.alternate}
                onChange={(event) => setForm((prev) => ({ ...prev, alternate: event.target.checked }))}
              />
              Include ±1 day alternatives
            </label>
            <div style={{ flex: "1 1 240px", display: "flex", gap: 6, flexWrap: "wrap" }}>
              {QUICK_ROUTES.map((route) => (
                <button
                  key={`${route.from}-${route.to}`}
                  type="button"
                  className="pill"
                  onClick={() => runSearch({ from: route.from, to: route.to })}
                  style={{ padding: "5px 9px", fontSize: 10.5, color: MUTED }}
                >
                  {route.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 14, borderTop: `1px solid ${LINE}`, paddingTop: 12 }}>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 7 }}>
              What matters most? The ranking changes with this choice.
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {PRIORITIES.map((priority) => (
                <button
                  key={priority.id}
                  type="button"
                  className={`pill${form.priority === priority.id ? " active" : ""}`}
                  title={priority.hint}
                  onClick={() => runSearch({ priority: priority.id })}
                  style={{ padding: "6px 11px", fontSize: 11.5 }}
                >
                  {priority.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
            <button
              type="submit"
              className="btn-primary"
              disabled={loading}
              style={{
                padding: "11px 20px",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 8,
                flex: "1 1 220px",
                justifyContent: "center",
              }}
            >
              {loading ? <Loader2 size={16} className="anim" /> : <Zap size={16} />}
              {loading ? "Optimising journeys…" : "Find the most certain journey"}
            </button>
            <span style={{ fontSize: 10.5, color: MUTED, flex: "1 1 220px" }}>
              Runs locally on 100 modelled services. Fares and availability are estimates; no
              RailRadar quota is used.
            </span>
          </div>
        </form>
      </section>

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "#FBECEC",
            border: `1px solid #EFC9C9`,
            borderRadius: 6,
            color: RED,
            fontSize: 12,
            display: "flex",
            gap: 7,
            alignItems: "flex-start",
          }}
        >
          <AlertTriangle size={14} style={{ flex: "0 0 auto", marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {loading && !result && (
        <div className="card" style={{ marginTop: 14, padding: 18 }}>
          <div className="skeleton" style={{ height: 16, width: "40%", marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 12, width: "70%", marginBottom: 8 }} />
          <div className="skeleton" style={{ height: 12, width: "55%" }} />
        </div>
      )}

      {/* ---------------- recommendation ---------------- */}
      {selected && result && (
        <section
          className="card"
          style={{ marginTop: 14, borderColor: ORANGE, borderWidth: 1.5, overflow: "hidden" }}
        >
          <div
            style={{
              background: "#FFF8F0",
              padding: "9px 16px",
              borderBottom: "1px solid #F3D5B5",
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Wand2 size={15} color={ORANGE} />
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: ".07em",
                  color: "#A85A0B",
                  textTransform: "uppercase",
                }}
              >
                YatraIQ recommendation
              </span>
            </div>
            <span style={{ fontSize: 10.5, color: MUTED }}>
              {result.stats.total} itineraries compared · {result.stats.direct} direct ·{" "}
              {result.stats.split} split
            </span>
          </div>

          <div style={{ padding: 16 }}>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                <div style={{ fontSize: 21, fontWeight: 700, color: BLUE_DARK, lineHeight: 1.2 }}>
                  {selected.legs[0].from.city}
                  <ArrowRight size={17} style={{ display: "inline", verticalAlign: "-2px", margin: "0 5px" }} />
                  {selected.legs[selected.legs.length - 1].to.city}
                </div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: TEXT, marginTop: 6 }}>
                  {selected.departure} → {selected.arrival}
                  {selected.arrivalDayOffset > 0 ? ` +${selected.arrivalDayOffset}d` : ""} ·{" "}
                  {formatDuration(selected.totalDurationMin)} · {formatDateLabel(selected.legs[0].depDate)}
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
                  {selected.legs.map((leg, index) => (
                    <span
                      key={`${leg.serviceNumber}-${index}`}
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10.5,
                        background: BLUE_LIGHT,
                        border: `1px solid #C9DCEC`,
                        borderRadius: 4,
                        padding: "3px 7px",
                        color: BLUE_DARK,
                      }}
                    >
                      {leg.serviceNumber} {leg.from.code}→{leg.to.code}
                    </span>
                  ))}
                </div>

                {comparison && (
                  <div style={{ marginTop: 12, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5 }}>
                    {comparison.confDelta !== 0 && (
                      <span style={{ color: comparison.confDelta > 0 ? GREEN : RED, fontWeight: 600 }}>
                        {comparison.confDelta > 0 ? "+" : ""}
                        {comparison.confDelta} pts confirmation vs cheapest direct
                      </span>
                    )}
                    <span style={{ color: comparison.priceDelta <= 0 ? GREEN : MUTED }}>
                      {comparison.priceDelta <= 0
                        ? `Saves ${formatINR(-comparison.priceDelta)}`
                        : `${formatINR(comparison.priceDelta)} more`}{" "}
                      than cheapest direct
                    </span>
                  </div>
                )}

                <ul style={{ margin: "12px 0 0", paddingLeft: 18, fontSize: 11.5, color: TEXT, lineHeight: 1.6 }}>
                  {selected.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>

              <div style={{ flex: "0 0 200px", textAlign: "right", minWidth: 170 }}>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 40,
                    fontWeight: 700,
                    lineHeight: 1,
                    color: confirmationColor(selected.confirmation),
                  }}
                >
                  {selected.confirmationPercent}%
                </div>
                <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>
                  estimated confirmation
                </div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 20, fontWeight: 700, color: TEXT, marginTop: 12 }}>
                  {formatINR(selected.totalPrice)}
                </div>
                <div style={{ fontSize: 10, color: MUTED }}>for {selected.passengers} passenger(s)</div>
                <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 8 }}>
                  <Tag tone={selected.transferRisk < 0.08 ? "green" : selected.transferRisk < 0.18 ? "orange" : "red"}>
                    {selected.transfers.length ? `${selected.transferRiskPercent}% transfer risk` : "No transfer"}
                  </Tag>
                  <Tag tone="blue">{selected.classLabel}</Tag>
                  <Tag tone="grey">{selected.quotaLabel}</Tag>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
              <button
                type="button"
                className="btn-primary"
                onClick={bookManually}
                style={{ padding: "10px 16px", fontSize: 12.5, display: "flex", alignItems: "center", gap: 7 }}
              >
                <Ticket size={15} /> {selected.isSplit ? "Book first leg" : "Book manually"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={downloadPdf}
                disabled={pdfBusy}
                style={{ padding: "10px 14px", fontSize: 12.5, display: "flex", alignItems: "center", gap: 7 }}
              >
                {pdfBusy ? <Loader2 size={15} className="anim" /> : <Download size={15} />}
                {pdfBusy ? "Building PDF…" : "Stitched PDF"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setShowAll((value) => !value)}
                style={{ padding: "10px 14px", fontSize: 12.5 }}
              >
                {showAll ? "Show top 6" : `Compare all ${result.stats.total}`}
              </button>
            </div>
            {selected.isSplit && (
              <div style={{ fontSize: 10.5, color: MUTED, marginTop: 8 }}>
                Split plans are separate PNRs. Use “Book leg” under each train to prefill the manual
                booking flow one leg at a time.
              </div>
            )}
            {pdfMessage && (
              <div
                style={{
                  fontSize: 11,
                  color: pdfMessage.includes("downloaded") ? GREEN : RED,
                  marginTop: 8,
                }}
              >
                {pdfMessage}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ---------------- Pareto frontier ---------------- */}
      {result && result.paretoIds.length > 1 && (
        <section className="card" style={{ marginTop: 12, padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <TrendingUp size={15} color={BLUE_DARK} />
              <span style={{ fontSize: 12, fontWeight: 600, color: BLUE_DARK }}>
                Price vs certainty frontier
              </span>
            </div>
            <span style={{ fontSize: 10.5, color: MUTED }}>
              Every dot is a Pareto-optimal plan in this search.
            </span>
          </div>
          <ParetoChart
            options={result.options}
            selectedId={selected?.id ?? null}
            recommendedId={result.recommendedId}
            onSelect={(id) => setSelectedId(id)}
          />
        </section>
      )}

      {/* ---------------- all options ---------------- */}
      {result && result.options.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <GitBranch size={15} color={BLUE_DARK} />
              <span style={{ fontSize: 13, fontWeight: 600, color: BLUE_DARK }}>
                All viable journeys
              </span>
              <span style={{ fontSize: 10.5, color: MUTED }}>
                ranked by “{PRIORITIES.find((item) => item.id === form.priority)?.label}”
              </span>
            </div>
            <span style={{ fontSize: 10.5, color: MUTED }}>
              Showing {visibleOptions.length} of {result.options.length}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleOptions.map((option) => (
              <OptionRow
                key={option.id}
                option={option}
                selected={option.id === selected?.id}
                onSelect={() => setSelectedId(option.id)}
                onBookLeg={onBookLeg}
              />
            ))}
          </div>

          {!showAll && result.options.length > visibleOptions.length && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowAll(true)}
              style={{ marginTop: 10, padding: "9px 14px", fontSize: 12, width: "100%" }}
            >
              Show all {result.options.length} journeys
            </button>
          )}
        </section>
      )}

      {/* ---------------- waitlist oracle ---------------- */}
      <section className="card" style={{ marginTop: 16, overflow: "hidden" }}>
        <div
          style={{
            background: BLUE_LIGHT,
            borderBottom: `1px solid ${LINE}`,
            padding: "11px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Gauge size={15} color={BLUE_DARK} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: BLUE_DARK }}>Waitlist Oracle</span>
            <span style={{ fontSize: 10.5, color: MUTED }}>
              explainable confirmation probability
            </span>
          </div>
          <Tag tone={prediction.percent >= 75 ? "green" : prediction.percent >= 45 ? "orange" : "red"}>
            {prediction.confidenceLabel} confidence
          </Tag>
        </div>

        <div style={{ padding: 16, display: "flex", gap: 22, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px", minWidth: 200 }}>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 44,
                fontWeight: 700,
                lineHeight: 1,
                color: confirmationColor(prediction.probability),
              }}
            >
              {prediction.percent}%
            </div>
            <div style={{ fontSize: 12, color: TEXT, fontWeight: 600, marginTop: 3 }}>
              {prediction.expectedStatus}
            </div>
            <div
              style={{
                height: 8,
                background: "#EDF2F7",
                borderRadius: 4,
                marginTop: 10,
                overflow: "hidden",
              }}
              role="progressbar"
              aria-valuenow={prediction.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                style={{
                  width: `${prediction.percent}%`,
                  height: "100%",
                  background: confirmationColor(prediction.probability),
                  transition: "width .25s",
                }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 14 }}>
              <div>
                <label htmlFor="iq-wl" style={{ fontSize: 11, color: MUTED, display: "flex", justifyContent: "space-between" }}>
                  <span>Waitlist position</span>
                  <span style={{ fontFamily: FONT_MONO, color: TEXT }}>WL {wlPosition}</span>
                </label>
                <input
                  id="iq-wl"
                  type="range"
                  min={1}
                  max={120}
                  value={wlPosition}
                  onChange={(event) => setWlPosition(Number(event.target.value))}
                  style={{ width: "100%", accentColor: ORANGE, marginTop: 4 }}
                />
              </div>
              <div>
                <label htmlFor="iq-oracle-train" style={{ fontSize: 11, color: MUTED, display: "block", marginBottom: 4 }}>
                  Train
                </label>
                <select
                  id="iq-oracle-train"
                  className="field"
                  value={activeTrain}
                  onChange={(event) => setOracleTrain(event.target.value)}
                  style={{ padding: "7px 9px", fontSize: 12 }}
                >
                  {directTrains.length === 0 && <option value="">No direct train in this search</option>}
                  {directTrains.map((train) => (
                    <option key={train.number} value={train.number}>
                      {train.number} · {train.name}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", gap: 10, fontSize: 10.5, color: MUTED, flexWrap: "wrap" }}>
                <span>
                  <CalendarDays size={11} style={{ verticalAlign: "-1px" }} /> {daysFromToday(form.date)}d to departure
                </span>
                <span>
                  <Users size={11} style={{ verticalAlign: "-1px" }} /> {form.passengers} pax
                </span>
                <span>{CLASS_META[form.classCode].label}</span>
              </div>
            </div>
          </div>

          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 7 }}>Why this number moved</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {prediction.factors.map((factor) => {
                const color =
                  factor.impact === "positive" ? GREEN : factor.impact === "negative" ? RED : MUTED;
                return (
                  <div key={factor.label}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10.5 }}>
                      <span style={{ color: TEXT }}>{factor.label}</span>
                      <span style={{ color, fontWeight: 600 }}>{factor.impact}</span>
                    </div>
                    <div style={{ height: 5, background: "#EDF2F7", borderRadius: 3, marginTop: 2 }}>
                      <div
                        style={{
                          width: `${Math.max(4, Math.min(100, factor.weight))}%`,
                          height: "100%",
                          background: color,
                          borderRadius: 3,
                          opacity: 0.75,
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 9.5, color: MUTED, marginTop: 2 }}>{factor.detail}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10.5, color: MUTED, marginTop: 10, lineHeight: 1.55 }}>
              {prediction.explanation}
            </div>
          </div>
        </div>

        <div
          style={{
            borderTop: `1px solid ${LINE}`,
            padding: "12px 16px",
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="btn-primary"
            onClick={runEscape}
            disabled={escapeBusy}
            style={{ padding: "9px 14px", fontSize: 12, display: "flex", alignItems: "center", gap: 7 }}
          >
            {escapeBusy ? <Loader2 size={14} className="anim" /> : <ShieldCheck size={14} />}
            {escapeBusy ? "Building plan…" : "Build waitlist escape plan"}
          </button>
          <span style={{ fontSize: 10.5, color: MUTED, flex: "1 1 260px" }}>
            The escape plan ranks split tickets, alternate trains, lower classes and Tatkal by how
            much confirmation they add.
          </span>
        </div>

        {escape && (
          <div style={{ borderTop: `1px dashed ${LINE}`, padding: 16, background: "#FBFDFF" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
              <Sparkles size={14} color={ORANGE} />
              <span style={{ fontSize: 12, fontWeight: 600, color: BLUE_DARK }}>
                Escape plan for WL {escape.current.inputs.wlPosition}
              </span>
              <span style={{ fontSize: 10.5, color: MUTED }}>
                now {escape.current.percent}% · {escape.current.classLabel} · {escape.current.quotaLabel}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {escape.actions.map((action) => {
                const tone =
                  action.type === "split"
                    ? "blue"
                    : action.type === "class"
                      ? "orange"
                      : action.type === "quota"
                        ? "green"
                        : "grey";
                return (
                  <div
                    key={action.id}
                    style={{
                      border: `1px solid ${LINE}`,
                      borderRadius: 6,
                      padding: "9px 11px",
                      background: "#fff",
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    <Tag tone={tone as "blue" | "green" | "orange" | "grey"}>
                      {action.type === "split"
                        ? "Split"
                        : action.type === "class"
                          ? "Lower class"
                          : action.type === "quota"
                            ? "Tatkal"
                            : action.type === "train"
                              ? "Other train"
                              : "Strategy"}
                    </Tag>
                    <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: TEXT }}>{action.title}</div>
                      <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>{action.description}</div>
                    </div>
                    <div style={{ textAlign: "right", flex: "0 0 auto" }}>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700, color: confirmationColor(action.confirmation) }}>
                        {action.confirmationPercent}%
                      </div>
                      <div style={{ fontSize: 10, color: GREEN }}>
                        +{Math.max(0, Math.round(action.gain * 100))} pts
                      </div>
                      <div style={{ fontSize: 10, color: MUTED }}>
                        {action.price == null ? "strategy" : formatINR(action.price)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: MUTED, marginTop: 9, lineHeight: 1.5 }}>{escape.note}</div>
          </div>
        )}
      </section>

      {/* ---------------- what-if simulator ---------------- */}
      <section className="card" style={{ marginTop: 16, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
          <Wand2 size={15} color={BLUE_DARK} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: BLUE_DARK }}>What-if simulator</span>
        </div>
        <div style={{ fontSize: 10.5, color: MUTED, marginBottom: 12 }}>
          Change the assumptions and watch the recommendation move. Nothing is saved or booked.
        </div>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 280px" }}>
            <label htmlFor="iq-festival" style={{ fontSize: 11, color: MUTED, display: "flex", justifyContent: "space-between" }}>
              <span>Festival / seasonal pressure</span>
              <span style={{ fontFamily: FONT_MONO, color: TEXT }}>
                {festivalPct === 0 ? "Auto" : `${festivalPct}%`}
              </span>
            </label>
            <input
              id="iq-festival"
              type="range"
              min={0}
              max={100}
              step={5}
              value={festivalPct}
              onChange={(event) => setFestivalPct(Number(event.target.value))}
              style={{ width: "100%", accentColor: ORANGE, marginTop: 5 }}
            />
            <div style={{ fontSize: 10, color: MUTED, marginTop: 3 }}>
              0% uses the built-in festival calendar. Higher pressure raises demand and lowers
              confirmation odds.
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => runSearch()}
              style={{ marginTop: 9, padding: "7px 12px", fontSize: 11.5 }}
            >
              Apply to the search
            </button>
          </div>

          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: MUTED }}>Date flexibility</span>
              <button
                type="button"
                className="btn-ghost"
                onClick={compareDates}
                disabled={dateBusy}
                style={{ padding: "5px 10px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}
              >
                {dateBusy ? <Loader2 size={12} className="anim" /> : <RefreshCw size={12} />}
                {dateBusy ? "Comparing…" : "Compare 4 dates"}
              </button>
            </div>

            {dateRows.length > 0 ? (
              <div style={{ marginTop: 8, border: `1px solid ${LINE}`, borderRadius: 6, overflow: "hidden" }}>
                {dateRows.map((row) => (
                  <div
                    key={row.date}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "7px 10px",
                      borderTop: `1px solid ${LINE}`,
                      fontSize: 11,
                      background: row.date === form.date ? BLUE_LIGHT : "#fff",
                    }}
                  >
                    <span style={{ fontFamily: FONT_MONO, flex: "1 1 130px" }}>
                      {formatDateLabel(row.date)}
                    </span>
                    <span style={{ color: MUTED, flex: "0 0 auto" }}>
                      {row.trains} train{row.trains === 1 ? "" : "s"}
                    </span>
                    <span style={{ fontFamily: FONT_MONO, flex: "0 0 auto" }}>{formatINR(row.price)}</span>
                    <span
                      style={{
                        fontFamily: FONT_MONO,
                        fontWeight: 700,
                        color: confirmationColor(row.percent / 100),
                        flex: "0 0 42px",
                        textAlign: "right",
                      }}
                    >
                      {row.percent}%
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 10.5, color: MUTED, marginTop: 9 }}>
                Compare today’s best plan with the next three dates to see whether waiting a day
                buys certainty.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ---------------- method note ---------------- */}
      <div
        style={{
          marginTop: 18,
          padding: "11px 13px",
          background: BLUE_LIGHT,
          border: `1px solid #C9DCEC`,
          borderRadius: 6,
          fontSize: 10.5,
          color: MUTED,
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: TEXT }}>How this demo works.</strong> YatraIQ runs a local model over{" "}
        {SERVICES.length} real-world inspired services and {SUPPORTED_STATIONS.length} stations. On long
        routes a through train is often waitlisted while shorter segments clear more easily — that is
        why a two-ticket plan can beat a direct ticket on certainty even when it costs a little more.
        Fares, availability and confirmation probabilities are estimates, not live IRCTC data. Split
        legs are separate PNRs and are not protected against a missed connection.
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12, fontSize: 10, color: "#9AAAB8" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <BadgeCheck size={11} /> Pareto-ranked options
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <ShieldCheck size={11} /> Transfer-risk aware
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Clock size={11} /> Alternate-date planning
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <TrainFront size={11} /> {SERVICES.length} services
        </span>
      </div>

    </div>
  );
}

