const SERVER_URL = "http://localhost:3000/api/report";

// ALLOWED DOMAINS (Whitelist)
// We allow localhost, 127.0.0.1, and the exam portal
const ALLOWED_DOMAINS = ["localhost", "127.0.0.1", "exam-portal.com"];

/* Utility: Check if URL is allowed */
function isUrlAllowed(url) {
    if (!url) return false;
    return ALLOWED_DOMAINS.some(domain => url.includes(domain));
}

/* Utility: send violation */
async function sendViolation(eventType, detail, providedId = null) {
    const data = await chrome.storage.local.get(["studentId"]);
    const finalId = providedId || data.studentId;

    // ❌ STRICT FIX: If we have NO ID, strictly STOP.
    if (!finalId || finalId === "Unknown" || finalId === "undefined") {
        console.log("Skipping report: No valid Student ID found.");
        return;
    }

    const payload = {
        studentId: finalId,
        eventType,
        detail,
        timestamp: new Date().toISOString()
    };

    fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }).catch(err => console.error("Send failed:", err));
}
/* 1. TAB SWITCHING */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (!tab.url) return;

        if (!isUrlAllowed(tab.url)) {
            sendViolation("TAB_SWITCH", "Switched to: " + tab.url);
        }
    } catch (err) {}
});

/* 2. URL CHANGE */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url) {
        if (!isUrlAllowed(tab.url)) {
            sendViolation("UNAUTHORIZED_NAVIGATION", "Navigated to: " + tab.url);
        }
    }
});

/* 3. WINDOW FOCUS */
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        sendViolation("BROWSER_OUT_OF_FOCUS", "Minimized Chrome");
    }
});

/* 4. RECEIVE MESSAGES */
chrome.runtime.onMessage.addListener((message) => {
    
    // ⚡ NEW: Handle Logout Reset Immediately
    if (message.type === "RESET_STATE") {
        chrome.storage.local.remove("studentId");
        console.log("🧹 Session Cleared: ID removed from storage.");
        return; 
    }

    if (message.type) {
        sendViolation(message.type, message.detail, message.studentId);
    }
});