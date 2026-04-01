const canvas = document.getElementById('drawing-board');
const ctx = canvas.getContext('2d');
const statusBadge = document.getElementById('connection-status');

// Responsive Canvas
canvas.width = window.innerWidth - 380; 
canvas.height = window.innerHeight - 80;

let drawing = false;
let current = { x: 0, y: 0, color: '#0f172a' };
let ws;

// --- Setup WebSocket ---
function connectWebSocket() {
    ws = new WebSocket('ws://localhost:8080/ws');

    ws.onopen = () => {
        statusBadge.textContent = 'Connected to Cluster';
        statusBadge.className = 'status-badge connected';
    };

    ws.onclose = () => {
        statusBadge.textContent = 'Disconnected - Retrying...';
        statusBadge.className = 'status-badge disconnected';
        setTimeout(connectWebSocket, 2000); // Auto-reconnect
    };

    ws.onmessage = (event) => {
        // Receive committed stroke from leader
        const stroke = JSON.parse(event.data);
        drawLine(stroke.x0, stroke.y0, stroke.x1, stroke.y1, stroke.color, false);
    };
}

// --- Drawing Logic ---
function drawLine(x0, y0, x1, y1, color, emit) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.closePath();

    if (!emit || ws.readyState !== WebSocket.OPEN) return;

    // Send stroke to Gateway
    ws.send(JSON.stringify({
        x0: x0, y0: y0, x1: x1, y1: y1, color: color
    }));
}

function onMouseDown(e) {
    drawing = true;
    const rect = canvas.getBoundingClientRect();
    current.x = e.clientX - rect.left;
    current.y = e.clientY - rect.top;
}

function onMouseUp(e) {
    if (!drawing) return;
    drawing = false;
    const rect = canvas.getBoundingClientRect();
    drawLine(current.x, current.y, e.clientX - rect.left, e.clientY - rect.top, current.color, true);
}

function onMouseMove(e) {
    if (!drawing) return;
    const rect = canvas.getBoundingClientRect();
    drawLine(current.x, current.y, e.clientX - rect.left, e.clientY - rect.top, current.color, true);
    current.x = e.clientX - rect.left;
    current.y = e.clientY - rect.top;
}

// --- Event Listeners ---
canvas.addEventListener('mousedown', onMouseDown, false);
canvas.addEventListener('mouseup', onMouseUp, false);
canvas.addEventListener('mouseout', onMouseUp, false);
canvas.addEventListener('mousemove', onMouseMove, false);

document.getElementById('clear-btn').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
});

document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        current.color = e.target.dataset.color;
    });
});

// Start connection
connectWebSocket();