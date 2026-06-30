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
const io     = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

mongoose
    .connect("mongodb://127.0.0.1:27017/cbt_logs")
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.error("❌ MongoDB Error:", err));

// ---------------------------------------------------------------------------
// SESSION STORE
//
// Each student has TWO timestamps:
//   lastHeartbeat — last /api/heartbeat  (Signal A: page is alive, network OK)
//   lastExtPing   — last /api/ext-ping   (Signal B: extension is running)
//
// { studentId → { lastHeartbeat: ms, lastExtPing: ms } }
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

const generateToken = (username) =>
    crypto.createHmac("sha256", TOKEN_SECRET).update(username).digest("hex");

const buildTimeRangeQuery = (start, end) => {
    const range = {};
    if (start) { const d = new Date(start); if (!isNaN(d)) range.$gte = d; }
    if (end)   { const d = new Date(end);   if (!isNaN(d)) range.$lte = d; }
    return Object.keys(range).length ? { serverReceivedAt: range } : {};
};

const escapeCsv = (v) => `"${(v == null ? "" : String(v)).replace(/"/g, '""')}"`;

// One-way hash for GDPR-compliant pseudonymization per paper Section III.D
const hashId = (id) => crypto.createHash("sha256").update(String(id)).digest("hex");

const persistAndBroadcast = async ({ studentId, sessionId, eventType, detail, violationURL, clientTimestamp }) => {
    const pseudonymizedId = hashId(studentId);
    const log = new ViolationLog({
        pseudonymizedId, sessionId: sessionId || "", eventType,
        violationURL: violationURL || "", detail,
        timestamp: clientTimestamp,
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
    if (scheme === "Bearer" && token === generateToken(ADMIN_USER)) return next();
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
    if (username === ADMIN_USER && password === ADMIN_PASS)
        return res.json({ success: true, token: generateToken(username) });
    res.status(401).json({ success: false });
});

// Violation report
app.post("/api/report", async (req, res) => {
    const { studentId, sessionId, eventType, detail, violationURL, timestamp } = req.body;
    if (!isValidId(studentId)) return res.status(400).json({ error: "Login required" });
    touchHeartbeat(studentId);
    try {
        await persistAndBroadcast({ studentId, sessionId, eventType, detail, violationURL, clientTimestamp: timestamp });
        res.sendStatus(200);
    } catch (err) {
        console.error("Report save failed:", err);
        res.status(500).json({ error: "Failed to save report" });
    }
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

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
