package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
)

func main() {
	// 1. Read configuration from Docker environment
	id := os.Getenv("REPLICA_ID")
	port := os.Getenv("PORT")
	peersEnv := os.Getenv("PEERS")
	
	// Handle case where a node might not have peers (e.g., testing isolation)
	var peers []string
	if peersEnv != "" {
		peers = strings.Split(peersEnv, ",")
	}

	if id == "" || port == "" {
		log.Fatal("REPLICA_ID and PORT environment variables are required")
	}

	log.Printf("Starting Replica %s on port %s...", id, port)

	// 2. Initialize the Mini-RAFT node we built in raft.go
	node := NewRaftNode(id, peers)
	go node.Start() // Run the consensus loop in the background

	// 3. Define Internal RPC Endpoints for the Cluster
	http.HandleFunc("/request-vote", node.HandleRequestVote)
	http.HandleFunc("/append-entries", node.HandleAppendEntries)
	http.HandleFunc("/heartbeat", node.HandleHeartbeat)
	http.HandleFunc("/sync-log", node.HandleSyncLog)

	// 4. Define Dashboard Endpoint (For the frontend UI)
	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Allow CORS so the browser can fetch this data directly
		w.Header().Set("Access-Control-Allow-Origin", "*") 
		
		status := node.GetStatus()
		json.NewEncoder(w).Encode(status)
	})

	// 5. Start listening
	addr := fmt.Sprintf(":%s", port)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}