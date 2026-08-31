// content.js — Injected into exam pages only (see manifest.json matches)

if (window.location.href.includes("login.html")) {
    chrome.storage.local.remove("studentId");
    localStorage.removeItem("cbt_student_id");
    localStorage.removeItem("cbt_student_name");
    localStorage.removeItem("cbt_session_id");
    throw new Error("[CBT Proctor] Disabled on login page.");
}

let SERVER_BASE    = DEFAULT_SERVER_BASE; // resolved from managed storage at bootstrap (config.js)
let studentId      = null;
let sessionId      = null;
let heartbeatTimer = null;
let contextPoller  = null;
let offlineDB      = null;

// ---------------------------------------------------------------------------
// INDEXEDDB OFFLINE BUFFER
// Queues violation records during network interruptions; flushed each heartbeat.
// ---------------------------------------------------------------------------
function openOfflineDB() {
    return new Promise((resolve) => {
        const req = indexedDB.open("hbmds_offline", 1);
        req.onupgradeneeded = (e) => e.target.result.createObjectStore("queue", { autoIncrement: true });
        req.onsuccess  = (e) => resolve(e.target.result);
        req.onerror    = () => resolve(null);
    });
}

function enqueueOffline(payload) {
    if (!offlineDB) return;
    const tx = offlineDB.transaction("queue", "readwrite");
    tx.objectStore("queue").add(payload);
}

async function flushOfflineQueue() {
    if (!offlineDB) return;
    const vals = await new Promise((r) => {
        const req = offlineDB.transaction("queue", "readonly").objectStore("queue").getAll();
        req.onsuccess = () => r(req.result);
        req.onerror   = () => r([]);
    });
    if (!vals.length) return;
    try {
        // Batched POSTs (server caps 100/batch). sentAt = flush time so the
        // server measures real transport latency, not the offline queueing
        // delay (improve.md §4B). Clear only after every chunk is accepted —
        // a rare duplicate beats losing forensic events.
        for (let i = 0; i < vals.length; i += 100) {
            const res = await fetch(`${SERVER_BASE}/api/report`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    studentId, sessionId,
                    sentAt: new Date().toISOString(),
                    events: vals.slice(i, i + 100),
                }),
                keepalive: true,
            });
            if (!res.ok) return; // retry whole queue next heartbeat
        }
        offlineDB.transaction("queue", "readwrite").objectStore("queue").clear();
    } catch { /* network still down — retry next heartbeat */ }
}

// ---------------------------------------------------------------------------
// BOOTSTRAP
// ---------------------------------------------------------------------------
const ID_POLL_MS = 1_000;

const idPoller = setInterval(async () => {
    const storedId = localStorage.getItem("cbt_student_id");

    if (storedId) {
        studentId = storedId;
        sessionId = localStorage.getItem("cbt_session_id") || crypto.randomUUID();
        localStorage.setItem("cbt_session_id", sessionId);

        // Handshake: signal to the page that the extension is active (readable by page JS via DOM)
        document.documentElement.setAttribute("data-hbmds-active", "true");

        console.log("[CBT Proctor] Active for:", studentId, "session:", sessionId);
        chrome.storage.local.set({ studentId });
        clearInterval(idPoller);
        SERVER_BASE = await getServerBase();
        offlineDB   = await openOfflineDB();
        startHeartbeat();
        startBatchFlusher();
        startContextWatchdog();
        attachProctoringListeners();
        return;
    }

    if (window.location.href.includes("paper.html")) {
        clearInterval(idPoller);
        window.location.href = "login.html";
    }
}, ID_POLL_MS);

// ---------------------------------------------------------------------------
// HEARTBEAT
// ---------------------------------------------------------------------------
const HEARTBEAT_INTERVAL_MS = 10_000;

function startHeartbeat() {
    sendPulse();
    heartbeatTimer = setInterval(() => {
        sendPulse();
        flushOfflineQueue();
    }, HEARTBEAT_INTERVAL_MS);
}

function sendPulse() {
    if (!studentId) return;
    fetch(`${SERVER_BASE}/api/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId }),
        keepalive: true,
    }).catch(() => {});
}

// ---------------------------------------------------------------------------
// EXTENSION CONTEXT WATCHDOG
// ---------------------------------------------------------------------------
const CONTEXT_POLL_MS = 2_000;

function startContextWatchdog() {
    contextPoller = setInterval(() => {
        try {
            void chrome.runtime.id;
        } catch (_e) {
            clearInterval(contextPoller);
            clearInterval(heartbeatTimer);
            if (!studentId) return;
            const payload = JSON.stringify({
                studentId, sessionId,
                eventType : "EXTENSION_KILLED",
                detail    : "Chrome extension was disabled or removed by the student.",
                timestamp : new Date().toISOString(),
            });
            navigator.sendBeacon(
                `${SERVER_BASE}/api/report`,
                new Blob([payload], { type: "application/json" })
            );
        }
    }, CONTEXT_POLL_MS);
}

// ---------------------------------------------------------------------------
// VIOLATION REPORTING
//
// High-frequency events (key mashing, resize storms, focus flapping) are
// buffered and flushed every few seconds via sendBeacon so they can't spam
// /api/report (improve.md §1B). Critical events still go out immediately.
// ---------------------------------------------------------------------------
const BATCH_FLUSH_MS  = 3_000;
const CRITICAL_EVENTS = new Set(["DEVTOOLS_OPEN", "PAGE_UNLOAD", "TAB_HIDDEN", "EXTENSION_KILLED"]);
const eventBuffer     = [];
let   batchTimer      = null;

function startBatchFlusher() {
    batchTimer = setInterval(flushEventBuffer, BATCH_FLUSH_MS);
    window.addEventListener("pagehide", flushEventBuffer); // don't lose the tail on unload
}

function flushEventBuffer() {
    if (!eventBuffer.length) return;
    const batch = eventBuffer.splice(0, eventBuffer.length);
    const body  = JSON.stringify({
        studentId, sessionId,
        sentAt: new Date().toISOString(),
        events: batch,
    });
    if (!navigator.sendBeacon(`${SERVER_BASE}/api/report`, new Blob([body], { type: "application/json" }))) {
        batch.forEach(enqueueOffline); // beacon queue full / network down — persist locally
    }
}

function reportViolation(type, detail, violationURL = "") {
    if (!studentId) return;

    const payload = {
        studentId, sessionId, eventType: type, detail, violationURL,
        timestamp: new Date().toISOString(),
    };

    if (!CRITICAL_EVENTS.has(type)) {
        eventBuffer.push(payload);
        return;
    }

    try {
        chrome.runtime.sendMessage({ type, studentId, sessionId, detail, violationURL });
    } catch (_e) {
        // Extension context dying — try beacon, fall back to IndexedDB queue
        const body = JSON.stringify({ ...payload, detail: detail + " [beacon fallback]" });
        if (!navigator.sendBeacon(`${SERVER_BASE}/api/report`, new Blob([body], { type: "application/json" }))) {
            enqueueOffline(payload);
        }
    }
}

// ---------------------------------------------------------------------------
// PROCTORING LISTENERS
// ---------------------------------------------------------------------------
function attachProctoringListeners() {
    attachResizeDetector();
    attachFocusListeners();
    attachVisibilityListener();
    attachClipboardListeners();
    attachKeyboardListeners();
    attachContextMenuBlocker();
}

function attachResizeDetector() {
    const RESIZE_THRESHOLD_PX = 150;
    let lastW = window.innerWidth;
    let lastH = window.innerHeight;

    window.addEventListener("resize", () => {
        const dw = lastW - window.innerWidth;
        const dh = lastH - window.innerHeight;
        if (dw > RESIZE_THRESHOLD_PX || dh > RESIZE_THRESHOLD_PX) {
            reportViolation("SUSPICIOUS_RESIZE", `Window shrank ${dw}w x ${dh}h px — possible DevTools.`);
        }
        lastW = window.innerWidth;
        lastH = window.innerHeight;
    });
}

function attachFocusListeners() {
    window.addEventListener("blur", () => {
        reportViolation("WINDOW_FOCUS_LOST", "Window lost focus");
        document.body.style.opacity = "0.5";
    });
    window.addEventListener("focus", () => {
        document.body.style.opacity = "1";
    });
}

function attachVisibilityListener() {
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) reportViolation("TAB_HIDDEN", "Tab hidden / minimised / switched");
    });
    window.addEventListener("pagehide", () => {
        reportViolation("PAGE_UNLOAD", "Page hidden or browser closed");
    });
}

function attachClipboardListeners() {
    for (const action of ["copy", "cut", "paste"]) {
        document.addEventListener(action, () => {
            reportViolation("CLIPBOARD_ACTION", `Attempted: ${action}`);
        });
    }
}

function attachKeyboardListeners() {
    document.addEventListener("keydown", (e) => {
        // DevTools access keys — reported as DEVTOOLS_OPEN per paper schema
        const isDevTools =
            e.key === "F12" ||
            (e.ctrlKey && e.shiftKey && ["i", "j", "c"].includes(e.key.toLowerCase()));

        if (isDevTools) {
            e.preventDefault();
            reportViolation("DEVTOOLS_OPEN", `DevTools key: ${e.key} ctrl=${e.ctrlKey} shift=${e.shiftKey}`);
            return;
        }

        // Other restricted keys
        const isRestricted =
            e.altKey  ||
            e.metaKey ||
            (e.ctrlKey && ["u", "s", "a"].includes(e.key.toLowerCase()));

        if (isRestricted) {
            e.preventDefault();
            reportViolation("RESTRICTED_KEY", `Key: ${e.key} ctrl=${e.ctrlKey} alt=${e.altKey} meta=${e.metaKey}`);
        }
    });
}

function attachContextMenuBlocker() {
    document.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        reportViolation("RIGHT_CLICK", "Right-click attempted");
    });
}

// paper.html dispatches this when the student submits — clear all state so
// background.js stops monitoring after the exam ends.
window.addEventListener("cbt_exam_submitted", () => {
    clearInterval(heartbeatTimer);
    clearInterval(contextPoller);
    clearInterval(batchTimer);
    flushEventBuffer();
    localStorage.removeItem("cbt_session_id");
    document.documentElement.removeAttribute("data-hbmds-active");
    try { chrome.runtime.sendMessage({ type: "RESET_STATE" }); } catch {}
});
