const canvas = document.getElementById('drawing-board');
const ctx = canvas.getContext('2d');
const wsBadge = document.getElementById('ws-badge');

// Responsive canvas
function resizeCanvas() {
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth  - 60;
  canvas.height = wrap.clientHeight - 60;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const COLORS = ['#0f172a','#ef4444','#3b82f6','#10b981','#f59e0b','#8b5cf6'];
let drawing = false;
let cur = { x: 0, y: 0, color: COLORS[0] };
let ws;

// Color picker
const picker = document.getElementById('color-picker');
COLORS.forEach((c, i) => {
  const btn = document.createElement('button');
  btn.className = 'color-btn' + (i === 0 ? ' active' : '');
  btn.style.background = c;
  btn.dataset.color = c;
  btn.onclick = e => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    cur.color = c;
  };
  picker.appendChild(btn);
});

// WebSocket
function connect() {
  ws = new WebSocket('ws://localhost:8080/ws');

  ws.onopen = () => {
    wsBadge.textContent = '● Connected';
    wsBadge.className = 'ws-badge connected';
  };
  ws.onclose = () => {
    wsBadge.textContent = '○ Reconnecting…';
    wsBadge.className = 'ws-badge disconnected';
    setTimeout(connect, 2000);
  };
  ws.onmessage = e => {
    const s = JSON.parse(e.data);
    drawLine(s.x0, s.y0, s.x1, s.y1, s.color, false);
  };
}

// Drawing
function drawLine(x0, y0, x1, y1, color, emit) {
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.stroke(); ctx.closePath();
  if (emit && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ x0, y0, x1, y1, color }));
  }
}

canvas.addEventListener('mousedown', e => {
  drawing = true;
  const r = canvas.getBoundingClientRect();
  cur.x = e.clientX - r.left; cur.y = e.clientY - r.top;
});
canvas.addEventListener('mouseup', e => {
  if (!drawing) return; drawing = false;
  const r = canvas.getBoundingClientRect();
  drawLine(cur.x, cur.y, e.clientX - r.left, e.clientY - r.top, cur.color, true);
});
canvas.addEventListener('mouseout', () => { drawing = false; });
canvas.addEventListener('mousemove', e => {
  if (!drawing) return;
  const r = canvas.getBoundingClientRect();
  const nx = e.clientX - r.left, ny = e.clientY - r.top;
  drawLine(cur.x, cur.y, nx, ny, cur.color, true);
  cur.x = nx; cur.y = ny;
});

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

connect();
