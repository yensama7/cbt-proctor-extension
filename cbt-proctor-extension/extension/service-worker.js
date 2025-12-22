const SERVER_URL = "http://localhost:3000/api/report";
const EXAM_DOMAIN = "exam-portal.com";

/* Utility: send violation to server */
async function sendViolation(eventType, detail) {
const data = await chrome.storage.local.get(["studentId"]);

const payload = {
    studentId: data.studentId || "UNKNOWN",
    eventType,
    detail,
    timestamp: new Date().toISOString()
};

fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
}).catch(err => {
    console.error("Failed to send violation:", err);
});
}

/* Store session data on install (example) */
chrome.runtime.onInstalled.addListener(() => {
chrome.storage.local.set({
    studentId: "U23CYS1008"
});
});

/* 1. TAB SWITCHING DETECTION */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
try {
    const tab = await chrome.tabs.get(activeInfo.tabId);

    if (!tab.url) return;

    if (!tab.url.includes(EXAM_DOMAIN)) {
        sendViolation("TAB_SWITCH", tab.url);
    }
} catch (err) {
    console.error("Tab switch error:", err);
}
});

/* 2. URL CHANGE DETECTION (NEW NAVIGATION) */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
if (changeInfo.status === "complete" && tab.url) {
    if (!tab.url.includes(EXAM_DOMAIN)) {
        sendViolation("UNAUTHORIZED_NAVIGATION", tab.url);
    }
}
});

/* 3. BROWSER OUT-OF-FOCUS / MINIMIZED */
chrome.windows.onFocusChanged.addListener((windowId) => {
if (windowId === chrome.windows.WINDOW_ID_NONE) {
    sendViolation(
        "BROWSER_OUT_OF_FOCUS",
        "Chrome window minimized or another application opened"
    );
}
});

/* 4. RECEIVE VISIBILITY EVENTS FROM CONTENT SCRIPT */
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "PAGE_HIDDEN") {
        sendViolation("PAGE_HIDDEN", message.detail);
}
});