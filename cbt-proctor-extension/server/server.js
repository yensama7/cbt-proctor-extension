const express = require("express");
const mongoose = require("mongoose");
const cors    = require("cors");
const http    = require("http");
const crypto  = require("crypto");
const path    = require("path");
const { Server } = require("socket.io");

const ViolationLog = require("./models/ViolationLog");

// ---------------------------------------------------------------------------
// CONFIG  (use env vars in production)
// ---------------------------------------------------------------------------
const ADMIN_USER            = process.env.ADMIN_USER   || "admin";
const ADMIN_PASS            = process.env.ADMIN_PASS   || "admin123";
const TOKEN_SECRET          = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const PORT                  = process.env.PORT         || 3000;
const HEARTBEAT_TIMEOUT_MS  = 45_000;
const HEARTBEAT_CHECK_MS    = 10_000;

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
// SESSION STORE  { studentId → lastSeenMs }
// ---------------------------------------------------------------------------
const activeSessions = new Map();

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
    return Object.keys(range).length ? { serverTimestamp: range } : {};
};

/** Escape a cell value for CSV output */
const escapeCsv = (v) => `"${(v == null ? "" : String(v)).replace(/"/g, '""')}"`;

/**
 * Save a log entry to MongoDB and broadcast it via Socket.io.
 * Returns the saved document.
 */
const persistAndBroadcast = async ({ studentId, eventType, detail, clientTimestamp }) => {
    const log = new ViolationLog({ studentId, eventType, detail, clientTimestamp });
    await log.save();

    io.emit("new_violation", {
        _id:             log._id,
        studentId,
        eventType,
        detail,
        clientTimestamp: log.clientTimestamp,
        serverTimestamp: log.serverTimestamp,
        latencyMs:       log.latencyMs,
    });

    return log;
};

// ---------------------------------------------------------------------------
// AUTH MIDDLEWARE
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

    // Send current active sessions immediately on connect
    socket.emit("active_sessions", [...activeSessions.keys()]);
});

// ---------------------------------------------------------------------------
// HEARTBEAT WATCHDOG
// ---------------------------------------------------------------------------
setInterval(async () => {
    const now = Date.now();
    for (const [studentId, lastSeen] of activeSessions) {
        if (now - lastSeen <= HEARTBEAT_TIMEOUT_MS) continue;

        activeSessions.delete(studentId);
        io.emit("session_ended", studentId);
        console.log(`[❌ DISCONNECT] ${studentId}`);

        try {
            await persistAndBroadcast({
                studentId,
                eventType:       "CRITICAL_DISCONNECT",
                detail:          "Signal lost. Network failed or extension disabled.",
                clientTimestamp: new Date().toISOString(),
            });
        } catch (err) {
            console.error(`Disconnect log failed for ${studentId}:`, err);
        }
    }
}, HEARTBEAT_CHECK_MS);

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => res.redirect("/exam/login.html"));

// Student heartbeat
app.post("/api/heartbeat", (req, res) => {
    const { studentId } = req.body;
    if (isValidId(studentId)) {
        const isNew = !activeSessions.has(studentId);
        activeSessions.set(studentId, Date.now());
        if (isNew) io.emit("session_started", studentId);
    }
    res.sendStatus(200);
});

// Exam start
app.post("/api/exam/start", (req, res) => {
    const { studentId } = req.body;
    if (isValidId(studentId)) {
        activeSessions.set(studentId, Date.now());
        io.emit("session_started", studentId);
    }
    res.sendStatus(200);
});

// Exam submit / logout
app.post("/api/logout", async (req, res) => {
    const { studentId } = req.body;
    if (!isValidId(studentId)) return res.sendStatus(200);

    activeSessions.delete(studentId);
    io.emit("session_ended", studentId);

    try {
        await persistAndBroadcast({
            studentId,
            eventType:       "EXAM_SUBMITTED",
            detail:          "Student submitted and logged out.",
            clientTimestamp: new Date().toISOString(),
        });
        console.log(`[✅ SUBMITTED] ${studentId}`);
    } catch (err) {
        console.error(`Logout log failed for ${studentId}:`, err);
    }
    res.sendStatus(200);
});

// Admin login
app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        return res.json({ success: true, token: generateToken(username) });
    }
    res.status(401).json({ success: false });
});

// Violation report from extension
app.post("/api/report", async (req, res) => {
    const { studentId, eventType, detail, timestamp } = req.body;

    if (!isValidId(studentId)) return res.status(400).json({ error: "Login required" });

    activeSessions.set(studentId, Date.now());

    try {
        await persistAndBroadcast({ studentId, eventType, detail, clientTimestamp: timestamp });
        res.sendStatus(200);
    } catch (err) {
        console.error("Report save failed:", err);
        res.status(500).json({ error: "Failed to save report" });
    }
});

// Fetch logs (admin)
app.get("/api/logs", authenticate, async (req, res) => {
    try {
        const query = buildTimeRangeQuery(req.query.start, req.query.end);
        if (req.query.studentId) query.studentId = req.query.studentId;
        const logs = await ViolationLog.find(query).sort({ serverTimestamp: -1 }).limit(2000);
        res.json(logs);
    } catch (err) {
        console.error("Fetch logs failed:", err);
        res.status(500).json({ error: "Failed to fetch logs" });
    }
});

// Distinct dates that have logs (for date picker in dashboard)
app.get("/api/logs/dates", authenticate, async (req, res) => {
    try {
        // Group by date string YYYY-MM-DD
        const dates = await ViolationLog.aggregate([
            {
                $group: {
                    _id: {
                        $dateToString: { format: "%Y-%m-%d", date: "$serverTimestamp" }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: -1 } }
        ]);
        res.json(dates);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch dates" });
    }
});

// Export as CSV (kept for backward compat)
app.get("/api/logs/export/csv", authenticate, async (req, res) => {
    try {
        const query = buildTimeRangeQuery(req.query.start, req.query.end);
        if (req.query.studentId) query.studentId = req.query.studentId;
        const logs = await ViolationLog.find(query).sort({ serverTimestamp: -1 });

        const headers = ["Student ID", "Event", "Detail", "Client Time", "Server Time", "Latency (ms)"];
        const rows = logs.map((l) => [
            escapeCsv(l.studentId),
            escapeCsv(l.eventType),
            escapeCsv(l.detail),
            escapeCsv(l.clientTimestamp ? new Date(l.clientTimestamp).toISOString() : ""),
            escapeCsv(new Date(l.serverTimestamp).toISOString()),
            escapeCsv(l.latencyMs),
        ].join(","));

        const csv = [headers.join(","), ...rows].join("\n");
        const date = req.query.start ? req.query.start.slice(0, 10) : "all";
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=cbt-logs-${date}.csv`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: "Failed to export" });
    }
});

// Export as XLSX (uses JSON — frontend generates the file using SheetJS)
app.get("/api/logs/export/xlsx-data", authenticate, async (req, res) => {
    try {
        const query = buildTimeRangeQuery(req.query.start, req.query.end);
        if (req.query.studentId) query.studentId = req.query.studentId;
        const logs = await ViolationLog.find(query).sort({ serverTimestamp: -1 });

        const data = logs.map((l) => ({
            "Student ID":    l.studentId,
            "Event":         l.eventType,
            "Detail":        l.detail,
            "Client Time":   l.clientTimestamp ? new Date(l.clientTimestamp).toISOString() : "",
            "Server Time":   new Date(l.serverTimestamp).toISOString(),
            "Latency (ms)":  l.latencyMs,
        }));

        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Failed to export" });
    }
});

// Active sessions list (admin)
app.get("/api/sessions", authenticate, (_req, res) => {
    res.json([...activeSessions.keys()]);
});

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
