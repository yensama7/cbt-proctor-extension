const socket = io();
const tableBody = document.getElementById("logTable");

// Inputs
const filterStudentInput = document.getElementById("filterStudent");
const filterStartInput = document.getElementById("filterStart");
const filterEndInput = document.getElementById("filterEnd");

// Store all logs in memory to filter them easily
let allLogs = [];

// 1. Fetch existing logs when page loads
async function fetchLogs() {
    try {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        
        // Map database format to frontend format if necessary
        // The endpoint returns full mongo objects
        allLogs = logs.map(log => ({
            studentId: log.studentId,
            eventType: log.eventType,
            detail: log.detail,
            time: log.clientTimestamp || log.serverTimestamp // Fallback to server time
        }));

        renderLogs();
    } catch (err) {
        console.error("Failed to load logs", err);
    }
}

// 2. Render logs based on current filters
function renderLogs() {
    tableBody.innerHTML = ""; // Clear current table

    const studentQuery = filterStudentInput.value.toLowerCase();
    const startTime = filterStartInput.value ? new Date(filterStartInput.value).getTime() : 0;
    const endTime = filterEndInput.value ? new Date(filterEndInput.value).getTime() : Infinity;

    // Filter logs
    const filtered = allLogs.filter(log => {
        const logTime = new Date(log.time).getTime();
        const matchesId = log.studentId.toLowerCase().includes(studentQuery);
        const matchesTime = logTime >= startTime && logTime <= endTime;
        return matchesId && matchesTime;
    });

    // Create HTML elements
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
    if (type.includes("tab_switch")) return "warning";
    if (type.includes("copy_paste")) return "danger";
    return "info";
}

// 3. Listen for real-time updates
socket.on("new_violation", (data) => {
    // Add new log to the beginning of our array
    allLogs.unshift(data);
    // Re-render to show the new log (if it matches filters)
    renderLogs();
});

// 4. Filter Event Listeners
filterStudentInput.addEventListener("input", renderLogs);
filterStartInput.addEventListener("change", renderLogs);
filterEndInput.addEventListener("change", renderLogs);

function clearFilters() {
    filterStudentInput.value = "";
    filterStartInput.value = "";
    filterEndInput.value = "";
    renderLogs();
}

// Initial fetch
fetchLogs();