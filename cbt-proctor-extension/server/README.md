# CBT Proctor System

Real-time exam proctoring: Express server + Socket.io + Chrome extension + Admin dashboard.

---

## Project Structure

```
cbt/
├── server.js                  # Main Express + Socket.io server
├── package.json
├── models/
│   └── ViolationLog.js        # Mongoose schema (auto-computes latency)
├── public/
│   ├── exam/
│   │   ├── login.html         # Student login page
│   │   └── paper.html         # Exam page (10 sample questions)
│   └── admin/
│       └── index.html         # Admin dashboard (real-time feed)
└── extension/
    ├── manifest.json
    ├── content.js             # Page-level proctoring (keyboard, focus, resize)
    └── background.js          # Browser-level monitoring (tabs, windows)
```

---

## Setup

### 1. Start MongoDB
```bash
mongod
```

### 2. Install dependencies & start server
```bash
cd cbt
npm install
npm start
```

Server runs at: `http://localhost:3000`

### 3. Load the Chrome Extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

---

## URLs

| Page | URL |
|------|-----|
| Student Login | http://localhost:3000/exam/login.html |
| Admin Dashboard | http://localhost:3000/admin/index.html |

### Admin credentials
- Username: `admin`
- Password: `admin123`

---

## Features

### Server
- Heartbeat watchdog — detects student disconnects after 45s silence
- Latency tracking — `serverTimestamp - clientTimestamp` stored per event
- Signed HMAC tokens for admin auth (not plain base64)
- `persistAndBroadcast()` — single function for all DB write + Socket.io emit
- `/api/logs/dates` — distinct dates with event counts (for dashboard date picker)
- `/api/logs/export/xlsx-data` — JSON endpoint; dashboard generates .xlsx client-side

### Extension
- `content.js` — focus loss, tab hide, window resize, clipboard, keyboard, right-click
- `background.js` — tab switches, navigation, OS-level focus changes
- Fixed: `isAllowedUrl()` bug where `urlString` was undefined (was crashing silently)
- Fixed: `idPoller` now clears before redirect (was firing repeatedly)

### Admin Dashboard
- Real-time violation feed via Socket.io
- Events grouped by date with separators
- Per-event latency badge (green < 500ms, yellow < 2s, red ≥ 2s)
- Active sessions panel (live count + student IDs)
- Filter by date, student ID, or event type chips
- Export filtered view as .xlsx (client-side via SheetJS)
- Stats: online count, violations, critical events, avg latency

---

## Customising

**Exam domain (production):** In `extension/background.js`:
```js
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "your-exam-domain.com"]);
```

**Admin credentials:** Use environment variables:
```bash
ADMIN_USER=admin ADMIN_PASS=yourpassword node server.js
```

**Exam duration:** In `public/exam/paper.html`, change:
```js
let secondsLeft = 60 * 60; // 60 minutes
```
