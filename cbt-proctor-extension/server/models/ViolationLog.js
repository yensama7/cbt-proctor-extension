const mongoose = require("mongoose");

const ViolationSchema = new mongoose.Schema({
studentId: String,
eventType: String,
detail: String,
clientTimestamp: String,
serverTimestamp: {
    type: Date,
    default: Date.now
}
});

module.exports = mongoose.model("ViolationLog", ViolationSchema);