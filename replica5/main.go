package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	id := os.Getenv("REPLICA_ID")
	port := os.Getenv("PORT")
	peersEnv := os.Getenv("PEERS")

	var peers []string
	if peersEnv != "" {
		peers = strings.Split(peersEnv, ",")
	}

	if id == "" || port == "" {
		log.Fatal("REPLICA_ID and PORT environment variables are required")
	}

	log.Printf("Starting Replica %s on port %s with %d peers...", id, port, len(peers))

	time.Sleep(6 * time.Second)

	node := NewRaftNode(id, peers)
	go node.Start()

	http.HandleFunc("/request-vote", node.HandleRequestVote)
	http.HandleFunc("/append-entries", node.HandleAppendEntries)
	http.HandleFunc("/heartbeat", node.HandleHeartbeat)
	http.HandleFunc("/sync-log", node.HandleSyncLog)
	http.HandleFunc("/chaos", node.HandleChaos)

	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		status := node.GetStatus()
		json.NewEncoder(w).Encode(status)
	})

	addr := fmt.Sprintf(":%s", port)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}
