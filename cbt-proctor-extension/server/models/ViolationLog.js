const mongoose = require("mongoose");

const ViolationLogSchema = new mongoose.Schema({
    studentId:       { type: String, required: true, index: true },
    eventType:       { type: String, required: true },
    detail:          { type: String, default: "" },
    clientTimestamp: { type: Date, default: null },
    serverTimestamp: { type: Date, default: Date.now, index: true },
    // Latency in milliseconds: serverTimestamp - clientTimestamp
    latencyMs:       { type: Number, default: null },
});

// Auto-compute latency before saving
ViolationLogSchema.pre("save", function (next) {
    if (this.clientTimestamp && this.serverTimestamp) {
        this.latencyMs = this.serverTimestamp - new Date(this.clientTimestamp).getTime();
    }
    next();
});

module.exports = mongoose.model("ViolationLog", ViolationLogSchema);
