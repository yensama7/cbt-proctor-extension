// background.js — Service Worker (Manifest V3)
// Handles browser-level events: tab switches, URL changes, window focus.
// Also sends its own bg-heartbeat so the server can distinguish
// EXTENSION_KILLED from NETWORK_DROP.

const SERVER_URL    = "http://localhost:3000/api/report";
const BG_HB_URL     = "http://localhost:3000/api/bg-heartbeat";
const BG_HB_MS      = 10_000; // must be less than server's HEARTBEAT_TIMEOUT_MS

// Hostnames the student is allowed to visit during the exam.
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function isAllowedUrl(url) {
    try {
        const { hostname } = new URL(url);
        return ALLOWED_HOSTNAMES.has(hostname);
    } catch {
        return false;
    }
}

async function sendViolation(eventType, detail, overrideStudentId = null) {
    const { studentId: storedId } = await chrome.storage.local.get("studentId");
    const studentId = overrideStudentId || storedId;

    if (!studentId || studentId === "Unknown" || studentId === "undefined") {
        console.log(`[CBT bg] Skipping (no ID): ${eventType}`);
        return;
    }

    const payload = {
        studentId,
        eventType,
        detail,
        timestamp: new Date().toISOString(),
    };

    try {
        await fetch(SERVER_URL, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
        });
    } catch (err) {
        console.error("[CBT bg] Send failed:", err);
    }
}

// ---------------------------------------------------------------------------
// BACKGROUND HEARTBEAT
//
// Pings /api/bg-heartbeat independently of content.js's /api/heartbeat.
// The server uses both signals to classify disconnects:
//
//   EXTENSION_KILLED received first  →  confirmed kill (student disabled extension)
//   Only content HB silent, bg HB alive  →  page / tab closed
//   Both silent, no EXTENSION_KILLED event  →  NETWORK_DROP (connectivity issue)
//
// Because this runs in the service worker (not in a tab), it survives
// tab-level events like page navigation or tab close.
// ---------------------------------------------------------------------------
async function sendBgHeartbeat() {
    const { studentId } = await chrome.storage.local.get("studentId");
    if (!studentId || studentId === "Unknown" || studentId === "undefined") return;

    try {
        await fetch(BG_HB_URL, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ studentId }),
        });
    } catch {
        // Network down — server will time both HBs out and classify as NETWORK_DROP
    }
}

// Start the background heartbeat loop.
// Service workers are event-driven and can be suspended, so we use a
// recurring alarm instead of setInterval to guarantee delivery.
// For simplicity in this build we use setInterval; production deployments
// should use chrome.alarms (requires "alarms" permission).
setInterval(sendBgHeartbeat, BG_HB_MS);

// ---------------------------------------------------------------------------
// TAB MONITORING
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url && !isAllowedUrl(tab.url)) {
            sendViolation("TAB_SWITCH", `Switched to: ${tab.url}`);
        }
    } catch {
        // Tab may already be closed
    }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url && !isAllowedUrl(tab.url)) {
        sendViolation("UNAUTHORIZED_NAVIGATION", `Navigated to: ${tab.url}`);
    }
});

// ---------------------------------------------------------------------------
// WINDOW FOCUS MONITORING
// ---------------------------------------------------------------------------

chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        sendViolation("BROWSER_OUT_OF_FOCUS", "Chrome lost focus / minimised");
    }
});

// ---------------------------------------------------------------------------
// MESSAGE HANDLER (receives from content.js)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
    if (!message?.type) return;

    if (message.type === "RESET_STATE") {
        chrome.storage.local.remove("studentId");
        console.log("[CBT bg] Session cleared.");
        return;
    }

    sendViolation(message.type, message.detail, message.studentId ?? null);
});
