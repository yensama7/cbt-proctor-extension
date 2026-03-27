// ⚡ FIX: STOP SCRIPT IF ON LOGIN PAGE
// This prevents any event listeners from attaching on the login screen
if (window.location.href.includes("login.html")) {
    // Explicitly clear storage just in case
    chrome.storage.local.remove("studentId");
    // Stop execution
    throw new Error("Proctoring disabled on login page");
}

let studentId = "Unknown";
let heartbeatInterval = null;

// 1. GET STUDENT ID
const idCheckInterval = setInterval(() => {
    const storedId = sessionStorage.getItem("cbt_student_id");
    
    if (storedId) {
        studentId = storedId;
        console.log("✅ Logged in as:", studentId);
        
        // Sync with Service Worker
        chrome.storage.local.set({ studentId: storedId });

        clearInterval(idCheckInterval); 
        startHeartbeat();
        enableProctoring();
    } 
    // Redirect if on paper page but not logged in
    else if (window.location.href.includes("paper.html")) {
        window.location.href = "login.html";
    }
}, 1000);

// 2. SEND HEARTBEAT
function startHeartbeat() {
    sendPulse();
    heartbeatInterval = setInterval(sendPulse, 10000);
}

function sendPulse() {
    if(studentId === "Unknown") return;
    fetch("http://localhost:3000/api/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: studentId }),
        keepalive: true
    }).catch(err => {}); 
}

// 3. REPORT VIOLATION HELPER
function reportViolation(type, detail) {
    if (studentId === "Unknown") return;

    const payload = JSON.stringify({
        studentId,
        eventType: type,
        detail,
        timestamp: new Date().toISOString()
    });

    fetch("http://localhost:3000/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
    }).catch(() => {});
}

// 4. PROCTORING LOGIC
function enableProctoring() {
    window.addEventListener("blur", () => {
        reportViolation("WINDOW_FOCUS_LOST", "Switched application");
        document.body.style.opacity = "0.5"; 
    });
    window.addEventListener("focus", () => { document.body.style.opacity = "1"; });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            reportViolation("WINDOW_HIDDEN", "Tab hidden / Chrome minimized / switched application");
        }
    });
    window.addEventListener("pagehide", () => {
        reportViolation("PAGE_HIDDEN", "Page hidden or browser closed/minimized");
    });
    ['copy', 'cut', 'paste'].forEach(action => {
        document.addEventListener(action, () => {
            reportViolation("CLIPBOARD_ACTION", `Attempted ${action}`);
        });
    });
    document.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        reportViolation("RIGHT_CLICK", "Right-click attempted");
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "F12" || e.altKey || e.metaKey) {
            reportViolation("RESTRICTED_KEY", `Pressed ${e.key}`);
        }
    });
}
