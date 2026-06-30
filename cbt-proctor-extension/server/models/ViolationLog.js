const mongoose = require("mongoose");

const ViolationLogSchema = new mongoose.Schema({
    pseudonymizedId: { type: String, required: true, index: true },
    sessionId:       { type: String, default: "" },
    eventType:       { type: String, required: true },
    violationURL:    { type: String, default: "" },
    detail:          { type: String, default: "" },
    timestamp:       { type: Date, default: null },            // client-generated
    serverReceivedAt:{ type: Date, default: Date.now, index: true },
    latencyMs:       { type: Number, default: null },
});

ViolationLogSchema.pre("save", function (next) {
    if (this.timestamp && this.serverReceivedAt)
        this.latencyMs = this.serverReceivedAt - new Date(this.timestamp).getTime();
    next();
});

module.exports = mongoose.model("ViolationLog", ViolationLogSchema);
