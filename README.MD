# 🎨 Mini-RAFT Distributed Drawing Board

A real-time collaborative drawing board built to demonstrate the **Raft Consensus Algorithm** in action. When you draw a stroke on the canvas, it goes through a full distributed consensus cycle — the leader replicates the stroke to a majority of nodes before it's committed and broadcast back to all browsers. If the leader node dies, the remaining nodes automatically elect a new leader and the system keeps running.

---

## 🏗️ Architecture Overview

```
Browser (Frontend)
     │  WebSocket
     ▼
┌──────────┐
│ Gateway  │  ← Go HTTP server (port 8080)
│ :8080    │    Routes strokes to the Leader
└──────────┘
     │  HTTP
     ▼
┌─────────────────────────────────────┐
│           Raft Cluster              │
│                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Replica1 │  │ Replica2 │  │ Replica3 │  │
│  │  :8081   │  │  :8082   │  │  :8083   │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│         One of these is the Leader          │
└─────────────────────────────────────┘
```

| Component     | Port  | Role                                                      |
|---------------|-------|-----------------------------------------------------------|
| **Gateway**   | 8080  | WebSocket hub for browsers; routes strokes to the leader  |
| **Replica 1** | 8081  | Raft node — can be Follower, Candidate, or Leader         |
| **Replica 2** | 8082  | Raft node — can be Follower, Candidate, or Leader         |
| **Replica 3** | 8083  | Raft node — can be Follower, Candidate, or Leader         |

---

## ⚙️ How Raft Consensus Works Here

### 1. Leader Election

Every replica starts as a **Follower** with a randomised election timeout (500–800 ms). If a follower doesn't receive a heartbeat within that window, it promotes itself to **Candidate**, increments its term, and broadcasts a `/request-vote` RPC to its peers. The first candidate to collect votes from a **majority (≥ 2 of 3)** becomes the new **Leader**.

```
Follower  ──(timeout)──►  Candidate  ──(majority votes)──►  Leader
   ▲                           │
   └─────(higher term seen)────┘
```

### 2. Heartbeat & Log Replication

The Leader sends a `/heartbeat` every **150 ms** to all followers. Each heartbeat includes the leader's current `prevLogIndex`. If a follower's log is shorter than the leader's, it replies with `success: false` and its own `logLen`, triggering the **Catch-Up Protocol** (`/sync-log`).

When a user draws a stroke:

1. Browser → WebSocket → **Gateway**
2. Gateway forwards stroke to the Leader via `POST /append-entries`
3. Leader appends the entry to its own log
4. Leader replicates the entry to all followers in parallel
5. Once a **majority** (≥ 2 of 3) acknowledge, the entry is **committed**
6. Leader calls `POST gateway:8080/broadcast`
7. Gateway fans the committed stroke out to **all connected browsers** via WebSocket

### 3. Node Failure & Recovery

- **Leader dies** → followers time out, a new election begins, a new leader is elected within ~1 second
- **Follower dies & restarts** → its log is stale; next heartbeat from the leader detects the gap and `triggerSync` sends all missing entries via `/sync-log`

---

## 📁 Project Structure

```
miniraft-drawing-board/
├── docker-compose.yml          # Spins up all 4 services on a shared Docker network
│
├── gateway/
│   ├── main.go                 # WebSocket hub + leader-discovery + broadcast endpoint
│   ├── go.mod
│   ├── go.sum
│   └── .air.toml               # Hot-reload config (Air)
│
├── replica1/                   # All three replicas are identical in code
│   ├── main.go                 # HTTP server, env-config, registers RPC routes
│   ├── raft.go                 # Full Raft implementation (election, heartbeat, log, sync)
│   ├── go.mod
│   └── .air.toml
│
├── replica2/                   # Same as replica1
│   └── ...
│
├── replica3/                   # Same as replica1
│   └── ...
│
└── frontend/
    ├── index.html              # Single-page app shell
    ├── canvas.js               # Drawing logic + WebSocket client
    ├── dashboard.js            # Polls /status on each replica every 500 ms
    └── style.css               # UI styles
```

---

## 🚀 Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/install/) (v2+)
- A modern browser (Chrome / Firefox / Edge)

---

### Commands

#### Start the cluster

```bash
docker compose up --build
```

This builds and starts all four containers (`gateway`, `replica1`, `replica2`, `replica3`) connected on a shared `raft-net` bridge network. Hot-reload (Air) is enabled inside every container, so editing any `.go` file triggers an automatic rebuild.

#### Open the frontend

The frontend is a static HTML file — just open it directly in your browser:

```bash
# macOS
open frontend/index.html

# Linux
xdg-open frontend/index.html

# Windows (PowerShell)
Start-Process frontend/index.html
```

Or drag `frontend/index.html` into any browser tab.

#### Stop the cluster

```bash
docker compose down
```

---

## 🔬 Simulating a Leader Failure

This is the main demo. Follow these steps:

**1. Watch the dashboard** — open `frontend/index.html` and observe which replica is the `Leader`.

**2. Kill the leader container:**

```bash
# If Replica 1 (port 8081) is the leader:
docker stop replica1

# If Replica 2 is the leader:
docker stop replica2

# If Replica 3 is the leader:
docker stop replica3
```

**3. Watch the dashboard** — within ~1 second the two surviving nodes hold an election and one becomes the new `Leader`.

**4. Keep drawing** — strokes continue to be committed by the new leader.

**5. Bring the dead node back:**

```bash
docker start replica1   # or replica2 / replica3
```

The restarted node rejoins as a Follower, detects its log is stale, and the leader automatically syncs all missing entries via the Catch-Up Protocol.

---

## 🔌 API Reference

### Replica endpoints (`:8081`, `:8082`, `:8083`)

| Method | Path              | Description                                             |
|--------|-------------------|---------------------------------------------------------|
| POST   | `/request-vote`   | Raft vote RPC — candidates ask peers for a vote         |
| POST   | `/heartbeat`      | Raft heartbeat RPC — leader keeps followers alive       |
| POST   | `/append-entries` | Accepts a new stroke (from gateway) **or** replicates it (from leader) |
| POST   | `/sync-log`       | Catch-up: leader sends missing log entries to a stale follower |
| GET    | `/status`         | Returns `{ id, state, current_term, log_size }` — used by the dashboard |

### Gateway endpoints (`:8080`)

| Method    | Path         | Description                                        |
|-----------|--------------|----------------------------------------------------|
| WebSocket | `/ws`        | Browser connects here to send/receive strokes      |
| POST      | `/broadcast` | Leader calls this once a stroke reaches consensus  |

---

## 🧠 Raft Implementation Details

| Parameter              | Value            |
|------------------------|------------------|
| Election timeout       | 500 – 800 ms (randomised) |
| Heartbeat interval     | 150 ms           |
| RPC HTTP timeout       | 50 ms (heartbeat/vote) |
| Quorum size (3 nodes)  | 2 nodes          |
| Log replication timeout | 500 ms          |

Key design decisions in `raft.go`:

- **Randomised timeouts** prevent split votes during elections.
- **Short HTTP client timeout (50 ms)** ensures a dead peer doesn't block the heartbeat loop.
- **`sync.Mutex` on all state** — every read/write of `CurrentTerm`, `State`, `VotedFor`, and `Log` is protected.
- **Catch-Up Protocol** — on heartbeat rejection, the leader calls `triggerSync` asynchronously to avoid blocking the 150 ms tick.
- **Gateway leader cache** — the gateway caches the last known leader address and tries it first before scanning all replicas, reducing discovery latency.

---

## 🛠️ Development Tips

### View live logs for a specific container

```bash
docker logs -f replica1
docker logs -f gateway
```

### Inspect a replica's status directly

```bash
curl http://localhost:8081/status
curl http://localhost:8082/status
curl http://localhost:8083/status
```

### Force a new election without stopping a container

Since all timeouts are randomised, simply pausing a container for ~1 second is enough:

```bash
docker pause replica1
sleep 1
docker unpause replica1
```

### Check which node is currently the leader

```bash
for port in 8081 8082 8083; do
  echo -n "replica $((port-8080)) (:$port) → "
  curl -s http://localhost:$port/status | python3 -m json.tool | grep state
done
```

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-change`
3. Commit your changes: `git commit -m "feat: describe your change"`
4. Push and open a Pull Request

---

## 📜 License

MIT