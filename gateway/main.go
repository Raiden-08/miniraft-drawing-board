package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

var (
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true }, // Allow all origins for the frontend
	}
	clients   = make(map[*websocket.Conn]bool)
	clientsMu sync.Mutex
	replicas  []string
	
	currentLeader   string
	currentLeaderMu sync.RWMutex
)

// Stroke represents a line drawn on the canvas
type Stroke struct {
	X0    float64 `json:"x0"`
	Y0    float64 `json:"y0"`
	X1    float64 `json:"x1"`
	Y1    float64 `json:"y1"`
	Color string  `json:"color"`
}

func main() {
	port := os.Getenv("PORT")
	replicasEnv := os.Getenv("REPLICAS")
	replicas = strings.Split(replicasEnv, ",")

	log.Printf("Starting Gateway on port %s...", port)

	// Endpoint for the browser to connect via WebSocket
	http.HandleFunc("/ws", handleWebSocket)

	// Endpoint for the RAFT Leader to push committed strokes back to the gateway
	http.HandleFunc("/broadcast", handleLeaderBroadcast)

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Gateway failed: %v", err)
	}
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer ws.Close()

	clientsMu.Lock()
	clients[ws] = true
	clientsMu.Unlock()

	log.Println("New browser client connected!")

	for {
		var stroke Stroke
		err := ws.ReadJSON(&stroke)
		if err != nil {
			log.Printf("Client disconnected: %v", err)
			clientsMu.Lock()
			delete(clients, ws)
			clientsMu.Unlock()
			break
		}

		// When a client draws, forward it to the cluster asynchronously 
		// so we don't block the WebSocket reading loop during consensus delays.
		go forwardToLeader(stroke)
	}
}

func forwardToLeader(stroke Stroke) {
	payload, _ := json.Marshal(stroke)
	
	currentLeaderMu.RLock()
	leader := currentLeader
	currentLeaderMu.RUnlock()

	// 1. If we have a cached leader, try sending to it first
	if leader != "" {
		log.Printf("GATEWAY: Sending stroke to cached leader %s", leader)
		resp, err := http.Post("http://"+leader+"/append-entries", "application/json", bytes.NewBuffer(payload))
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				log.Printf("GATEWAY: Cached leader accepted stroke")
				return // Success!
			}
			log.Printf("GATEWAY: Cached leader returned status %d", resp.StatusCode)
		} else {
			log.Printf("GATEWAY: Post to cached leader failed: %v", err)
		}
		// If it failed, the leader might have died or stepped down. Clear the cache.
		currentLeaderMu.Lock()
		if currentLeader == leader {
			currentLeader = ""
		}
		currentLeaderMu.Unlock()
	}

	// 2. Try to find the leader and send the stroke to them
	for _, replicaAddr := range replicas {
		resp, err := http.Get("http://" + replicaAddr + "/status")
		if err != nil {
			continue // Node is dead, skip
		}
		
		var status map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&status)
		resp.Body.Close()

		if status["state"] == "Leader" {
			log.Printf("GATEWAY: Discovered new leader %s", replicaAddr)
			currentLeaderMu.Lock()
			currentLeader = replicaAddr
			currentLeaderMu.Unlock()

			// Found the leader! Forward the stroke to /append-entries
			postResp, postErr := http.Post("http://"+replicaAddr+"/append-entries", "application/json", bytes.NewBuffer(payload))
			if postErr != nil {
				log.Printf("GATEWAY: Post to newly discovered leader failed: %v", postErr)
			} else {
				log.Printf("GATEWAY: Newly discovered leader responded %d", postResp.StatusCode)
				postResp.Body.Close()
			}
			return
		}
	}
	log.Println("GATEWAY: Warning: Could not find an active leader to accept the stroke.")
}

func handleLeaderBroadcast(w http.ResponseWriter, r *http.Request) {
	// The leader calls this once a majority of nodes have saved the stroke
	body, _ := io.ReadAll(r.Body)
	
	clientsMu.Lock()
	defer clientsMu.Unlock()

	// Blast the committed stroke to all connected browsers
	for client := range clients {
		err := client.WriteMessage(websocket.TextMessage, body)
		if err != nil {
			client.Close()
			delete(clients, client)
		}
	}
	w.WriteHeader(http.StatusOK)
}