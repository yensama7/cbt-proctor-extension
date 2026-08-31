const mongoose = require("mongoose");

const ViolationLogSchema = new mongoose.Schema({
    pseudonymizedId: { type: String, required: true, index: true },
    sessionId:       { type: String, default: "" },
    eventType:       { type: String, required: true },
    violationURL:    { type: String, default: "" },
    detail:          { type: String, default: "" },
    timestamp:       { type: Date, default: null },            // when the event occurred (client clock)
    sentAt:          { type: Date, default: null },            // when the client transmitted (batched/offline flushes)
    serverReceivedAt:{ type: Date, default: Date.now, index: true },
    latencyMs:       { type: Number, default: null },
});

// latencyMs measures transport latency: prefer sentAt (batch/offline flush time)
// over timestamp so queued events don't show up as false multi-second latencies.
ViolationLogSchema.pre("save", function (next) {
    const base = this.sentAt || this.timestamp;
    if (base && this.serverReceivedAt)
        this.latencyMs = this.serverReceivedAt - new Date(base).getTime();
    next();
});

module.exports = mongoose.model("ViolationLog", ViolationLogSchema);
