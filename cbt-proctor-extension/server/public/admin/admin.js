const socket = io();

const table = document.getElementById("logTable");

socket.on("new_violation", (data) => {
const row = document.createElement("tr");

row.innerHTML = `
    <td>${data.studentId}</td>
    <td>${data.eventType}</td>
    <td>${data.detail}</td>
    <td>${new Date(data.time).toLocaleTimeString()}</td>
`;

table.prepend(row);
});