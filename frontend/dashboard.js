// ─── Config ──────────────────────────────────────────────────────────────────
const NODES = [
  { id: 1, port: 8081, label: 'R1' },
  { id: 2, port: 8082, label: 'R2' },
  { id: 3, port: 8083, label: 'R3' },
  { id: 4, port: 8084, label: 'R4' },
  { id: 5, port: 8085, label: 'R5' },
];

const STATE_COLOR = {
  Leader:    '#3fb950',
  Follower:  '#58a6ff',
  Candidate: '#d29922',
  Offline:   '#f85149',
};

let prevStates = {};  // port → last known state string (for change detection)
const seenEvents = new Set(); // deduplicate event log entries

// ─── Topology SVG ─────────────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('topology-svg');
const CX = 130, CY = 130, R = 95; // centre + orbit radius

function topoPos(i, total) {
  const angle = (2 * Math.PI * i / total) - Math.PI / 2;
  return { x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle) };
}

function initTopology() {
  svg.innerHTML = '';

  // draw edges between every pair
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

  // draw node circles + labels
  NODES.forEach((node, i) => {
    const pos = topoPos(i, NODES.length);
    const g = document.createElementNS(SVG_NS, 'g');

    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y);
    circle.setAttribute('r', 18);
    circle.setAttribute('fill', '#161b22');
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
    const color = chaos === 'partition' ? '#f85149'
                : chaos === 'slowdown'  ? '#d29922'
                : STATE_COLOR[state] || STATE_COLOR.Offline;

    const circle = document.getElementById(`topo-c-${node.port}`);
    const label  = document.getElementById(`topo-l-${node.port}`);
    if (!circle) return;

    circle.setAttribute('stroke', color);
    circle.setAttribute('fill', state === 'Leader' ? 'rgba(63,185,80,0.15)' : '#161b22');
    // pulse effect for leader
    if (state === 'Leader') {
      circle.setAttribute('r', 20);
    } else {
      circle.setAttribute('r', 18);
    }
    if (label) {
      label.setAttribute('fill', color);
      label.textContent = state === 'Leader' ? '👑' : node.label;
    }
  });

  // dim edges that involve a partitioned node
  for (let i = 0; i < NODES.length; i++) {
    for (let j = i + 1; j < NODES.length; j++) {
      const si = statuses[NODES[i].port];
      const sj = statuses[NODES[j].port];
      const partitioned = (si && si.chaos === 'partition') || (sj && sj.chaos === 'partition');
      const offline = (!si || si.state === 'Offline') || (!sj || sj.state === 'Offline');
      const edge = document.getElementById(`edge-${NODES[i].id}-${NODES[j].id}`);
      if (edge) {
        edge.setAttribute('stroke', (partitioned || offline) ? '#3a1515' : '#30363d');
        edge.setAttribute('stroke-dasharray', partitioned ? '4 3' : 'none');
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
      ? `<span style="font-size:10px;color:${chaos==='partition'?'#f85149':'#d29922'}">⚡ ${chaos}</span>`
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
    row.innerHTML = `
      <span class="chaos-label">Replica ${node.id}</span>
      <button class="chaos-btn btn-partition" onclick="sendChaos(${node.port},'partition')">Partition</button>
      <button class="chaos-btn btn-slowdown"  onclick="sendChaos(${node.port},'slowdown')">Slow</button>
      <button class="chaos-btn btn-heal"      onclick="sendChaos(${node.port},'heal')">Heal</button>
      <button class="chaos-btn btn-kill"      onclick="sendChaos(${node.port},'kill')">Kill</button>
    `;
    container.appendChild(row);
  });
}

async function sendChaos(port, action) {
  const actionLabels = { partition:'🔴 Partitioned','slowdown':'🟡 Slowed','heal':'🟢 Healed','kill':'💀 Killed' };
  appendEventLog(`Sending ${action} to Replica port ${port}…`, 'ev-chaos');
  try {
    const res = await fetch(`http://localhost:${port}/chaos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    if (res.ok) {
      appendEventLog(`✔ Replica :${port} → ${actionLabels[action]||action}`, action==='heal'?'ev-heal':'ev-chaos');
    } else {
      appendEventLog(`✘ Replica :${port} returned ${res.status}`, 'ev-chaos');
    }
  } catch (e) {
    appendEventLog(`✘ Could not reach Replica :${port} (already dead?)`, 'ev-chaos');
  }
}

// ─── Event Log ────────────────────────────────────────────────────────────────
function appendEventLog(msg, cls = '') {
  const log = document.getElementById('event-log');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = msg;
  log.appendChild(div);
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
      if (lc.includes('leader'))    cls = 'ev-leader';
      else if (lc.includes('elect') || lc.includes('candidate')) cls = 'ev-election';
      else if (lc.includes('chaos') || lc.includes('kill') || lc.includes('partition')) cls = 'ev-chaos';
      else if (lc.includes('heal')) cls = 'ev-heal';
      else if (lc.includes('vote')) cls = 'ev-vote';
      else if (lc.includes('sync')) cls = 'ev-sync';

      appendEventLog(ev, cls);
    });
  });
}

// ─── Cluster Health Badge ─────────────────────────────────────────────────────
function updateHealthBadge(statuses) {
  const badge = document.getElementById('cluster-health');
  const online = NODES.filter(n => statuses[n.port] && statuses[n.port].state !== 'Offline').length;
  const leaders = NODES.filter(n => statuses[n.port] && statuses[n.port].state === 'Leader').length;
  if (leaders === 1 && online >= 3) {
    badge.textContent = '● Healthy'; badge.style.color = '#3fb950';
  } else if (online >= 3) {
    badge.textContent = '◉ Electing'; badge.style.color = '#d29922';
  } else {
    badge.textContent = '✕ Degraded'; badge.style.color = '#f85149';
  }
}

// ─── Poll ─────────────────────────────────────────────────────────────────────
async function poll() {
  const statuses = {};
  await Promise.all(NODES.map(async node => {
    try {
      const res = await fetch(`http://localhost:${node.port}/status`);
      if (res.ok) statuses[node.port] = await res.json();
    } catch (_) {}
  }));

  renderNodeCards(statuses);
  updateTopology(statuses);
  ingestNodeEvents(statuses);
  updateHealthBadge(statuses);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
initTopology();
initChaosControls();
setInterval(poll, 500);
poll();
