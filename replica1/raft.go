package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"math/rand"
	"net/http"
	"sync"
	"time"
)

// --- Data Structures ---

type State string

const (
	Follower  State = "Follower"
	Candidate State = "Candidate"
	Leader    State = "Leader"
)

type LogEntry struct {
	Term    int         `json:"term"`
	Payload interface{} `json:"payload"`
}

type RequestVoteArgs struct {
	Term        int    `json:"term"`
	CandidateID string `json:"candidateId"`
}

type RequestVoteReply struct {
	Term        int  `json:"term"`
	VoteGranted bool `json:"voteGranted"`
}

type HeartbeatArgs struct {
	Term         int    `json:"term"`
	LeaderID     string `json:"leaderId"`
	PrevLogIndex int    `json:"prevLogIndex"`
}

type HeartbeatReply struct {
	Term    int  `json:"term"`
	Success bool `json:"success"`
	LogLen  int  `json:"logLen"`
}

// --- Core Node Logic ---

type RaftNode struct {
	mu sync.Mutex

	ID    string
	Peers []string
	State State

	CurrentTerm int
	VotedFor    string
	Log         []LogEntry

	CommitIndex int

	heartbeatChan   chan bool
	electionTimeout time.Duration
	httpClient      *http.Client
}

func NewRaftNode(id string, peers []string) *RaftNode {
	return &RaftNode{
		ID:            id,
		Peers:         peers,
		State:         Follower,
		CurrentTerm:   0,
		VotedFor:      "",
		Log:           make([]LogEntry, 0),
		heartbeatChan: make(chan bool),
		// Short timeout so a dead peer doesn't block the system
		httpClient: &http.Client{Timeout: 50 * time.Millisecond},
	}
}

func (rn *RaftNode) Start() {
	rn.resetElectionTimeout()
	for {
		rn.mu.Lock()
		state := rn.State
		rn.mu.Unlock()

		switch state {
		case Follower:
			rn.runFollower()
		case Candidate:
			rn.runCandidate()
		case Leader:
			rn.runLeader()
		}
	}
}

func (rn *RaftNode) resetElectionTimeout() {
	rn.electionTimeout = time.Duration(500+rand.Intn(300)) * time.Millisecond
}

func (rn *RaftNode) runFollower() {
	timeout := time.After(rn.electionTimeout)
	select {
	case <-rn.heartbeatChan:
		rn.resetElectionTimeout()
	case <-timeout:
		log.Printf("Node %s: Election timeout. Becoming Candidate.", rn.ID)
		rn.mu.Lock()
		rn.State = Candidate
		rn.mu.Unlock()
	}
}

func (rn *RaftNode) runCandidate() {
	rn.mu.Lock()
	rn.CurrentTerm++
	rn.VotedFor = rn.ID
	term := rn.CurrentTerm
	rn.mu.Unlock()

	log.Printf("Node %s: Starting election for term %d", rn.ID, term)

	votes := 1
	votesNeeded := (len(rn.Peers)+1)/2 + 1
	var voteMu sync.Mutex
	var wg sync.WaitGroup

	args := RequestVoteArgs{Term: term, CandidateID: rn.ID}

	for _, peer := range rn.Peers {
		wg.Add(1)
		go func(peerAddr string) {
			defer wg.Done()

			body, _ := json.Marshal(args)
			resp, err := rn.httpClient.Post("http://"+peerAddr+"/request-vote", "application/json", bytes.NewBuffer(body))
			if err != nil {
				return // Peer is likely dead
			}
			defer resp.Body.Close()

			var reply RequestVoteReply
			json.NewDecoder(resp.Body).Decode(&reply)

			rn.mu.Lock()
			defer rn.mu.Unlock()

			if reply.Term > rn.CurrentTerm {
				rn.State = Follower
				rn.CurrentTerm = reply.Term
				rn.VotedFor = ""
				return
			}

			if reply.VoteGranted {
				voteMu.Lock()
				votes++
				voteMu.Unlock()
			}
		}(peer)
	}

	wg.Wait()

	rn.mu.Lock()
	if rn.State == Candidate && votes >= votesNeeded {
		log.Printf("Node %s won election with %d votes! Becoming Leader.", rn.ID, votes)
		rn.State = Leader
	} else if rn.State == Candidate {
		rn.State = Follower
	}
	rn.mu.Unlock()
}

func (rn *RaftNode) runLeader() {
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()

	for {
		rn.mu.Lock()
		if rn.State != Leader {
			rn.mu.Unlock()
			return
		}
		term := rn.CurrentTerm
		prevLogIdx := len(rn.Log) - 1 // Send our log length so followers can check if they are behind
		rn.mu.Unlock()

		args := HeartbeatArgs{Term: term, LeaderID: rn.ID, PrevLogIndex: prevLogIdx}

		<-ticker.C
		for _, peer := range rn.Peers {
			go func(peerAddr string) {
				body, _ := json.Marshal(args)
				resp, err := rn.httpClient.Post("http://"+peerAddr+"/heartbeat", "application/json", bytes.NewBuffer(body))
				if err != nil {
					return
				}
				defer resp.Body.Close()

				var reply HeartbeatReply
				json.NewDecoder(resp.Body).Decode(&reply)

				rn.mu.Lock()
				if reply.Term > rn.CurrentTerm {
					log.Printf("Node %s stepping down. Found higher term %d", rn.ID, reply.Term)
					rn.State = Follower
					rn.CurrentTerm = reply.Term
					rn.VotedFor = ""
				} else if !reply.Success && reply.LogLen < len(rn.Log) {
					// Catch-Up Protocol: Follower rejected heartbeat because its log is too short.
					// Trigger sync asynchronously so we don't block the heartbeat loop.
					go rn.triggerSync(peerAddr, reply.LogLen)
				}
				rn.mu.Unlock()
			}(peer)
		}
	}
}

// triggerSync sends missing log entries to a node that just restarted
func (rn *RaftNode) triggerSync(peer string, followerLogLen int) {
	rn.mu.Lock()
	if followerLogLen >= len(rn.Log) {
		rn.mu.Unlock()
		return
	}
	// Grab all entries the follower is missing
	missingEntries := rn.Log[followerLogLen:]
	rn.mu.Unlock()

	body, _ := json.Marshal(map[string]interface{}{
		"entries": missingEntries,
	})
	http.Post("http://"+peer+"/sync-log", "application/json", bytes.NewBuffer(body))
}

// --- HTTP RPC Handlers ---

func (rn *RaftNode) HandleRequestVote(w http.ResponseWriter, r *http.Request) {
	var args RequestVoteArgs
	json.NewDecoder(r.Body).Decode(&args)

	rn.mu.Lock()
	defer rn.mu.Unlock()

	reply := RequestVoteReply{Term: rn.CurrentTerm, VoteGranted: false}

	if args.Term > rn.CurrentTerm {
		rn.CurrentTerm = args.Term
		rn.State = Follower
		rn.VotedFor = ""
	}

	if args.Term == rn.CurrentTerm && (rn.VotedFor == "" || rn.VotedFor == args.CandidateID) {
		rn.VotedFor = args.CandidateID
		reply.VoteGranted = true
		go func() { rn.heartbeatChan <- true }()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(reply)
}

func (rn *RaftNode) HandleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var args HeartbeatArgs
	json.NewDecoder(r.Body).Decode(&args)

	rn.mu.Lock()
	defer rn.mu.Unlock()

	// Respond with our current log length so the leader knows if we missed anything
	reply := HeartbeatReply{Term: rn.CurrentTerm, Success: false, LogLen: len(rn.Log)}

	if args.Term >= rn.CurrentTerm {
		rn.CurrentTerm = args.Term
		rn.State = Follower

		if args.PrevLogIndex >= len(rn.Log) {
			// Our log is too short (e.g. we just restarted). Reject success to trigger sync-log.
			reply.Success = false
		} else {
			reply.Success = true
		}

		select {
		case rn.heartbeatChan <- true:
		default:
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(reply)
}

func (rn *RaftNode) HandleAppendEntries(w http.ResponseWriter, r *http.Request) {
	bodyBytes, _ := io.ReadAll(r.Body)
	var data map[string]interface{}
	json.Unmarshal(bodyBytes, &data)

	if _, isFromLeader := data["leaderId"]; isFromLeader {
		// 1. We are a FOLLOWER receiving a replicated stroke from the LEADER
		rn.mu.Lock()
		defer rn.mu.Unlock()

		term := int(data["term"].(float64))
		if term >= rn.CurrentTerm {
			rn.CurrentTerm = term
			rn.State = Follower

			prevLogIndex := int(data["prevLogIndex"].(float64))
			if prevLogIndex > len(rn.Log)-1 {
				http.Error(w, "Log mismatch", http.StatusConflict)
				return // Reject. Heartbeat will trigger catchup
			}

			entryData := data["entry"].(map[string]interface{})
			rn.Log = append(rn.Log, LogEntry{
				Term:    int(entryData["term"].(float64)),
				Payload: entryData["payload"],
			})
			w.WriteHeader(http.StatusOK)
		} else {
			http.Error(w, "Stale term", http.StatusBadRequest)
		}
	} else {
		// 2. We are the LEADER receiving a brand new stroke from the GATEWAY
		rn.mu.Lock()
		if rn.State != Leader {
			rn.mu.Unlock()
			http.Error(w, "Not the leader", http.StatusBadRequest)
			return
		}

		entry := LogEntry{Term: rn.CurrentTerm, Payload: data}
		rn.Log = append(rn.Log, entry)
		logIndex := len(rn.Log) - 1
		currentTerm := rn.CurrentTerm
		leaderId := rn.ID
		rn.mu.Unlock()

		log.Printf("Node %s (Leader) saved stroke! Log size is now: %d", leaderId, logIndex+1)

		var wg sync.WaitGroup
		var successCount = 1 // Leader's own append
		var cntMu sync.Mutex

		payload := map[string]interface{}{
			"term":         currentTerm,
			"leaderId":     leaderId,
			"prevLogIndex": logIndex - 1,
			"entry":        entry,
		}
		payloadBytes, _ := json.Marshal(payload)

		appendClient := &http.Client{Timeout: 500 * time.Millisecond}

		for _, peer := range rn.Peers {
			wg.Add(1)
			go func(peerAddr string) {
				defer wg.Done()
				resp, err := appendClient.Post("http://"+peerAddr+"/append-entries", "application/json", bytes.NewBuffer(payloadBytes))
				if err == nil {
					defer resp.Body.Close()
					if resp.StatusCode == http.StatusOK {
						cntMu.Lock()
						successCount++
						cntMu.Unlock()
					}
				}
			}(peer)
		}

		// Wait to see if we reached majority
		wg.Wait()

		if successCount >= (len(rn.Peers)+1)/2+1 {
			rn.mu.Lock()
			if logIndex > rn.CommitIndex {
				rn.CommitIndex = logIndex
			}
			rn.mu.Unlock()

			// Broadcast it to the Gateway so all clients see it drawn instantly
			go http.Post("http://gateway:8080/broadcast", "application/json", bytes.NewBuffer(bodyBytes))
			w.WriteHeader(http.StatusOK)
		} else {
			log.Printf("Leader %s failed to reach consensus for stroke.", leaderId)
			http.Error(w, "Failed to reach quorum", http.StatusInternalServerError)
		}
	}
}

func (rn *RaftNode) HandleSyncLog(w http.ResponseWriter, r *http.Request) {
	var data struct {
		Entries []LogEntry `json:"entries"`
	}
	json.NewDecoder(r.Body).Decode(&data)

	rn.mu.Lock()
	defer rn.mu.Unlock()

	// Catch-Up Protocol: Append all the missing entries the leader just sent us
	rn.Log = append(rn.Log, data.Entries...)
	log.Printf("Node %s: Synced %d missing log entries from Leader", rn.ID, len(data.Entries))

	w.WriteHeader(http.StatusOK)
}

func (rn *RaftNode) GetStatus() map[string]interface{} {
	rn.mu.Lock()
	defer rn.mu.Unlock()
	return map[string]interface{}{
		"id":           rn.ID,
		"state":        rn.State,
		"current_term": rn.CurrentTerm,
		"log_size":     len(rn.Log),
	}
}
