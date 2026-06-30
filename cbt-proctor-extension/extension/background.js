// background.js — Service Worker (Manifest V3)
//
// TWO-SIGNAL DETECTION MODEL:
//
//  Signal A: /api/heartbeat  (sent by content.js from the PAGE)
//            → proves the exam page is open and network is working
//
//  Signal B: /api/ext-ping   (sent by THIS background worker every 12s)
//            → proves the extension is still enabled and running
//
// Server tracks both timestamps per student:
//   A stops,  B alive  → page closed / network drop  → CRITICAL_DISCONNECT
//   B stops,  A recent → extension was disabled       → EXTENSION_DISABLED
//   Both stop together → escalate to CRITICAL_DISCONNECT after full timeout

const SERVER_BASE  = "http://localhost:3000";
const REPORT_URL   = `${SERVER_BASE}/api/report`;
const EXT_PING_URL = `${SERVER_BASE}/api/ext-ping`;
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function isAllowedUrl(url) {
    try {
        const { hostname } = new URL(url);
        return ALLOWED_HOSTNAMES.has(hostname);
    } catch { return false; }
}

async function getStudentId() {
    const { studentId } = await chrome.storage.local.get("studentId");
    return (studentId && studentId !== "Unknown" && studentId !== "undefined")
        ? studentId : null;
}

async function sendViolation(eventType, detail, overrideId = null, sessionId = null, violationURL = "") {
    const studentId = overrideId || await getStudentId();
    if (!studentId) return;
    try {
        await fetch(REPORT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                studentId, sessionId, eventType, detail, violationURL,
                timestamp: new Date().toISOString(),
            }),
        });
    } catch { /* server unreachable — session watchdog will classify the dropout */ }
}

// ---------------------------------------------------------------------------
// EXTENSION PING — Signal B
// ---------------------------------------------------------------------------
async function sendExtPing() {
    const studentId = await getStudentId();
    if (!studentId) return;
    try {
        await fetch(EXT_PING_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId, timestamp: new Date().toISOString() }),
        });
    } catch { }
}

chrome.alarms.create("extPing", { periodInMinutes: 1 / 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "extPing") sendExtPing();
});
sendExtPing();

// ---------------------------------------------------------------------------
// TAB MONITORING
// ---------------------------------------------------------------------------
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url && !isAllowedUrl(tab.url))
            sendViolation("TAB_SWITCH", `Switched to: ${tab.url}`, null, null, tab.url);
    } catch {}
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url && !isAllowedUrl(tab.url))
        sendViolation("UNAUTHORIZED_NAVIGATION", `Navigated to: ${tab.url}`, null, null, tab.url);
});

// ---------------------------------------------------------------------------
// WINDOW FOCUS
// ---------------------------------------------------------------------------
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE)
        sendViolation("BROWSER_OUT_OF_FOCUS", "Chrome lost focus / minimised");
});

// ---------------------------------------------------------------------------
// MESSAGES FROM content.js
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
    if (!message?.type) return;
    if (message.type === "RESET_STATE") {
        chrome.storage.local.remove("studentId");
        chrome.alarms.clear("extPing");
        return;
    }
    sendViolation(
        message.type,
        message.detail,
        message.studentId ?? null,
        message.sessionId ?? null,
        message.violationURL ?? ""
    );
});
