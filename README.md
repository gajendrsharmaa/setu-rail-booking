# Rail Bandhu — Train Ticket Booking (College Project)

**Live demo:** <https://rail-bandhu.rail-bandhu.workers.dev>

> **Rail Bandhu YatraIQ** is now the default home screen: a certainty-first journey planner that
> combines a split-ticket optimiser, an explainable waitlist oracle and transfer-risk scoring. The
> original booking flow is unchanged and still available under the **Book manually** tab.

A full train-ticket booking flow for Indian Railways, built with **React + TypeScript + Vite** and
served by a small API (Express locally, a Cloudflare Worker in production).

**Zero setup by default.** A fresh clone runs the complete demo with only:

```bash
npm install
npm start
```

No API key, no `.env`, no separate build step. `npm start` builds the app automatically and serves it
at `http://127.0.0.1:8787`.

## Features

- **All-India station search** — 8,670 active stations bundled locally, searchable by name or code.
- **Train search** — 4 bundled demo trains with realistic timings, run days, duration and distance.
- **Live station board** — labelled demo arrivals/departures for the next 2/4/6/8 hours.
- **Live train running status** — labelled demo position, delay, platform and route timeline.
- **8 quotas** — General (GN), Tatkal (TQ), Premium Tatkal (PT), Ladies (LD), Senior Citizens (SS),
  Defence (DF), Divyangjan (DP) and Lower Berth (LB), with Ladies/Senior validation.
- **Seat selection** — coach-wise maps with berth types; unavailable berths are greyed out.
- **Sandbox payment gateway** — UPI, card, net banking and wallet, validation, OTP, processing,
  transaction ID and auth code. No real money moves.
- **E-ticket + invoice** — PNR, passenger/seat table, fare breakup, payment details and a printable
  ticket.
- **Email after booking** — the backend sends a full HTML ticket + invoice email when SMTP or
  EmailJS is configured. Without credentials the rendered email is captured server-side for
  debugging; the confirmation screen no longer displays it.
- **Download + print fallback** — the confirmation screen downloads the ticket + invoice as a
  standalone PDF or prints the on-screen ticket.
- **Refresh-safe booking** — progress is saved to `localStorage` and restored after a browser refresh.

## YatraIQ: certainty-first planner

YatraIQ answers a different question from a normal train search: *which journey am I most likely to
actually complete?* One search compares direct trains, 2-leg and 3-leg split tickets, same-station
and nearby-station transfers, ±1 day alternatives, waitlist odds and transfer risk.

- **Split-ticket optimiser** — searches 100 modelled services across 59 major stations and prices
  each leg separately. Direct trains are often waitlisted on long routes while shorter segments
  clear more easily, so a two-PNR plan can beat a through ticket on certainty.
- **Waitlist Oracle** — an explainable logistic model turns WL position, days to departure, train
  demand, festival pressure, class, quota and passenger count into a confirmation probability with
  a factor-by-factor breakdown.
- **Transfer Risk Score** — combines the first train's punctuality, station walking time, buffer and
  same-station/nearby-station change into a missed-connection probability.
- **Pareto frontier** — plots price against confirmation so the trade-off is visible; dominated
  options are removed from the frontier.
- **Waitlist Escape Plan** — ranks split tickets, alternate trains, lower classes and Tatkal by how
  much confirmation they add.
- **What-if simulator** — festival-pressure slider and a four-date comparison.
- **Stitched multi-PNR PDF** — one printable document with a cover summary, one page per leg, PNR
  placeholders, transfer instructions and model notes.
- **Book manually hand-off** — any direct itinerary or individual split leg can be sent to the
  existing booking flow with stations, date and class prefilled.

The engine is written once in plain JavaScript (`src/lib/yatraiq-engine.js`) and imported by the
browser, the Express server and the Cloudflare Worker, so all three produce identical results. It
uses no network calls and no RailRadar quota.

### YatraIQ API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET`/`POST` | `/api/optimize` | Full optimisation. Query/body: `from`, `to`, `date`, `class`, `quota`, `passengers`, `priority`, `maxLegs`, `alternate`, `festival`. |
| `POST` | `/api/waitlist/predict` | Waitlist probability for one train/class/quota. |
| `POST` | `/api/waitlist/escape` | Ranked escape actions for a waitlisted journey. |
| `POST` | `/api/itinerary/pdf` | Stitched multi-PNR PDF for an itinerary returned by `/api/optimize`. |

All fares, availability and probabilities are **modelled estimates**, not live IRCTC data. Split
legs are separate PNRs and are not protected against a missed connection.

## Quick start (no keys)

```bash
cd setu-rail-booking
npm install
npm start
```

Open **http://127.0.0.1:8787**.

That is the whole setup. The search form is pre-filled with **Raipur Jn → New Delhi** for tomorrow.
Press **Search trains** and pick any train/class to continue through seats, passengers, payment and
the confirmation screen.

### What runs without any key

| Part | Behaviour with no key |
| --- | --- |
| Station search | Real, bundled 8,670-station list |
| Train search | 4 bundled demo trains, auto-loaded |
| Station board | Bundled demo board, labelled `DEMO BOARD` |
| Running status | Bundled demo route, labelled `DEMO SAMPLE` |
| Coach layout / berths | Generated locally |
| Fares / availability | Simulated, clearly labelled |
| Payment / OTP | SetuPay sandbox (`123456`) |
| Email | Captured server-side when no provider is configured |
| Ticket document | Download PDF / print always works |

The UI labels demo data everywhere so nothing is passed off as live.

## Booking progress survives refresh

Every meaningful change is saved to `localStorage` under `railbandhu:booking:v1`:

- current step, search form and results
- selected train, class, coach and seat maps
- selected seats and passenger/contact details
- PNR, payment receipt and email state

Refresh at any point and the app returns to the same screen with the same values. Email state is
saved too, but the confirmation screen always keeps the ticket PDF and print actions available.
**Book another journey** clears the saved snapshot.

## Email: what actually happens

After payment the app calls `POST /api/send-ticket` on the backend.

| Configuration | Result |
| --- | --- |
| No email credentials (default) | The full ticket + invoice HTML is rendered and captured server-side (Ethereal locally, Cloudflare preview in production). Nothing is delivered to the passenger's real address. |
| `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` | The same email is delivered to the passenger's real inbox through your SMTP account. |
| EmailJS keys | The same email is delivered through EmailJS. |

The confirmation screen always offers:

- **Download ticket + invoice** — save a two-page PDF with the e-ticket and invoice
- **Print / Save PDF** — print the on-screen ticket
- **Book another journey** — start a fresh booking

### Enable real inbox delivery (optional, not needed for the demo)

1. Create a Gmail **App Password** at <https://myaccount.google.com/apppasswords>.
2. Copy `.env.example` to `.env`.
3. Set:

   ```env
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=you@gmail.com
   SMTP_PASS=your_16_character_app_password
   MAIL_FROM=Rail Bandhu <you@gmail.com>
   ```

4. Restart with `npm start`.

The Ethereal fallback is only a test inbox; no free service can deliver mail to arbitrary real
addresses without some sending credential.

### Cloudflare Workers deployment

The app is also deployed as a single Cloudflare Worker with static assets. The Worker implements the
same `/api` routes as the Express server, including a server-side RailRadar proxy.

```bash
npx wrangler secret put RAILRADAR_API_KEY   # live trains, station boards, running status, coaches
npm run deploy                             # builds in cloudflare mode, then deploys
```

The deployed build calls RailRadar through `/api/railradar`, so the API key is stored as a Worker
secret and is never included in the browser bundle. `wrangler.jsonc` contains the Worker,
static-assets and KV bindings. Timetable, coach, station-board and live-status responses are cached
in KV so multiple visitors share one upstream request.

To enable real email delivery, create an EmailJS account and set these Worker secrets:

```bash
npx wrangler secret put EMAILJS_SERVICE_ID
npx wrangler secret put EMAILJS_TEMPLATE_ID
npx wrangler secret put EMAILJS_PUBLIC_KEY
npx wrangler secret put EMAILJS_PRIVATE_KEY
```

For real fares and seat availability, set `IRCTC_API_KEY` the same way. Without an IRCTC key, the
ticket flow works normally but fares and availability are estimates. The KV namespace also stores
rendered test-inbox emails for seven days.

> **RailRadar quota:** the current free plan allows 100 requests per month. The proxy caches
> aggressively, but heavy use can still exhaust that quota. Upgrade the RailRadar plan for
> production traffic.

## Optional: local RailRadar and IRCTC keys

The app runs without them, but train data is then bundled sample data and fares/availability are
estimates. To use live data locally, create `.env` **before** running `npm start` (a `VITE_` key is
compiled into the browser bundle at build time, so use the Worker proxy for public deployments):

```env
VITE_RAILRADAR_API_KEY=your_railradar_key
VITE_RAILRADAR_API_BASE=https://api.railradar.in/v1

# Optional: real IRCTC fares + seat availability (free key at https://irctc.dev/dashboard)
IRCTC_API_KEY=your_irctc_key
IRCTC_API_BASE=https://api.irctc.dev
```

Then:

```bash
npm start
```

With a RailRadar key, train search, the station board, running status and coach composition use the
real API. Without it, every one of those screens automatically uses the bundled demo data. The IRCTC
key stays on the server and is never shipped to the browser.

> **RailRadar quota:** the free plan is limited. Responses are cached (train search 6 h, live status
> 45 s, station board 90 s, coach composition 12 h). The footer shows the remaining monthly quota.
> If it runs out, the app falls back to a readable error and the demo remains usable.

## Share a demo link

Run the server, then expose it with a tunnel:

```bash
npm start                    # app + API on http://127.0.0.1:8787
```

```bash
# no account needed (temporary link, changes every restart)
cloudflared tunnel --url http://127.0.0.1:8787

# or ngrok (free account + authtoken required)
ngrok config add-authtoken <YOUR_TOKEN>
ngrok http 8787
```

The printed `https://...` URL works for anyone. Quick tunnels are temporary: the link stops working
when the tunnel process or the server is closed.

**For a public demo, build without your RailRadar key** so the key is not exposed in the public
bundle. Temporarily rename `.env`, run `npm run build`, then start the server and tunnel. The public
visitor gets the complete demo mode.

## Troubleshooting

**Blank page after starting?** Open the exact URL printed in the terminal
(`http://127.0.0.1:8787`) and hard-refresh with `Ctrl + Shift + R`. Then:

1. Check the terminal running `npm start` for errors.
2. Make sure port `8787` is free (close old servers), then start again.
3. If it still fails, delete `node_modules` and run `npm install`, then `npm start`.
4. VPN or ad-blocker extensions (Browsec, Privacy Badger, etc.) can block scripts on `localhost`.
   Disable them for this site, or open the app in an Incognito window.

**Payment OTP:** the sandbox accepts `123456`. Card number `4111 1111 1111 1111`, any future expiry,
CVV `123`.

**Email not delivered:** without SMTP/EmailJS the message is only captured server-side. Use
**Download ticket + invoice** for a PDF copy, or configure SMTP as described above.

**Email failed / retry:** delivery is attempted automatically after payment. If the local API is
offline, start the app with `npm start` (the email API is part of the same server). The ticket PDF
download does not depend on email delivery.

## Scripts

| Command | Description |
| --- | --- |
| `npm start` | Build the app, then serve `dist/` + `/api` on port 8787 |
| `npm run dev` | Start the Vite dev server |
| `npm run dev:api` | Start the backend only |
| `npm run dev:all` | Start both together |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build |
| `npm run typecheck` | TypeScript type-check |
| `npm run lint` | ESLint |
| `node scripts/fetch-stations.mjs` | Refresh the all-India station list |

## Project structure

```
server/
  index.mjs                  IRCTC proxy, email API, ticket download, static hosting
  ticketEmail.mjs            ticket + invoice HTML/text email template
  ticketPdf.mjs              two-page e-ticket + invoice PDF generator
src/
  App.tsx                    booking flow, screens, persistence, PDF download
  components/
    StationPicker.tsx        all-India searchable station combobox
    StationBoard.tsx         demo/live arrivals-departures board
    LiveTrainTracker.tsx     demo/live running status + route timeline
    PaymentGateway.tsx       sandbox UPI/card/netbanking/wallet checkout
  data/
    stations.ts              generated list of 8,670 active stations
  lib/
    demo.ts                  bundled demo trains, station board, live status
    railradar.ts             RailRadar client, coach composition, caching, quota
    irctc.ts                 IRCTC fare/availability client + parsers
    email.ts                 email client, ticket text, mailto and download helpers
    stations.ts              local station search/index
    booking.ts               classes, quotas, fares, seat maps, receipts
  theme.tsx                  design tokens + global styles
scripts/
  fetch-stations.mjs         regenerate the station dataset
```

## What is real vs simulated (default demo mode)

| Part | Source |
| --- | --- |
| Stations (8,670) | Real, bundled locally |
| Train search, timings, run days, distance | Bundled demo sample |
| Live running status, platform, route timeline | Bundled demo sample |
| Live station board | Bundled demo sample |
| Coach composition, coach numbers, berth types | Generated locally |
| Fares and fare breakup | Simulated |
| Seat availability (counts, RAC, waitlist) | Simulated |
| Exact seat-level occupancy | Simulated |
| Payment gateway, OTP, transaction/auth codes | Simulated sandbox |
| PNR and QR code | Simulated |
| Ticket + invoice email delivery | Ethereal test inbox by default; real SMTP/EmailJS when configured |
| Ticket + invoice document | Real downloadable HTML / printable PDF |

With a RailRadar key, the first five rows switch to the real API; with an IRCTC key, fares and
availability become real. The UI labels which mode is active.

This is a college project. It is **not affiliated with Indian Railways or IRCTC**, and the ticket is
not valid for travel.

## Demo flow (for evaluation)

1. Search **Raipur Jn (R) → Bilaspur Jn (BSP)** for tomorrow.
2. The results show real RailRadar trains and a `REAL TRAINS · RAILRADAR` chip when a key is configured.
3. Pick **SL** on a train. The seat screen shows a coach layout and simulated availability.
4. Select a seat, fill passenger details and contact email/phone.
5. Pay with UPI `name@bank`, card `4111 1111 1111 1111`, or any method; OTP is `123456`.
6. On the confirmation screen, show the e-ticket and invoice. Use **Download ticket + invoice** to
   save the two-page PDF, or **Print / Save PDF**.
7. Refresh the browser to show that the booking and PNR are restored.
8. Open **Live rail radar**, try the **Station board** and **Track a train** (`18237`, `12441`,
   `12919`, `12854`) to show the labelled demo/live data.
9. Book another journey and confirm the saved snapshot is cleared.

## Credits

- Train, station, live tracking and coach data (when configured): [RailRadar](https://railradar.in)
  (independent platform, not affiliated with Indian Railways).
- IRCTC fares/availability (when configured): [irctc.dev](https://irctc.dev).
- Icons: [Lucide](https://lucide.dev).
- Fonts: IBM Plex Sans / IBM Plex Mono.
