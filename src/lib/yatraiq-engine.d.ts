/* Type declarations for the plain-JS YatraIQ engine. The implementation lives
   in yatraiq-engine.js so the browser, Express and the Cloudflare Worker can
   all import exactly the same code. */

export type ClassCode = "SL" | "3A" | "3E" | "2A" | "1A" | "CC" | "EC" | "2S";

export type QuotaId =
  | "general"
  | "tatkal"
  | "premium"
  | "ladies"
  | "senior"
  | "defence"
  | "divyangjan"
  | "lower";

export type PriorityId = "best" | "cheapest" | "fastest" | "safest" | "certainty";

export interface Station {
  code: string;
  name: string;
  city: string;
  state: string;
  tier: number;
  transferMinutes: number;
  popularity: number;
}

export interface ClassMeta {
  code: ClassCode;
  label: string;
  perKm: number;
  reservationFee: number;
  minFare: number;
  order: number;
}

export interface QuotaMeta {
  id: QuotaId;
  label: string;
  code: string;
  multiplier: number;
  demandModifier: number;
  confirmationBonus: number;
}

export interface PriorityMeta {
  id: PriorityId;
  label: string;
  hint: string;
}

export interface ServiceStop {
  code: string;
  km: number;
  arr: string | null;
  arrMin: number | null;
  dep: string | null;
  depMin: number | null;
  day: number;
  halt: number;
}

export interface Service {
  number: string;
  name: string;
  type: string;
  path: string[];
  km: number[];
  stops: ServiceStop[];
  distance: number;
  classes: ClassCode[];
  demand: number;
  punctuality: number;
  clearance: number;
  flexi: boolean;
  runsOn: string | string[];
  speed: number;
  halt: number;
}

export type AvailabilityStatus = "Available" | "RAC" | "Waitlist";

export interface Availability {
  status: AvailabilityStatus;
  count: number;
  wlPosition: number;
  source: string;
}

export interface WaitlistFactor {
  label: string;
  impact: "positive" | "negative" | "neutral";
  detail: string;
  weight: number;
}

export interface WaitlistPrediction {
  probability: number;
  percent: number;
  confidence: number;
  confidenceLabel: string;
  expectedStatus: string;
  factors: WaitlistFactor[];
  explanation: string;
  inputs: {
    wlPosition: number;
    classCode: ClassCode;
    quota: QuotaId;
    daysToDeparture: number;
    trainDemand: number;
    festivalPressure: number;
    historicalClearance: number;
    passengers: number;
  };
}

export interface WaitlistInput {
  wlPosition?: number;
  classCode?: ClassCode;
  quota?: QuotaId;
  daysToDeparture?: number;
  trainDemand?: number;
  festivalPressure?: number;
  historicalClearance?: number;
  passengers?: number;
}

export interface LegEndpoint {
  code: string;
  name: string;
  city: string;
}

export interface Leg {
  serviceNumber: string;
  serviceName: string;
  serviceType: string;
  from: LegEndpoint;
  to: LegEndpoint;
  depDate: string;
  arrDate: string;
  depClock: string;
  arrClock: string;
  depAbs: number;
  arrAbs: number;
  durationMin: number;
  distance: number;
  classCode: ClassCode;
  classLabel: string;
  quota: QuotaId;
  quotaLabel: string;
  price: number;
  availability: Availability;
  confirmation: number;
  waitlist: WaitlistPrediction | null;
  punctuality: number;
  flexi: boolean;
  dateOffset: number;
}

export interface Transfer {
  risk: number;
  success: number;
  label: string;
  bufferMin: number;
  requiredMinutes: number;
  transferMinutes: number;
  slackMin: number;
  sameStation: boolean;
  stationCode: string;
  station: string;
  stationName: string;
  fromStation: string;
  toStation: string;
}

export interface Itinerary {
  id: string;
  signature: string;
  legs: Leg[];
  transfers: Transfer[];
  legCount: number;
  isSplit: boolean;
  totalPrice: number;
  pricePerPassenger: number;
  totalDurationMin: number;
  departure: string;
  arrival: string;
  arrivalDayOffset: number;
  dateOffset: number;
  confirmation: number;
  confirmationPercent: number;
  transferRisk: number;
  transferRiskPercent: number;
  classCode: ClassCode;
  classLabel: string;
  quota: QuotaId;
  quotaLabel: string;
  passengers: number;
  summary: string;
  reasons: string[];
  tags: string[];
  score: number;
  recommended: boolean;
  pareto: boolean;
}

export interface OptimizeStats {
  total: number;
  direct: number;
  split: number;
  cheapest: { id: string; price: number } | null;
  fastest: { id: string; durationMin: number } | null;
  mostCertain: { id: string; confirmation: number } | null;
  bestDirect: { id: string; price: number } | null;
  fastestDirect: { id: string; durationMin: number } | null;
  premiumDirect: { id: string; price: number } | null;
  maxSaving: number;
  maxSavingVsPremium: number;
}

export interface OptimizeInput {
  from: string;
  to: string;
  date: string;
  classCode?: ClassCode;
  quota?: QuotaId;
  passengers?: number;
  priority?: PriorityId;
  maxLegs?: number;
  includeAlternateDates?: boolean;
  today?: string;
  festivalOverride?: number;
}

export interface OptimizeQuery {
  from: string;
  to: string;
  date: string;
  classCode: ClassCode;
  quota: QuotaId;
  passengers: number;
  priority: PriorityId;
  maxLegs: number;
  classLabel: string;
  quotaLabel: string;
  fromName: string;
  toName: string;
}

export interface OptimizeResult {
  engine: string;
  query: OptimizeQuery;
  options: Itinerary[];
  recommendedId: string | null;
  paretoIds: string[];
  stats: OptimizeStats;
  message: string | null;
  notes: string[];
  generatedAt: string;
}

export interface EscapeInput extends OptimizeInput {
  wlPosition?: number;
  trainNumber?: string;
}

export interface EscapeAction {
  id: string;
  type: string;
  title: string;
  description: string;
  price: number | null;
  priceDelta: number | null;
  confirmation: number;
  confirmationPercent: number;
  gain: number;
  risk: number;
  itinerary: Itinerary | null;
}

export interface EscapePlan {
  current: WaitlistPrediction & {
    trainNumber: string | null;
    trainName: string | null;
    price: number | null;
    classCode: ClassCode;
    classLabel: string;
    quota: QuotaId;
    quotaLabel: string;
    date: string;
  };
  actions: EscapeAction[];
  note: string;
}

export const ENGINE_VERSION: string;
export const STATIONS: Record<string, Station>;
export const SUPPORTED_STATIONS: Station[];
export const SERVICES: Service[];
export const PRIORITIES: PriorityMeta[];
export const CLASS_META: Record<ClassCode, ClassMeta>;
export const QUOTA_META: Record<QuotaId, QuotaMeta>;
export const CLASS_DOWNGRADE: Record<ClassCode, ClassCode | null>;

export function optimizeJourney(input: OptimizeInput): OptimizeResult;
export function predictWaitlist(input: WaitlistInput): WaitlistPrediction;
export function buildEscapePlan(input: EscapeInput): EscapePlan;
export function formatINR(amount: number): string;
export function formatDuration(minutes: number): string;
export function formatDateLabel(iso: string): string;
export function riskLabel(risk: number): string;
export function todayIso(): string;
export function festivalPressure(iso: string, override?: number): number;
export function fareForSegment(
  distance: number,
  classCode: ClassCode,
  quota: QuotaId,
  service: Service,
  date: string,
  festivalOverride?: number
): number;
export function availabilityFor(
  service: Service,
  date: string,
  classCode: ClassCode,
  quota: QuotaId,
  from: string,
  to: string,
  distance: number,
  passengers: number,
  options?: { today?: string; festivalOverride?: number }
): Availability;
