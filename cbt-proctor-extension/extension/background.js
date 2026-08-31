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

importScripts("config.js");

// Resolved from managed storage (enterprise policy) with localhost fallback.
let SERVER_BASE       = DEFAULT_SERVER_BASE;
let ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

const configReady = getServerBase().then((base) => {
    SERVER_BASE = base;
    try { ALLOWED_HOSTNAMES.add(new URL(base).hostname); } catch {}
});

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
    await configReady;
    const studentId = overrideId || await getStudentId();
    if (!studentId) return;
    try {
        await fetch(`${SERVER_BASE}/api/report`, {
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
    await configReady;
    const studentId = await getStudentId();
    if (!studentId) return;
    try {
        await fetch(`${SERVER_BASE}/api/ext-ping`, {
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
        await configReady;
        const tab = await chrome.tabs.get(tabId);
        // onActivated can fire at tab creation before any URL is committed
        // (url and pendingUrl both empty) — re-read once after the navigation starts
        let url = tab.pendingUrl || tab.url;
        if (!url) {
            await new Promise((r) => setTimeout(r, 500));
            const t2 = await chrome.tabs.get(tabId);
            url = t2.pendingUrl || t2.url;
        }
        if (url && !isAllowedUrl(url))
            sendViolation("TAB_SWITCH", `Switched to: ${url}`, null, null, url);
    } catch {}
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
    await configReady;
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
