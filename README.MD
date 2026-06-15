# 🗳️ Mini-RAFT Drawing Board — v3 (All Boards + Auto-Chaos)

A hands-on implementation of the **Raft consensus algorithm**, built around a real-time collaborative drawing board. Every brush stroke is a distributed log entry — it only appears on screen once a majority of nodes agree it exists. The v3 upgrade adds an **All Boards** multi-canvas view, an **Auto-Chaos** engine, and an offline-node guard so chaos controls never fire against dead replicas.

**GitHub:** https://github.com/Raiden-08/miniraft-drawing-board

---

## Table of Contents

1. [What We Built](#1-what-we-built)
2. [Architecture](#2-architecture)
3. [How Raft Works in This Project](#3-how-raft-works-in-this-project)
4. [Chaos Monkey Engine](#4-chaos-monkey-engine)
5. [The Dashboard UI](#5-the-dashboard-ui)
6. [Project Structure](#6-project-structure)
7. [Getting Started](#7-getting-started)
8. [All Commands](#8-all-commands)
9. [API Reference](#9-api-reference)
10. [Raft Parameters](#10-raft-parameters)
11. [Transferring Context to an LLM](#11-transferring-context-to-an-llm)

---

## 1. What We Built

### v1 — Core Raft on a Drawing Board (3 nodes)

The first version proved the concept: a shared whiteboard where every stroke goes through a full consensus cycle before being rendered. The system was wired as:

- A **Go gateway** that accepts WebSocket connections from browsers and routes drawing strokes to whoever is currently the Raft leader.
- Three **Go replica nodes**, each running a from-scratch Raft state machine over plain HTTP RPCs.
- A vanilla JS **frontend** with a sidebar showing each node's term and role.

When you drew a line, it traveled: `browser → WebSocket → gateway → leader → replicate to 2 followers → commit → broadcast back to all browsers`. If the leader died, the two survivors elected a new one and the board kept working.

### v2 — 5 Nodes + Chaos Monkey + Live Visualizer

Built on top of v1 without breaking any existing behavior:

- **Scaled to 5 nodes** — quorum is now 3, so you can kill 2 nodes simultaneously and consensus still holds.
- **Chaos Monkey** — every replica exposes a `/chaos` HTTP endpoint (partition / slowdown / heal / kill). All controllable from the UI or `curl`.
- **Redesigned dashboard** — dark terminal aesthetic, SVG ring topology, color-coded event log, per-node chaos buttons.
- **`restart: on-failure`** in `docker-compose.yml` — killed nodes come back and re-sync automatically.

### v3 — All Boards View + Auto-Chaos + Offline Guard

Three quality-of-life upgrades on top of v2:

- **All Boards tab** — a dedicated page showing a live drawing canvas for every one of the 5 replicas side-by-side. Each board mirrors all committed strokes received over the WebSocket. The leader's board is highlighted with a 👑 and a `Source` badge; offline/partitioned boards show an overlay instead of buttons. Quick Heal/Kill shortcuts live in each board's footer.
- **Auto-Chaos engine** — a toggle button in the right panel fires a random chaos action every **15 seconds** automatically. It is quorum-aware: it will not kill a node if only 3 remain online, preventing a full cluster stall. A live countdown bar shows time until the next event.
- **Offline-node guard** — `sendChaos()` now checks the most recent `/status` poll before firing any HTTP request. If the target node is not in the live-status map (i.e. its container is down or restarting), the UI logs a warning and skips the network call entirely. This eliminates the `✘ Could not reach Replica :XXXX (already dead?)` error that occurred when trying to heal or kill a node whose Docker container had already exited.

---

## 2. Architecture

```
                        Browser
                           │
                    WebSocket /ws
                           │
              ┌────────────▼────────────┐
              │         Gateway         │
              │   Go HTTP server        │
              │   Port 8080             │
              │                         │
              │  · WebSocket hub        │
              │  · Leader discovery     │
              │  · Broadcast committed  │
              │    strokes back to      │
              │    all browsers         │
              └────────────┬────────────┘
                           │  HTTP POST /append-entries
                           ▼
              ┌────────────────────────────────────┐
              │           Raft Cluster             │
              │                                    │
              │  ┌────────┐      ┌────────┐        │
              │  │  R1    │◄────►│  R2    │        │
              │  │ :8081  │      │ :8082  │        │
              │  └───┬────┘      └───┬────┘        │
              │      │    ┌──────┐   │             │
              │      └───►│  R3  │◄──┘             │
              │           │:8083 │                 │
              │      ┌────┴──────┴────┐            │
              │  ┌───┴───┐       ┌───┴───┐         │
              │  │  R4   │◄─────►│  R5   │         │
              │  │ :8084 │       │ :8085 │         │
              │  └───────┘       └───────┘         │
              │                                    │
              │  Every node talks to every other.  │
              │  One is elected Leader.            │
              └────────────────────────────────────┘
```

| Service   | Port | Role |
|-----------|------|------|
| Gateway   | 8080 | WebSocket hub, leader proxy, broadcast endpoint |
| Replica 1 | 8081 | Raft node |
| Replica 2 | 8082 | Raft node |
| Replica 3 | 8083 | Raft node |
| Replica 4 | 8084 | Raft node |
| Replica 5 | 8085 | Raft node |

All six containers share a Docker bridge network called `raft-net`. They address each other by container name (e.g. `replica2:8082`). Only their ports are exposed to the host so the browser and `curl` can reach them.

---

## 3. How Raft Works in This Project

Raft is a consensus algorithm that ensures a cluster of nodes agrees on an ordered log of entries even when some nodes crash or become unreachable. This project implements the three core sub-problems: **leader election**, **log replication**, and **log catch-up after recovery**.

### 3.1 Leader Election

Every node starts as a **Follower** with a randomised election timeout between 500 ms and 800 ms. The randomisation is the key trick — it staggers timeouts so one node almost always fires first, avoiding split votes.

```
Follower ──(timeout, no heartbeat)──► Candidate
   ▲                                       │
   │  (higher term seen)                   │
   │                                       ▼
   └──────────────── Leader ◄── (majority votes)
```

When a follower times out:
1. It increments its `CurrentTerm`, votes for itself, transitions to `Candidate`.
2. It broadcasts `POST /request-vote` to all peers in parallel with its term number.
3. Each peer grants at most one vote per term — only if the candidate's term is current and the peer hasn't already voted.
4. If the candidate collects votes from **≥ 3 of 5 nodes** (a majority), it becomes **Leader** and immediately starts sending heartbeats to suppress new elections.
5. If it fails to reach majority (split vote or too many nodes down), it returns to **Follower** and waits for the next timeout.

### 3.2 Heartbeats

The leader sends `POST /heartbeat` to every follower every **150 ms**. Each heartbeat carries the leader's current `term` and `prevLogIndex`. A follower that receives a valid heartbeat resets its election timer. If the follower's log is shorter than the leader's, it replies `success: false`, triggering the catch-up protocol.

### 3.3 Log Replication — A Drawing Stroke

When a user draws a stroke on the canvas:

```
1.  Browser   ──WebSocket──►  Gateway
2.  Gateway   ──POST /append-entries──►  Leader
3.  Leader    appends entry to its own log
4.  Leader    ──POST /append-entries (with leaderId)──►  all 4 Followers  (parallel goroutines)
5.  Followers append the entry and reply 200 OK
6.  Leader    waits for majority (≥ 3) acknowledgements
7.  Leader    increments CommitIndex
8.  Leader    ──POST /broadcast──►  Gateway
9.  Gateway   ──WebSocket broadcast──►  all connected browsers
10. Stroke appears on every canvas
```

If the leader can't reach a majority (e.g. two nodes are dead or partitioned), the stroke is rejected and never rendered. This is Raft's core safety guarantee: no partial writes.

### 3.4 Log Catch-Up After Recovery

When a node restarts, its in-memory log is empty. The next heartbeat from the leader detects `prevLogIndex >= follower's logLen` and marks the reply `success: false`. The leader then calls `triggerSync` asynchronously, sending all missing entries via `POST /sync-log`. The recovered node appends them all and is fully caught up.

### 3.5 Term Numbers and Stepdown

Every message carries a `term`. If any node sees a term higher than its own, it immediately steps down to Follower and updates its term. This is how stale leaders (that were partitioned away) are safely deposed when they reconnect.

---

## 4. Chaos Monkey Engine

Every replica exposes `POST /chaos` with four actions:

| Action | What happens inside the Go process | Real-world analogy |
|--------|------------------------------------|--------------------|
| `partition` | Sets `chaosMode = "partition"`. All incoming RPC handlers return `503` immediately. The node's heartbeat channel stops receiving, its election timer fires, it tries to become candidate — but can't get votes. The rest of the cluster elects a new leader. | Network cable unplugged |
| `slowdown` | Sets `chaosMode = "slowdown"`. All incoming RPCs sleep 400 ms before processing. The 50 ms RPC timeout on peers means this node appears unreachable. | Saturated network / heavy packet loss |
| `heal` | Resets `chaosMode = "none"`. The node starts processing RPCs normally, receives the next heartbeat, resets its election timer, and rejoins as Follower. | Cable plugged back in |
| `kill` | Logs the event, returns 200, then calls `panic()` after 100 ms. Docker's `restart: on-failure` brings the container back in ~1 second with a clean in-memory state. Catch-up re-syncs the log. | `kill -9` on the process |

The chaos state is stored in a `sync.RWMutex`-protected field on `RaftNode`, safe to toggle at runtime. All transitions are emitted into the node's internal 100-entry event buffer which the dashboard polls and streams into the live event log.

---

## 5. The Dashboard UI

The frontend is a static three-column layout. No framework, no build step — just open `frontend/index.html` in a browser.

**Tab bar (top):**
- Switch between **Dashboard** and **All Boards** views. Cluster health badge visible on every tab.

**Left panel — Cluster (Dashboard tab):**
- SVG ring topology with all 5 nodes. Leader pulses larger with a 👑 emoji. Partitioned nodes turn red with dashed edges. Offline nodes dim.
- Per-node cards: role pill (Leader / Follower / Candidate / Offline), current term, log size, active chaos mode.
- Cluster health badge: `Healthy` (leader + quorum) → `Electing` (no leader) → `Degraded` (below quorum).

**Center — Canvas (Dashboard tab):**
- Drawing board. Every stroke goes through full consensus before rendering. WebSocket badge shows connection state and auto-reconnects on disconnect.

**Right panel — Chaos & Log (Dashboard tab):**
- **⚡ Auto-Chaos toggle** — enables automatic random chaos every 15 s with a live countdown bar. Quorum-safe (won't kill nodes when only 3 remain).
- Per-node buttons: `Part` / `Slow` / `Heal` / `Kill`. Offline nodes show a red `⬤ Offline / Restarting` badge instead of buttons — clicking is blocked.
- Live event log (color-coded), color picker, canvas clear.

**All Boards tab:**
- 2-column responsive grid showing a live canvas for each of the 5 replicas.
- Boards update in real time as strokes are committed and broadcast.
- Leader board highlighted in green with `✓ Source` badge.
- Partitioned / offline boards display a dark overlay with the chaos state.
- Per-board quick-action buttons (Heal / Kill / Partition) in the footer.

---

## 6. Project Structure

```
miniraft-drawing-board/
├── docker-compose.yml          # 6 services on raft-net bridge, restart: on-failure
│
├── gateway/
│   ├── main.go                 # WebSocket hub, leader-discovery cache, /broadcast
│   ├── go.mod                  # requires gorilla/websocket
│   ├── go.sum
│   └── .air.toml               # Hot-reload config
│
├── replica1/                   # All 5 replicas share identical code
│   ├── main.go                 # HTTP server, env config, route registration
│   ├── raft.go                 # Raft: election, heartbeat, replication,
│   │                           # catch-up, chaos engine, event log (566 lines)
│   ├── go.mod
│   └── .air.toml
│
├── replica2/ … replica5/       # Same files as replica1
│
└── frontend/
    ├── index.html              # Tab nav shell (Dashboard + All Boards tabs)
    ├── dashboard.js            # SVG topology, node cards, chaos controls,
    │                           # auto-chaos engine, boards grid, event log
    ├── canvas.js               # Drawing + WebSocket client, color picker,
    │                           # stroke mirror hook for boards tab
    └── style.css               # Dark Inter/Fira Code theme, CSS variables,
                                # board cards, auto-chaos countdown bar
```

Each replica is differentiated entirely by environment variables injected at runtime:

| Variable     | Example (replica 3)                                         |
|--------------|-------------------------------------------------------------|
| `REPLICA_ID` | `3`                                                         |
| `PORT`       | `8083`                                                      |
| `PEERS`      | `replica1:8081,replica2:8082,replica4:8084,replica5:8085`   |

---

## 7. Getting Started

**Prerequisites:** Docker + Docker Compose v2+, any modern browser.

```bash
# 1. Clone
git clone https://github.com/Raiden-08/miniraft-drawing-board.git
cd miniraft-drawing-board

# 2. Start the cluster
#    (first run: downloads golang:alpine, installs Air, builds all 6 services — ~2 min)
docker compose up --build

# 3. Open the frontend — no server needed, it's static HTML
open frontend/index.html          # macOS
xdg-open frontend/index.html      # Linux
start frontend/index.html         # Windows PowerShell
```

The dashboard polls all nodes immediately. Within a second you'll see one node turn green and show 👑 — that's your first elected leader.

---

## 8. All Commands

### Cluster lifecycle

```bash
# Start with live hot-reload on .go file saves
docker compose up --build

# Start in background
docker compose up --build -d

# Stop (keeps volumes)
docker compose down

# Full reset — remove containers, networks, cached layers
docker compose down --volumes --rmi local
```

### Watching elections

```bash
# Stream all container logs together (best for watching elections)
docker compose logs -f

# Stream a single node
docker logs -f replica1

# Snapshot every node's state right now
for port in 8081 8082 8083 8084 8085; do
  echo -n ":$port → "
  curl -s http://localhost:$port/status | python3 -c \
    "import sys,json; d=json.load(sys.stdin); \
     print(d['state'], '| term', d['current_term'], '| log', d['log_size'])"
done

# Live-watch term numbers increment during elections
watch -n 0.5 "for p in 8081 8082 8083 8084 8085; do \
  echo -n \":$p  \"; \
  curl -s http://localhost:\$p/status 2>/dev/null | \
  python3 -c \"import sys,json; d=json.load(sys.stdin); \
  print(d['state'].ljust(10), 'term', d['current_term'])\"; done"
```

### Chaos from the terminal

```bash
# Partition — node drops all RPCs; new election fires in ~800 ms
curl -X POST http://localhost:8081/chaos \
  -H "Content-Type: application/json" -d '{"action":"partition"}'

# Slowdown — 400 ms delay; heartbeat timeouts cause peers to treat it as dead
curl -X POST http://localhost:8082/chaos \
  -H "Content-Type: application/json" -d '{"action":"slowdown"}'

# Heal — restore to normal; node rejoins as Follower
curl -X POST http://localhost:8081/chaos \
  -H "Content-Type: application/json" -d '{"action":"heal"}'

# Kill — process panic, Docker restarts it, catch-up re-syncs log
curl -X POST http://localhost:8083/chaos \
  -H "Content-Type: application/json" -d '{"action":"kill"}'
```

### Multi-node failure scenarios

```bash
# Kill 2 nodes — quorum is still 3, cluster holds a leader
docker stop replica1 replica2

# Kill majority (3 nodes) — no quorum, cluster stalls, no leader elected
docker stop replica1 replica2 replica3

# Revive everything — catch-up re-syncs all stale logs automatically
docker start replica1 replica2 replica3

# Pause to trigger timeout without losing process state (gentler)
docker pause replica4 && sleep 1.2 && docker unpause replica4

# Partition whichever node is currently the leader
LEADER_PORT=$(for p in 8081 8082 8083 8084 8085; do
  curl -s http://localhost:$p/status 2>/dev/null | grep -q '"Leader"' && echo $p && break
done)
echo "Partitioning leader on :$LEADER_PORT"
curl -sX POST http://localhost:$LEADER_PORT/chaos \
  -H "Content-Type: application/json" -d '{"action":"partition"}'

# Chaos storm: slowdown 2 nodes simultaneously
curl -X POST http://localhost:8081/chaos -d '{"action":"slowdown"}' &
curl -X POST http://localhost:8082/chaos -d '{"action":"slowdown"}' &
wait
# Then heal them
curl -X POST http://localhost:8081/chaos -d '{"action":"heal"}'
curl -X POST http://localhost:8082/chaos -d '{"action":"heal"}'
```

### Inspecting internals

```bash
# Full JSON status including event log from one node
curl -s http://localhost:8081/status | python3 -m json.tool

# Just the last 5 events from a node
curl -s http://localhost:8082/status | python3 -c \
  "import sys,json; [print(e) for e in json.load(sys.stdin)['events'][-5:]]"

# Manually inject a stroke directly to the leader (bypasses WebSocket)
curl -X POST http://localhost:8081/append-entries \
  -H "Content-Type: application/json" \
  -d '{"x0":10,"y0":10,"x1":200,"y1":200,"color":"#ef4444"}'

# Check chaos state of all nodes
for port in 8081 8082 8083 8084 8085; do
  echo -n ":$port chaos → "
  curl -s http://localhost:$port/status | python3 -c \
    "import sys,json; print(json.load(sys.stdin)['chaos'])"
done
```

---

## 9. API Reference

### Replica endpoints (ports 8081–8085)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET`  | `/status` | — | Returns `{ id, state, current_term, log_size, chaos, events[] }` |
| `POST` | `/request-vote` | `{ term, candidateId }` | Raft vote RPC — candidates solicit votes from peers |
| `POST` | `/heartbeat` | `{ term, leaderId, prevLogIndex }` | Leader keepalive; followers reset their election timer |
| `POST` | `/append-entries` | stroke payload or `{ term, leaderId, prevLogIndex, entry }` | Dual-purpose: gateway sends raw strokes; leader replicates entries to followers |
| `POST` | `/sync-log` | `{ entries[] }` | Catch-up: leader pushes all missing log entries to a stale node |
| `POST` | `/chaos` | `{ action: "partition"\|"slowdown"\|"heal"\|"kill" }` | Chaos Monkey control |

### Gateway endpoints (port 8080)

| Method | Path | Description |
|--------|------|-------------|
| `WS`   | `/ws` | Browser WebSocket — send stroke JSON, receive committed stroke JSON |
| `POST` | `/broadcast` | Internal: leader calls this after commit; gateway fans out to all browsers |

---

## 10. Raft Parameters

| Parameter | Value | Location | Why |
|-----------|-------|----------|-----|
| Election timeout | 500–800 ms (random) | `raft.go · resetElectionTimeout` | Wide spread avoids split votes; fast enough for sub-second recovery |
| Heartbeat interval | 150 ms | `raft.go · runLeader` | Well under minimum timeout — followers never time out under a live leader |
| RPC client timeout | 50 ms | `raft.go · NewRaftNode` | Dead peer must not stall the heartbeat goroutine |
| Append-entries timeout | 500 ms | `raft.go · HandleAppendEntries` | Slow follower gets a fair window; still bounded |
| Chaos slowdown delay | 400 ms | `raft.go · applyIncomingChaos` | Exceeds the 50 ms RPC timeout — slowed node looks dead to peers |
| Event buffer size | 100 entries | `raft.go · logEvent` | Bounded memory; enough history for the dashboard |
| Quorum size (5 nodes) | 3 | `(len(peers)+1)/2 + 1` | Tolerates any 2 simultaneous failures |

---

## 11. Transferring Context to an LLM

When you start a new chat session and want to continue working on this project, giving the model structured context gets far better results than dumping raw code. Below are four approaches from lightest to heaviest.

---

### Option A — Minimal summary prompt (for quick questions)

Paste this at the top of your message, then ask your question:

```
Project: Mini-RAFT Drawing Board (Go + vanilla JS, Docker Compose)
Repo: https://github.com/Raiden-08/miniraft-drawing-board

Summary:
  A collaborative whiteboard where every brush stroke is a Raft log entry.
  5 Go replica nodes (ports 8081–8085) run a hand-rolled Raft state machine
  over HTTP RPCs. A Go gateway (port 8080) proxies WebSocket connections from
  browsers to the current leader. A Chaos Monkey engine (POST /chaos per node)
  supports: partition (drops all RPCs), slowdown (400 ms delay), heal, kill.
  The frontend has a live SVG ring topology, per-node chaos buttons, and a
  colour-coded event log. All 5 replicas share identical code, differentiated
  by REPLICA_ID / PORT / PEERS env vars.

Key files:
  replica1/raft.go     — full Raft (election, heartbeat, replication, sync, chaos)
  replica1/main.go     — HTTP server + route registration
  gateway/main.go      — WebSocket hub + leader-discovery cache + /broadcast
  frontend/dashboard.js — SVG topology, chaos controls, event log (polls /status)
  frontend/canvas.js   — drawing tool + WebSocket client
  docker-compose.yml   — 6 services on raft-net bridge, restart: on-failure

Tech stack: Go 1.24, gorilla/websocket, Air (hot-reload), Docker Compose v2

My question: <YOUR QUESTION HERE>
```

---

### Option B — Full code dump via shell script (for deep changes)

Run this in the project root to produce a single paste-ready file:

```bash
# Run from the project root — creates context.txt (~900 lines)
{
  echo "=== docker-compose.yml ==="
  cat docker-compose.yml
  echo ""

  for f in \
    gateway/main.go \
    gateway/go.mod \
    replica1/main.go \
    replica1/raft.go \
    replica1/go.mod \
    frontend/index.html \
    frontend/dashboard.js \
    frontend/canvas.js \
    frontend/style.css; do
    echo "=== $f ==="
    cat "$f"
    echo ""
  done
} > context.txt

wc -l context.txt
echo "Open context.txt and paste its contents into your LLM chat."
```

Then open a new chat with:

```
I'm going to paste my entire project. Read it fully before responding.
My question: <YOUR QUESTION HERE>

--- BEGIN PROJECT ---
<paste contents of context.txt here>
--- END PROJECT ---
```

---

### Option C — GitHub URL (for models with web access)

Claude, GPT-4o, and Gemini 1.5+ can fetch URLs directly. Just start your message with:

```
Read the full project at https://github.com/Raiden-08/miniraft-drawing-board
then help me with: <YOUR QUESTION HERE>
```

---

### Option D — Structured feature request (best format for new features)

When asking for new features or changes, this format produces the most precise output with minimal back-and-forth:

```
## Project context
<paste Option A block here>

## Current behavior
- 5 Raft nodes, quorum = 3
- Chaos Monkey: partition / slowdown / heal / kill via POST /chaos
- Frontend polls /status every 500 ms, renders SVG ring topology
- No persistence — log is in-memory, lost on kill/restart
- No authentication, no TLS

## What I want to add
<describe the feature clearly>

## Constraints
- Keep the same docker-compose structure (no new services unless essential)
- No new Go dependencies unless unavoidable
- Frontend must stay a single static HTML file (no npm/build step)
- Changes should be backward-compatible (existing /status, /chaos API unchanged)

## Files most likely to change
- replica1/raft.go
- frontend/dashboard.js
(list others if relevant)

## Output format I want
Show only the changed sections as diffs or clearly marked before/after blocks.
Do not reprint unchanged code.
```

---

### Suggested follow-up prompts

Copy any of these directly after providing context in Option A or B:

```bash
# Add disk persistence so nodes survive container restarts with their log intact
"Add log persistence to raft.go using a JSON file at /tmp/raft-log-{id}.json.
 Load it on startup if it exists. Append each new entry on commit.
 Show only the changed functions."

# Log compaction / snapshotting
"Implement basic snapshotting: when the log exceeds 50 entries, compact
 everything up to CommitIndex into a snapshot struct, truncate the log,
 and store the snapshot's last included term and index. Show the diff."

# Gateway retry queue during elections
"The gateway currently returns an error if no leader is found.
 Add a retry queue: hold strokes for up to 2 seconds, retry every 200 ms.
 If no leader is elected within 2 s, drop and return 503."

# Term history sparkline on each node card
"In dashboard.js, add a 60px wide inline SVG sparkline to each node card
 showing the last 20 term values. No external libraries."

# Pre-Vote optimization (prevents disruptive elections)
"Implement the Pre-Vote extension in raft.go: before incrementing CurrentTerm,
 a candidate first sends a pre-vote RPC to check if it can win. Only start a
 real election if a majority respond positively."

# Prometheus metrics endpoint
"Add GET /metrics to each replica returning Prometheus text format with:
 raft_current_term, raft_log_size,
 raft_state_info{state='Leader|Follower|Candidate'} 1,
 raft_chaos_active{mode='partition|slowdown|none'} 1."

# Second terminal tab showing real-time election race
"Add a second HTML page election-race.html that shows a horizontal
 bar race chart of each node's term number over time, updating every
 500 ms. Vanilla JS + inline SVG only."
```

---

*Built with Go 1.24 · gorilla/websocket · Air · Docker Compose v2 · vanilla JS*