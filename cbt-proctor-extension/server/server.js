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

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
});

// --- HEARTBEAT CHECKER (Runs every 10 seconds) ---
setInterval(() => {
    const now = Date.now();
    for (const [studentId, lastSeen] of Object.entries(activeSessions)) {
        if (now - lastSeen > HEARTBEAT_TIMEOUT) {
            
            // Only alert if we actually knew the student ID
            if (studentId && studentId !== "Unknown") {
                const alert = {
                    studentId,
                    eventType: "CRITICAL_DISCONNECT",
                    detail: "Signal lost. Network failed or Extension disabled.",
                    time: new Date().toISOString()
                };
                console.log(`[❌ DISCONNECT] ${studentId}`);
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
        activeSessions[studentId] = Date.now();
        res.sendStatus(200);
    } else {
        res.sendStatus(200); // Just say OK, but don't track
    }
});

// LOGOUT ENDPOINT (Now logs the event to Admin)
app.post("/api/logout", async (req, res) => {
    const { studentId } = req.body;
    const timestamp = new Date().toISOString();

    if (studentId) {
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
    activeSessions[studentId] = Date.now();

    const log = new ViolationLog({ studentId, eventType, detail, clientTimestamp: timestamp });
    await log.save();

    const alert = { studentId, eventType, detail, time: timestamp, _id: log._id };
    io.emit("new_violation", alert);
    
    res.send("Logged");
});

app.get("/api/logs", authenticate, async (req, res) => {
    const logs = await ViolationLog.find().sort({ serverTimestamp: -1 });
    res.json(logs);
});

server.listen(3000, () => console.log("🚀 Server running on http://localhost:3000"));