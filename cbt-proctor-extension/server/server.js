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

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

mongoose.connect("mongodb://127.0.0.1:27017/cbt_logs");

io.on("connection", (socket) => {
    console.log("Admin connected:", socket.id);

socket.on("disconnect", () => {
    console.log("Admin disconnected:", socket.id);
});
});

/* API endpoint called by extension */
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
    time: timestamp
};

  // 🔴 REAL-TIME PUSH TO ADMINS
io.emit("new_violation", alert);

console.log("[ALERT]", alert);
res.send("Logged");
});

server.listen(3000, () => {
console.log("Server + WebSocket running on port 3000");
});