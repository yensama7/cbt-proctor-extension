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
    const filteredLogs = getFilteredLogs();
    const fragment = document.createDocumentFragment();

    filteredLogs.forEach(log => {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td><span class="badge-id">${log.studentId}</span></td>
            <td><span class="badge-event ${getEventClass(log.eventType)}">${log.eventType}</span></td>
            <td>${log.detail}</td>
            <td class="time-cell">${new Date(log.time).toLocaleString()}</td>
        `;
        fragment.appendChild(row);
    });

    tableBody.appendChild(fragment);
}

function getFilteredLogs() {
    const studentQuery = filterStudentInput.value.trim().toLowerCase();
    const startTime = filterStartInput.value ? new Date(filterStartInput.value).getTime() : 0;
    const endTime = filterEndInput.value ? new Date(filterEndInput.value).getTime() : Infinity;

    return allLogs.filter(log => {
        const logTime = new Date(log.time).getTime();
        const matchesId = log.studentId.toLowerCase().includes(studentQuery);
        const matchesTime = logTime >= startTime && logTime <= endTime;
        return matchesId && matchesTime;
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

async function exportFilteredCsv() {
    const params = new URLSearchParams();
    if (filterStartInput.value) params.set("start", new Date(filterStartInput.value).toISOString());
    if (filterEndInput.value) params.set("end", new Date(filterEndInput.value).toISOString());

    const hasStudentFilter = filterStudentInput.value.trim().length > 0;

    try {
        if (hasStudentFilter) {
            // Student ID filtering is client-side for partial matching.
            const csvContent = toCsv(getFilteredLogs());
            downloadCsv(csvContent);
            return;
        }

        const url = params.toString() ? `/api/logs/export?${params.toString()}` : "/api/logs/export";
        const res = await fetch(url, {
            headers: { "Authorization": "Bearer " + authToken }
        });

        if (res.status === 401) {
            logout();
            return;
        }
        if (!res.ok) throw new Error("Failed to export logs");

        const csvContent = await res.text();
        downloadCsv(csvContent);
    } catch (err) {
        console.error("CSV export failed", err);
        alert("Failed to export CSV. Please try again.");
    }
}

function toCsv(logs) {
    const headers = ["Student ID", "Event", "Detail", "Time"];
    const rows = logs.map(log => ([
        escapeCsv(log.studentId),
        escapeCsv(log.eventType),
        escapeCsv(log.detail),
        escapeCsv(toIsoOrRaw(log.time))
    ]).join(","));

    return [headers.join(","), ...rows].join("\n");
}

function toIsoOrRaw(value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return value == null ? "" : String(value);
}

function escapeCsv(value) {
    const text = value == null ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(csvContent) {
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const downloadLink = document.createElement("a");
    const start = filterStartInput.value ? new Date(filterStartInput.value).toISOString().slice(0, 10) : "all";
    const end = filterEndInput.value ? new Date(filterEndInput.value).toISOString().slice(0, 10) : "all";
    const fileName = `cbt-logs-${start}-to-${end}.csv`;

    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = fileName;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(downloadLink.href);
}
