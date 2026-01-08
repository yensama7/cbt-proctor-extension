const socket = io();
const tableBody = document.getElementById("logTable");

// UI Elements
const loginScreen = document.getElementById("login-screen");
const dashboardScreen = document.getElementById("dashboard-screen");
const loginError = document.getElementById("login-error");

// Filters
const filterStudentInput = document.getElementById("filterStudent");
const filterStartInput = document.getElementById("filterStart");
const filterEndInput = document.getElementById("filterEnd");

let allLogs = [];
let authToken = localStorage.getItem("adminToken");

// ==========================================
// 🔐 AUTHENTICATION LOGIC
// ==========================================

// Check if already logged in on load
if (authToken) {
    showDashboard();
}

async function login() {
    const user = document.getElementById("username").value;
    const pass = document.getElementById("password").value;

    try {
        const res = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: user, password: pass })
        });

        const data = await res.json();

        if (data.success) {
            authToken = data.token;
            localStorage.setItem("adminToken", authToken);
            showDashboard();
        } else {
            loginError.textContent = "Invalid Credentials";
        }
    } catch (err) {
        loginError.textContent = "Server Error";
    }
}

function logout() {
    localStorage.removeItem("adminToken");
    location.reload();
}

function showDashboard() {
    loginScreen.style.display = "none";
    dashboardScreen.style.display = "block";
    fetchLogs(); // Load data only after login
}

// ==========================================
// 📊 DASHBOARD LOGIC
// ==========================================

async function fetchLogs() {
    try {
        const res = await fetch('/api/logs', {
            headers: { "Authorization": "Bearer " + authToken }
        });

        if (res.status === 401) {
            logout(); // Token expired or invalid
            return;
        }

        const logs = await res.json();
        
        allLogs = logs.map(log => ({
            studentId: log.studentId,
            eventType: log.eventType,
            detail: log.detail,
            time: log.clientTimestamp || log.serverTimestamp
        }));

        renderLogs();
    } catch (err) {
        console.error("Failed to load logs", err);
    }
}

function renderLogs() {
    tableBody.innerHTML = ""; 

    const studentQuery = filterStudentInput.value.toLowerCase();
    const startTime = filterStartInput.value ? new Date(filterStartInput.value).getTime() : 0;
    const endTime = filterEndInput.value ? new Date(filterEndInput.value).getTime() : Infinity;

    const filtered = allLogs.filter(log => {
        const logTime = new Date(log.time).getTime();
        const matchesId = log.studentId.toLowerCase().includes(studentQuery);
        const matchesTime = logTime >= startTime && logTime <= endTime;
        return matchesId && matchesTime;
    });

    filtered.forEach(log => {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td><span class="badge-id">${log.studentId}</span></td>
            <td><span class="badge-event ${getEventClass(log.eventType)}">${log.eventType}</span></td>
            <td>${log.detail}</td>
            <td class="time-cell">${new Date(log.time).toLocaleString()}</td>
        `;
        tableBody.appendChild(row);
    });
}

// Helper to style event types
function getEventClass(type) {
    if (type === "EXAM_SUBMITTED") return "success"; // <--- NEW GREEN BADGE
    if (type === "CRITICAL_DISCONNECT") return "danger";
    if (type.includes("tab_switch") || type.includes("PAGE_HIDDEN")) return "warning";
    if (type.includes("copy") || type.includes("paste")) return "danger";
    return "info";
}

socket.on("new_violation", (data) => {
    // Only update if logged in
    if(dashboardScreen.style.display !== "none") {
        allLogs.unshift(data);
        renderLogs();
    }
});

// Event Listeners
filterStudentInput.addEventListener("input", renderLogs);
filterStartInput.addEventListener("change", renderLogs);
filterEndInput.addEventListener("change", renderLogs);

function clearFilters() {
    filterStudentInput.value = "";
    filterStartInput.value = "";
    filterEndInput.value = "";
    renderLogs();
}