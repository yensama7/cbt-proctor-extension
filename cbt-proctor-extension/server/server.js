const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const ViolationLog = require("./models/ViolationLog");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 1. SET ADMIN CREDENTIALS
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin123";

// 2. HEARTBEAT SETTINGS
// Increased to 45s to prevent false alarms when Chrome throttles background tabs
const HEARTBEAT_TIMEOUT = 45000; 
let activeSessions = {}; // { studentId: lastSeenTimestamp }
const submittedStudents = new Set();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

mongoose.connect("mongodb://127.0.0.1:27017/cbt_logs")
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ MongoDB Error:", err));

// --- AUTH MIDDLEWARE ---
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const validToken = Buffer.from(ADMIN_USER + ":" + ADMIN_PASS).toString('base64');
    if (authHeader === "Bearer " + validToken) next();
    else res.status(401).json({ error: "Unauthorized" });
};

const buildTimeRangeQuery = (start, end) => {
    const range = {};

    if (start) {
        const startDate = new Date(start);
        if (!Number.isNaN(startDate.getTime())) range.$gte = startDate;
    }

    if (end) {
        const endDate = new Date(end);
        if (!Number.isNaN(endDate.getTime())) range.$lte = endDate;
    }

    return Object.keys(range).length ? { serverTimestamp: range } : {};
};

const getLogIsoTime = (log) => {
    if (log.clientTimestamp) {
        const clientDate = new Date(log.clientTimestamp);
        if (!Number.isNaN(clientDate.getTime())) return clientDate.toISOString();
    }

    if (log.serverTimestamp) {
        const serverDate = new Date(log.serverTimestamp);
        if (!Number.isNaN(serverDate.getTime())) return serverDate.toISOString();
    }

    return new Date().toISOString();
};

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
});

// --- HEARTBEAT CHECKER (Runs every 10 seconds) ---
setInterval(async () => {
    const now = Date.now();
    for (const [studentId, lastSeen] of Object.entries(activeSessions)) {
        if (submittedStudents.has(studentId)) {
            delete activeSessions[studentId];
            continue;
        }

        if (now - lastSeen > HEARTBEAT_TIMEOUT) {
            
            // Only alert if we actually knew the student ID
            if (studentId && studentId !== "Unknown") {
                const disconnectTime = new Date().toISOString();
                const alert = {
                    studentId,
                    eventType: "CRITICAL_DISCONNECT",
                    detail: "Signal lost. Network failed or Extension disabled.",
                    time: disconnectTime
                };
                console.log(`[❌ DISCONNECT] ${studentId}`);

                try {
                    const disconnectLog = new ViolationLog({
                        studentId,
                        eventType: "CRITICAL_DISCONNECT",
                        detail: "Signal lost. Network failed or Extension disabled.",
                        clientTimestamp: disconnectTime
                    });
                    await disconnectLog.save();
                    alert._id = disconnectLog._id;
                } catch (err) {
                    console.error("Failed to persist disconnect log", err);
                }

                io.emit("new_violation", alert);
            }

            // Stop tracking them
            delete activeSessions[studentId];
        }
    }
}, 10000);

// --- API ENDPOINTS ---

app.post("/api/heartbeat", (req, res) => {
    const { studentId } = req.body;
    
    // IGNORE UNKNOWNS: Don't track if they haven't logged in yet
    if (studentId && studentId !== "Unknown") {
        submittedStudents.delete(studentId);
        activeSessions[studentId] = Date.now();
        res.sendStatus(200);
    } else {
        res.sendStatus(200); // Just say OK, but don't track
    }
});

app.post("/api/exam/start", (req, res) => {
    const { studentId } = req.body;

    if (studentId && studentId !== "Unknown") {
        submittedStudents.delete(studentId);
        activeSessions[studentId] = Date.now();
    }

    res.sendStatus(200);
});

// LOGOUT ENDPOINT (Now logs the event to Admin)
app.post("/api/logout", async (req, res) => {
    const { studentId } = req.body;
    const timestamp = new Date().toISOString();

    if (studentId) {
        submittedStudents.add(studentId);
        // 1. Stop tracking immediately (Prevent Disconnect Error)
        if (activeSessions[studentId]) {
            delete activeSessions[studentId];
        }

        // 2. Log "Exam Submitted" to Database
        const log = new ViolationLog({
            studentId,
            eventType: "EXAM_SUBMITTED",
            detail: "Student successfully submitted and logged out.",
            clientTimestamp: timestamp
        });
        await log.save();

        // 3. Notify Admin Dashboard (Green Alert)
        const alert = {
            studentId,
            eventType: "EXAM_SUBMITTED",
            detail: "Student successfully submitted and logged out.",
            time: timestamp,
            _id: log._id
        };
        io.emit("new_violation", alert); // Re-using the violation channel for status updates
        
        console.log(`[✅ FINISHED] ${studentId} submitted the exam.`);
    }
    
    res.sendStatus(200);
});

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = Buffer.from(username + ":" + password).toString('base64');
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false });
    }
});

// Redirect root to Login
app.get("/", (req, res) => res.redirect("/exam/login.html"));

app.post("/api/report", async (req, res) => {
    const { studentId, eventType, detail, timestamp } = req.body;

    // Reject reports from "Unknown" students
    if (!studentId || studentId === "Unknown") {
        return res.status(400).send("Login Required");
    }
    
    // Update heartbeat since we heard from them
    submittedStudents.delete(studentId);
    activeSessions[studentId] = Date.now();

    const log = new ViolationLog({ studentId, eventType, detail, clientTimestamp: timestamp });
    await log.save();

    const alert = { studentId, eventType, detail, time: timestamp, _id: log._id };
    io.emit("new_violation", alert);
    
    res.send("Logged");
});

app.get("/api/logs", authenticate, async (req, res) => {
    try {
        const { start, end } = req.query;
        const query = buildTimeRangeQuery(start, end);
        const logs = await ViolationLog.find(query).sort({ serverTimestamp: -1 });
        res.json(logs);
    } catch (err) {
        console.error("Failed to fetch logs", err);
        res.status(500).json({ error: "Failed to fetch logs" });
    }
});

app.get("/api/logs/export", authenticate, async (req, res) => {
    try {
        const { start, end } = req.query;
        const query = buildTimeRangeQuery(start, end);
        const logs = await ViolationLog.find(query).sort({ serverTimestamp: -1 });

        const escapeCsv = (value) => {
            const text = value == null ? "" : String(value);
            return `"${text.replace(/"/g, '""')}"`;
        };

        const headers = ["Student ID", "Event", "Detail", "Time"];
        const rows = logs.map(log => [
            escapeCsv(log.studentId),
            escapeCsv(log.eventType),
            escapeCsv(log.detail),
            escapeCsv(getLogIsoTime(log))
        ].join(","));

        const csv = [headers.join(","), ...rows].join("\n");
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=cbt-logs.csv");
        res.send(csv);
    } catch (err) {
        console.error("Failed to export logs", err);
        res.status(500).json({ error: "Failed to export logs" });
    }
});

server.listen(3000, () => console.log("🚀 Server running on http://localhost:3000"));
