// content.js — Injected into exam pages only (see manifest.json matches)

// ---------------------------------------------------------------------------
// GUARD: Kill immediately on login page. Clear stale session data.
// ---------------------------------------------------------------------------
if (window.location.href.includes("login.html")) {
    chrome.storage.local.remove("studentId");
    localStorage.removeItem("cbt_student_id");
    localStorage.removeItem("cbt_student_name");
    throw new Error("[CBT Proctor] Disabled on login page.");
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
const SERVER_BASE = "http://localhost:3000";
let studentId      = null;
let heartbeatTimer = null;
let contextPoller  = null;

// ---------------------------------------------------------------------------
// BOOTSTRAP
// ---------------------------------------------------------------------------
const ID_POLL_MS = 1_000;

const idPoller = setInterval(() => {
    const storedId = localStorage.getItem("cbt_student_id");

    if (storedId) {
        studentId = storedId;
        console.log("[CBT Proctor] Active for:", studentId);
        chrome.storage.local.set({ studentId });
        clearInterval(idPoller);
        startHeartbeat();
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
    heartbeatTimer = setInterval(sendPulse, HEARTBEAT_INTERVAL_MS);
}

function sendPulse() {
    if (!studentId) return;
    fetch(`${SERVER_BASE}/api/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId }),
        keepalive: true,
    }).catch(() => {
        // Silent — network failures are classified server-side as NETWORK_DROP
        // once the heartbeat timeout fires. No chrome API is involved here,
        // so this path is safe even if the extension context is dying.
    });
}

// ---------------------------------------------------------------------------
// EXTENSION CONTEXT WATCHDOG
//
// When the user disables the extension via chrome://extensions, Chrome
// invalidates chrome.* bindings in content scripts but does NOT immediately
// halt the JS event loop — setInterval callbacks keep ticking briefly.
// We exploit this window: accessing chrome.runtime.id throws
// "Extension context invalidated", we catch it, then fire a
// navigator.sendBeacon (plain Web API — no chrome dependency) before
// execution fully stops.
//
// This lets the server distinguish two otherwise identical-looking events:
//   EXTENSION_KILLED  — beacon arrived first  →  deliberate tampering
//   NETWORK_DROP      — heartbeats just went silent  →  connectivity issue
// ---------------------------------------------------------------------------
const CONTEXT_POLL_MS = 2_000;

function startContextWatchdog() {
    contextPoller = setInterval(() => {
        try {
            void chrome.runtime.id; // throws when context is invalidated
        } catch (_e) {
            clearInterval(contextPoller);
            clearInterval(heartbeatTimer);

            if (!studentId) return;

            const payload = JSON.stringify({
                studentId,
                eventType : "EXTENSION_KILLED",
                detail    : "Chrome extension was disabled or removed by the student.",
                timestamp : new Date().toISOString(),
            });

            // sendBeacon survives extension death; it queues at the network
            // layer even if the page context is about to be torn down.
            navigator.sendBeacon(
                `${SERVER_BASE}/api/report`,
                new Blob([payload], { type: "application/json" })
            );

            console.warn("[CBT Proctor] Extension context invalidated — kill beacon sent.");
        }
    }, CONTEXT_POLL_MS);
}

// ---------------------------------------------------------------------------
// VIOLATION REPORTING
// Delegates to background.js service worker (survives page unloads).
// Falls back to sendBeacon if context is already gone.
// ---------------------------------------------------------------------------
function reportViolation(type, detail) {
    if (!studentId) return;

    try {
        chrome.runtime.sendMessage({ type, studentId, detail });
    } catch (_e) {
        // Extension context died between the triggering event and this call.
        // Use the Web platform as last-resort.
        const payload = JSON.stringify({
            studentId,
            eventType : type,
            detail    : detail + " [beacon fallback]",
            timestamp : new Date().toISOString(),
        });
        navigator.sendBeacon(
            `${SERVER_BASE}/api/report`,
            new Blob([payload], { type: "application/json" })
        );
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
            reportViolation("SUSPICIOUS_RESIZE", `Window shrank ${dw}w×${dh}h px — possible DevTools.`);
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
        const isSuspicious =
            e.key === "F12" ||
            e.altKey        ||
            e.metaKey       ||
            (e.ctrlKey && ["u","s","a","c","v","i","j"].includes(e.key.toLowerCase()));

        if (isSuspicious) {
            e.preventDefault();
            reportViolation("RESTRICTED_KEY", `Key: ${e.key} | ctrl=${e.ctrlKey} alt=${e.altKey} meta=${e.metaKey}`);
        }
    });
}

function attachContextMenuBlocker() {
    document.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        reportViolation("RIGHT_CLICK", "Right-click attempted");
    });
}
