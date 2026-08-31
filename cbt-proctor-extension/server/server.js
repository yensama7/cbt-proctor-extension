const express = require("express");
const mongoose = require("mongoose");
const cors    = require("cors");
const http    = require("http");
const crypto  = require("crypto");
const path    = require("path");
const { Server } = require("socket.io");

const ViolationLog = require("./models/ViolationLog");

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const ADMIN_USER   = process.env.ADMIN_USER   || "admin";
const ADMIN_PASS   = process.env.ADMIN_PASS   || "admin123";
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const PORT         = process.env.PORT         || 3000;
const MONGO_URI    = process.env.MONGO_URI    || "mongodb://127.0.0.1:27017/cbt_logs";
const CORS_ORIGIN  = process.env.CORS_ORIGIN  || "*";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // admin tokens expire after 12h

// Refuse to boot into production with development credentials
if (process.env.NODE_ENV === "production" && ADMIN_PASS === "admin123") {
    console.error("FATAL: ADMIN_PASS is still the development default. Set ADMIN_PASS before deploying.");
    process.exit(1);
}

// Signal A (page heartbeat) timeout — 45s to allow Chrome tab throttling
const HEARTBEAT_TIMEOUT_MS  = 45_000;
// Signal B (extension ping) timeout — 25s (pings every 12s, so 2 missed = dead)
const EXT_PING_TIMEOUT_MS   = 25_000;
// How often we check
const WATCHDOG_INTERVAL_MS  = 8_000;

// ---------------------------------------------------------------------------
// APP SETUP
// ---------------------------------------------------------------------------
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: CORS_ORIGIN } });

app.set("trust proxy", 1); // behind nginx in production
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

mongoose
    .connect(MONGO_URI, { maxPoolSize: 100, wtimeoutMS: 2500 })
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => {
        console.error("❌ MongoDB Error:", err.message);
        process.exit(1); // let the process manager / Docker restart us
    });

// ---------------------------------------------------------------------------
// SESSION STORE
//
// Each student has TWO timestamps:
//   lastHeartbeat — last /api/heartbeat  (Signal A: page is alive, network OK)
//   lastExtPing   — last /api/ext-ping   (Signal B: extension is running)
//
// { studentId → { lastHeartbeat: ms, lastExtPing: ms } }
//
// ponytail: in-memory Map — single-instance only. One Node process handles
// ~220 req/s (1000 students) with room to spare; move to Redis TTL keys
// (improve.md §1A) only if you need multiple server instances behind nginx.
// ---------------------------------------------------------------------------
const sessions = new Map();

function touchHeartbeat(studentId) {
    const s = sessions.get(studentId) || {};
    sessions.set(studentId, { ...s, lastHeartbeat: Date.now() });
}

function touchExtPing(studentId) {
    const s = sessions.get(studentId) || {};
    const isNew = !s.lastExtPing && !s.lastHeartbeat;
    sessions.set(studentId, { ...s, lastExtPing: Date.now() });
    return isNew;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const isValidId = (id) =>
    typeof id === "string" && id.trim() !== "" && id !== "Unknown" && id !== "undefined";

// Constant-time string comparison (hashes both sides to normalize length)
const safeEqual = (a, b) =>
    crypto.timingSafeEqual(
        crypto.createHash("sha256").update(String(a)).digest(),
        crypto.createHash("sha256").update(String(b)).digest()
    );

const sign = (payload) =>
    crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");

// Token format: "<expiryEpochMs>.<hmac(username.expiry)>"
const generateToken = (username) => {
    const exp = Date.now() + TOKEN_TTL_MS;
    return `${exp}.${sign(`${username}.${exp}`)}`;
};

const buildTimeRangeQuery = (start, end) => {
    const range = {};
    if (start) { const d = new Date(start); if (!isNaN(d)) range.$gte = d; }
    if (end)   { const d = new Date(end);   if (!isNaN(d)) range.$lte = d; }
    return Object.keys(range).length ? { serverReceivedAt: range } : {};
};

const escapeCsv = (v) => `"${(v == null ? "" : String(v)).replace(/"/g, '""')}"`;

// One-way hash for GDPR-compliant pseudonymization per paper Section III.D
const hashId = (id) => crypto.createHash("sha256").update(String(id)).digest("hex");

const persistAndBroadcast = async ({ studentId, sessionId, eventType, detail, violationURL, clientTimestamp, sentAt }) => {
    const pseudonymizedId = hashId(studentId);
    const log = new ViolationLog({
        pseudonymizedId, sessionId: sessionId || "", eventType,
        violationURL: violationURL || "", detail,
        timestamp: clientTimestamp,
        sentAt: sentAt || null,
    });
    await log.save();
    io.emit("new_violation", {
        _id: log._id, pseudonymizedId, sessionId: log.sessionId, eventType,
        violationURL: log.violationURL, detail,
        timestamp:        log.timestamp,
        serverReceivedAt: log.serverReceivedAt,
        latencyMs:        log.latencyMs,
    });
    return log;
};

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------
const authenticate = (req, res, next) => {
    const [scheme, token] = (req.headers.authorization || "").split(" ");
    const [exp, sig]      = (token || "").split(".");
    if (
        scheme === "Bearer" && sig &&
        Date.now() < Number(exp) &&
        safeEqual(sig, sign(`${ADMIN_USER}.${exp}`))
    ) return next();
    res.status(401).json({ error: "Unauthorized" });
};

// ---------------------------------------------------------------------------
// SOCKET.IO
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
    console.log("Dashboard connected:", socket.id);
    // Send current session summary on connect
    const summary = buildSessionSummary();
    socket.emit("session_summary", summary);
});

function buildSessionSummary() {
    const now = Date.now();
    const list = [];
    for (const [studentId, s] of sessions) {
        const hbAge  = s.lastHeartbeat ? now - s.lastHeartbeat : Infinity;
        const extAge = s.lastExtPing   ? now - s.lastExtPing   : Infinity;
        list.push({
            studentId,
            status: getStatus(hbAge, extAge),
            lastSeen: s.lastHeartbeat || s.lastExtPing || 0,
        });
    }
    return list;
}

function getStatus(hbAge, extAge) {
    if (hbAge < HEARTBEAT_TIMEOUT_MS && extAge < EXT_PING_TIMEOUT_MS) return "online";
    if (extAge >= EXT_PING_TIMEOUT_MS && hbAge < HEARTBEAT_TIMEOUT_MS) return "ext_disabled";
    return "offline";
}

// ---------------------------------------------------------------------------
// WATCHDOG — runs every 8 seconds
//
// Decision table:
//  heartbeat OK, ext-ping OK   → all good, skip
//  heartbeat OK, ext-ping DEAD → EXTENSION_DISABLED (student killed the extension)
//  heartbeat DEAD, ext-ping OK → shouldn't happen in practice (page closed but ext alive)
//  both DEAD                   → CRITICAL_DISCONNECT (network or browser closed)
// ---------------------------------------------------------------------------
setInterval(async () => {
    const now = Date.now();

    for (const [studentId, s] of sessions) {
        const hbAge  = s.lastHeartbeat ? now - s.lastHeartbeat : Infinity;
        const extAge = s.lastExtPing   ? now - s.lastExtPing   : Infinity;

        const hbDead  = hbAge  >= HEARTBEAT_TIMEOUT_MS;
        const extDead = extAge >= EXT_PING_TIMEOUT_MS;

        // Case 1: Extension disabled — heartbeat still fresh, ext-ping gone
        if (!hbDead && extDead) {
            sessions.delete(studentId);
            io.emit("session_ended", { studentId, reason: "EXTENSION_DISABLED" });
            console.log(`[EXT DISABLED] ${studentId}`);
            try {
                await persistAndBroadcast({
                    studentId,
                    eventType: "EXTENSION_DISABLED",
                    detail:    "Extension was disabled or removed by the student.",
                    clientTimestamp: new Date().toISOString(),
                });
            } catch (err) { console.error("Failed to log EXTENSION_DISABLED:", err); }
            continue;
        }

        // Case 2: Both signals dead → network failure or browser closed
        if (hbDead && extDead) {
            sessions.delete(studentId);
            io.emit("session_ended", { studentId, reason: "CRITICAL_DISCONNECT" });
            console.log(`[DISCONNECT] ${studentId}`);
            try {
                await persistAndBroadcast({
                    studentId,
                    eventType: "CRITICAL_DISCONNECT",
                    detail:    "All signals lost. Network failure or browser was closed.",
                    clientTimestamp: new Date().toISOString(),
                });
            } catch (err) { console.error("Failed to log CRITICAL_DISCONNECT:", err); }
        }
    }
}, WATCHDOG_INTERVAL_MS);

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => res.redirect("/exam/login.html"));

// Signal A — page heartbeat (content.js)
app.post("/api/heartbeat", (req, res) => {
    const { studentId } = req.body;
    if (isValidId(studentId)) {
        const existed = sessions.has(studentId);
        touchHeartbeat(studentId);
        if (!existed) {
            io.emit("session_started", studentId);
            io.emit("session_summary", buildSessionSummary());
        }
    }
    res.sendStatus(200);
});

// Signal B — extension ping (background.js)
app.post("/api/ext-ping", (req, res) => {
    const { studentId } = req.body;
    if (isValidId(studentId)) {
        const isNew = touchExtPing(studentId);
        if (isNew) {
            io.emit("session_started", studentId);
            io.emit("session_summary", buildSessionSummary());
        }
    }
    res.sendStatus(200);
});

// Exam start
app.post("/api/exam/start", (req, res) => {
    const { studentId } = req.body;
    if (isValidId(studentId)) {
        touchHeartbeat(studentId);
        touchExtPing(studentId);
        io.emit("session_started", studentId);
        io.emit("session_summary", buildSessionSummary());
    }
    res.sendStatus(200);
});

// Logout / submit
app.post("/api/logout", async (req, res) => {
    const { studentId } = req.body;
    if (!isValidId(studentId)) return res.sendStatus(200);
    sessions.delete(studentId);
    io.emit("session_ended", { studentId, reason: "SUBMITTED" });
    io.emit("session_summary", buildSessionSummary());
    try {
        await persistAndBroadcast({
            studentId,
            eventType: "EXAM_SUBMITTED",
            detail:    "Student submitted and logged out.",
            clientTimestamp: new Date().toISOString(),
        });
        console.log(`[SUBMITTED] ${studentId}`);
    } catch (err) { console.error("Logout log failed:", err); }
    res.sendStatus(200);
});

// Admin login
app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (username != null && password != null &&
        safeEqual(username, ADMIN_USER) && safeEqual(password, ADMIN_PASS))
        return res.json({ success: true, token: generateToken(ADMIN_USER) });
    res.status(401).json({ success: false });
});

// Violation report — accepts a single event object, or a batch:
//   { studentId, sessionId, sentAt, events: [{ eventType, detail, violationURL, timestamp }] }
// sentAt = when the client actually transmitted; used for latency so batched/offline
// flushes don't register as multi-second false latency spikes (improve.md §4B).
app.post("/api/report", async (req, res) => {
    const body   = req.body || {};
    const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [body];
    let saved = 0;
    for (const e of events) {
        const studentId = e.studentId || body.studentId;
        if (!isValidId(studentId) || typeof e.eventType !== "string" || !e.eventType) continue;
        touchHeartbeat(studentId);
        try {
            await persistAndBroadcast({
                studentId,
                sessionId:       e.sessionId || body.sessionId,
                eventType:       e.eventType,
                detail:          e.detail,
                violationURL:    e.violationURL,
                clientTimestamp: e.timestamp,
                sentAt:          e.sentAt || body.sentAt,
            });
            saved++;
        } catch (err) {
            console.error("Report save failed:", err);
            return res.status(500).json({ error: "Failed to save report" });
        }
    }
    if (!saved) return res.status(400).json({ error: "Login required" });
    res.sendStatus(200);
});

// Fetch logs
app.get("/api/logs", authenticate, async (req, res) => {
    try {
        const query = buildTimeRangeQuery(req.query.start, req.query.end);
        if (req.query.studentId) query.pseudonymizedId = hashId(req.query.studentId);
        const logs = await ViolationLog.find(query).sort({ serverReceivedAt: -1 }).limit(2000);
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch logs" });
    }
});

// Distinct dates for date picker
app.get("/api/logs/dates", authenticate, async (req, res) => {
    try {
        const dates = await ViolationLog.aggregate([
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$serverReceivedAt" } }, count: { $sum: 1 } } },
            { $sort: { _id: -1 } }
        ]);
        res.json(dates);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch dates" });
    }
});

// XLSX data export
app.get("/api/logs/export/xlsx-data", authenticate, async (req, res) => {
    try {
        const query = buildTimeRangeQuery(req.query.start, req.query.end);
        if (req.query.studentId) query.pseudonymizedId = hashId(req.query.studentId);
        const logs = await ViolationLog.find(query).sort({ serverReceivedAt: -1 });
        const data = logs.map((l) => ({
            "Pseudonymized ID": l.pseudonymizedId,
            "Session ID":       l.sessionId || "",
            "Event":            l.eventType,
            "Violation URL":    l.violationURL || "",
            "Detail":           l.detail,
            "Client Time":      l.timestamp ? new Date(l.timestamp).toISOString() : "",
            "Server Received":  new Date(l.serverReceivedAt).toISOString(),
            "Latency (ms)":     l.latencyMs,
        }));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Failed to export" });
    }
});

// Live session summary for admin
app.get("/api/sessions", authenticate, (_req, res) => {
    res.json(buildSessionSummary());
});

// Health check for Docker / nginx / load balancers
app.get("/healthz", (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ ok: dbUp, sessions: sessions.size });
});

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

// Graceful shutdown so Docker stop / deploys don't drop in-flight writes
const shutdown = async (sig) => {
    console.log(`${sig} received — shutting down`);
    server.close(async () => {
        await mongoose.disconnect().catch(() => {});
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // force-exit if close hangs
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
