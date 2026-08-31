# CBT Proctor Extension (HBMDS)

Host-Based Malpractice Detection System — a lightweight browser-extension architecture for real-time CBT malpractice detection, as described in:

> Uzonu, C. O., Bello, M. A., & Opeyemi, A. K. (2026). *Empirical Evaluation of a Browser Extension Architecture for Real-Time Examination Malpractice Detection.* AFIT, Kaduna.

---

## Project Structure

```
cbt-proctor-extension/
├── extension/
│   ├── manifest.json        — Manifest V3; managed-storage schema, any-host /exam/* scope
│   ├── config.js            — Shared server-URL resolver (enterprise policy → localhost)
│   ├── managed_schema.json  — chrome.storage.managed schema (serverUrl)
│   ├── background.js        — Service worker: tab/window monitoring, Signal B ping
│   └── content.js           — Injected into exam pages: heartbeat, listeners, event batching
├── server/
│   ├── server.js            — Express + Socket.IO + Mongoose (single file)
│   ├── Dockerfile           — node:20-alpine production image
│   ├── models/
│   │   └── ViolationLog.js  — MongoDB schema
│   └── public/
│       ├── exam/            — login.html, paper.html (monitored)
│       └── admin/           — Admin dashboard (self-contained SPA)
├── deploy/
│   └── nginx.conf           — Edge proxy: static files, WebSocket, rate limiting, TLS
├── docker-compose.yml       — nginx → node → mongo production stack
├── .env.example             — Required production secrets
└── tests/
    ├── test_detection_events.py — Selenium verification of all 11 detection events
    └── stress_test.py           — 50-session / 500-event stress test (Zenodo dataset)
```

---

## How It Works

Two independent signals are sent to the server during an active exam session:

| Signal | Source | Interval | Purpose |
|--------|--------|----------|---------|
| A — Heartbeat | `content.js` → `POST /api/heartbeat` | 10 s | Proves exam page is open and network is up |
| B — Ext ping | `background.js` → `POST /api/ext-ping` | 12 s | Proves extension is still enabled |

A server-side watchdog checks both signals every 8 seconds:
- Signal B dead, Signal A alive → `EXTENSION_DISABLED`
- Both dead → `CRITICAL_DISCONNECT`

Violation events are reported to `POST /api/report` and broadcast in real time to the admin dashboard via Socket.IO.

### Event batching (client-side)

High-frequency, non-critical events (`WINDOW_FOCUS_LOST`, `CLIPBOARD_ACTION`, `RESTRICTED_KEY`, `RIGHT_CLICK`, `SUSPICIOUS_RESIZE`) are buffered in `content.js` and flushed every 3 seconds in a single `navigator.sendBeacon()` batch, so key-mashing or resize storms cannot spam the server. Critical events (`DEVTOOLS_OPEN`, `TAB_HIDDEN`, `PAGE_UNLOAD`, `EXTENSION_KILLED`) are transmitted immediately.

Each batch carries a `sentAt` transmission timestamp. The server computes `latencyMs` from `sentAt` (when present) rather than the original event timestamp, so batched or offline-queued events register their true transport latency instead of false multi-second spikes.

---

## Detection Events

| Event | Source | Trigger |
|-------|--------|---------|
| `TAB_SWITCH` | background.js | Tab activated to non-exam URL |
| `UNAUTHORIZED_NAVIGATION` | background.js | Tab navigated to non-exam URL |
| `BROWSER_OUT_OF_FOCUS` | background.js | Chrome lost OS window focus |
| `DEVTOOLS_OPEN` | content.js | F12, Ctrl+Shift+I/J/C |
| `WINDOW_FOCUS_LOST` | content.js | Page `blur` event |
| `TAB_HIDDEN` | content.js | `visibilitychange` → hidden |
| `PAGE_UNLOAD` | content.js | `pagehide` event |
| `CLIPBOARD_ACTION` | content.js | copy / cut / paste |
| `RESTRICTED_KEY` | content.js | Alt, Meta, Ctrl+U/S/A |
| `RIGHT_CLICK` | content.js | `contextmenu` |
| `SUSPICIOUS_RESIZE` | content.js | Window shrinks >150 px (DevTools heuristic) |
| `EXTENSION_KILLED` | content.js | Extension context invalidated (watchdog beacon) |
| `EXTENSION_DISABLED` | server watchdog | Signal B dead, Signal A recent |
| `CRITICAL_DISCONNECT` | server watchdog | Both signals dead |
| `EXAM_SUBMITTED` | `POST /api/logout` | Student submitted exam |

---

## Database Schema

Student identities are never stored in plain text. The server computes a one-way SHA-256 hash of the student ID before persisting any violation record (GDPR/NDPA compliance, paper §III.D).

```js
{
  pseudonymizedId:  String,   // SHA-256(studentId)
  sessionId:        String,   // UUID generated per exam session
  eventType:        String,
  violationURL:     String,   // populated for TAB_SWITCH / UNAUTHORIZED_NAVIGATION
  detail:           String,
  timestamp:        Date,     // when the event occurred (client clock)
  sentAt:           Date,     // when the client transmitted (batched/offline flushes)
  serverReceivedAt: Date,     // server clock
  latencyMs:        Number,   // serverReceivedAt − (sentAt ‖ timestamp)
}
```

The in-memory session Map (`studentId → { lastHeartbeat, lastExtPing }`) uses plain IDs for real-time monitoring; only the MongoDB log layer pseudonymizes.

---

## Local Development

Requirements: Node.js 18+, MongoDB on `mongodb://127.0.0.1:27017`, Google Chrome.

```bash
cd server && npm install
mongod                     # separate terminal
node server.js             # http://localhost:3000
```

Load the extension: `chrome://extensions/` → Developer mode → **Load unpacked** → `extension/` folder. With no enterprise policy set, the extension defaults to `http://localhost:3000`.

- Student: `http://localhost:3000/exam/login.html`
- Admin: `http://localhost:3000/admin/index.html` — default credentials `admin` / `admin123` (dev only; production refuses to start with these)

---

## Production Deployment

### 1. Server stack (Docker)

Requirements: Docker Engine + Compose plugin on the lab server.

```bash
cp .env.example .env
# Edit .env: set ADMIN_USER, a strong ADMIN_PASS, and TOKEN_SECRET (openssl rand -hex 32)
docker compose up -d --build
```

This starts three containers:

| Container | Role |
|-----------|------|
| `nginx` | Edge on ports 80/443 — serves all static files, proxies `/api` + `/socket.io` to Node, rate-limits report endpoints (20 req/s per client IP, burst 40) |
| `server` | Node.js API + WebSocket hub. Health-checked via `GET /healthz`; auto-restarts on failure. Refuses to boot with default admin credentials |
| `mongo` | MongoDB 7, persisted in the `mongo_data` volume; never exposed to the network |

Verify: `curl http://<server-ip>/healthz` → `{"ok":true,...}`.

**TLS (recommended):** place `fullchain.pem` + `privkey.pem` in `deploy/certs/`, then uncomment the certs volume in `docker-compose.yml` and the `ssl_*` lines in `deploy/nginx.conf`. Restart nginx: `docker compose restart nginx`.

**Server environment variables** (see `.env.example`):

| Variable | Default | Notes |
|----------|---------|-------|
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin123` | **Must** be changed; production boot fails on the default password |
| `TOKEN_SECRET` | random per boot | Set it so admin tokens survive restarts. Tokens expire after 12 h |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/cbt_logs` | Compose sets this to the `mongo` container |
| `PORT` | `3000` | |
| `CORS_ORIGIN` | `*` | Lock to the public origin in production |

### 2. Extension rollout (Active Directory / Chrome Enterprise)

Never rely on Developer Mode in production — students can pause or remove unpacked extensions. Deploy via Group Policy instead:

1. **Force-install** — add the extension ID to the `ExtensionInstallForcelist` policy (`HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist`). Students cannot disable or remove force-installed extensions.
2. **Point it at your server** — the same build works on any subnet; push the server URL through managed storage policy (`Software\Policies\Google\Chrome\3rdparty\extensions\<extension-id>\policy`):

   ```json
   { "serverUrl": "https://cbt.campus.edu" }
   ```

   `config.js` reads `chrome.storage.managed.serverUrl` on load; with no policy it falls back to `http://localhost:3000` (development).
3. **Disable DevTools browser-wide** — set the `DeveloperToolsAvailability` policy to `2` (disallowed). This is an OS-level safeguard on top of the extension's `DEVTOOLS_OPEN` detection.

The content script matches `*://*/exam/*`, so it activates on the exam pages of whatever host the policy points to.

### 3. Scaling notes

- A single Node instance comfortably handles 1,000 concurrent students (~220 req/s of heartbeats/pings; client-side batching keeps `/api/report` traffic low). Mongoose runs with `maxPoolSize: 100` for login/submission rushes.
- Session state lives in an in-memory Map, so run **one** server instance. If you ever need horizontal scaling, move the session Map to Redis TTL keys (see comments in `server.js`) and add more `server` containers behind nginx — the load-balancing config is already in place.
- Nginx serves every static asset directly; Node's event loop is reserved for API and WebSocket traffic.

---

## API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/login` | — | Admin login; returns Bearer token (12 h expiry) |
| `POST` | `/api/heartbeat` | — | Signal A (content.js) |
| `POST` | `/api/ext-ping` | — | Signal B (background.js) |
| `POST` | `/api/exam/start` | — | Register session at login |
| `POST` | `/api/report` | — | Violation event — single object, or batch `{ studentId, sessionId, sentAt, events: [...] }` (max 100/batch) |
| `POST` | `/api/logout` | — | Exam submitted |
| `GET` | `/api/logs` | Bearer | Fetch logs (`start`, `end`, `studentId` query params) |
| `GET` | `/api/logs/dates` | Bearer | Distinct dates with counts |
| `GET` | `/api/logs/export/xlsx-data` | Bearer | XLSX export data |
| `GET` | `/api/sessions` | Bearer | Live session snapshot |
| `GET` | `/healthz` | — | Liveness + DB state (Docker/nginx health checks) |

`?studentId=` query params are hashed server-side before querying `pseudonymizedId`.

---

## Running the Tests

```bash
cd tests
pip install selenium requests
python test_detection_events.py     # all 11 detection events, end to end
python stress_test.py               # 50 sessions / 500 events, Zenodo dataset output
```

The detection script launches Chrome with the extension loaded, logs in a test student, triggers all 11 detection events, and verifies each one appears in `/api/logs` (latest verified run: 11/11, 24 ms mean latency against the paper's 450 ms ± 50 ms benchmark).

> **Note:** branded Google Chrome ≥ 137 ignores `--load-extension`, so the tests pin `browser_version = "stable"` — Selenium Manager automatically downloads Chrome for Testing on first run (cached thereafter).

Environment variables: `SERVER`, `ADMIN_USER`, `ADMIN_PASS`, `STUDENT_ID`, `EXTENSION_PATH`.

---

## Offline Resilience

`content.js` maintains an IndexedDB store (`hbmds_offline`) as a local violation queue. If a beacon fails during a network outage, records are queued and flushed to `POST /api/report` in batches of 100 on the next successful heartbeat cycle; the queue is cleared only after the server acknowledges every chunk. Flushed records carry `sentAt`, so offline bursts report true transport latency rather than triggering false latency alerts on the dashboard (paper §III.A).
