package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"sync"
	"syscall"
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

// --- Chaos State ---

type ChaosMode string

const (
	ChaosNone      ChaosMode = "none"
	ChaosPartition ChaosMode = "partition" // drops all incoming RPCs
	ChaosSlowdown  ChaosMode = "slowdown"  // adds 400ms delay to RPCs
)

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

	// Chaos
	chaosMode    ChaosMode
	chaosMu      sync.RWMutex
	eventLog     []string
	eventLogMu   sync.Mutex
}

func NewRaftNode(id string, peers []string) *RaftNode {
	return &RaftNode{
		ID:            id,
		Peers:         peers,
		State:         Follower,
		CurrentTerm:   0,
		VotedFor:      "",
		Log:           make([]LogEntry, 0),
		heartbeatChan: make(chan bool, 1),
		chaosMode:     ChaosNone,
		eventLog:      make([]string, 0, 50),
		httpClient:    &http.Client{Timeout: 50 * time.Millisecond},
	}
}

func (rn *RaftNode) logEvent(msg string) {
	rn.eventLogMu.Lock()
	defer rn.eventLogMu.Unlock()
	ts := time.Now().Format("15:04:05.000")
	entry := "[" + ts + "] " + msg
	log.Println(entry)
	rn.eventLog = append(rn.eventLog, entry)
	// Keep last 100 events
	if len(rn.eventLog) > 100 {
		rn.eventLog = rn.eventLog[len(rn.eventLog)-100:]
	}
}

func (rn *RaftNode) isChaosActive(mode ChaosMode) bool {
	rn.chaosMu.RLock()
	defer rn.chaosMu.RUnlock()
	return rn.chaosMode == mode
}

func (rn *RaftNode) applyIncomingChaos() bool {
	rn.chaosMu.RLock()
	mode := rn.chaosMode
	rn.chaosMu.RUnlock()
	switch mode {
	case ChaosPartition:
		return false // drop the request
	case ChaosSlowdown:
		time.Sleep(400 * time.Millisecond)
		return true
	}
	return true
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
		rn.logEvent("Node " + rn.ID + ": Election timeout → becoming Candidate")
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

	rn.logEvent("Node " + rn.ID + ": Starting election for term " + itoa(term))

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
				return
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
		rn.logEvent("Node " + rn.ID + " WON election with " + itoa(votes) + " votes → Leader (term " + itoa(rn.CurrentTerm) + ")")
		rn.State = Leader
	} else if rn.State == Candidate {
		rn.logEvent("Node " + rn.ID + ": Election failed (got " + itoa(votes) + " votes) → back to Follower")
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
		prevLogIdx := len(rn.Log) - 1
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
					rn.logEvent("Node " + rn.ID + " stepping down — found higher term " + itoa(reply.Term))
					rn.State = Follower
					rn.CurrentTerm = reply.Term
					rn.VotedFor = ""
				} else if !reply.Success && reply.LogLen < len(rn.Log) {
					go rn.triggerSync(peerAddr, reply.LogLen)
				}
				rn.mu.Unlock()
			}(peer)
		}
	}
}

func (rn *RaftNode) triggerSync(peer string, followerLogLen int) {
	rn.mu.Lock()
	if followerLogLen >= len(rn.Log) {
		rn.mu.Unlock()
		return
	}
	missingEntries := rn.Log[followerLogLen:]
	rn.mu.Unlock()

	body, _ := json.Marshal(map[string]interface{}{
		"entries": missingEntries,
	})
	http.Post("http://"+peer+"/sync-log", "application/json", bytes.NewBuffer(body))
}

// --- HTTP RPC Handlers ---

func (rn *RaftNode) HandleRequestVote(w http.ResponseWriter, r *http.Request) {
	if !rn.applyIncomingChaos() {
		http.Error(w, "partitioned", http.StatusServiceUnavailable)
		return
	}

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
		rn.logEvent("Node " + rn.ID + " voted for " + args.CandidateID + " in term " + itoa(args.Term))
		go func() {
			select {
			case rn.heartbeatChan <- true:
			default:
			}
		}()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(reply)
}

func (rn *RaftNode) HandleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if !rn.applyIncomingChaos() {
		http.Error(w, "partitioned", http.StatusServiceUnavailable)
		return
	}

	var args HeartbeatArgs
	json.NewDecoder(r.Body).Decode(&args)

	rn.mu.Lock()
	defer rn.mu.Unlock()

	reply := HeartbeatReply{Term: rn.CurrentTerm, Success: false, LogLen: len(rn.Log)}

	if args.Term >= rn.CurrentTerm {
		rn.CurrentTerm = args.Term
		rn.State = Follower

		if args.PrevLogIndex >= len(rn.Log) {
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
	if !rn.applyIncomingChaos() {
		http.Error(w, "partitioned", http.StatusServiceUnavailable)
		return
	}

	bodyBytes, _ := io.ReadAll(r.Body)
	var data map[string]interface{}
	json.Unmarshal(bodyBytes, &data)

	if _, isFromLeader := data["leaderId"]; isFromLeader {
		rn.mu.Lock()
		defer rn.mu.Unlock()

		term := int(data["term"].(float64))
		if term >= rn.CurrentTerm {
			rn.CurrentTerm = term
			rn.State = Follower

			prevLogIndex := int(data["prevLogIndex"].(float64))
			if prevLogIndex > len(rn.Log)-1 {
				http.Error(w, "Log mismatch", http.StatusConflict)
				return
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
		leaderID := rn.ID
		rn.mu.Unlock()

		var wg sync.WaitGroup
		var successCount = 1
		var cntMu sync.Mutex

		payload := map[string]interface{}{
			"term":         currentTerm,
			"leaderId":     leaderID,
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

		wg.Wait()

		if successCount >= (len(rn.Peers)+1)/2+1 {
			rn.mu.Lock()
			if logIndex > rn.CommitIndex {
				rn.CommitIndex = logIndex
			}
			rn.mu.Unlock()

			go http.Post("http://gateway:8080/broadcast", "application/json", bytes.NewBuffer(bodyBytes))
			w.WriteHeader(http.StatusOK)
		} else {
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

	rn.Log = append(rn.Log, data.Entries...)
	rn.logEvent("Node " + rn.ID + ": Synced " + itoa(len(data.Entries)) + " missing entries from Leader")

	w.WriteHeader(http.StatusOK)
}

// --- Chaos Handler ---

func (rn *RaftNode) HandleChaos(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	var req struct {
		Action string `json:"action"` // "partition", "slowdown", "heal", "kill"
	}
	json.NewDecoder(r.Body).Decode(&req)

	rn.chaosMu.Lock()
	switch req.Action {
	case "partition":
		rn.chaosMode = ChaosPartition
		rn.logEvent("🔴 CHAOS: Node " + rn.ID + " PARTITIONED (dropping all RPCs)")
	case "slowdown":
		rn.chaosMode = ChaosSlowdown
		rn.logEvent("🟡 CHAOS: Node " + rn.ID + " SLOWED DOWN (400ms delay on RPCs)")
	case "heal":
		rn.chaosMode = ChaosNone
		rn.logEvent("🟢 CHAOS: Node " + rn.ID + " HEALED (back to normal)")
	case "kill":
		rn.logEvent("💀 CHAOS: Node " + rn.ID + " received KILL signal — exiting")
		rn.chaosMu.Unlock()
		w.WriteHeader(http.StatusOK)
		go func() {
			time.Sleep(100 * time.Millisecond)
			if p, err := os.FindProcess(1); err == nil {
				p.Signal(syscall.SIGABRT)
			}
			os.Exit(1)
		}()
		return
	}
	rn.chaosMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "action": req.Action})
}

func (rn *RaftNode) GetStatus() map[string]interface{} {
	rn.mu.Lock()
	state := rn.State
	term := rn.CurrentTerm
	logSize := len(rn.Log)
	rn.mu.Unlock()

	rn.chaosMu.RLock()
	chaos := string(rn.chaosMode)
	rn.chaosMu.RUnlock()

	rn.eventLogMu.Lock()
	events := make([]string, len(rn.eventLog))
	copy(events, rn.eventLog)
	rn.eventLogMu.Unlock()

	return map[string]interface{}{
		"id":           rn.ID,
		"state":        state,
		"current_term": term,
		"log_size":     logSize,
		"chaos":        chaos,
		"events":       events,
	}
}

// simple int-to-string without fmt import
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	buf := [20]byte{}
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
