/* ==================================================================
   YatraIQ data layer
   ------------------------------------------------------------------
   A compact, offline network of major Indian Railways corridors.
   It is deliberately small so the optimiser can run instantly in the
   browser and in the Worker without spending RailRadar quota.

   Train numbers, names and approximate distances are real-world
   inspired. Timings are generated from a departure time, average
   speed and halt time so every service has a coherent schedule.
   Fares, availability and waitlist positions are modelled, not live.
   ================================================================== */

export const ENGINE_VERSION = "yatraiq-1.0.0";

export const CLASS_META = {
  SL: { code: "SL", label: "Sleeper", perKm: 0.55, reservationFee: 20, minFare: 120, order: 1 },
  "3A": { code: "3A", label: "AC 3 Tier", perKm: 1.35, reservationFee: 40, minFare: 400, order: 3 },
  "3E": { code: "3E", label: "AC 3 Economy", perKm: 1.15, reservationFee: 40, minFare: 350, order: 2 },
  "2A": { code: "2A", label: "AC 2 Tier", perKm: 1.95, reservationFee: 50, minFare: 600, order: 4 },
  "1A": { code: "1A", label: "AC First Class", perKm: 3.1, reservationFee: 60, minFare: 900, order: 5 },
  CC: { code: "CC", label: "AC Chair Car", perKm: 1.0, reservationFee: 30, minFare: 250, order: 2 },
  EC: { code: "EC", label: "Executive Chair Car", perKm: 1.8, reservationFee: 50, minFare: 500, order: 3 },
  "2S": { code: "2S", label: "Second Sitting", perKm: 0.3, reservationFee: 15, minFare: 60, order: 0 },
};

export const CLASS_DOWNGRADE = {
  "1A": "2A",
  "2A": "3A",
  "3A": "SL",
  "3E": "SL",
  EC: "CC",
  CC: "2S",
  SL: "2S",
  "2S": null,
};

export const QUOTA_META = {
  general: { id: "general", label: "General", code: "GN", multiplier: 1, demandModifier: 0, confirmationBonus: 0 },
  tatkal: { id: "tatkal", label: "Tatkal", code: "TQ", multiplier: 1.25, demandModifier: -0.28, confirmationBonus: 0.14 },
  premium: { id: "premium", label: "Premium Tatkal", code: "PT", multiplier: 1.5, demandModifier: -0.34, confirmationBonus: 0.18 },
  ladies: { id: "ladies", label: "Ladies", code: "LD", multiplier: 1, demandModifier: -0.06, confirmationBonus: 0.05 },
  senior: { id: "senior", label: "Senior Citizens", code: "SS", multiplier: 1, demandModifier: -0.04, confirmationBonus: 0.04 },
  defence: { id: "defence", label: "Defence", code: "DF", multiplier: 1, demandModifier: -0.04, confirmationBonus: 0.06 },
  divyangjan: { id: "divyangjan", label: "Divyangjan", code: "DP", multiplier: 1, demandModifier: -0.05, confirmationBonus: 0.05 },
  lower: { id: "lower", label: "Lower Berth", code: "LB", multiplier: 1, demandModifier: -0.02, confirmationBonus: 0.02 },
};

export const PRIORITIES = [
  { id: "best", label: "Best overall", hint: "Balances price, time, certainty and transfer risk." },
  { id: "cheapest", label: "Cheapest", hint: "Lowest total fare first, then certainty." },
  { id: "fastest", label: "Fastest", hint: "Shortest total journey time first." },
  { id: "safest", label: "Safest connection", hint: "Minimises missed-connection risk." },
  { id: "certainty", label: "Highest confirmation", hint: "Maximises the chance of a confirmed seat." },
];

/* ---------------- stations ---------------- */

function station(code, name, city, state, tier, transferMinutes, popularity) {
  return { code, name, city, state, tier, transferMinutes, popularity };
}

export const STATIONS = {
  R: station("R", "Raipur Jn", "Raipur", "Chhattisgarh", 2, 14, 0.62),
  BSP: station("BSP", "Bilaspur Jn", "Bilaspur", "Chhattisgarh", 2, 12, 0.7),
  RIG: station("RIG", "Raigarh", "Raigarh", "Chhattisgarh", 3, 8, 0.45),
  JSG: station("JSG", "Jharsuguda Jn", "Jharsuguda", "Odisha", 3, 8, 0.45),
  SBP: station("SBP", "Sambalpur", "Sambalpur", "Odisha", 2, 10, 0.5),
  BBS: station("BBS", "Bhubaneswar", "Bhubaneswar", "Odisha", 1, 15, 0.75),
  KUR: station("KUR", "Khurda Road Jn", "Khurda", "Odisha", 3, 8, 0.4),
  VSKP: station("VSKP", "Visakhapatnam", "Visakhapatnam", "Andhra Pradesh", 1, 15, 0.7),
  BZA: station("BZA", "Vijayawada Jn", "Vijayawada", "Andhra Pradesh", 1, 15, 0.75),
  MAS: station("MAS", "Chennai Central", "Chennai", "Tamil Nadu", 1, 18, 0.85),
  SBC: station("SBC", "KSR Bengaluru", "Bengaluru", "Karnataka", 1, 18, 0.85),
  MYS: station("MYS", "Mysuru Jn", "Mysuru", "Karnataka", 2, 10, 0.55),
  HWH: station("HWH", "Howrah Jn", "Kolkata", "West Bengal", 1, 18, 0.85),
  KGP: station("KGP", "Kharagpur Jn", "Kharagpur", "West Bengal", 2, 12, 0.6),
  TATA: station("TATA", "Tatanagar Jn", "Jamshedpur", "Jharkhand", 2, 12, 0.6),
  CKP: station("CKP", "Chakradharpur", "Chakradharpur", "Jharkhand", 3, 8, 0.4),
  ROU: station("ROU", "Rourkela", "Rourkela", "Odisha", 2, 10, 0.5),
  NGP: station("NGP", "Nagpur Jn", "Nagpur", "Maharashtra", 1, 15, 0.8),
  G: station("G", "Gondia Jn", "Gondia", "Maharashtra", 3, 8, 0.4),
  DURG: station("DURG", "Durg Jn", "Durg", "Chhattisgarh", 2, 10, 0.5),
  BSQ: station("BSQ", "Bhusaval Jn", "Bhusaval", "Maharashtra", 2, 12, 0.55),
  ET: station("ET", "Itarsi Jn", "Itarsi", "Madhya Pradesh", 2, 12, 0.55),
  BPL: station("BPL", "Bhopal Jn", "Bhopal", "Madhya Pradesh", 1, 15, 0.7),
  JHS: station("JHS", "Jhansi Jn", "Jhansi", "Uttar Pradesh", 2, 12, 0.6),
  GWL: station("GWL", "Gwalior Jn", "Gwalior", "Madhya Pradesh", 2, 10, 0.55),
  AGC: station("AGC", "Agra Cantt", "Agra", "Uttar Pradesh", 2, 12, 0.6),
  NDLS: station("NDLS", "New Delhi", "Delhi", "Delhi", 1, 20, 0.95),
  NZM: station("NZM", "Hazrat Nizamuddin", "Delhi", "Delhi", 1, 18, 0.85),
  ANVT: station("ANVT", "Anand Vihar Terminal", "Delhi", "Delhi", 1, 16, 0.75),
  CNB: station("CNB", "Kanpur Central", "Kanpur", "Uttar Pradesh", 1, 15, 0.75),
  LKO: station("LKO", "Lucknow Charbagh", "Lucknow", "Uttar Pradesh", 1, 15, 0.7),
  PRYJ: station("PRYJ", "Prayagraj Jn", "Prayagraj", "Uttar Pradesh", 2, 12, 0.6),
  DDU: station("DDU", "Pt DD Upadhyaya Jn", "Mughalsarai", "Uttar Pradesh", 2, 12, 0.6),
  GAYA: station("GAYA", "Gaya Jn", "Gaya", "Bihar", 2, 10, 0.5),
  PNBE: station("PNBE", "Patna Jn", "Patna", "Bihar", 1, 15, 0.75),
  RJPB: station("RJPB", "Rajendra Nagar", "Patna", "Bihar", 2, 10, 0.5),
  DHN: station("DHN", "Dhanbad Jn", "Dhanbad", "Jharkhand", 2, 12, 0.55),
  ASN: station("ASN", "Asansol Jn", "Asansol", "West Bengal", 2, 10, 0.5),
  BGP: station("BGP", "Bhagalpur", "Bhagalpur", "Bihar", 3, 8, 0.4),
  DBG: station("DBG", "Darbhanga Jn", "Darbhanga", "Bihar", 3, 8, 0.4),
  BSB: station("BSB", "Varanasi Jn", "Varanasi", "Uttar Pradesh", 2, 12, 0.6),
  MMCT: station("MMCT", "Mumbai Central", "Mumbai", "Maharashtra", 1, 18, 0.9),
  CSMT: station("CSMT", "Mumbai CSMT", "Mumbai", "Maharashtra", 1, 18, 0.9),
  PUNE: station("PUNE", "Pune Jn", "Pune", "Maharashtra", 1, 15, 0.75),
  SUR: station("SUR", "Solapur Jn", "Solapur", "Maharashtra", 2, 12, 0.55),
  HYB: station("HYB", "Hyderabad Deccan", "Hyderabad", "Telangana", 1, 15, 0.75),
  SC: station("SC", "Secunderabad Jn", "Hyderabad", "Telangana", 1, 15, 0.75),
  KOTA: station("KOTA", "Kota Jn", "Kota", "Rajasthan", 2, 12, 0.55),
  RTM: station("RTM", "Ratlam Jn", "Ratlam", "Madhya Pradesh", 2, 10, 0.5),
  BRC: station("BRC", "Vadodara Jn", "Vadodara", "Gujarat", 1, 15, 0.7),
  ST: station("ST", "Surat", "Surat", "Gujarat", 1, 12, 0.65),
  ADI: station("ADI", "Ahmedabad Jn", "Ahmedabad", "Gujarat", 1, 15, 0.75),
  JP: station("JP", "Jaipur Jn", "Jaipur", "Rajasthan", 1, 15, 0.7),
  AII: station("AII", "Ajmer Jn", "Ajmer", "Rajasthan", 2, 10, 0.55),
  CDG: station("CDG", "Chandigarh", "Chandigarh", "Chandigarh", 2, 10, 0.5),
  ASR: station("ASR", "Amritsar Jn", "Amritsar", "Punjab", 2, 12, 0.55),
  JAT: station("JAT", "Jammu Tawi", "Jammu", "J&K", 2, 12, 0.5),
  ERS: station("ERS", "Ernakulam Jn", "Kochi", "Kerala", 2, 12, 0.6),
  CBE: station("CBE", "Coimbatore Jn", "Coimbatore", "Tamil Nadu", 2, 10, 0.55),
};

export const SUPPORTED_STATIONS = Object.values(STATIONS);

/* Nearby stations that count as a station change rather than a same-station transfer. */
export const TRANSFER_LINKS = [
  { a: "NDLS", b: "NZM", minutes: 40 },
  { a: "NDLS", b: "ANVT", minutes: 45 },
  { a: "NZM", b: "ANVT", minutes: 50 },
  { a: "CSMT", b: "MMCT", minutes: 35 },
  { a: "SC", b: "HYB", minutes: 20 },
  { a: "BBS", b: "KUR", minutes: 25 },
];

/* ---------------- approximate inter-station distances (km) ---------------- */

const EDGE_KM = {
  "R|BSP": 113,
  "BSP|NGP": 298,
  "NGP|BPL": 390,
  "BPL|JHS": 290,
  "JHS|GWL": 100,
  "GWL|AGC": 120,
  "AGC|NDLS": 195,
  "JHS|AGC": 220,
  "R|DURG": 40,
  "DURG|G": 130,
  "G|NGP": 130,
  "NGP|R": 300,
  "R|ROU": 210,
  "ROU|BSP": 323,
  "BSP|ROU": 323,
  "ROU|CKP": 120,
  "CKP|TATA": 60,
  "TATA|KGP": 160,
  "KGP|HWH": 115,
  "TATA|ROU": 180,
  "TATA|HWH": 275,
  "BSP|RIG": 130,
  "RIG|JSG": 100,
  "JSG|SBP": 49,
  "SBP|BBS": 320,
  "BBS|KUR": 20,
  "KUR|VSKP": 420,
  "VSKP|BZA": 350,
  "BZA|MAS": 430,
  "MAS|BZA": 430,
  "BZA|SBC": 700,
  "MAS|SBC": 350,
  "SBC|SUR": 700,
  "NGP|BSQ": 310,
  "BSQ|ET": 260,
  "ET|BPL": 90,
  "BSQ|CSMT": 440,
  "BSQ|PUNE": 430,
  "PUNE|SUR": 260,
  "SUR|HYB": 380,
  "HYB|SUR": 380,
  "MMCT|ST": 280,
  "ST|BRC": 130,
  "BRC|RTM": 240,
  "RTM|KOTA": 280,
  "KOTA|NDLS": 470,
  "MMCT|PUNE": 190,
  "MMCT|BRC": 410,
  "MMCT|SUR": 450,
  "NDLS|CNB": 440,
  "CNB|PRYJ": 200,
  "PRYJ|DDU": 150,
  "DDU|GAYA": 200,
  "GAYA|DHN": 200,
  "DHN|ASN": 60,
  "ASN|HWH": 200,
  "HWH|DHN": 260,
  "DDU|PNBE": 220,
  "PNBE|RJPB": 5,
  "PNBE|BGP": 240,
  "DBG|PNBE": 150,
  "CNB|LKO": 80,
  "LKO|BSB": 300,
  "BSB|DDU": 120,
  "NDLS|JP": 300,
  "JP|AII": 135,
  "AII|ADI": 400,
  "ADI|JP": 535,
  "ADI|BRC": 100,
  "ADI|RTM": 300,
  "BPL|RTM": 300,
  "NDLS|CDG": 250,
  "CDG|ASR": 200,
  "CDG|JAT": 450,
  "HYB|NGP": 580,
  "NGP|HYB": 580,
  "HYB|BZA": 280,
  "BZA|HYB": 280,
  "BZA|NGP": 580,
  "NGP|BZA": 580,
  "CBE|BZA": 700,
  "BZA|CBE": 700,
  "ERS|CBE": 200,
  "PUNE|NGP": 900,
  "NGP|PUNE": 900,
  "BSP|BBS": 599,
  "BBS|VSKP": 440,
  "VSKP|BBS": 440,
  "HWH|BBS": 440,
  "BBS|HWH": 440,
  "JHS|PRYJ": 210,
  "PRYJ|JHS": 210,
  "PNBE|HWH": 450,
  "HWH|PNBE": 450,
  "GAYA|PNBE": 100,
  "PNBE|GAYA": 100,
};

function edgeKm(a, b) {
  const km = EDGE_KM[`${a}|${b}`] ?? EDGE_KM[`${b}|${a}`];
  if (!km) throw new Error(`YatraIQ data error: missing distance for ${a}-${b}`);
  return km;
}

function pathKm(path) {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += edgeKm(path[i - 1], path[i]);
  return total;
}

/* ---------------- time helpers ---------------- */

function pad(value) {
  return String(value).padStart(2, "0");
}

function clockToMinutes(clock) {
  const [hours, minutes] = String(clock).split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToClock(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
}

function makeRun(definition) {
  const {
    number,
    name,
    type,
    path,
    depart,
    speed,
    halt = 5,
    classes,
    demand = 0.8,
    punctuality = 0.7,
    clearance = 0.55,
    flexi = false,
    runsOn = "daily",
  } = definition;

  const km = [0];
  for (let i = 1; i < path.length; i += 1) {
    km.push(km[i - 1] + edgeKm(path[i - 1], path[i]));
  }

  const stops = [];
  let previousDeparture = clockToMinutes(depart);

  stops.push({
    code: path[0],
    km: 0,
    arr: null,
    arrMin: null,
    dep: minutesToClock(previousDeparture),
    depMin: previousDeparture,
    day: 0,
    halt: 0,
  });

  for (let i = 1; i < path.length; i += 1) {
    const travel = Math.round(((km[i] - km[i - 1]) / speed) * 60);
    const arrival = previousDeparture + travel;
    const day = Math.floor(arrival / 1440);
    const isLast = i === path.length - 1;
    const departure = isLast ? null : arrival + halt;

    stops.push({
      code: path[i],
      km: km[i],
      arr: minutesToClock(arrival),
      arrMin: arrival,
      dep: isLast ? null : minutesToClock(departure),
      depMin: departure,
      day,
      halt: isLast ? 0 : halt,
    });

    if (!isLast) previousDeparture = departure;
  }

  return {
    number,
    name,
    type,
    path,
    km,
    stops,
    distance: km[km.length - 1],
    classes,
    demand,
    punctuality,
    clearance,
    flexi,
    runsOn,
    speed,
    halt,
  };
}

/* ---------------- services ---------------- */

const BASE_SERVICES = [
  /* Raipur / Bilaspur - Nagpur - Bhopal - Delhi */
  {
    number: "18237", name: "Chhattisgarh Express", type: "Superfast Express",
    path: ["R", "BSP", "NGP", "BPL", "JHS", "AGC", "NDLS"],
    depart: "14:30", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.88, punctuality: 0.66, clearance: 0.55,
  },
  {
    number: "12409", name: "Gondwana Express", type: "Superfast Express",
    path: ["R", "BSP", "NGP", "BPL", "JHS", "AGC", "NDLS"],
    depart: "09:20", speed: 62, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.82, punctuality: 0.72, clearance: 0.58,
  },
  {
    number: "12441", name: "Bilaspur - New Delhi Rajdhani", type: "Rajdhani Express",
    path: ["BSP", "NGP", "BPL", "JHS", "AGC", "NDLS"],
    depart: "15:35", speed: 70, halt: 3, classes: ["1A", "2A", "3A"],
    demand: 0.95, punctuality: 0.84, clearance: 0.62, flexi: true,
  },
  {
    number: "18239", name: "Shivnath Express", type: "Mail/Express",
    path: ["R", "DURG", "G", "NGP"],
    depart: "18:10", speed: 52, halt: 6, classes: ["SL", "3A", "2A"],
    demand: 0.78, punctuality: 0.7, clearance: 0.6,
  },
  {
    number: "12853", name: "Amarkantak Express", type: "Superfast Express",
    path: ["DURG", "R", "BSP", "NGP", "BPL"],
    depart: "18:30", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.68, clearance: 0.56,
  },
  {
    number: "12002", name: "Bhopal Shatabdi", type: "Shatabdi Express",
    path: ["BPL", "JHS", "GWL", "AGC", "NDLS"],
    depart: "15:15", speed: 78, halt: 3, classes: ["CC", "EC"],
    demand: 0.9, punctuality: 0.9, clearance: 0.65, flexi: true,
  },
  {
    number: "12137", name: "Punjab Mail", type: "Mail/Express",
    path: ["CSMT", "BSQ", "ET", "BPL", "JHS", "AGC", "NDLS"],
    depart: "19:35", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.86, punctuality: 0.7, clearance: 0.58,
  },
  {
    number: "12723", name: "Telangana Express", type: "Superfast Express",
    path: ["HYB", "NGP", "BPL", "JHS", "AGC", "NDLS"],
    depart: "06:25", speed: 62, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.88, punctuality: 0.75, clearance: 0.6,
  },
  {
    number: "12621", name: "Tamil Nadu Express", type: "Superfast Express",
    path: ["MAS", "BZA", "NGP", "BPL", "JHS", "AGC", "NDLS"],
    depart: "22:00", speed: 60, halt: 4, classes: ["SL", "3A", "2A", "1A"],
    demand: 0.9, punctuality: 0.7, clearance: 0.6,
  },
  {
    number: "12615", name: "Grand Trunk Express", type: "Mail/Express",
    path: ["MAS", "BZA", "NGP", "BPL", "JHS", "AGC", "NDLS"],
    depart: "19:15", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.85, punctuality: 0.65, clearance: 0.56,
  },
  {
    number: "12807", name: "Samata Express", type: "Superfast Express",
    path: ["VSKP", "BZA", "NGP", "BPL", "JHS", "AGC", "NDLS"],
    depart: "17:20", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.68, clearance: 0.57,
  },
  {
    number: "12626", name: "Kerala Express", type: "Superfast Express",
    path: ["ERS", "CBE", "BZA", "NGP", "BPL", "JHS", "AGC", "NDLS"],
    depart: "11:15", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.86, punctuality: 0.66, clearance: 0.56,
  },
  {
    number: "12627", name: "Karnataka Express", type: "Superfast Express",
    path: ["SBC", "SUR", "PUNE", "BSQ", "ET", "BPL", "JHS", "AGC", "NDLS"],
    depart: "19:20", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.85, punctuality: 0.7, clearance: 0.58,
  },

  /* Raipur - Howrah */
  {
    number: "12810", name: "Howrah - Mumbai Mail", type: "Mail/Express",
    path: ["HWH", "KGP", "TATA", "CKP", "ROU", "BSP", "R", "DURG", "G", "NGP", "BSQ", "CSMT"],
    depart: "20:10", speed: 55, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.88, punctuality: 0.65, clearance: 0.55,
  },
  {
    number: "12834", name: "Howrah - Ahmedabad Express", type: "Mail/Express",
    path: ["HWH", "KGP", "TATA", "ROU", "BSP", "R", "DURG", "G", "NGP", "BSQ", "ET", "BPL", "RTM", "ADI"],
    depart: "23:55", speed: 55, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.82, punctuality: 0.62, clearance: 0.54,
  },
  {
    number: "12860", name: "Gitanjali Express", type: "Superfast Express",
    path: ["HWH", "KGP", "TATA", "ROU", "BSP", "R", "DURG", "G", "NGP", "BSQ", "CSMT"],
    depart: "14:05", speed: 60, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.86, punctuality: 0.7, clearance: 0.58,
  },
  {
    number: "18030", name: "Shalimar - LTT Express", type: "Mail/Express",
    path: ["HWH", "KGP", "TATA", "ROU", "BSP", "R", "DURG", "G", "NGP", "BSQ", "PUNE"],
    depart: "18:00", speed: 52, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.78, punctuality: 0.6, clearance: 0.53,
  },

  /* East coast / Odisha */
  {
    number: "20825", name: "Raipur - Bhubaneswar Vande Bharat", type: "Vande Bharat",
    path: ["R", "BSP", "RIG", "JSG", "SBP", "BBS"],
    depart: "06:15", speed: 78, halt: 2, classes: ["CC", "EC"],
    demand: 0.9, punctuality: 0.92, clearance: 0.7, flexi: true,
  },
  {
    number: "18463", name: "Prashanti Express", type: "Express",
    path: ["BBS", "KUR", "VSKP", "BZA", "SBC"],
    depart: "05:30", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.68, clearance: 0.57,
  },
  {
    number: "12845", name: "Bhubaneswar - Yesvantpur Express", type: "Superfast Express",
    path: ["BBS", "VSKP", "BZA", "SBC"],
    depart: "07:10", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.78, punctuality: 0.7, clearance: 0.58,
  },
  {
    number: "12841", name: "Coromandel Express", type: "Superfast Express",
    path: ["HWH", "BBS", "VSKP", "BZA", "MAS"],
    depart: "14:50", speed: 62, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.88, punctuality: 0.72, clearance: 0.6,
  },
  {
    number: "12863", name: "Howrah - Yesvantpur Express", type: "Superfast Express",
    path: ["HWH", "BBS", "VSKP", "BZA", "SBC"],
    depart: "22:55", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.68, clearance: 0.57,
  },

  /* Raipur - Mumbai */
  {
    number: "12812", name: "LTT - Howrah Express", type: "Superfast Express",
    path: ["CSMT", "BSQ", "NGP", "G", "DURG", "R", "BSP", "ROU", "TATA", "KGP", "HWH"],
    depart: "08:20", speed: 55, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.62, clearance: 0.54,
  },
  {
    number: "12101", name: "Jnaneswari Express", type: "Superfast Express",
    path: ["CSMT", "BSQ", "NGP", "G", "DURG", "R", "BSP", "ROU", "TATA", "HWH"],
    depart: "20:35", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.84, punctuality: 0.66, clearance: 0.56,
  },

  /* Mumbai - Delhi */
  {
    number: "12951", name: "Mumbai Rajdhani", type: "Rajdhani Express",
    path: ["MMCT", "ST", "BRC", "RTM", "KOTA", "NDLS"],
    depart: "17:00", speed: 78, halt: 3, classes: ["1A", "2A", "3A"],
    demand: 0.95, punctuality: 0.9, clearance: 0.68, flexi: true,
  },
  {
    number: "12953", name: "August Kranti Rajdhani", type: "Rajdhani Express",
    path: ["MMCT", "BRC", "RTM", "KOTA", "NDLS"],
    depart: "17:10", speed: 75, halt: 3, classes: ["1A", "2A", "3A"],
    demand: 0.92, punctuality: 0.88, clearance: 0.66, flexi: true,
  },
  {
    number: "12925", name: "Paschim Express", type: "Superfast Express",
    path: ["MMCT", "ST", "BRC", "RTM", "KOTA", "NDLS"],
    depart: "11:25", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.84, punctuality: 0.66, clearance: 0.56,
  },
  {
    number: "19031", name: "Yoga Express", type: "Mail/Express",
    path: ["ADI", "JP", "NDLS"],
    depart: "22:30", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.75, punctuality: 0.62, clearance: 0.54,
  },
  {
    number: "12015", name: "Ajmer Shatabdi", type: "Shatabdi Express",
    path: ["AII", "JP", "NDLS"],
    depart: "06:00", speed: 75, halt: 3, classes: ["CC", "EC"],
    demand: 0.82, punctuality: 0.9, clearance: 0.66, flexi: true,
  },
  {
    number: "12985", name: "Jaipur - Delhi Double Decker", type: "Double Decker",
    path: ["JP", "NDLS"],
    depart: "06:00", speed: 70, halt: 2, classes: ["CC"],
    demand: 0.8, punctuality: 0.85, clearance: 0.64,
  },

  /* Mumbai - Pune - Hyderabad */
  {
    number: "12123", name: "Deccan Queen", type: "Superfast Express",
    path: ["MMCT", "PUNE"],
    depart: "17:10", speed: 65, halt: 2, classes: ["CC", "EC"],
    demand: 0.85, punctuality: 0.88, clearance: 0.64,
  },
  {
    number: "17031", name: "Hyderabad Express", type: "Express",
    path: ["MMCT", "PUNE", "SUR", "HYB"],
    depart: "13:00", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.66, clearance: 0.56,
  },
  {
    number: "12701", name: "Hussain Sagar Express", type: "Superfast Express",
    path: ["MMCT", "SUR", "HYB"],
    depart: "21:50", speed: 60, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.82, punctuality: 0.7, clearance: 0.58,
  },

  /* Delhi - Howrah / Patna */
  {
    number: "12301", name: "Howrah Rajdhani", type: "Rajdhani Express",
    path: ["HWH", "DHN", "GAYA", "DDU", "PRYJ", "CNB", "NDLS"],
    depart: "16:50", speed: 78, halt: 3, classes: ["1A", "2A", "3A"],
    demand: 0.96, punctuality: 0.88, clearance: 0.7, flexi: true,
  },
  {
    number: "12303", name: "Poorva Express", type: "Superfast Express",
    path: ["HWH", "ASN", "DHN", "GAYA", "DDU", "PRYJ", "CNB", "NDLS"],
    depart: "16:15", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.86, punctuality: 0.66, clearance: 0.56,
  },
  {
    number: "12309", name: "Patna Rajdhani", type: "Rajdhani Express",
    path: ["RJPB", "PNBE", "DDU", "PRYJ", "CNB", "NDLS"],
    depart: "19:10", speed: 75, halt: 3, classes: ["1A", "2A", "3A"],
    demand: 0.94, punctuality: 0.86, clearance: 0.68, flexi: true,
  },
  {
    number: "12397", name: "Mahabodhi Express", type: "Superfast Express",
    path: ["GAYA", "DDU", "PRYJ", "CNB", "NDLS"],
    depart: "14:00", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.68, clearance: 0.57,
  },
  {
    number: "12559", name: "Shiv Ganga Express", type: "Superfast Express",
    path: ["BSB", "DDU", "PRYJ", "CNB", "NDLS"],
    depart: "18:30", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.82, punctuality: 0.68, clearance: 0.57,
  },
  {
    number: "12004", name: "Lucknow Shatabdi", type: "Shatabdi Express",
    path: ["LKO", "CNB", "NDLS"],
    depart: "06:00", speed: 75, halt: 3, classes: ["CC", "EC"],
    demand: 0.85, punctuality: 0.9, clearance: 0.66, flexi: true,
  },
  {
    number: "12565", name: "Bihar Sampark Kranti", type: "Sampark Kranti",
    path: ["DBG", "PNBE", "DDU", "PRYJ", "CNB", "NDLS"],
    depart: "08:30", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.65, clearance: 0.55,
  },
  {
    number: "22405", name: "Bhagalpur - Anand Vihar Express", type: "Superfast Express",
    path: ["BGP", "PNBE", "DDU", "PRYJ", "CNB", "NDLS"],
    depart: "17:45", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.78, punctuality: 0.62, clearance: 0.54,
  },

  /* Delhi - Rajasthan / Gujarat */
  {
    number: "12915", name: "Ashram Express", type: "Superfast Express",
    path: ["ADI", "JP", "NDLS"],
    depart: "19:30", speed: 58, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.68, clearance: 0.57,
  },
  {
    number: "12957", name: "Swarna Jayanti Rajdhani", type: "Rajdhani Express",
    path: ["ADI", "JP", "NDLS"],
    depart: "19:05", speed: 75, halt: 3, classes: ["1A", "2A", "3A"],
    demand: 0.88, punctuality: 0.85, clearance: 0.65, flexi: true,
  },

  /* Delhi - Punjab / Jammu */
  {
    number: "12013", name: "Amritsar Shatabdi", type: "Shatabdi Express",
    path: ["NDLS", "CDG", "ASR"],
    depart: "16:30", speed: 75, halt: 3, classes: ["CC", "EC"],
    demand: 0.85, punctuality: 0.9, clearance: 0.66, flexi: true,
  },
  {
    number: "12471", name: "Swaraj Express", type: "Superfast Express",
    path: ["NDLS", "CDG", "JAT"],
    depart: "11:00", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.78, punctuality: 0.62, clearance: 0.54,
  },
  {
    number: "12413", name: "Pooja Express", type: "Superfast Express",
    path: ["NDLS", "CDG", "JAT"],
    depart: "21:35", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.75, punctuality: 0.6, clearance: 0.53,
  },

  /* South */
  {
    number: "12027", name: "Chennai - Bengaluru Shatabdi", type: "Shatabdi Express",
    path: ["MAS", "SBC"],
    depart: "17:30", speed: 75, halt: 3, classes: ["CC", "EC"],
    demand: 0.85, punctuality: 0.9, clearance: 0.66, flexi: true,
  },
  {
    number: "12608", name: "Lalbagh Express", type: "Superfast Express",
    path: ["MAS", "SBC"],
    depart: "06:30", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.8, punctuality: 0.68, clearance: 0.57,
  },
  {
    number: "12707", name: "Andhra Pradesh Sampark Kranti", type: "Sampark Kranti",
    path: ["HYB", "NGP", "BPL", "JHS", "AGC", "NDLS"],
    depart: "06:00", speed: 60, halt: 4, classes: ["SL", "3A", "2A"],
    demand: 0.82, punctuality: 0.7, clearance: 0.58,
  },
  {
    number: "22881", name: "Pune - Bhubaneswar Express", type: "Superfast Express",
    path: ["PUNE", "NGP", "R", "BSP", "BBS"],
    depart: "11:15", speed: 55, halt: 5, classes: ["SL", "3A", "2A"],
    demand: 0.78, punctuality: 0.65, clearance: 0.55,
  },
].map(makeRun);

/* Every direction is useful in a planner. Real Indian Railways trains have
   separate return services; we generate a plausible return run for each
   defined service so any station pair on a corridor can be searched. */
const RETURN_SERVICES = BASE_SERVICES.map((service) => {
  const lastStop = service.stops[service.stops.length - 1];
  const turnaround = 180;
  return makeRun({
    number: `${service.number}R`,
    name: `${service.name} (return)`,
    type: service.type,
    path: [...service.path].reverse(),
    depart: minutesToClock(clockToMinutes(lastStop.arr) + turnaround),
    speed: service.speed,
    halt: service.halt,
    classes: service.classes,
    demand: Math.max(0.45, service.demand * 0.95),
    punctuality: service.punctuality,
    clearance: service.clearance,
    flexi: service.flexi,
    runsOn: service.runsOn,
  });
});

export const SERVICES = [...BASE_SERVICES, ...RETURN_SERVICES];

/* ---------------- festivals and seasonal pressure ---------------- */

const FESTIVALS = [
  { name: "Diwali", dates: ["2026-11-08", "2027-10-29"], window: 5, weight: 0.95 },
  { name: "Chhath Puja", dates: ["2026-11-15", "2027-11-04"], window: 4, weight: 0.9 },
  { name: "Holi", dates: ["2026-03-04", "2027-03-22"], window: 4, weight: 0.75 },
  { name: "Eid al-Fitr", dates: ["2026-03-21", "2027-03-10"], window: 3, weight: 0.7 },
  { name: "Onam", dates: ["2026-08-26", "2027-08-15"], window: 3, weight: 0.6 },
  { name: "Pongal", dates: ["2026-01-14", "2027-01-14"], window: 3, weight: 0.6 },
  { name: "Bihu", dates: ["2026-04-14", "2027-04-14"], window: 3, weight: 0.55 },
  { name: "Christmas", dates: ["2026-12-25", "2027-12-25"], window: 3, weight: 0.6 },
  { name: "New Year", dates: ["2026-12-31", "2027-12-31"], window: 3, weight: 0.65 },
];

function dateToUtc(iso) {
  return new Date(`${iso}T00:00:00Z`);
}

export function dateAdd(iso, days) {
  const date = dateToUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((dateToUtc(toIso).getTime() - dateToUtc(fromIso).getTime()) / 86400000);
}

export function weekdayKey(iso) {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dateToUtc(iso).getUTCDay()];
}

export function isWeekend(iso) {
  return ["fri", "sat", "sun"].includes(weekdayKey(iso));
}

export function festivalPressure(iso, override) {
  if (typeof override === "number") return Math.max(0, Math.min(1, override));

  let pressure = 0;
  const date = dateToUtc(iso);
  for (const festival of FESTIVALS) {
    for (const festivalDate of festival.dates) {
      const distance = Math.abs(daysBetween(festivalDate, iso));
      if (distance <= festival.window) {
        const proximity = 1 - distance / (festival.window + 1);
        pressure = Math.max(pressure, festival.weight * proximity);
      }
    }
  }

  const month = date.getUTCMonth() + 1;
  if (month >= 4 && month <= 6) pressure = Math.max(pressure, 0.35);
  if (month === 2 || month === 3) pressure = Math.max(pressure, 0.25);
  if (isWeekend(iso)) pressure = Math.max(pressure, 0.12);
  return Math.min(1, pressure);
}

export function serviceRunsOn(service, iso) {
  return service.runsOn === "daily" || service.runsOn.includes(weekdayKey(iso));
}

export function stationByCode(code) {
  return STATIONS[String(code || "").toUpperCase()];
}

export function serviceByNumber(number) {
  return SERVICES.find((service) => service.number === String(number));
}
