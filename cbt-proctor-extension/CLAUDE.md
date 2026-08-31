# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install server dependencies
cd server && npm install

# Start the server (requires MongoDB running)
node server/server.js

# Start MongoDB (separate terminal)
mongod
```

No test runner or linter is configured. The server runs at `http://localhost:3000`.

## Architecture

This is a two-component system: a **Chrome extension** and a **Node.js server**. They are completely separate codebases — the extension has no build step or package.json; the server lives in `server/`.

### Chrome Extension (`extension/`)

Manifest V3. Two scripts coordinate to provide dual-signal detection:

- **`background.js`** — Service worker. Sends `POST /api/ext-ping` every 12 seconds via `chrome.alarms` (survives service worker suspension). Also monitors tab switches and window focus via Chrome API events, and forwards violations from `content.js` messages to `POST /api/report`.
- **`content.js`** — Injected into `http://localhost:3000/exam/*` pages only. Sends `POST /api/heartbeat` every 10 seconds (Signal A). Attaches proctoring event listeners (focus loss, tab visibility, clipboard, keyboard shortcuts, resize, context menu). Reports violations by messaging `background.js`; falls back to `navigator.sendBeacon` if the extension context is dying. Also has an extension-context watchdog that polls `chrome.runtime.id` every 2 seconds and fires a beacon to report `EXTENSION_KILLED` before the context is fully torn down.

Extension loads the `studentId` from `localStorage` (set by the exam login page) and mirrors it into `chrome.storage.local` so `background.js` can access it.

### Instruction
- Avoid the use of emoji in the admin page
- Make the Admin page look professional
- Fix UI errors always

### Server (`server/`)

Single file: **`server.js`**. Express + Socket.IO + Mongoose. No routers, no controllers — everything inline.

**Session tracking** uses an in-memory `Map<studentId, { lastHeartbeat, lastExtPing }>`. Two signals per student:
- Signal A (`/api/heartbeat`) — sent by the exam page (content.js)
- Signal B (`/api/ext-ping`) — sent by the extension background worker

A **watchdog** runs every 8 seconds and compares ages:
- heartbeat OK, ext-ping dead → `EXTENSION_DISABLED` (student removed extension)
- both dead → `CRITICAL_DISCONNECT` (network/browser closed)

`buildTimeRangeQuery()` centralizes date-range filtering for both `/api/logs` and the export endpoints.

`persistAndBroadcast()` atomically saves a `ViolationLog` to MongoDB and emits `new_violation` via Socket.IO.

**MongoDB model** (`models/ViolationLog.js`): `{ studentId, eventType, detail, clientTimestamp, serverTimestamp, latencyMs }`. A `pre("save")` hook auto-computes `latencyMs` from the client/server timestamp delta.

### Admin Dashboard (`server/public/admin/`)

Single-page app (`index.html` + `admin.js`). Auth token stored in `localStorage`, sent as `Authorization: Bearer <token>`. Token is HMAC-SHA256 of the username against a random `TOKEN_SECRET` (regenerated each server restart — no persistence).

Real-time updates arrive via Socket.IO `new_violation` events and prepend to the local `allLogs` array, then re-render. Filtering is client-side. CSV export is server-side (`GET /api/logs/export`) unless a student ID partial-match filter is active, in which case the filtered in-memory data is exported client-side to preserve the partial-match behavior.

### Exam UI (`server/public/exam/`)

Static HTML served by Express. `login.html` sets `localStorage.cbt_student_id`; `paper.html` is the exam page the extension monitors.

## Key Constraints

- **`SERVER_BASE`** is resolved by `extension/config.js` (shared by content.js and background.js): `chrome.storage.managed.serverUrl` (enterprise policy) with fallback to `http://localhost:3000` for development.
- **Admin credentials** default to `admin` / `admin123`. Override with `ADMIN_USER` and `ADMIN_PASS` env vars. In `NODE_ENV=production` the server refuses to start on the default password.
- **Admin tokens expire after 12h** and don't survive restarts unless `TOKEN_SECRET` is set via env var.
- MongoDB connection comes from `MONGO_URI` env var (default `mongodb://127.0.0.1:27017/cbt_logs`), pooled with `maxPoolSize: 100`.
- Non-critical content.js events are batched (3s flush via sendBeacon); `/api/report` accepts both a single event object and `{ studentId, sessionId, sentAt, events: [...] }` (max 100). `latencyMs` is computed from `sentAt` when present.
- Production deployment is `docker-compose.yml` (nginx → node → mongo); nginx serves static files and rate-limits `/api`.
- Selenium tests pin `browser_version = "stable"` (Chrome for Testing) because branded Chrome ≥137 ignores `--load-extension`.

## Event Types

Violation events reported to the server:

| Event | Source | Trigger |
|---|---|---|
| `TAB_SWITCH` | background.js | Chrome tab activated to non-localhost URL |
| `UNAUTHORIZED_NAVIGATION` | background.js | Tab loaded non-localhost URL |
| `BROWSER_OUT_OF_FOCUS` | background.js | Chrome window lost OS focus |
| `WINDOW_FOCUS_LOST` | content.js | Page `blur` event |
| `TAB_HIDDEN` | content.js | `visibilitychange` hidden |
| `PAGE_UNLOAD` | content.js | `pagehide` event |
| `CLIPBOARD_ACTION` | content.js | copy/cut/paste |
| `RESTRICTED_KEY` | content.js | F12, Alt, Meta, Ctrl+U/S/A/C/V/I/J |
| `RIGHT_CLICK` | content.js | contextmenu |
| `SUSPICIOUS_RESIZE` | content.js | Window shrinks >150px (DevTools open) |
| `EXTENSION_KILLED` | content.js | Extension context invalidated beacon |
| `EXTENSION_DISABLED` | server watchdog | ext-ping dead, heartbeat alive |
| `CRITICAL_DISCONNECT` | server watchdog | Both signals dead |
| `EXAM_SUBMITTED` | server `/api/logout` | Student submitted exam |
