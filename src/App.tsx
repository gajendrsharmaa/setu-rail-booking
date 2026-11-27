import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronLeft,
  Clock,
  Info,
  Lock,
  MapPin,
  Printer,
  Search,
  Sparkles,
  Ticket,
  TrainFront,
  Users,
  Wifi,
} from "lucide-react";
import LiveTrainTracker from "@/components/LiveTrainTracker";
import PaymentGateway from "@/components/PaymentGateway";
import StationBoard from "@/components/StationBoard";
import StationPicker from "@/components/StationPicker";
import YatraIQ from "@/components/YatraIQ";
import {
  buildTrainResult,
  CLASS_META,
  fareFor,
  formatDuration,
  formatINR,
  formatJourneyDate,
  generateSeatMap,
  makePnr,
  QUOTAS,
  quotaById,
  quotaCodeFor,
  runDaysLabel,
  type ClassCode,
  type ClassOption,
  type PaymentReceipt,
  type SeatMap,
  type TrainResult,
} from "@/lib/booking";
import {
  friendlyApiError,
  getCoachComposition,
  getQuotaRemaining,
  getTrainsBetween,
  HAS_API_KEY,
  subscribeQuota,
  type CoachCompositionData,
} from "@/lib/railradar";
import { DEMO_TRAIN_TEMPLATES, demoTrainBetween } from "@/lib/demo";
import {
  availabilityForDate,
  fareBreakupRows,
  getBackendHealth,
  getRealAvailability,
  getRealFares,
  parseAvailability,
  type BackendHealth,
  type ParsedAvailability,
} from "@/lib/irctc";
import {
  downloadTicketDocument,
  sendTicketEmail,
  type TicketEmailPayload,
} from "@/lib/email";
import { getStation, stationTitle } from "@/lib/stations";
import {
  AMBER,
  BLUE,
  BLUE_DARK,
  BLUE_LIGHT,
  FONT_BODY,
  FONT_MONO,
  GlobalStyles,
  GREEN,
  LINE,
  MUTED,
  ORANGE,
  ORANGE_DARK,
  RED,
  TEXT,
  WHITE,
} from "@/theme";

/* ------------------------------------------------------------------ */

type Step = "search" | "results" | "seats" | "passengers" | "payment" | "confirm";

interface SearchState {
  from: string;
  to: string;
  date: string;
  quota: string;
  count: number;
}

interface SelectedSeat {
  key: string;
  coach: string;
  num: number;
  type: string;
}

interface Passenger {
  name: string;
  age: string;
  gender: string;
}

const CONVENIENCE_FEE = 40;

const STATUS_COLORS: Record<string, string> = {
  Available: GREEN,
  RAC: AMBER,
  Waitlist: RED,
};

const QUICK_ROUTES = [
  { from: "R", to: "BSP", label: "Raipur → Bilaspur" },
  { from: "R", to: "NDLS", label: "Raipur → New Delhi" },
  { from: "R", to: "NGP", label: "Raipur → Nagpur" },
  { from: "R", to: "DURG", label: "Raipur → Durg" },
  { from: "NDLS", to: "R", label: "New Delhi → Raipur" },
];

/* Coach-style seat layouts: seats per row and where the aisle / side-berth gaps go. */
const SEAT_LAYOUTS: Record<ClassCode, { perRow: number; gapsAfter: number[]; gapWidth: number }> = {
  SL: { perRow: 8, gapsAfter: [3, 6], gapWidth: 18 },
  "3A": { perRow: 8, gapsAfter: [3, 6], gapWidth: 18 },
  "3E": { perRow: 8, gapsAfter: [3, 6], gapWidth: 18 },
  "2A": { perRow: 6, gapsAfter: [2, 4], gapWidth: 18 },
  "1A": { perRow: 4, gapsAfter: [2], gapWidth: 18 },
  CC: { perRow: 6, gapsAfter: [3], gapWidth: 22 },
  EC: { perRow: 4, gapsAfter: [2], gapWidth: 22 },
  "2S": { perRow: 6, gapsAfter: [3], gapWidth: 22 },
};

/* ------------------------------------------------------------------ */

function pad(value: number) {
  return value < 10 ? `0${value}` : `${value}`;
}

function dateString(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addMinutesToIso(iso: string, minutes: number) {
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (!match) return iso;
  const total = Number(match[1]) * 60 + Number(match[2]) + minutes;
  const normalized = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
}

/** Real berth numbers/types from RailRadar's coach blueprint. */
function seatOptionsFromComposition(
  composition: CoachCompositionData | null,
  classCode: ClassCode,
  coachId: string
): { seatCount?: number; seatTypes?: string[] } {
  if (!composition) return {};
  const coachInfo = composition.rake.find((item) => item.code === coachId);
  const blueprint = composition.blueprints[classCode];
  const blueprintSeats = blueprint
    ? [...blueprint.cabins.flatMap((cabin) => [...cabin.main, ...cabin.side])].sort(
        (left, right) => left.number - right.number
      )
    : [];

  return {
    seatCount: coachInfo?.totalBerths || blueprint?.totalBerths || undefined,
    seatTypes:
      blueprintSeats.length > 0
        ? blueprintSeats.map((seat) => seat.name.replace(/\s*Berth$/i, ""))
        : undefined,
  };
}

/** Approximate how many berths to grey out from the live IRCTC count. */
function bookedRatioFor(availability: ParsedAvailability | null, totalBerths: number): number {
  if (!availability) return 0.2;
  if (availability.status === "Available") {
    return 1 - Math.min(availability.count, totalBerths) / Math.max(1, totalBerths);
  }
  if (availability.status === "RAC") return 0.85;
  return 0.95;
}

type EmailStatus = "idle" | "sending" | "sent" | "preview" | "failed";

interface EmailState {
  status: EmailStatus;
  message: string;
  previewUrl?: string;
}

interface SearchFormState {
  from: string;
  to: string;
  date: string;
  cls: ClassCode;
  quota: string;
  count: number;
}

const DEFAULT_FORM: SearchFormState = {
  from: "R",
  /* Raipur -> New Delhi has no direct train on many weekdays in the real
     timetable. In live mode the busiest Raipur route is a better landing
     page; Raipur -> New Delhi remains one click away in Quick routes. */
  to: HAS_API_KEY ? "BSP" : "NDLS",
  date: dateString(1),
  cls: "SL",
  quota: "general",
  count: 1,
};

const BOOKING_STORAGE_KEY = "railbandhu:booking:v1";

interface BookingSnapshot {
  version: 1;
  savedAt: string;
  step: Step;
  form: SearchFormState;
  search: SearchState | null;
  trains: TrainResult[];
  usingDemo: boolean;
  selectedTrain: TrainResult | null;
  selectedClass: ClassCode | null;
  coach: string;
  seatMaps: Record<string, SeatMap>;
  selectedSeats: SelectedSeat[];
  passengers: Passenger[];
  contact: { email: string; phone: string };
  pnr: string;
  receipt: PaymentReceipt | null;
  composition: CoachCompositionData | null;
  liveAvailability: ParsedAvailability | null;
  availabilityNote: string;
  emailState: EmailState;
  realFareTrains: number;
}

function loadBookingSnapshot(): BookingSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(BOOKING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BookingSnapshot;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveBookingSnapshot(snapshot: BookingSnapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BOOKING_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* localStorage full or blocked — the app still works for this visit */
  }
}

/* ------------------------------------------------------------------ */

function TearLine() {
  return (
    <div style={{ position: "relative", height: 1, margin: "0 -20px" }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, borderTop: `2px dashed ${LINE}` }} />
      <div
        style={{
          position: "absolute",
          left: -10,
          top: -9,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: WHITE,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: -10,
          top: -9,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: WHITE,
        }}
      />
    </div>
  );
}

function StepTrail({ step }: { step: Step }) {
  const steps = ["Search", "Select train", "Seats", "Details", "Payment", "Ticket"];
  const index = { search: 0, results: 1, seats: 2, passengers: 3, payment: 4, confirm: 5 }[step];

  return (
    <div className="flex items-center gap-1 flex-wrap no-print" style={{ fontFamily: FONT_MONO }}>
      {steps.map((label, stepIndex) => (
        <div key={label} className="flex items-center gap-1">
          <span
            className="flex items-center justify-center"
            style={{
              width: 20,
              height: 20,
              fontSize: 11,
              borderRadius: "50%",
              background: stepIndex <= index ? BLUE_DARK : "transparent",
              color: stepIndex <= index ? "#fff" : "#9AAAB8",
              border: `1px solid ${stepIndex <= index ? BLUE_DARK : LINE}`,
            }}
          >
            {stepIndex < index ? "✓" : stepIndex + 1}
          </span>
          <span style={{ fontSize: 11, color: stepIndex <= index ? TEXT : "#9AAAB8" }}>{label}</span>
          {stepIndex < steps.length - 1 && (
            <span style={{ width: 12, height: 1, background: LINE, display: "inline-block", margin: "0 2px" }} />
          )}
        </div>
      ))}
    </div>
  );
}

function FakeQr({ value, size = 104 }: { value: string; size?: number }) {
  const cells = 21;
  const grid = useMemo(() => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const random = () => {
      hash ^= hash << 13;
      hash ^= hash >>> 17;
      hash ^= hash << 5;
      return ((hash >>> 0) % 1000) / 1000;
    };

    const output: boolean[] = [];
    for (let y = 0; y < cells; y += 1) {
      for (let x = 0; x < cells; x += 1) {
        const inFinder =
          (x < 7 && y < 7) || (x >= cells - 7 && y < 7) || (x < 7 && y >= cells - 7);
        let dark = false;
        if (inFinder) {
          const localX = x >= cells - 7 ? x - (cells - 7) : x;
          const localY = y >= cells - 7 ? y - (cells - 7) : y;
          dark =
            localX === 0 ||
            localX === 6 ||
            localY === 0 ||
            localY === 6 ||
            (localX >= 2 && localX <= 4 && localY >= 2 && localY <= 4);
        } else {
          dark = random() > 0.54;
        }
        output.push(dark);
      }
    }
    return output;
  }, [value]);

  return (
    <div
      style={{
        width: size,
        height: size,
        padding: 5,
        background: "#fff",
        border: `1px solid ${LINE}`,
        borderRadius: 4,
        display: "grid",
        gridTemplateColumns: `repeat(${cells}, 1fr)`,
        gridTemplateRows: `repeat(${cells}, 1fr)`,
        gap: 0,
      }}
      aria-label="Simulated ticket QR code"
    >
      {grid.map((dark, index) => (
        <span key={index} style={{ background: dark ? TEXT : "#fff" }} />
      ))}
    </div>
  );
}

function DataNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2" style={{ fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
      <Info size={12} style={{ marginTop: 2, flex: "0 0 auto" }} />
      <span>{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function TrainBooking() {
  const [product, setProduct] = useState<"yatraiq" | "booking">("yatraiq");
  const [step, setStep] = useState<Step>("search");
  const [form, setForm] = useState<SearchFormState>(DEFAULT_FORM);

  const [search, setSearch] = useState<SearchState | null>(null);
  const [trains, setTrains] = useState<TrainResult[]>([]);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [usingDemo, setUsingDemo] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortBy, setSortBy] = useState("departure");

  const [selectedTrain, setSelectedTrain] = useState<TrainResult | null>(null);
  const [selectedClass, setSelectedClass] = useState<ClassCode | null>(null);
  const [coach, setCoach] = useState("");
  const [seatMaps, setSeatMaps] = useState<Record<string, SeatMap>>({});
  const [selectedSeats, setSelectedSeats] = useState<SelectedSeat[]>([]);
  const [seatWarning, setSeatWarning] = useState("");

  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [contact, setContact] = useState({ email: "", phone: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [pnr, setPnr] = useState("");
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [quota, setQuota] = useState<number | null>(getQuotaRemaining());
  const [liveTab, setLiveTab] = useState<"board" | "train">("board");

  const [backend, setBackend] = useState<BackendHealth | null>(null);
  const [fareEnriching, setFareEnriching] = useState(false);
  const [realFareTrains, setRealFareTrains] = useState(0);
  const [composition, setComposition] = useState<CoachCompositionData | null>(null);
  const [seatLoading, setSeatLoading] = useState(false);
  const [liveAvailability, setLiveAvailability] = useState<ParsedAvailability | null>(null);
  const [availabilityNote, setAvailabilityNote] = useState("");
  const [emailState, setEmailState] = useState<EmailState>({ status: "idle", message: "" });
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const enrichedFares = useRef<Set<string>>(new Set());

  /* Restore an in-progress booking after a page refresh. */
  useEffect(() => {
    const snapshot = loadBookingSnapshot();
    if (!snapshot) {
      setHydrated(true);
      return;
    }

    const hasBooking = Boolean(
      snapshot.selectedTrain && snapshot.selectedClass && snapshot.search
    );
    let restoredStep = snapshot.step;

    if (!["search", "results", "seats", "passengers", "payment", "confirm"].includes(restoredStep)) {
      restoredStep = "search";
    }
    if (restoredStep === "results" && (!snapshot.search || !snapshot.trains?.length)) {
      restoredStep = "search";
    }
    if (["seats", "passengers", "payment"].includes(restoredStep) && !hasBooking) {
      restoredStep = "search";
    }
    if (
      restoredStep === "seats" &&
      Object.keys(snapshot.seatMaps ?? {}).length === 0
    ) {
      restoredStep = "results";
    }
    if (restoredStep === "passengers" && (!snapshot.passengers?.length || !snapshot.selectedSeats?.length)) {
      restoredStep = "seats";
    }
    if (restoredStep === "payment" && (!snapshot.passengers?.length || !snapshot.selectedSeats?.length)) {
      restoredStep = "seats";
    }
    if (
      restoredStep === "confirm" &&
      (!hasBooking || !snapshot.pnr || !snapshot.receipt)
    ) {
      restoredStep = hasBooking ? "payment" : "search";
    }

    let restoredEmail: EmailState = snapshot.emailState?.status
      ? snapshot.emailState
      : { status: "idle", message: "" };
    if (restoredEmail.status === "sending") {
      restoredEmail = {
        status: "failed",
        message: "The page was refreshed while sending. Use Retry email.",
      };
    } else if (
      restoredStep === "confirm" &&
      !["sent", "preview", "failed"].includes(restoredEmail.status)
    ) {
      restoredEmail = {
        status: "failed",
        message: "Your booking was restored. Resend the e-ticket if needed.",
      };
    }

    setForm(snapshot.form ?? DEFAULT_FORM);
    setSearch(snapshot.search ?? null);
    setTrains(snapshot.trains ?? []);
    setUsingDemo(Boolean(snapshot.usingDemo));
    setSelectedTrain(snapshot.selectedTrain ?? null);
    setSelectedClass(snapshot.selectedClass ?? null);
    setCoach(snapshot.coach ?? "");
    setSeatMaps(snapshot.seatMaps ?? {});
    setSelectedSeats(snapshot.selectedSeats ?? []);
    setPassengers(snapshot.passengers ?? []);
    setContact(snapshot.contact ?? { email: "", phone: "" });
    setPnr(snapshot.pnr ?? "");
    setReceipt(snapshot.receipt ?? null);
    setComposition(snapshot.composition ?? null);
    setLiveAvailability(snapshot.liveAvailability ?? null);
    setAvailabilityNote(snapshot.availabilityNote ?? "");
    setEmailState(restoredEmail);
    setRealFareTrains(snapshot.realFareTrains ?? 0);
    setStep(restoredStep);
    setHydrated(true);
  }, []);

  /* Save progress on every meaningful change. */
  useEffect(() => {
    if (!hydrated) return;
    saveBookingSnapshot({
      version: 1,
      savedAt: new Date().toISOString(),
      step,
      form,
      search,
      trains,
      usingDemo,
      selectedTrain,
      selectedClass,
      coach,
      seatMaps,
      selectedSeats,
      passengers,
      contact,
      pnr,
      receipt,
      composition,
      liveAvailability,
      availabilityNote,
      emailState,
      realFareTrains,
    });
  }, [
    hydrated,
    step,
    form,
    search,
    trains,
    usingDemo,
    selectedTrain,
    selectedClass,
    coach,
    seatMaps,
    selectedSeats,
    passengers,
    contact,
    pnr,
    receipt,
    composition,
    liveAvailability,
    availabilityNote,
    emailState,
    realFareTrains,
  ]);

  useEffect(() => subscribeQuota(setQuota), []);
  useEffect(() => {
    document.title =
      product === "yatraiq"
        ? "Rail Bandhu YatraIQ — Certainty-first rail planner"
        : "Rail Bandhu — Train Ticket Booking";
  }, [product]);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step, product]);
  useEffect(() => {
    let cancelled = false;
    void getBackendHealth(true).then((health) => {
      if (!cancelled) setBackend(health);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- search ---------------- */

  async function runSearch(overrides: Partial<typeof form> = {}) {
    const next = { ...form, ...overrides };
    const nextErrors: Record<string, string> = {};

    if (!getStation(next.from)) nextErrors.from = "Pick a valid station";
    if (!getStation(next.to)) nextErrors.to = "Pick a valid station";
    if (next.from === next.to) nextErrors.to = "Destination must differ from origin";
    if (!next.date) nextErrors.date = "Pick a date of travel";
    else if (next.date < dateString(0)) nextErrors.date = "Date cannot be in the past";

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setForm(next);
    setSearch({
      from: next.from,
      to: next.to,
      date: next.date,
      quota: next.quota,
      count: next.count,
    });
    setStep("results");
    setResultsLoading(true);
    setResultsError(null);
    setUsingDemo(false);
    setRealFareTrains(0);
    setTrains([]);
    setTypeFilter("all");

    /* No RailRadar key: run the complete flow on bundled demo trains.
       This is the default on a fresh clone, so no .env setup is needed. */
    if (!HAS_API_KEY) {
      setTrains(buildDemoTrainList(next.from, next.to, next.date, next.quota));
      setUsingDemo(true);
      setResultsLoading(false);
      return;
    }

    try {
      const data = await getTrainsBetween(next.from, next.to, next.date);
      setTrains(data.trains.map((train) => buildTrainResult(train, next.date, next.quota)));
    } catch (error) {
      setResultsError(friendlyApiError(error));
    } finally {
      setResultsLoading(false);
    }
  }

  function buildDemoTrainList(fromCode: string, toCode: string, date: string, quota: string) {
    const fromName = getStation(fromCode)?.name ?? fromCode;
    const toName = getStation(toCode)?.name ?? toCode;
    return DEMO_TRAIN_TEMPLATES.map((template) =>
      buildTrainResult(demoTrainBetween(template, fromCode, fromName, toCode, toName), date, quota)
    );
  }

  function loadDemoTrains() {
    const fromCode = search?.from ?? form.from;
    const toCode = search?.to ?? form.to;
    const date = search?.date ?? form.date;
    const quota = search?.quota ?? form.quota;

    setTrains(buildDemoTrainList(fromCode, toCode, date, quota));
    setResultsError(null);
    setUsingDemo(true);
  }

  const visibleTrains = useMemo(() => {
    let list = trains;

    if (typeFilter !== "all") {
      const needle = typeFilter.toLowerCase();
      list = list.filter((train) =>
        `${train.name} ${train.type}`.toLowerCase().includes(needle)
      );
    }

    const sorted = [...list];
    if (sortBy === "duration") sorted.sort((a, b) => a.durMin - b.durMin);
    else if (sortBy === "arrival") sorted.sort((a, b) => a.arr.localeCompare(b.arr));
    else sorted.sort((a, b) => a.dep.localeCompare(b.dep));
    return sorted;
  }, [trains, typeFilter, sortBy]);

  /* Replace simulated class fares with real IRCTC fares where available. */
  useEffect(() => {
    if (step !== "results" || !search || !backend?.irctc || trains.length === 0) return;
    const quotaCode = quotaCodeFor(search.quota);
    const pending = trains
      .filter(
        (train) =>
          !enrichedFares.current.has(`${train.number}|${search.from}|${search.to}|${quotaCode}`)
      )
      .slice(0, 12);
    if (pending.length === 0) return;

    let cancelled = false;
    setFareEnriching(true);

    void (async () => {
      for (const train of pending) {
        const key = `${train.number}|${search.from}|${search.to}|${quotaCode}`;
        enrichedFares.current.add(key);
        try {
          const data = await getRealFares(train.number, search.from, search.to, quotaCode);
          if (cancelled) return;
          const byClass = new Map(
            (data.fares ?? []).map((fare) => [fare.class.toUpperCase(), fare])
          );
          const matched = train.classes.some((option) => {
            const real = byClass.get(option.code);
            return Boolean(real && Number.isFinite(real.totalFare) && real.totalFare > 0);
          });
          if (!matched) continue;

          setTrains((previous) =>
            previous.map((item) => {
              if (item.id !== train.id) return item;
              return {
                ...item,
                classes: item.classes.map((option) => {
                  const real = byClass.get(option.code);
                  if (!real || !Number.isFinite(real.totalFare) || real.totalFare <= 0) {
                    return option;
                  }
                  return {
                    ...option,
                    price: Math.round(real.totalFare),
                    source: "irctc" as const,
                    breakup: fareBreakupRows(real.breakup),
                  };
                }),
              };
            })
          );
          setRealFareTrains((count) => count + 1);
        } catch {
          /* keep the realistic simulated fare for this train */
        }
      }
      if (!cancelled) setFareEnriching(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [step, search, trains.length, backend?.irctc]);

  /* ---------------- seats ---------------- */

  async function chooseClass(train: TrainResult, classCode: ClassCode) {
    const meta = CLASS_META[classCode];
    const from = search?.from ?? form.from;
    const to = search?.to ?? form.to;
    const date = search?.date ?? form.date;
    const quotaCode = quotaCodeFor(search?.quota ?? form.quota);

    setSelectedTrain(train);
    setSelectedClass(classCode);
    setCoach(meta.coaches[0]);
    setSeatMaps({});
    setSelectedSeats([]);
    setSeatWarning("");
    setComposition(null);
    setLiveAvailability(null);
    setAvailabilityNote("");
    setSeatLoading(true);
    setForm((previous) => ({ ...previous, cls: classCode }));
    setStep("seats");

    const [fareResult, coachResult, availabilityResult] = await Promise.all([
      backend?.irctc
        ? getRealFares(train.number, from, to, quotaCode).catch(() => null)
        : Promise.resolve(null),
      getCoachComposition(train.number).catch(() => null),
      backend?.irctc
        ? getRealAvailability(train.number, from, to, date, classCode, quotaCode).catch(() => null)
        : Promise.resolve(null),
    ]);

    let nextTrain = train;
    if (fareResult?.fares) {
      const byClass = new Map(
        fareResult.fares.map((fare) => [fare.class.toUpperCase(), fare])
      );
      let anyReal = false;
      nextTrain = {
        ...train,
        classes: train.classes.map((option) => {
          const real = byClass.get(option.code);
          if (!real || !Number.isFinite(real.totalFare) || real.totalFare <= 0) return option;
          anyReal = true;
          return {
            ...option,
            price: Math.round(real.totalFare),
            source: "irctc" as const,
            breakup: fareBreakupRows(real.breakup),
          };
        }),
      };
      if (anyReal) {
        setSelectedTrain(nextTrain);
        setTrains((previous) =>
          previous.map((item) => (item.id === nextTrain.id ? nextTrain : item))
        );
      }
    }

    let parsed: ParsedAvailability | null = null;
    if (availabilityResult) {
      const row = availabilityForDate(availabilityResult, date);
      parsed = parseAvailability(row);
      if (parsed) {
        setLiveAvailability(parsed);
        setAvailabilityNote(row?.status ?? parsed.label);
      } else {
        setAvailabilityNote("IRCTC returned no availability rows for this date.");
      }
    } else if (backend?.irctc) {
      setAvailabilityNote(
        "Live IRCTC availability could not be loaded; showing a simulated count."
      );
    } else {
      setAvailabilityNote(
        HAS_API_KEY
          ? "Live IRCTC availability is not configured; showing a simulated count."
          : "Demo mode: simulated seat availability."
      );
    }

    if (coachResult) {
      setComposition(coachResult);
      const realCoaches = coachResult.rake.filter(
        (item) => item.hasSeats && item.classType.toUpperCase() === classCode
      );

      if (realCoaches.length > 0) {
        const first = realCoaches[0];
        const total = first.totalBerths || meta.seatCount;
        setCoach(first.code);
        setSeatMaps({
          [first.code]: generateSeatMap(
            `${train.number}-${first.code}-${classCode}`,
            classCode,
            {
              ...seatOptionsFromComposition(coachResult, classCode, first.code),
              bookedRatio: bookedRatioFor(parsed, total),
            }
          ),
        });
      } else {
        const fallback = meta.coaches[0];
        setCoach(fallback);
        setSeatMaps({
          [fallback]: generateSeatMap(
            `${train.number}-${fallback}-${classCode}`,
            classCode,
            { bookedRatio: bookedRatioFor(parsed, meta.seatCount) }
          ),
        });
        setAvailabilityNote((previous) =>
          `${previous ? `${previous} ` : ""}This rake has no ${classCode} coach; showing a simulated layout.`
        );
      }
    } else {
      const fallback = meta.coaches[0];
      setCoach(fallback);
      setSeatMaps({
        [fallback]: generateSeatMap(
          `${train.number}-${fallback}-${classCode}`,
          classCode,
          { bookedRatio: bookedRatioFor(parsed, meta.seatCount) }
        ),
      });
      setAvailabilityNote((previous) =>
        `${previous ? `${previous} ` : ""}Real coach composition unavailable; showing a simulated layout.`
      );
    }

    setSeatLoading(false);
  }

  function switchCoach(coachId: string) {
    if (!selectedTrain || !selectedClass) return;
    setCoach(coachId);
    setSeatMaps((previous) => {
      if (previous[coachId]) return previous;
      const options = seatOptionsFromComposition(composition, selectedClass, coachId);
      const total = options.seatCount ?? CLASS_META[selectedClass].seatCount;
      return {
        ...previous,
        [coachId]: generateSeatMap(
          `${selectedTrain.number}-${coachId}-${selectedClass}`,
          selectedClass,
          { ...options, bookedRatio: bookedRatioFor(liveAvailability, total) }
        ),
      };
    });
  }

  function toggleSeat(seat: { num: number; type: string; booked: boolean }) {
    if (seat.booked) return;
    const key = `${coach}-${seat.num}`;
    setSeatWarning("");

    const exists = selectedSeats.find((item) => item.key === key);
    if (exists) {
      setSelectedSeats(selectedSeats.filter((item) => item.key !== key));
      return;
    }

    if (selectedSeats.length >= form.count) {
      setSeatWarning(
        `You can select only ${form.count} seat${form.count === 1 ? "" : "s"} for this booking.`
      );
      return;
    }

    setSelectedSeats([...selectedSeats, { key, coach, num: seat.num, type: seat.type }]);
  }

  function seatFare() {
    if (!selectedTrain || !selectedClass) return 0;
    const option = selectedTrain.classes.find((item) => item.code === selectedClass);
    return (option?.price ?? 0) * selectedSeats.length;
  }

  function totalFare() {
    return seatFare() + CONVENIENCE_FEE;
  }

  function proceedFromSeats() {
    setPassengers(selectedSeats.map(() => ({ name: "", age: "", gender: "Male" })));
    setErrors({});
    setStep("passengers");
  }

  function updatePassenger(index: number, field: keyof Passenger, value: string) {
    setPassengers((previous) =>
      previous.map((passenger, passengerIndex) =>
        passengerIndex === index ? { ...passenger, [field]: value } : passenger
      )
    );
  }

  function validatePassengers() {
    const nextErrors: Record<string, string> = {};
    const quotaId = search?.quota ?? form.quota;

    passengers.forEach((passenger, index) => {
      if (passenger.name.trim().length < 2) nextErrors[`name${index}`] = "Enter the passenger's full name";
      const age = Number(passenger.age);
      if (!passenger.age || !Number.isInteger(age) || age < 1 || age > 120) {
        nextErrors[`age${index}`] = "Enter a valid age (1–120)";
      } else if (quotaId === "ladies" && passenger.gender !== "Female" && age >= 12) {
        nextErrors[`quota${index}`] =
          "Ladies quota is only for female passengers and children under 12";
      } else if (quotaId === "senior") {
        const threshold = passenger.gender === "Female" ? 58 : 60;
        if (age < threshold) {
          nextErrors[`quota${index}`] = `Senior Citizens quota needs age ${threshold}+`;
        }
      }
    });

    if (
      quotaId === "ladies" &&
      passengers.length > 0 &&
      !passengers.some((passenger) => passenger.gender === "Female")
    ) {
      nextErrors.quota = "Ladies quota needs at least one female passenger";
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())) {
      nextErrors.email = "Enter a valid email address";
    }

    const phoneDigits = contact.phone.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
    if (!/^[6-9]\d{9}$/.test(phoneDigits)) {
      nextErrors.phone = "Enter a valid 10-digit Indian mobile number";
    }

    return nextErrors;
  }

  function handlePassengerSubmit(event: FormEvent) {
    event.preventDefault();
    const nextErrors = validatePassengers();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setStep("payment");
  }

  function buildTicketPayload(
    nextPnr: string,
    nextReceipt: PaymentReceipt
  ): TicketEmailPayload | null {
    if (!selectedTrain || !selectedClass || !search) return null;
    const option = selectedTrain.classes.find((item) => item.code === selectedClass);
    const fromStation = getStation(search.from);
    const toStation = getStation(search.to);
    const passengerCount = passengers.length || selectedSeats.length;
    const breakup = option?.breakup?.map((row) => ({
      label: `${row.label} × ${passengerCount}`,
      amount: row.amount * passengerCount,
    }));

    return {
      pnr: nextPnr,
      train: { name: selectedTrain.name, number: selectedTrain.number },
      classLabel: CLASS_META[selectedClass].label,
      classCode: selectedClass,
      quotaLabel: quotaById(search.quota).label,
      from: { name: fromStation?.name ?? search.from, code: search.from },
      to: { name: toStation?.name ?? search.to, code: search.to },
      date: formatJourneyDate(search.date),
      departure: selectedTrain.dep,
      arrival: selectedTrain.arr,
      dayOffset: selectedTrain.dayOffset,
      duration: formatDuration(selectedTrain.durMin),
      distance: String(Math.round(selectedTrain.distance)),
      passengers: passengers.map((passenger, index) => ({
        name: passenger.name,
        age: passenger.age,
        gender: passenger.gender,
        coach: selectedSeats[index]?.coach ?? "",
        seat: selectedSeats[index]?.num ?? "",
        berth: selectedSeats[index]?.type ?? "",
      })),
      fare: {
        base: seatFare(),
        fee: CONVENIENCE_FEE,
        total: totalFare(),
        breakup,
      },
      payment: {
        methodLabel: nextReceipt.methodLabel,
        detail: nextReceipt.detail,
        txnId: nextReceipt.txnId,
        authCode: nextReceipt.authCode,
        paidAt: nextReceipt.paidAt,
        amount: nextReceipt.amount,
      },
      contact: { email: contact.email.trim(), phone: contact.phone },
    };
  }

  async function sendTicketEmailNow(nextPnr: string, nextReceipt: PaymentReceipt) {
    const payload = buildTicketPayload(nextPnr, nextReceipt);
    if (!payload) {
      setEmailState({ status: "failed", message: "Ticket details are incomplete." });
      return;
    }

    setEmailState({
      status: "sending",
      message: `Sending the e-ticket and invoice to ${payload.contact.email}…`,
    });

    try {
      const result = await sendTicketEmail(payload.contact.email, payload);
      if (result.mode === "ethereal" || result.mode === "preview") {
        setEmailState({
          status: "preview",
          message: result.message || "Test email captured for the demo.",
          previewUrl: result.previewUrl ?? undefined,
        });
      } else {
        setEmailState({
          status: "sent",
          message: result.message || `Ticket emailed to ${payload.contact.email}.`,
        });
      }
    } catch (error) {
      setEmailState({
        status: "failed",
        message: error instanceof Error ? error.message : "The email could not be sent.",
      });
    }
  }

  async function downloadTicket() {
    if (!ticketEmailPayload) return;
    setDownloading(true);
    setDownloadError("");
    try {
      await downloadTicketDocument(ticketEmailPayload);
    } catch (error) {
      setDownloadError(
        error instanceof Error
          ? error.message
          : "The ticket file could not be downloaded."
      );
    } finally {
      setDownloading(false);
    }
  }

  function handlePaymentSuccess(nextReceipt: PaymentReceipt) {
    const nextPnr = makePnr();
    setReceipt(nextReceipt);
    setPnr(nextPnr);
    setStep("confirm");
    void sendTicketEmailNow(nextPnr, nextReceipt);
  }

  function resetAll() {
    try {
      window.localStorage.removeItem(BOOKING_STORAGE_KEY);
    } catch {
      /* ignore storage errors */
    }
    setStep("search");
    setSearch(null);
    setTrains([]);
    setResultsError(null);
    setSelectedTrain(null);
    setSelectedClass(null);
    setSelectedSeats([]);
    setPassengers([]);
    setContact({ email: "", phone: "" });
    setPnr("");
    setReceipt(null);
    setErrors({});
    setSeatMaps({});
    setUsingDemo(false);
    setComposition(null);
    setLiveAvailability(null);
    setAvailabilityNote("");
    setSeatLoading(false);
    setFareEnriching(false);
    setRealFareTrains(0);
    setEmailState({ status: "idle", message: "" });
  }

  const selectedClassMeta = selectedClass ? CLASS_META[selectedClass] : null;
  const seatMap = seatMaps[coach];
  const seatLayout = selectedClass ? SEAT_LAYOUTS[selectedClass] : SEAT_LAYOUTS.SL;
  const seatRows = useMemo(() => {
    if (!seatMap) return [] as SeatMap["seats"][];
    const rows: SeatMap["seats"][] = [];
    for (let index = 0; index < seatMap.seats.length; index += seatLayout.perRow) {
      rows.push(seatMap.seats.slice(index, index + seatLayout.perRow));
    }
    return rows;
  }, [seatMap, seatLayout.perRow]);
  const quotaLabel = quotaById(search?.quota ?? form.quota).label;
  const selectedOption =
    selectedTrain && selectedClass
      ? selectedTrain.classes.find((item) => item.code === selectedClass) ?? null
      : null;
  const selectedFare = selectedOption?.price ?? 0;
  const selectedBreakup = selectedOption?.breakup ?? null;
  const coachList = useMemo(() => {
    if (!selectedClass) return [] as string[];
    if (composition) {
      const realCoaches = composition.rake
        .filter((item) => item.hasSeats && item.classType.toUpperCase() === selectedClass)
        .map((item) => item.code);
      if (realCoaches.length > 0) return realCoaches;
    }
    return CLASS_META[selectedClass].coaches;
  }, [composition, selectedClass]);
  const ticketEmailPayload = receipt && pnr ? buildTicketPayload(pnr, receipt) : null;

  /* ---------------- YatraIQ hand-off ---------------- */

  function openManualBooking(prefill: {
    from: string;
    to: string;
    date: string;
    cls: ClassCode;
  }) {
    setForm((previous) => ({
      ...previous,
      from: prefill.from,
      to: prefill.to,
      date: prefill.date,
      cls: prefill.cls,
    }));
    setProduct("booking");
    setStep("search");
    setResultsError(null);
    setErrors({});
  }

  function openManualLeg(leg: {
    from: { code: string };
    to: { code: string };
    depDate: string;
    classCode: ClassCode;
  }) {
    openManualBooking({
      from: leg.from.code,
      to: leg.to.code,
      date: leg.depDate,
      cls: leg.classCode,
    });
  }

  /* ---------------- render ---------------- */

  return (
    <div
      style={{
        background: BLUE_LIGHT,
        color: TEXT,
        fontFamily: FONT_BODY,
        minHeight: "100vh",
        width: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <GlobalStyles />

      <header style={{ background: BLUE_DARK, color: "#fff" }} className="no-print">
        <div
          style={{ maxWidth: 1000, margin: "0 auto", padding: "14px 20px" }}
          className="flex items-center justify-between gap-3 flex-wrap"
        >
          <div className="flex items-center gap-2">
            <TrainFront size={24} color={ORANGE} />
            <div>
              <div style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 18, lineHeight: 1.1 }}>
                Rail Bandhu
              </div>
              <div style={{ fontSize: 10, color: "#BFD3E6" }}>
                {product === "yatraiq"
                  ? "YatraIQ · Split tickets + waitlist oracle"
                  : HAS_API_KEY
                    ? "Raipur Division · Live rail data"
                    : "Raipur Division · College Project"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2" style={{ fontSize: 11, color: "#BFD3E6" }}>
            <span className="live-dot" style={{ background: HAS_API_KEY ? "#7BD88F" : "#F5A623" }} />
            {HAS_API_KEY ? "Live data by RailRadar" : "Demo mode · no API key needed"}
          </div>
        </div>
        <div style={{ borderTop: "1px solid rgba(255,255,255,.14)" }}>
          <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 20px", display: "flex", gap: 4 }}>
            {([
              { id: "yatraiq", label: "YatraIQ planner", icon: <Sparkles size={14} /> },
              { id: "booking", label: "Book manually", icon: <Ticket size={14} /> },
            ] as const).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setProduct(tab.id);
                  if (tab.id === "booking") setStep("search");
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: product === tab.id ? "#fff" : "#BFD3E6",
                  borderBottom: product === tab.id ? `2px solid ${ORANGE}` : "2px solid transparent",
                  padding: "9px 12px",
                  fontSize: 12,
                  fontWeight: product === tab.id ? 600 : 500,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ height: 4, background: ORANGE }} />
      </header>

      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "0 0 60px", flex: "1 0 auto", width: "100%" }}>
        {product === "yatraiq" ? (
          <YatraIQ onBookManually={openManualBooking} onBookLeg={openManualLeg} />
        ) : (
          <>
        {step !== "search" && (
          <div style={{ padding: "20px 20px 0" }}>
            <StepTrail step={step} />
          </div>
        )}

        {/* ================= SEARCH / HOME ================= */}
        {step === "search" && (
          <div>
            <div
              style={{
                background: `linear-gradient(160deg, ${BLUE_DARK}, ${BLUE})`,
                padding: "36px 20px 90px",
              }}
            >
              <div style={{ maxWidth: 960, margin: "0 auto" }}>
                <h1 style={{ color: "#fff", fontSize: 28, fontWeight: 600, margin: "0 0 4px" }}>
                  Book your train ticket
                </h1>
                <p style={{ color: "#CFE0EE", fontSize: 14, margin: 0 }}>
                  {HAS_API_KEY
                    ? "All 8,670 Indian Railways stations, real trains and live running status."
                    : "All 8,670 stations, bundled demo trains and a complete sandbox booking flow."}
                </p>
                <div className="flex flex-wrap gap-2" style={{ marginTop: 14 }}>
                  {(HAS_API_KEY
                    ? ["8,670 stations", "Real timetables", "Live GPS status", "Sandbox payments"]
                    : ["8,670 stations", "Demo trains", "Sample live status", "Sandbox payments"]
                  ).map((item) => (
                    <span
                      key={item}
                      style={{
                        fontSize: 10,
                        color: "#E6F0F8",
                        border: "1px solid rgba(255,255,255,.28)",
                        borderRadius: 20,
                        padding: "3px 9px",
                        background: "rgba(255,255,255,.06)",
                      }}
                    >
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ maxWidth: 960, margin: "-60px auto 0", padding: "0 20px" }}>
              <form onSubmit={(event) => { event.preventDefault(); void runSearch(); }} className="card" style={{ padding: 20 }}>
                {!HAS_API_KEY && (
                  <div
                    style={{
                      marginBottom: 14,
                      padding: "9px 12px",
                      borderRadius: 6,
                      border: "1px solid #F3D9A5",
                      background: "#FDF4E3",
                      color: "#7A4E00",
                      fontSize: 12,
                      lineHeight: 1.45,
                    }}
                  >
                    <strong>Demo mode</strong> — this copy needs no API key. Train search, the station
                    board and running status use realistic bundled sample data. Every booking, seat,
                    payment and email step works normally.
                  </div>
                )}
                <div className="flex flex-wrap gap-2 mb-2">
                  {QUOTAS.map((quotaOption) => (
                    <button
                      type="button"
                      key={quotaOption.id}
                      onClick={() => setForm({ ...form, quota: quotaOption.id })}
                      className={`pill${form.quota === quotaOption.id ? " active" : ""}`}
                      style={{ padding: "6px 12px", fontSize: 12 }}
                      title={quotaOption.description}
                    >
                      {quotaOption.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 16 }}>
                  <strong style={{ fontFamily: FONT_MONO }}>{quotaById(form.quota).code}</strong> ·{" "}
                  {quotaById(form.quota).description}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <StationPicker
                    id="from-station"
                    label="From station"
                    value={form.from}
                    onChange={(code) => setForm((previous) => ({ ...previous, from: code }))}
                    error={errors.from}
                  />
                  <div className="flex items-end gap-2">
                    <div style={{ flex: 1 }}>
                      <StationPicker
                        id="to-station"
                        label="To station"
                        value={form.to}
                        onChange={(code) => setForm((previous) => ({ ...previous, to: code }))}
                        error={errors.to}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setForm((previous) => ({ ...previous, from: previous.to, to: previous.from }))
                      }
                      className="btn-ghost"
                      aria-label="Swap stations"
                      title="Swap stations"
                      style={{ padding: 10, height: 42, marginBottom: errors.to ? 18 : 0 }}
                    >
                      <ArrowLeftRight size={16} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <div>
                    <label style={{ fontSize: 12, color: MUTED }}>Date of journey</label>
                    <input
                      className="field"
                      type="date"
                      min={dateString(0)}
                      value={form.date}
                      onChange={(event) => setForm({ ...form, date: event.target.value })}
                    />
                    {errors.date && <div style={{ color: RED, fontSize: 12, marginTop: 4 }}>{errors.date}</div>}
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: MUTED }}>Preferred class</label>
                    <select
                      className="field"
                      value={form.cls}
                      onChange={(event) => setForm({ ...form, cls: event.target.value as ClassCode })}
                    >
                      {Object.values(CLASS_META).map((meta) => (
                        <option value={meta.code} key={meta.code}>
                          {meta.label} ({meta.code})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: MUTED }}>Passengers</label>
                    <select
                      className="field"
                      value={form.count}
                      onChange={(event) => setForm({ ...form, count: Number(event.target.value) })}
                    >
                      {[1, 2, 3, 4, 5, 6].map((count) => (
                        <option value={count} key={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  type="submit"
                  className="btn-primary flex items-center justify-center gap-2"
                  style={{ padding: "12px 20px", fontSize: 15, width: "100%" }}
                >
                  <Search size={16} /> Search trains
                </button>

                <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 10 }}>
                  <span style={{ fontSize: 10, color: "#8A99A8" }}>Quick routes:</span>
                  {QUICK_ROUTES.map((route) => (
                    <button
                      key={`${route.from}-${route.to}`}
                      type="button"
                      className="pill"
                      style={{ padding: "3px 8px", fontSize: 10 }}
                      onClick={() => {
                        setForm((previous) => ({ ...previous, from: route.from, to: route.to }));
                        void runSearch({ from: route.from, to: route.to });
                      }}
                    >
                      {route.label}
                    </button>
                  ))}
                </div>

                <div style={{ marginTop: 12 }}>
                  <DataNote>
                    {HAS_API_KEY
                      ? "Trains, timings, live running status and coach layouts are real (RailRadar). Fares and seat availability come live from IRCTC when an API key is configured, otherwise realistic simulations are used. Payment is a sandbox gateway."
                      : "Demo mode: the station list is real and bundled. Train times, live status and coach layouts are bundled samples; fares and seats are simulated. Payment is a sandbox gateway."}
                  </DataNote>
                </div>

                <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 10 }}>
                  <span
                    style={{
                      fontSize: 10,
                      color: backend?.irctc ? GREEN : ORANGE_DARK,
                      background: backend?.irctc ? "#EAF5EE" : "#FDF4E3",
                      border: `1px solid ${backend?.irctc ? "#BFE3CB" : "#F3D9A5"}`,
                      borderRadius: 3,
                      padding: "2px 7px",
                    }}
                  >
                    {backend?.irctc ? "● IRCTC FARES & SEATS: LIVE" : "IRCTC FARES & SEATS: SIMULATED"}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color:
                        backend?.email &&
                        backend.emailMode !== "ethereal" &&
                        backend.emailMode !== "preview"
                          ? GREEN
                          : ORANGE_DARK,
                      background:
                        backend?.email &&
                        backend.emailMode !== "ethereal" &&
                        backend.emailMode !== "preview"
                          ? "#EAF5EE"
                          : "#FDF4E3",
                      border: `1px solid ${
                        backend?.email &&
                        backend.emailMode !== "ethereal" &&
                        backend.emailMode !== "preview"
                          ? "#BFE3CB"
                          : "#F3D9A5"
                      }`,
                      borderRadius: 3,
                      padding: "2px 7px",
                    }}
                  >
                    {backend?.offline
                      ? "BOOKING API OFFLINE · RUN npm run dev:all"
                      : backend?.emailMode === "smtp"
                        ? "EMAIL: SMTP DELIVERY"
                        : backend?.emailMode === "emailjs"
                          ? "EMAIL: EMAILJS DELIVERY"
                          : backend?.emailMode === "ethereal"
                            ? "EMAIL: TEST INBOX (ETHEREAL)"
                            : backend?.emailMode === "preview"
                              ? "EMAIL: TEST INBOX (CLOUDFLARE)"
                              : "EMAIL: NOT CONFIGURED"}
                  </span>
                </div>
              </form>

              {/* Live rail radar */}
              <div style={{ marginTop: 32 }}>
                <div className="flex flex-wrap items-center justify-between gap-2" style={{ marginBottom: 12 }}>
                  <div className="flex items-center gap-2">
                    <Wifi size={18} color={BLUE_DARK} />
                    <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Live rail radar</h2>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={`pill${liveTab === "board" ? " active" : ""}`}
                      style={{ padding: "6px 12px", fontSize: 12 }}
                      onClick={() => setLiveTab("board")}
                    >
                      Station board
                    </button>
                    <button
                      type="button"
                      className={`pill${liveTab === "train" ? " active" : ""}`}
                      style={{ padding: "6px 12px", fontSize: 12 }}
                      onClick={() => setLiveTab("train")}
                    >
                      Track a train
                    </button>
                  </div>
                </div>

                {liveTab === "board" ? <StationBoard stationCode="R" stationName="Raipur Jn" /> : <LiveTrainTracker />}
              </div>

              <div style={{ marginTop: 28, marginBottom: 10 }}>
                <DataNote>
                  {HAS_API_KEY
                    ? "Live data is provided by RailRadar's crowdsourced tracking network. Seat maps, availability, fares and the payment gateway are demo simulations."
                    : "Demo mode: the station board and running status above are bundled samples, not live feeds. Seat maps, fares and the payment gateway are simulations."}
                </DataNote>
              </div>
            </div>
          </div>
        )}

        <div style={{ padding: step === "search" ? 0 : "20px" }}>
          {/* ================= RESULTS ================= */}
          {step === "results" && search && (
            <div>
              <button
                onClick={() => setStep("search")}
                className="btn-ghost flex items-center gap-1 mb-4 no-print"
                style={{ padding: "6px 10px", fontSize: 13, border: "none" }}
              >
                <ChevronLeft size={16} /> Modify search
              </button>

              <div className="flex items-center gap-2 flex-wrap mb-1">
                <MapPin size={16} color={BLUE_DARK} />
                <span style={{ fontWeight: 600 }}>{stationTitle(search.from)}</span>
                <ArrowRight size={13} color={MUTED} />
                <span style={{ fontWeight: 600 }}>{stationTitle(search.to)}</span>
              </div>
              <p style={{ color: MUTED, fontSize: 13, marginBottom: 4 }}>
                {formatJourneyDate(search.date)} · {quotaById(search.quota).label} ({quotaById(search.quota).code}) ·{" "}
                {search.count} passenger{search.count > 1 ? "s" : ""}
                {!resultsLoading && !resultsError ? ` · ${trains.length} trains found` : ""}
              </p>
              <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 16 }}>
                <span
                  style={{
                    fontSize: 10,
                    color: usingDemo ? ORANGE_DARK : GREEN,
                    border: `1px solid ${usingDemo ? "#F3D9A5" : "#BFE3CB"}`,
                    background: usingDemo ? "#FDF4E3" : "#EAF5EE",
                    borderRadius: 3,
                    padding: "2px 7px",
                  }}
                >
                  {usingDemo ? "DEMO DATA" : "● REAL TRAINS · RAILRADAR"}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: realFareTrains > 0 ? GREEN : ORANGE_DARK,
                    border: `1px solid ${realFareTrains > 0 ? "#BFE3CB" : "#F3D9A5"}`,
                    background: realFareTrains > 0 ? "#EAF5EE" : "#FDF4E3",
                    borderRadius: 3,
                    padding: "2px 7px",
                  }}
                >
                  {realFareTrains > 0
                    ? `● LIVE IRCTC FARES · ${realFareTrains} TRAIN${realFareTrains === 1 ? "" : "S"}`
                    : fareEnriching
                      ? "FETCHING IRCTC FARES…"
                      : backend?.irctc
                        ? "IRCTC FARES UNAVAILABLE · SIMULATED"
                        : HAS_API_KEY
                          ? "FARES SIMULATED · ADD IRCTC_API_KEY"
                          : "FARES SIMULATED · DEMO MODE"}
                </span>
                <span style={{ fontSize: 10, color: "#8A99A8" }}>
                  Live seat availability is fetched when you choose a class
                </span>
              </div>
              {usingDemo && (
                <p style={{ fontSize: 11, color: "#8A5A00", margin: "-6px 0 12px" }}>
                  Bundled demo trains — no API key required. Pick any train to continue the full
                  booking flow.
                </p>
              )}

              {!resultsLoading && !resultsError && trains.length > 0 && (
                <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 14 }}>
                  <select
                    className="field"
                    style={{ width: "auto", padding: "6px 8px", fontSize: 12 }}
                    value={typeFilter}
                    onChange={(event) => setTypeFilter(event.target.value)}
                    aria-label="Filter by train type"
                  >
                    <option value="all">All train types</option>
                    <option value="vande bharat">Vande Bharat</option>
                    <option value="rajdhani">Rajdhani</option>
                    <option value="shatabdi">Shatabdi</option>
                    <option value="superfast">Superfast</option>
                    <option value="express">Express</option>
                    <option value="passenger">Passenger</option>
                  </select>
                  <select
                    className="field"
                    style={{ width: "auto", padding: "6px 8px", fontSize: 12 }}
                    value={sortBy}
                    onChange={(event) => setSortBy(event.target.value)}
                    aria-label="Sort trains"
                  >
                    <option value="departure">Sort: departure</option>
                    <option value="arrival">Sort: arrival</option>
                    <option value="duration">Sort: duration</option>
                  </select>
                  <span style={{ fontSize: 11, color: MUTED }}>
                    {visibleTrains.length} of {trains.length} trains
                  </span>
                </div>
              )}

              {resultsLoading && (
                <div className="grid gap-4">
                  {[0, 1, 2].map((item) => (
                    <div key={item} className="card" style={{ padding: 18 }}>
                      <div className="skeleton" style={{ height: 18, width: "45%", marginBottom: 10 }} />
                      <div className="skeleton" style={{ height: 12, width: "25%", marginBottom: 18 }} />
                      <div className="skeleton" style={{ height: 34, width: "80%", marginBottom: 16 }} />
                      <div className="flex gap-2">
                        {[0, 1, 2, 3].map((chip) => (
                          <div key={chip} className="skeleton" style={{ height: 56, width: 104 }} />
                        ))}
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-2" style={{ fontSize: 12, color: MUTED }}>
                    <span className="spinner-dark" /> Fetching real trains from RailRadar…
                  </div>
                </div>
              )}

              {!resultsLoading && resultsError && (
                <div className="card" style={{ padding: 24, textAlign: "center" }}>
                  <AlertTriangle size={28} color={AMBER} style={{ margin: "0 auto 8px" }} />
                  <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Couldn’t load trains</div>
                  <p style={{ fontSize: 13, color: MUTED, maxWidth: 460, margin: "0 auto 14px" }}>
                    {resultsError}
                  </p>
                  <div className="flex justify-center gap-2 flex-wrap">
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ padding: "9px 16px", fontSize: 13 }}
                      onClick={() => void runSearch()}
                    >
                      Try again
                    </button>
                    {!HAS_API_KEY && (
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ padding: "9px 16px", fontSize: 13 }}
                        onClick={loadDemoTrains}
                      >
                        Load demo trains
                      </button>
                    )}
                  </div>
                </div>
              )}

              {!resultsLoading && !resultsError && trains.length === 0 && (
                <div className="card" style={{ padding: 28, textAlign: "center" }}>
                  <TrainFront size={30} color={BLUE_DARK} style={{ margin: "0 auto 8px" }} />
                  <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>No direct trains found</div>
                  <p style={{ fontSize: 13, color: MUTED, maxWidth: 440, margin: "0 auto 14px" }}>
                    There are no direct trains between {stationTitle(search.from)} and{" "}
                    {stationTitle(search.to)} on {formatJourneyDate(search.date)}. Try another date or a
                    nearby major station.
                  </p>
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ padding: "9px 16px", fontSize: 13 }}
                    onClick={() => setStep("search")}
                  >
                    Modify search
                  </button>
                </div>
              )}

              {!resultsLoading && !resultsError && trains.length > 0 && visibleTrains.length === 0 && (
                <div className="card" style={{ padding: 20, textAlign: "center", fontSize: 13, color: MUTED }}>
                  No trains match the selected type. Choose “All train types”.
                </div>
              )}

              {!resultsLoading && !resultsError && visibleTrains.length > 0 && (
                <div className="grid gap-4">
                  {visibleTrains.map((train) => (
                    <div key={train.id} className="card card-hover" style={{ padding: 18 }}>
                      <div className="flex flex-wrap justify-between gap-3 mb-3">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span style={{ fontWeight: 600, fontSize: 15 }}>{train.name}</span>
                            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: MUTED }}>
                              #{train.number}
                            </span>
                            <span
                              style={{
                                fontSize: 10,
                                color: BLUE_DARK,
                                background: BLUE_LIGHT,
                                border: `1px solid ${LINE}`,
                                borderRadius: 3,
                                padding: "1px 6px",
                              }}
                            >
                              {train.type}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>
                            Runs {runDaysLabel(train.runDays)} · {train.halts} halts between ·{" "}
                            {Math.round(train.distance)} km
                          </div>
                        </div>
                        <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: MUTED }}>
                          {formatDuration(train.durMin)}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 mb-4 flex-wrap">
                        <div style={{ fontFamily: FONT_MONO, fontSize: 22, fontWeight: 600 }}>{train.dep}</div>
                        <div
                          style={{
                            flex: "1 1 60px",
                            minWidth: 40,
                            borderTop: `1px dashed ${LINE}`,
                            position: "relative",
                            top: -6,
                          }}
                        />
                        <div style={{ fontFamily: FONT_MONO, fontSize: 22, fontWeight: 600 }}>
                          {train.arr}
                          {train.dayOffset > 0 && (
                            <sup style={{ fontSize: 11, color: ORANGE_DARK }}> +{train.dayOffset}d</sup>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {train.classes.map((option) => {
                          const preferred = form.cls === option.code;
                          return (
                            <button
                              key={option.code}
                              onClick={() => chooseClass(train, option.code)}
                              className="pill"
                              style={{
                                padding: "8px 12px",
                                textAlign: "left",
                                minWidth: 108,
                                borderColor: preferred ? BLUE_DARK : undefined,
                                boxShadow: preferred ? `inset 0 0 0 1px ${BLUE_DARK}` : undefined,
                              }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span style={{ fontSize: 12, fontWeight: 600 }}>{option.code}</span>
                                <span className="flex items-center gap-1">
                                  {option.source === "irctc" && (
                                    <span style={{ fontSize: 8, color: GREEN, fontFamily: FONT_MONO }}>
                                      IRCTC
                                    </span>
                                  )}
                                  {preferred && (
                                    <span style={{ fontSize: 8, color: BLUE_DARK, fontFamily: FONT_MONO }}>
                                      PREF
                                    </span>
                                  )}
                                </span>
                              </div>
                              <div style={{ fontFamily: FONT_MONO, fontSize: 13 }}>{formatINR(option.price)}</div>
                              <div style={{ fontSize: 10, color: STATUS_COLORS[option.status] }}>
                                {option.status === "Available"
                                  ? `${option.count} left`
                                  : `${option.status} ${option.count}`}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                <DataNote>
                  {usingDemo
                    ? "Demo mode: train numbers, timings and distances are bundled samples. Fares and seat availability are simulated; coach layouts are generated locally. The full booking, payment and email flow still works."
                    : "Train numbers, timings, run days and distances are real (RailRadar). Fares marked “IRCTC” are live IRCTC fares; the rest are realistic estimates. Live seat availability is fetched when you open a class, and coach/berth layouts come from RailRadar's real rake composition."}
                </DataNote>
              </div>
            </div>
          )}

          {/* ================= SEATS ================= */}
          {step === "seats" && selectedTrain && selectedClassMeta && (
            <div style={{ paddingBottom: 80 }}>
              <button
                onClick={() => setStep("results")}
                className="btn-ghost flex items-center gap-1 mb-4 no-print"
                style={{ padding: "6px 10px", fontSize: 13, border: "none" }}
              >
                <ChevronLeft size={16} /> Back to trains
              </button>

              <div className="card flex flex-wrap justify-between gap-3" style={{ padding: 16, marginBottom: 16 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {selectedTrain.name} · #{selectedTrain.number}
                  </div>
                  <div style={{ fontSize: 13, color: MUTED }}>
                    {stationTitle(search?.from)} {selectedTrain.dep} → {stationTitle(search?.to)}{" "}
                    {selectedTrain.arr}
                  </div>
                  <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                    {search ? formatJourneyDate(search.date) : ""} · {quotaLabel} ·{" "}
                    {formatDuration(selectedTrain.durMin)}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600 }}>
                    {selectedClassMeta.label} ({selectedClass})
                  </div>
                  <div style={{ fontSize: 11, color: MUTED }}>
                    {formatINR(selectedFare)} per passenger
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: selectedOption?.source === "irctc" ? GREEN : ORANGE_DARK,
                    }}
                  >
                    {selectedOption?.source === "irctc" ? "● LIVE IRCTC FARE" : "Simulated fare"}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 mb-2">
                {coachList.map((coachId) => (
                  <button
                    key={coachId}
                    onClick={() => switchCoach(coachId)}
                    className={`pill${coach === coachId ? " active" : ""}`}
                    style={{ padding: "6px 12px", fontSize: 13, fontFamily: FONT_MONO }}
                  >
                    {coachId}
                  </button>
                ))}
                <span style={{ fontSize: 11, color: MUTED, alignSelf: "center", marginLeft: 4 }}>
                  {composition
                    ? `Real rake · ${coachList.length} ${selectedClass} coach${coachList.length === 1 ? "" : "s"}`
                    : "Coach layout simulated"}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 14, fontSize: 11 }}>
                {seatLoading ? (
                  <span className="flex items-center gap-2" style={{ color: MUTED }}>
                    <span className="spinner-dark" /> Loading live IRCTC availability and the real
                    coach layout…
                  </span>
                ) : liveAvailability ? (
                  <span
                    style={{
                      color:
                        liveAvailability.status === "Available"
                          ? GREEN
                          : liveAvailability.status === "RAC"
                            ? AMBER
                            : RED,
                      background:
                        liveAvailability.status === "Available"
                          ? "#EAF5EE"
                          : liveAvailability.status === "RAC"
                            ? "#FDF4E3"
                            : "#FDECEC",
                      border: `1px solid ${
                        liveAvailability.status === "Available"
                          ? "#BFE3CB"
                          : liveAvailability.status === "RAC"
                            ? "#F3D9A5"
                            : "#F3C2C2"
                      }`,
                      borderRadius: 3,
                      padding: "3px 8px",
                      fontFamily: FONT_MONO,
                    }}
                  >
                    ● LIVE IRCTC · {availabilityNote}
                  </span>
                ) : (
                  <span
                    style={{
                      color: ORANGE_DARK,
                      background: "#FDF4E3",
                      border: "1px solid #F3D9A5",
                      borderRadius: 3,
                      padding: "3px 8px",
                    }}
                  >
                    {availabilityNote || "Seat availability simulated"}
                  </span>
                )}
                {composition && (
                  <span style={{ color: MUTED }}>
                    {composition.totalCoaches} coaches in the real rake · berth numbers from the
                    RailRadar blueprint
                  </span>
                )}
              </div>

              <div className="card" style={{ padding: 20 }}>
                <div className="flex flex-wrap justify-between gap-2" style={{ marginBottom: 12 }}>
                  <p style={{ fontSize: 12, color: MUTED, margin: 0 }}>
                    Tap a seat to select ({selectedSeats.length}/{form.count} chosen). Grey seats are
                    already booked.
                  </p>
                  <div className="flex items-center gap-2" style={{ fontSize: 11, color: MUTED }}>
                    <Users size={13} /> {form.count} passenger{form.count > 1 ? "s" : ""}
                  </div>
                </div>

                {seatWarning && (
                  <div
                    style={{
                      marginBottom: 10,
                      fontSize: 11,
                      color: AMBER,
                      background: "#FDF4E3",
                      border: "1px solid #F3D9A5",
                      borderRadius: 4,
                      padding: "6px 8px",
                    }}
                  >
                    {seatWarning}
                  </div>
                )}

                {seatMap ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      alignItems: "flex-start",
                      overflowX: "auto",
                      paddingBottom: 4,
                    }}
                  >
                    {seatRows.map((row, rowIndex) => (
                      <div key={rowIndex} className="flex items-center" style={{ gap: 8 }}>
                        <span
                          style={{
                            width: 18,
                            flex: "0 0 auto",
                            fontFamily: FONT_MONO,
                            fontSize: 10,
                            color: "#9AAAB8",
                            textAlign: "right",
                          }}
                        >
                          {String(rowIndex + 1).padStart(2, "0")}
                        </span>
                        {row.map((seat, columnIndex) => {
                          const key = `${coach}-${seat.num}`;
                          const isSelected = selectedSeats.some((item) => item.key === key);
                          return (
                            <Fragment key={seat.num}>
                              {columnIndex > 0 && seatLayout.gapsAfter.includes(columnIndex) && (
                                <span
                                  aria-hidden="true"
                                  style={{ width: seatLayout.gapWidth, flex: "0 0 auto" }}
                                />
                              )}
                              <button
                                type="button"
                                title={`Seat ${seat.num} · ${seat.type}`}
                                disabled={seat.booked}
                                aria-pressed={isSelected}
                                onClick={() => toggleSeat(seat)}
                                className={`seat-btn${seat.booked ? " booked" : isSelected ? " selected" : ""}`}
                              >
                                {seat.num}
                              </button>
                            </Fragment>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="skeleton" style={{ height: 220 }} />
                )}

                <div className="flex flex-wrap gap-4 mt-5" style={{ fontSize: 12, color: MUTED }}>
                  <span className="flex items-center gap-1">
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: "#fff",
                        border: `1px solid ${LINE}`,
                        display: "inline-block",
                      }}
                    />
                    Available
                  </span>
                  <span className="flex items-center gap-1">
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: GREEN, display: "inline-block" }} />
                    Selected
                  </span>
                  <span className="flex items-center gap-1">
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: "#EDEFF2",
                        border: "1px solid #E1E4E8",
                        display: "inline-block",
                      }}
                    />
                    Booked
                  </span>
                  <span style={{ fontSize: 11, color: "#8A99A8" }}>Hover a seat to see its berth type</span>
                </div>
              </div>

              {selectedSeats.length > 0 && (
                <div className="card" style={{ padding: 14, marginTop: 14 }}>
                  <div style={{ fontSize: 11, color: MUTED, fontFamily: FONT_MONO, marginBottom: 8 }}>
                    SELECTED SEATS
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedSeats.map((seat) => (
                      <span
                        key={seat.key}
                        style={{
                          fontSize: 11,
                          border: `1px solid ${LINE}`,
                          borderRadius: 4,
                          padding: "4px 8px",
                          background: "#FBFCFD",
                        }}
                      >
                        <strong style={{ fontFamily: FONT_MONO }}>
                          {seat.coach}-{seat.num}
                        </strong>{" "}
                        · {seat.type}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div
                className="card"
                style={{
                  position: "sticky",
                  bottom: 12,
                  marginTop: 16,
                  padding: 14,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13 }}>
                  {selectedSeats.length} seat{selectedSeats.length !== 1 ? "s" : ""} selected ·{" "}
                  <span style={{ fontFamily: FONT_MONO, fontWeight: 600 }}>{formatINR(seatFare())}</span>
                  <span style={{ color: MUTED, fontSize: 11 }}> + {formatINR(CONVENIENCE_FEE)} fee</span>
                </div>
                <button
                  disabled={selectedSeats.length !== form.count}
                  onClick={proceedFromSeats}
                  className="btn-primary"
                  style={{ padding: "10px 18px", fontSize: 14 }}
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ================= PASSENGERS ================= */}
          {step === "passengers" && selectedTrain && selectedClassMeta && (
            <div>
              <button
                onClick={() => setStep("seats")}
                className="btn-ghost flex items-center gap-1 mb-4 no-print"
                style={{ padding: "6px 10px", fontSize: 13, border: "none" }}
              >
                <ChevronLeft size={16} /> Back to seats
              </button>

              <div
                className="card flex flex-wrap items-center justify-between gap-2"
                style={{ padding: 12, marginBottom: 16, fontSize: 12 }}
              >
                <span style={{ fontWeight: 600 }}>
                  {selectedTrain.name} · {selectedClassMeta.label}
                </span>
                <span style={{ color: MUTED }}>
                  {stationTitle(search?.from)} → {stationTitle(search?.to)} ·{" "}
                  {search ? formatJourneyDate(search.date) : ""}
                </span>
              </div>

              <form onSubmit={handlePassengerSubmit} className="grid gap-4">
                <div className="card" style={{ padding: 12, fontSize: 12 }}>
                  <div>
                    <strong>
                      Quota: {quotaById(search?.quota ?? form.quota).label} (
                      {quotaById(search?.quota ?? form.quota).code})
                    </strong>
                  </div>
                  <div style={{ color: MUTED, marginTop: 3 }}>
                    {quotaById(search?.quota ?? form.quota).description}
                  </div>
                  {errors.quota && (
                    <div style={{ color: RED, marginTop: 4 }}>{errors.quota}</div>
                  )}
                </div>

                {passengers.map((passenger, index) => (
                  <div key={index} className="card" style={{ padding: 16 }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: MUTED,
                        marginBottom: 10,
                        fontFamily: FONT_MONO,
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <span>PASSENGER {index + 1}</span>
                      <span>
                        Coach {selectedSeats[index]?.coach} · Seat {selectedSeats[index]?.num} (
                        {selectedSeats[index]?.type})
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <label style={{ fontSize: 12, color: MUTED }}>Full name</label>
                        <input
                          className="field"
                          value={passenger.name}
                          onChange={(event) => updatePassenger(index, "name", event.target.value)}
                          placeholder="As printed on ID"
                          style={{ borderColor: errors[`name${index}`] ? RED : undefined }}
                        />
                        {errors[`name${index}`] && (
                          <div style={{ color: RED, fontSize: 11, marginTop: 3 }}>{errors[`name${index}`]}</div>
                        )}
                      </div>
                      <div>
                        <label style={{ fontSize: 12, color: MUTED }}>Age</label>
                        <input
                          className="field"
                          type="number"
                          min="1"
                          max="120"
                          value={passenger.age}
                          onChange={(event) => updatePassenger(index, "age", event.target.value)}
                          style={{ borderColor: errors[`age${index}`] ? RED : undefined }}
                        />
                        {errors[`age${index}`] && (
                          <div style={{ color: RED, fontSize: 11, marginTop: 3 }}>{errors[`age${index}`]}</div>
                        )}
                      </div>
                      <div>
                        <label style={{ fontSize: 12, color: MUTED }}>Gender</label>
                        <select
                          className="field"
                          value={passenger.gender}
                          onChange={(event) => updatePassenger(index, "gender", event.target.value)}
                          style={{ borderColor: errors[`quota${index}`] ? RED : undefined }}
                        >
                          <option>Male</option>
                          <option>Female</option>
                          <option>Other</option>
                        </select>
                        {errors[`quota${index}`] && (
                          <div style={{ color: RED, fontSize: 11, marginTop: 3 }}>
                            {errors[`quota${index}`]}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, fontFamily: FONT_MONO }}>
                    CONTACT FOR TICKET UPDATES
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label style={{ fontSize: 12, color: MUTED }}>Email</label>
                      <input
                        className="field"
                        type="email"
                        value={contact.email}
                        onChange={(event) => setContact({ ...contact, email: event.target.value })}
                        placeholder="you@example.com"
                        style={{ borderColor: errors.email ? RED : undefined }}
                      />
                      {errors.email && <div style={{ color: RED, fontSize: 11, marginTop: 3 }}>{errors.email}</div>}
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: MUTED }}>Mobile number</label>
                      <input
                        className="field"
                        type="tel"
                        value={contact.phone}
                        onChange={(event) => setContact({ ...contact, phone: event.target.value })}
                        placeholder="10-digit mobile"
                        style={{ borderColor: errors.phone ? RED : undefined }}
                      />
                      {errors.phone && <div style={{ color: RED, fontSize: 11, marginTop: 3 }}>{errors.phone}</div>}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "#8A99A8", marginTop: 10 }}>
                    The e-ticket, booking invoice and payment OTP are sent here. With SMTP or
                    EmailJS configured this is a real inbox. Otherwise the email is captured in a
                    test inbox, and you can download or print the ticket after booking.
                  </div>
                </div>

                <button
                  type="submit"
                  className="btn-primary flex items-center justify-center gap-2"
                  style={{ padding: "12px 20px", fontSize: 15, justifySelf: "start" }}
                >
                  Continue to payment <ArrowRight size={15} />
                </button>
              </form>
            </div>
          )}

          {/* ================= PAYMENT ================= */}
          {step === "payment" && selectedTrain && selectedClassMeta && (
            <PaymentGateway
              amount={totalFare()}
              baseFare={seatFare()}
              fee={CONVENIENCE_FEE}
              passengerCount={selectedSeats.length}
              contact={contact}
              onSuccess={handlePaymentSuccess}
              onBack={() => setStep("passengers")}
            />
          )}

          {/* ================= CONFIRMATION ================= */}
          {step === "confirm" && selectedTrain && selectedClassMeta && search && (
            <div style={{ animation: "riseIn 0.4s ease" }} className="anim">
              <div className="flex items-center gap-2 mb-4 no-print" style={{ color: GREEN }}>
                <span
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    background: GREEN,
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    animation: "checkPop .4s ease",
                  }}
                >
                  <Check size={18} />
                </span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16, color: TEXT }}>Booking confirmed</div>
                  <div style={{ fontSize: 12, color: MUTED }}>
                    Your ticket is ready below — download, print or save it as a PDF.
                  </div>
                </div>
              </div>

              <div className="card print-ticket" style={{ overflow: "hidden" }}>
                <div style={{ background: BLUE_DARK, color: "#fff", padding: "18px 20px" }}>
                  <div className="flex justify-between items-start flex-wrap gap-3">
                    <div>
                      <div style={{ fontSize: 10, color: "#BFD3E6", fontFamily: FONT_MONO, letterSpacing: 0.5 }}>
                        ELECTRONIC RESERVATION SLIP · RAIL BANDHU
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 18, marginTop: 3 }}>{selectedTrain.name}</div>
                      <div style={{ fontSize: 12, color: "#CFE0EE" }}>
                        #{selectedTrain.number} · {selectedClassMeta.label} ({selectedClass}) · {quotaLabel}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: "#BFD3E6", fontFamily: FONT_MONO }}>PNR</div>
                      <div style={{ fontSize: 26, fontFamily: FONT_MONO, fontWeight: 700, letterSpacing: 2 }}>
                        {pnr}
                      </div>
                      <div style={{ fontSize: 10, color: "#BFD3E6" }}>Booked {receipt?.paidAt}</div>
                    </div>
                  </div>
                </div>

                <div style={{ padding: "18px 20px" }}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 24, fontWeight: 600 }}>{selectedTrain.dep}</div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{stationTitle(search.from)}</div>
                      <div style={{ fontSize: 11, color: MUTED }}>{formatJourneyDate(search.date)}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 80, textAlign: "center" }}>
                      <div style={{ fontSize: 10, color: MUTED, fontFamily: FONT_MONO }}>
                        {formatDuration(selectedTrain.durMin)}
                      </div>
                      <div style={{ borderTop: `1px dashed ${LINE}`, margin: "6px 0", position: "relative" }}>
                        <TrainFront
                          size={14}
                          color={ORANGE_DARK}
                          style={{
                            position: "absolute",
                            left: "50%",
                            top: -7,
                            transform: "translateX(-50%)",
                            background: "#fff",
                          }}
                        />
                      </div>
                      <div style={{ fontSize: 10, color: MUTED }}>{Math.round(selectedTrain.distance)} km</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 24, fontWeight: 600 }}>
                        {selectedTrain.arr}
                        {selectedTrain.dayOffset > 0 && (
                          <sup style={{ fontSize: 10, color: ORANGE_DARK }}> +{selectedTrain.dayOffset}d</sup>
                        )}
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{stationTitle(search.to)}</div>
                      <div style={{ fontSize: 11, color: MUTED }}>Destination</div>
                    </div>
                  </div>
                </div>

                <div style={{ padding: "0 20px" }}>
                  <TearLine />
                </div>

                <div style={{ padding: "16px 20px" }}>
                  <div style={{ fontSize: 11, color: MUTED, fontFamily: FONT_MONO, marginBottom: 8 }}>
                    PASSENGERS &amp; SEATS
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: MUTED }}>
                          <th style={{ padding: "4px 6px", fontWeight: 500 }}>Passenger</th>
                          <th style={{ padding: "4px 6px", fontWeight: 500 }}>Age / Gender</th>
                          <th style={{ padding: "4px 6px", fontWeight: 500 }}>Coach</th>
                          <th style={{ padding: "4px 6px", fontWeight: 500 }}>Seat</th>
                          <th style={{ padding: "4px 6px", fontWeight: 500 }}>Berth</th>
                        </tr>
                      </thead>
                      <tbody>
                        {passengers.map((passenger, index) => (
                          <tr key={index} style={{ borderTop: `1px solid ${LINE}` }}>
                            <td style={{ padding: "7px 6px", fontWeight: 500 }}>{passenger.name}</td>
                            <td style={{ padding: "7px 6px", color: MUTED }}>
                              {passenger.age} / {passenger.gender}
                            </td>
                            <td style={{ padding: "7px 6px", fontFamily: FONT_MONO }}>
                              {selectedSeats[index]?.coach}
                            </td>
                            <td style={{ padding: "7px 6px", fontFamily: FONT_MONO }}>
                              {selectedSeats[index]?.num}
                            </td>
                            <td style={{ padding: "7px 6px", color: MUTED }}>{selectedSeats[index]?.type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div style={{ padding: "0 20px" }}>
                  <TearLine />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4" style={{ padding: "16px 20px" }}>
                  <div>
                    <div style={{ fontSize: 11, color: MUTED, fontFamily: FONT_MONO, marginBottom: 6 }}>
                      FARE SUMMARY
                    </div>
                    {selectedBreakup && selectedBreakup.length > 0 ? (
                      selectedBreakup.map((row) => (
                        <div
                          key={row.label}
                          className="flex justify-between"
                          style={{ fontSize: 12, marginBottom: 3 }}
                        >
                          <span>
                            {row.label} × {selectedSeats.length}
                          </span>
                          <span style={{ fontFamily: FONT_MONO }}>
                            {formatINR(row.amount * selectedSeats.length)}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 3 }}>
                        <span>
                          {selectedClassMeta.label} × {selectedSeats.length}
                        </span>
                        <span style={{ fontFamily: FONT_MONO }}>{formatINR(seatFare())}</span>
                      </div>
                    )}
                    <div className="flex justify-between" style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>
                      <span>Convenience fee</span>
                      <span style={{ fontFamily: FONT_MONO }}>{formatINR(CONVENIENCE_FEE)}</span>
                    </div>
                    <div
                      className="flex justify-between"
                      style={{ fontSize: 14, fontWeight: 600, borderTop: `1px solid ${LINE}`, paddingTop: 6 }}
                    >
                      <span>Total paid</span>
                      <span style={{ fontFamily: FONT_MONO }}>{formatINR(receipt?.amount ?? totalFare())}</span>
                    </div>
                    <div className="flex items-center gap-1" style={{ color: GREEN, fontSize: 11, marginTop: 6 }}>
                      <Check size={12} /> Payment successful
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 11, color: MUTED, fontFamily: FONT_MONO, marginBottom: 6 }}>
                      PAYMENT DETAILS
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 3 }}>
                      <span style={{ color: MUTED }}>Method: </span>
                      {receipt ? `${receipt.methodLabel} · ${receipt.detail}` : "—"}
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 3 }}>
                      <span style={{ color: MUTED }}>Transaction: </span>
                      <span style={{ fontFamily: FONT_MONO }}>{receipt?.txnId ?? "—"}</span>
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 3 }}>
                      <span style={{ color: MUTED }}>Auth code: </span>
                      <span style={{ fontFamily: FONT_MONO }}>{receipt?.authCode ?? "—"}</span>
                    </div>
                    <div style={{ fontSize: 12 }}>
                      <span style={{ color: MUTED }}>Paid at: </span>
                      {receipt?.paidAt ?? "—"}
                    </div>
                  </div>
                </div>

                <div
                  className="flex flex-wrap items-center justify-between gap-3"
                  style={{ padding: "0 20px 18px" }}
                >
                  <div className="flex items-center gap-2">
                    <FakeQr value={`${pnr}-${selectedTrain.number}`} size={92} />
                    <div style={{ fontSize: 10, color: MUTED, maxWidth: 130, lineHeight: 1.5 }}>
                      Simulated QR code for this demo ticket. Not scannable at a real station.
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: "#9AAAB8", maxWidth: 260, lineHeight: 1.5 }}>
                    College project demo ticket — not valid for travel. Train and coach data are
                    real; fares/availability are live when IRCTC is configured. Payment is a
                    sandbox. The email is a real message when SMTP/EmailJS is configured.
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 no-print" style={{ marginTop: 18 }}>
                <button
                  onClick={() => void downloadTicket()}
                  disabled={downloading}
                  className="btn-ghost flex items-center gap-2"
                  style={{ padding: "10px 16px", fontSize: 14 }}
                >
                  <Ticket size={15} /> {downloading ? "Preparing…" : "Download ticket + invoice"}
                </button>
                <button
                  onClick={() => window.print()}
                  className="btn-primary flex items-center gap-2"
                  style={{ padding: "10px 16px", fontSize: 14 }}
                >
                  <Printer size={15} /> Print / Save PDF
                </button>
                <button
                  onClick={resetAll}
                  className="btn-ghost flex items-center gap-2"
                  style={{ padding: "10px 16px", fontSize: 14 }}
                >
                  <Search size={15} /> Book another journey
                </button>
              </div>
              {downloadError && (
                <div className="no-print" style={{ marginTop: 8, fontSize: 12, color: RED }}>
                  {downloadError}
                </div>
              )}
            </div>
          )}
        </div>
          </>
        )}
      </main>

      <footer style={{ background: "#fff", borderTop: `1px solid ${LINE}` }} className="no-print">
        <div
          style={{ maxWidth: 1000, margin: "0 auto", padding: "18px 20px" }}
          className="flex flex-wrap items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2">
            <TrainFront size={16} color={BLUE_DARK} />
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600 }}>Rail Bandhu</span>
            <span style={{ fontSize: 10, color: "#9AAAB8" }}>
              · {HAS_API_KEY ? "Live rail data" : "College project demo"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3" style={{ fontSize: 10, color: MUTED }}>
            <span>
              {HAS_API_KEY ? "Train data & live status: RailRadar" : "Demo mode: bundled sample data"}
            </span>
            <span>{backend?.irctc ? "IRCTC fares/seats: live" : "Fares/seats: simulated"}</span>
            <span>
              Email:{" "}
              {backend?.emailMode === "smtp"
                ? "SMTP"
                : backend?.emailMode === "emailjs"
                  ? "EmailJS"
                  : backend?.emailMode === "ethereal"
                    ? "Ethereal test inbox"
                    : backend?.emailMode === "preview"
                      ? "Cloudflare preview inbox"
                      : "not configured"}
            </span>
            <span>Payment: SetuPay sandbox</span>
            {quota !== null && (
              <span style={{ color: quota < 10 ? AMBER : MUTED }}>
                API quota: {quota} request{quota === 1 ? "" : "s"} left this month
              </span>
            )}
          </div>
        </div>
        <div
          style={{
            maxWidth: 1000,
            margin: "0 auto",
            padding: "0 20px 14px",
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: "#9AAAB8",
            letterSpacing: ".02em",
          }}
          className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center"
          aria-label="Developed by Gajendra Sharma, Atharva Khotele and Sanskar Shukla"
        >
          <span>Developed by</span>
          <span style={{ color: MUTED, fontWeight: 600 }}>Gajendra Sharma</span>
          <span aria-hidden="true">·</span>
          <span style={{ color: MUTED, fontWeight: 600 }}>Atharva Khotele</span>
          <span aria-hidden="true">·</span>
          <span style={{ color: MUTED, fontWeight: 600 }}>Sanskar Shukla</span>
        </div>
      </footer>
    </div>
  );
}
