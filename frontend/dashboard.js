// ─── Config ──────────────────────────────────────────────────────────────────
const NODES = [
  { id: 1, port: 8081, label: 'R1' },
  { id: 2, port: 8082, label: 'R2' },
  { id: 3, port: 8083, label: 'R3' },
  { id: 4, port: 8084, label: 'R4' },
  { id: 5, port: 8085, label: 'R5' },
];

const STATE_COLOR = {
  Leader:    '#22c55e',
  Follower:  '#3b82f6',
  Candidate: '#f59e0b',
  Offline:   '#ef4444',
};

// Shared state
let prevStates    = {};  // port → last known state string (for change detection)
const seenEvents  = new Set();
let latestStatuses = {}; // most recent poll result, shared with boards tab

// ─── Tab Switching ────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.getElementById(`view-${name}`).classList.add('active');
  if (name === 'boards') renderBoards(latestStatuses);
}

// ─── Topology SVG ─────────────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('topology-svg');
const CX = 130, CY = 130, R = 95;

function topoPos(i, total) {
  const angle = (2 * Math.PI * i / total) - Math.PI / 2;
  return { x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle) };
}

function initTopology() {
  svg.innerHTML = '';
  for (let i = 0; i < NODES.length; i++) {
    for (let j = i + 1; j < NODES.length; j++) {
      const a = topoPos(i, NODES.length);
      const b = topoPos(j, NODES.length);
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      line.setAttribute('class', 'topo-edge');
      line.id = `edge-${NODES[i].id}-${NODES[j].id}`;
      svg.appendChild(line);
    }
  }

  NODES.forEach((node, i) => {
    const pos = topoPos(i, NODES.length);
    const g = document.createElementNS(SVG_NS, 'g');

    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y);
    circle.setAttribute('r', 18);
    circle.setAttribute('fill', '#0f1621');
    circle.setAttribute('stroke', STATE_COLOR.Follower);
    circle.setAttribute('class', 'topo-node-circle');
    circle.id = `topo-c-${node.port}`;

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', pos.x); label.setAttribute('y', pos.y);
    label.setAttribute('class', 'topo-label');
    label.id = `topo-l-${node.port}`;
    label.textContent = node.label;

    g.appendChild(circle); g.appendChild(label);
    svg.appendChild(g);
  });
}

function updateTopology(statuses) {
  NODES.forEach((node, i) => {
    const s = statuses[node.port];
    const state = s ? s.state : 'Offline';
    const chaos = s ? s.chaos : 'none';
    const color = chaos === 'partition' ? '#ef4444'
                : chaos === 'slowdown'  ? '#f59e0b'
                : STATE_COLOR[state] || STATE_COLOR.Offline;

    const circle = document.getElementById(`topo-c-${node.port}`);
    const label  = document.getElementById(`topo-l-${node.port}`);
    if (!circle) return;

    circle.setAttribute('stroke', color);
    circle.setAttribute('fill', state === 'Leader'
      ? 'rgba(34,197,94,0.12)'
      : state === 'Offline' ? 'rgba(239,68,68,0.05)' : '#0f1621');
    circle.setAttribute('r', state === 'Leader' ? 21 : 18);
    if (label) {
      label.setAttribute('fill', color);
      label.textContent = state === 'Leader' ? '👑' : node.label;
    }
  });

  for (let i = 0; i < NODES.length; i++) {
    for (let j = i + 1; j < NODES.length; j++) {
      const si = statuses[NODES[i].port];
      const sj = statuses[NODES[j].port];
      const partitioned = (si && si.chaos === 'partition') || (sj && sj.chaos === 'partition');
      const offline = (!si || si.state === 'Offline') || (!sj || sj.state === 'Offline');
      const edge = document.getElementById(`edge-${NODES[i].id}-${NODES[j].id}`);
      if (edge) {
        edge.setAttribute('stroke', (partitioned || offline) ? '#2a1515' : '#1e2d42');
        edge.setAttribute('stroke-dasharray', partitioned ? '4 3' : 'none');
        edge.setAttribute('opacity', offline ? '0.3' : '1');
      }
    }
  }
}

// ─── Node Cards ──────────────────────────────────────────────────────────────
function renderNodeCards(statuses) {
  const container = document.getElementById('nodes-container');
  NODES.forEach(node => {
    const s = statuses[node.port];
    const state = s ? s.state : 'Offline';
    const chaos = s ? s.chaos : 'none';
    const term  = s ? s.current_term : '—';
    const logs  = s ? s.log_size : '—';

    let card = document.getElementById(`card-${node.port}`);
    if (!card) {
      card = document.createElement('div');
      card.id = `card-${node.port}`;
      container.appendChild(card);
    }

    card.className = `node-card state-${state} chaos-${chaos}`;
    const chaosTag = chaos !== 'none'
      ? `<span style="font-size:9px;color:${chaos==='partition'?'#ef4444':'#f59e0b'};margin-top:4px;display:block;">⚡ ${chaos}</span>`
      : '';
    card.innerHTML = `
      <div class="node-top">
        <span class="node-name">Replica ${node.id}</span>
        <span class="state-pill pill-${state}">${state}</span>
      </div>
      <div class="node-stats">
        <span>Term <strong>${term}</strong></span>
        <span>Log <strong>${logs}</strong></span>
      </div>
      ${chaosTag}
    `;
  });
}

// ─── Chaos Controls ──────────────────────────────────────────────────────────
function initChaosControls() {
  const container = document.getElementById('chaos-controls');
  NODES.forEach(node => {
    const row = document.createElement('div');
    row.className = 'chaos-row';
    row.id = `chaos-row-${node.port}`;
    row.innerHTML = buildChaosRowHTML(node, 'Offline');
    container.appendChild(row);
  });
}

function buildChaosRowHTML(node, state) {
  const isOffline = (state === 'Offline');
  if (isOffline) {
    return `
      <span class="chaos-label">R${node.id}</span>
      <span class="node-offline-badge">⬤ Offline / Restarting</span>
    `;
  }
  return `
    <span class="chaos-label">R${node.id}</span>
    <button class="chaos-btn btn-partition" id="btn-p-${node.port}" onclick="sendChaos(${node.port},'partition')">Part</button>
    <button class="chaos-btn btn-slowdown"  id="btn-s-${node.port}" onclick="sendChaos(${node.port},'slowdown')">Slow</button>
    <button class="chaos-btn btn-heal"      id="btn-h-${node.port}" onclick="sendChaos(${node.port},'heal')">Heal</button>
    <button class="chaos-btn btn-kill"      id="btn-k-${node.port}" onclick="sendChaos(${node.port},'kill')">Kill</button>
  `;
}

function updateChaosControls(statuses) {
  NODES.forEach(node => {
    const row = document.getElementById(`chaos-row-${node.port}`);
    if (!row) return;
    const s = statuses[node.port];
    const state = s ? s.state : 'Offline';
    row.innerHTML = buildChaosRowHTML(node, state);
  });
}

async function sendChaos(port, action) {
  const actionLabels = {
    partition: '🔴 Partitioned',
    slowdown:  '🟡 Slowed',
    heal:      '🟢 Healed',
    kill:      '💀 Killed',
  };

  // Guard: don't try to reach a node we know is Offline
  const s = latestStatuses[port];
  if (!s) {
    appendEventLog(`⚠ Replica :${port} is offline — skipping ${action}`, 'ev-chaos');
    return;
  }

  appendEventLog(`Sending ${action} to Replica :${port}…`, 'ev-info');
  try {
    const res = await fetch(`http://localhost:${port}/chaos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      appendEventLog(`✔ Replica :${port} → ${actionLabels[action] || action}`, action === 'heal' ? 'ev-heal' : 'ev-chaos');
    } else {
      appendEventLog(`✘ Replica :${port} returned HTTP ${res.status}`, 'ev-chaos');
    }
  } catch (e) {
    appendEventLog(`✘ Could not reach Replica :${port} (offline or restarting)`, 'ev-chaos');
  }
}

// ─── Auto-Chaos Engine ────────────────────────────────────────────────────────
const AUTO_CHAOS_INTERVAL = 15; // seconds
let autoChaosActive   = false;
let autoChaosTimer    = null;
let countdownInterval = null;
let countdownRemaining = AUTO_CHAOS_INTERVAL;

const CHAOS_ACTIONS = ['partition', 'slowdown', 'heal', 'kill'];

function toggleAutoChaos() {
  autoChaosActive = !autoChaosActive;
  const btn = document.getElementById('auto-chaos-btn');
  const statusLabel = document.getElementById('auto-chaos-status');
  const countdown = document.getElementById('auto-chaos-countdown');

  if (autoChaosActive) {
    btn.classList.add('active');
    statusLabel.textContent = 'ON';
    countdown.classList.remove('hidden');
    appendEventLog('⚡ AUTO-CHAOS ENABLED — random chaos every 15s', 'ev-chaos');
    scheduleNextAutoChaos(AUTO_CHAOS_INTERVAL);
  } else {
    btn.classList.remove('active');
    statusLabel.textContent = 'OFF';
    countdown.classList.add('hidden');
    clearTimeout(autoChaosTimer);
    clearInterval(countdownInterval);
    autoChaosTimer = null;
    countdownInterval = null;
    appendEventLog('⏹ AUTO-CHAOS DISABLED', 'ev-info');
  }
}

function scheduleNextAutoChaos(seconds) {
  countdownRemaining = seconds;
  updateCountdownUI(seconds);

  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    countdownRemaining--;
    updateCountdownUI(countdownRemaining);
    if (countdownRemaining <= 0) {
      clearInterval(countdownInterval);
    }
  }, 1000);

  clearTimeout(autoChaosTimer);
  autoChaosTimer = setTimeout(async () => {
    if (!autoChaosActive) return;
    await fireAutoChaos();
    scheduleNextAutoChaos(AUTO_CHAOS_INTERVAL);
  }, seconds * 1000);
}

function updateCountdownUI(remaining) {
  const bar = document.getElementById('countdown-bar');
  const text = document.getElementById('countdown-text');
  if (!bar || !text) return;
  const pct = (remaining / AUTO_CHAOS_INTERVAL) * 100;
  bar.style.width = `${Math.max(0, pct)}%`;
  text.textContent = `Next chaos in ${Math.max(0, remaining)}s`;
}

async function fireAutoChaos() {
  // Pick only nodes that are actually online
  const liveNodes = NODES.filter(n => latestStatuses[n.port]);
  if (liveNodes.length === 0) {
    appendEventLog('⚡ AUTO-CHAOS: No live nodes available — skipping', 'ev-chaos');
    return;
  }

  const target = liveNodes[Math.floor(Math.random() * liveNodes.length)];
  const s = latestStatuses[target.port];

  // Smart action selection: don't heal a normal node, don't kill an already-dead
  let availableActions = [];
  if (s.chaos !== 'none') {
    availableActions = ['heal']; // always offer to heal chaotic nodes
  } else {
    availableActions = ['partition', 'slowdown', 'kill'];
  }
  // Ensure at least 3 nodes stay alive (don't kill if we're at quorum edge)
  const onlineCount = NODES.filter(n => latestStatuses[n.port]).length;
  if (onlineCount <= 3) {
    // Remove kill from options to preserve quorum
    availableActions = availableActions.filter(a => a !== 'kill');
    if (availableActions.length === 0) availableActions = ['heal'];
  }

  const action = availableActions[Math.floor(Math.random() * availableActions.length)];

  appendEventLog(`⚡ AUTO-CHAOS → Replica ${target.id} :${target.port} → ${action}`, 'ev-chaos');
  await sendChaos(target.port, action);
}

// ─── Event Log ────────────────────────────────────────────────────────────────
function appendEventLog(msg, cls = '') {
  const log = document.getElementById('event-log');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = msg;
  log.appendChild(div);
  // Cap log length
  while (log.children.length > 300) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function ingestNodeEvents(statuses) {
  NODES.forEach(node => {
    const s = statuses[node.port];
    if (!s || !s.events) return;
    s.events.forEach(ev => {
      const key = `${node.port}:${ev}`;
      if (seenEvents.has(key)) return;
      seenEvents.add(key);

      let cls = '';
      const lc = ev.toLowerCase();
      if (lc.includes('leader'))                                      cls = 'ev-leader';
      else if (lc.includes('elect') || lc.includes('candidate'))      cls = 'ev-election';
      else if (lc.includes('chaos') || lc.includes('kill') || lc.includes('partition')) cls = 'ev-chaos';
      else if (lc.includes('heal'))                                   cls = 'ev-heal';
      else if (lc.includes('vote'))                                   cls = 'ev-vote';
      else if (lc.includes('sync'))                                   cls = 'ev-sync';

      appendEventLog(ev, cls);
    });
  });
}

// ─── Cluster Health Badge ─────────────────────────────────────────────────────
function updateHealthBadge(statuses) {
  const badge    = document.getElementById('cluster-health');
  const navBadge = document.getElementById('cluster-health-nav');
  const online  = NODES.filter(n => statuses[n.port] && statuses[n.port].state !== 'Offline').length;
  const leaders = NODES.filter(n => statuses[n.port] && statuses[n.port].state === 'Leader').length;

  let text, color, navBg, navBorder;
  if (leaders === 1 && online >= 3) {
    text = '● Healthy'; color = '#22c55e';
    navBg = 'rgba(34,197,94,0.1)'; navBorder = 'rgba(34,197,94,0.25)';
  } else if (online >= 3) {
    text = '◉ Electing'; color = '#f59e0b';
    navBg = 'rgba(245,158,11,0.1)'; navBorder = 'rgba(245,158,11,0.25)';
  } else {
    text = '✕ Degraded'; color = '#ef4444';
    navBg = 'rgba(239,68,68,0.1)'; navBorder = 'rgba(239,68,68,0.25)';
  }

  if (badge) { badge.textContent = text; badge.style.color = color; }
  if (navBadge) {
    navBadge.textContent = text;
    navBadge.style.color = color;
    navBadge.style.background = navBg;
    navBadge.style.borderColor = navBorder;
  }
}

// ─── Poll ─────────────────────────────────────────────────────────────────────
async function poll() {
  const statuses = {};
  await Promise.all(NODES.map(async node => {
    try {
      const res = await fetch(`http://localhost:${node.port}/status`, { signal: AbortSignal.timeout(800) });
      if (res.ok) statuses[node.port] = await res.json();
    } catch (_) {
      // Node is offline — leave statuses[node.port] undefined
    }
  }));

  latestStatuses = statuses;
  renderNodeCards(statuses);
  updateTopology(statuses);
  updateChaosControls(statuses);
  ingestNodeEvents(statuses);
  updateHealthBadge(statuses);

  // Keep boards tab in sync if it's currently active
  if (document.getElementById('view-boards').classList.contains('active')) {
    renderBoards(statuses);
  }
}

// ─── BOARDS TAB ───────────────────────────────────────────────────────────────

// Each node canvas stores its strokes so we can replay them on re-render
const boardStrokes = {}; // port → array of stroke objects
NODES.forEach(n => { boardStrokes[n.port] = []; });

// Listen on the gateway WebSocket and replicate strokes to board canvases too
// We tap into canvas.js's drawLine via a shared hook
window.onBoardStroke = function(stroke) {
  NODES.forEach(node => {
    boardStrokes[node.port].push(stroke);
    drawOnBoard(node.port, stroke);
  });
};

function drawOnBoard(port, stroke) {
  const canvas = document.getElementById(`board-canvas-${port}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.moveTo(stroke.x0, stroke.y0);
  ctx.lineTo(stroke.x1, stroke.y1);
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.closePath();
}

function replayBoardStrokes(port) {
  const canvas = document.getElementById(`board-canvas-${port}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  boardStrokes[port].forEach(s => drawOnBoard(port, s));
}

function renderBoards(statuses) {
  const grid = document.getElementById('boards-grid');
  const statusEl = document.getElementById('boards-cluster-status');
  
  const urlParams = new URLSearchParams(window.location.search);
  const isolatedNodeId = urlParams.get('node');

  // Update cluster status strip
  const onlinePorts = NODES.filter(n => statuses[n.port]).length;
  const leaderNode  = NODES.find(n => statuses[n.port] && statuses[n.port].state === 'Leader');
  if (statusEl) {
    statusEl.textContent = leaderNode
      ? `Leader: Replica ${leaderNode.id} | ${onlinePorts}/5 nodes online`
      : `No leader | ${onlinePorts}/5 nodes online`;
  }

  NODES.forEach(node => {
    const s = statuses[node.port];
    const state = s ? s.state : 'Offline';
    const chaos = s ? s.chaos : 'none';
    const term  = s ? s.current_term : '—';
    const logs  = s ? s.log_size : '—';
    const isOffline = !s;
    const isLeader  = state === 'Leader';

    if (isolatedNodeId && node.id.toString() !== isolatedNodeId) {
      const existing = document.getElementById(`board-card-${node.port}`);
      if (existing) existing.remove();
      return;
    }

    let card = document.getElementById(`board-card-${node.port}`);
    const isNew = !card;

    if (isNew) {
      card = document.createElement('div');
      card.id = `board-card-${node.port}`;
      if (isolatedNodeId) {
        card.style.height = '100vh';
        card.style.border = 'none';
        card.style.borderRadius = '0';
      }
      grid.appendChild(card);
    }

    // Determine classes
    let cardClass = 'board-card';
    if (isLeader)              cardClass += ' board-leader';
    if (isOffline)             cardClass += ' board-offline';
    if (chaos === 'partition') cardClass += ' board-chaos-partition';
    if (chaos === 'slowdown')  cardClass += ' board-chaos-slowdown';
    card.className = cardClass;

    const stateColor = isOffline ? '#ef4444'
      : chaos === 'partition' ? '#ef4444'
      : chaos === 'slowdown'  ? '#f59e0b'
      : STATE_COLOR[state] || STATE_COLOR.Offline;

    const pillClass = `board-state-pill pill-${state}`;
    const syncBadge = isLeader ? '<span class="board-sync-badge synced">✓ Source</span>'
      : isOffline ? ''
      : `<span class="board-sync-badge ${logs !== '—' ? 'synced' : 'stale'}">Log ${logs}</span>`;

    const overlayHidden = isOffline ? '' : 'hidden';
    const overlayText = chaos === 'partition' ? '🔴 Partitioned'
      : chaos === 'slowdown' ? '🟡 Slowed Down'
      : '💀 Offline / Restarting';

    const chaosLabel = chaos !== 'none'
      ? `<span style="font-size:9px;color:${stateColor};font-family:var(--font-mono)">⚡ ${chaos}</span>`
      : `<span style="font-size:9px;color:var(--muted);font-family:var(--font-mono)">Term ${term}</span>`;

    // Footer action buttons
    let footerActions = '';
    if (!isOffline) {
      if (chaos !== 'none') {
        footerActions += `<button class="btn-board-action btn-heal" onclick="sendChaos(${node.port},'heal')">🟢 Heal</button>`;
      } else {
        footerActions += `<button class="btn-board-action" onclick="sendChaos(${node.port},'partition')">Partition</button>`;
        footerActions += `<button class="btn-board-action btn-kill" onclick="sendChaos(${node.port},'kill')">Kill</button>`;
      }
    }

    card.innerHTML = `
      <div class="board-card-header">
        <div class="board-card-title">
          <span class="board-node-name" style="color:${stateColor}">
            ${isLeader ? '👑 ' : ''}Replica ${node.id}
          </span>
          <span class="${pillClass}">${state}</span>
        </div>
        <div class="board-card-meta">
          ${chaosLabel}
        </div>
      </div>
      <div class="board-canvas-wrap" style="${isolatedNodeId ? 'flex: 1; aspect-ratio: auto;' : ''}">
        <canvas id="board-canvas-${node.port}" class="board-canvas"></canvas>
        ${syncBadge}
        <div class="board-overlay ${overlayHidden}">
          ${overlayText}
        </div>
      </div>
      <div class="board-card-footer">
        <span>:${node.port} — Log size: <strong style="color:var(--text)">${logs}</strong></span>
        <div class="board-footer-actions">${footerActions}</div>
      </div>
    `;

    // Set canvas dimensions and replay strokes
    const canvas = document.getElementById(`board-canvas-${node.port}`);
    if (canvas) {
      const wrap = canvas.parentElement;
      canvas.width  = wrap.clientWidth  || 400;
      canvas.height = wrap.clientHeight || 300;
      replayBoardStrokes(node.port);
    }
  });
}

function clearAllBoards() {
  NODES.forEach(node => {
    boardStrokes[node.port] = [];
    const canvas = document.getElementById(`board-canvas-${node.port}`);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const isolatedNodeId = urlParams.get('node');

if (isolatedNodeId) {
  // Hide UI elements not needed for isolated view
  const nav = document.getElementById('tab-nav');
  if (nav) nav.style.display = 'none';
  const header = document.querySelector('.boards-header');
  if (header) header.style.display = 'none';
  
  // Force active tab to boards
  document.getElementById('view-dashboard').classList.remove('active');
  document.getElementById('view-boards').classList.add('active');
  
  // Adjust grid for full screen
  const grid = document.getElementById('boards-grid');
  if (grid) {
    grid.style.padding = '0';
    grid.style.display = 'block'; // remove grid layout to fill screen
  }
}

initTopology();
initChaosControls();
setInterval(poll, 500);
poll();
