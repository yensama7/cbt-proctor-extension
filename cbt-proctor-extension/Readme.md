# CBT Proctor Extension (HBMDS)

Host-Based Malpractice Detection System — a lightweight browser-extension architecture for real-time CBT malpractice detection, as described in:

> Uzonu, C. O., Bello, M. A., & Opeyemi, A. K. (2026). *Empirical Evaluation of a Browser Extension Architecture for Real-Time Examination Malpractice Detection.* AFIT, Kaduna.

---

## Project Structure

```
cbt-proctor-extension/
├── extension/
│   ├── manifest.json       — Manifest V3, scoped to localhost:3000
│   ├── background.js       — Service worker: tab/window monitoring, Signal B ping
│   └── content.js          — Injected into exam pages: heartbeat, violation listeners
├── server/
│   ├── server.js           — Express + Socket.IO + Mongoose
│   ├── models/
│   │   └── ViolationLog.js — MongoDB schema
│   └── public/
│       ├── exam/
│       │   ├── login.html  — Student login
│       │   └── paper.html  — Exam page (monitored)
│       └── admin/
│           └── index.html  — Admin dashboard (self-contained SPA)
└── tests/
    └── test_detection_events.py — Selenium detection verification test
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
  timestamp:        Date,     // client-generated
  serverReceivedAt: Date,     // server-generated (latency = serverReceivedAt - timestamp)
  latencyMs:        Number,
}
```

The session tracking Map (`studentId → { lastHeartbeat, lastExtPing }`) in memory uses plain IDs for real-time monitoring; only the MongoDB log layer pseudonymizes.

---

## Requirements

- Node.js 18+
- MongoDB running on `mongodb://127.0.0.1:27017`
- Google Chrome (to load the extension)
- Python 3.9+ and `pip install selenium requests` (for tests only)

---

## Setup & Run

### 1. Install server dependencies

```bash
cd server && npm install
```

### 2. Start MongoDB

```bash
mongod
```

### 3. Start the server

```bash
node server/server.js
```

Runs at `http://localhost:3000`. Default admin credentials: `admin` / `admin123` (override with `ADMIN_USER` / `ADMIN_PASS` env vars).

### 4. Load the Chrome extension

1. Go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder

### 5. Open the exam UI

- Student: `http://localhost:3000/exam/login.html`
- Admin: `http://localhost:3000/admin/index.html`

The exam page checks for the extension handshake (`data-hbmds-active` attribute set by `content.js`). If the extension is absent (e.g. incognito mode without permission), the exam content is blocked.

---

## API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/login` | — | Admin login; returns Bearer token |
| `POST` | `/api/heartbeat` | — | Signal A (content.js) |
| `POST` | `/api/ext-ping` | — | Signal B (background.js) |
| `POST` | `/api/exam/start` | — | Register session at login |
| `POST` | `/api/report` | — | Violation event |
| `POST` | `/api/logout` | — | Exam submitted |
| `GET` | `/api/logs` | Bearer | Fetch logs (`start`, `end`, `studentId` query params) |
| `GET` | `/api/logs/dates` | Bearer | Distinct dates with counts |
| `GET` | `/api/logs/export/xlsx-data` | Bearer | XLSX export data |
| `GET` | `/api/sessions` | Bearer | Live session snapshot |

**Note:** `?studentId=` query params are hashed server-side before querying `pseudonymizedId`.

---

## Running the Detection Tests

```bash
cd tests
pip install selenium requests
python test_detection_events.py
```

The script launches Chrome with the extension loaded, logs in a test student, triggers all 11 detection events, and verifies each one appears in `/api/logs`. It reports a detection rate and mean latency against the paper's 450 ms ± 50 ms benchmark.

Environment variables: `SERVER`, `ADMIN_USER`, `ADMIN_PASS`, `STUDENT_ID`, `EXTENSION_PATH`.

---

## Offline Resilience

`content.js` maintains an IndexedDB store (`hbmds_offline`) as a local violation queue. If a `sendBeacon` fails during a network outage, the record is queued and flushed to `POST /api/report` on the next successful heartbeat cycle. This ensures no forensic events are lost during transient connectivity failures (paper §III.A).
