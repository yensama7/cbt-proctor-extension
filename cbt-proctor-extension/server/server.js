const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const ViolationLog = require("./models/ViolationLog");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// ==========================================
// 1. SET ADMIN CREDENTIALS
// ==========================================
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin123";

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

mongoose.connect("mongodb://127.0.0.1:27017/cbt_logs");

// ==========================================
// 2. AUTHENTICATION MIDDLEWARE
// ==========================================
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    // We expect the token to be: "Bearer " + base64(username:password)
    const validToken = Buffer.from(ADMIN_USER + ":" + ADMIN_PASS).toString('base64');

    if (authHeader === "Bearer " + validToken) {
        next(); // Password is correct, let them see the data
    } else {
        res.status(401).json({ error: "Unauthorized" });
    }
};

io.on("connection", (socket) => {
    console.log("Admin connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("Admin disconnected:", socket.id);
    });
});

// ==========================================
// 3. LOGIN ENDPOINT
// ==========================================
app.post("/api/login", (req, res) => {
    const { username, password } = req.body;

    if (username === ADMIN_USER && password === ADMIN_PASS) {
        // Create the token to send back to frontend
        const token = Buffer.from(username + ":" + password).toString('base64');
        res.json({ success: true, token: token });
    } else {
        res.status(401).json({ success: false, message: "Invalid credentials" });
    }
});

/* API endpoint called by extension (Kept Public) */
app.post("/api/report", async (req, res) => {
    const { studentId, eventType, detail, timestamp } = req.body;

    if (!studentId || !eventType) {
        return res.status(400).send("Invalid payload");
    }

    const log = new ViolationLog({
        studentId,
        eventType,
        detail,
        clientTimestamp: timestamp
    });

    await log.save();

    const alert = {
        studentId,
        eventType,
        detail,
        time: timestamp,
        _id: log._id 
    };

    // 🔴 REAL-TIME PUSH TO ADMINS
    io.emit("new_violation", alert);

    console.log("[ALERT]", alert);
    res.send("Logged");
});

/* API endpoint to fetch historical logs */
// ==========================================
// 4. PROTECT THIS ROUTE
// ==========================================
app.get("/api/logs", authenticate, async (req, res) => {
    try {
        // Fetch logs sorted by newest first
        const logs = await ViolationLog.find().sort({ serverTimestamp: -1 });
        res.json(logs);
    } catch (err) {
        res.status(500).send("Error fetching logs");
    }
});

server.listen(3000, () => {
    console.log("Server + WebSocket running on port 3000");
});