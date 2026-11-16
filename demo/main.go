// Command demo serves a local, visual walkthrough of Gemini API self-hosted
// environments running on Agent Substrate (ate-gemini) in a kind cluster.
//
// It is a small Backend-for-Frontend: the browser never sees GEMINI_API_KEY.
// The server
//   - proxies streaming Interactions API calls (POST /api/run),
//   - polls Substrate actors and WorkerPool pods via kubectl / kubectl-ate,
//   - tails the gemini-substrate-controller logs,
//
// and fans all of that out to the browser over Server-Sent Events.
package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed static
var staticFS embed.FS

type config struct {
	Addr        string
	KubeContext string
	Namespace   string
	Atespace    string
	Template    string
	Agent       string
	BaseURL     string
	apiKey      string
}

var (
	// Validation allow-lists for everything that reaches an exec sink or the
	// upstream API.
	envIDRe     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// Mirrors ate-gemini ActorName(): "<sanitized env id>-<16 hex>", with an
	// "env-" prefix only when the env ID doesn't start with a letter.
	actorNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	actorEnvRe  = regexp.MustCompile(`^(?:env-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f]{16}$`)

	// Controller log patterns (see ate-gemini controller / gemini-api poll).
	claimedRe    = regexp.MustCompile(`\[([^\]]+)\] Claimed interaction lease \(env=([0-9a-f-]+)\)`)
	dispatchedRe = regexp.MustCompile(`\[([^\]]+)\] Dispatched interaction lease for environment ([0-9a-f-]+)`)
	suspendedRe  = regexp.MustCompile(`msg="Suspended Substrate actor".*actor=(\S+)`)
)

// egressPresets are the only egress policies the UI may request. They are
// Substrate EgressPolicy rules passed through custom_config.egress_policy.
var egressPresets = map[string][]map[string]any{
	"default": nil, // Gemini API host only (ate-gemini default-deny).
	"dev": {
		{"tlsPassthrough": map[string]any{
			"hostnames": []string{
				"pypi.org", "files.pythonhosted.org",
				"github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com",
			},
			"ports": map[string]any{"all": map[string]any{}},
		}},
	},
}

func main() {
	var cfg config
	flag.StringVar(&cfg.Addr, "addr", "127.0.0.1:8765", "listen address (keep on loopback)")
	flag.StringVar(&cfg.KubeContext, "context", "kind-gemini-api", "kubeconfig context of the Substrate cluster")
	flag.StringVar(&cfg.Namespace, "namespace", "gemini-self-hosted", "Kubernetes namespace of the controller and WorkerPool")
	flag.StringVar(&cfg.Atespace, "atespace", "gemini-self-hosted", "Substrate atespace for actors")
	flag.StringVar(&cfg.Template, "template", "gemini-env-actor", "Substrate ActorTemplate name")
	flag.StringVar(&cfg.Agent, "agent", "antigravity-preview-05-2026", "Gemini agent to run")
	flag.StringVar(&cfg.BaseURL, "base-url", "https://generativelanguage.googleapis.com", "Gemini API base URL")
	flag.Parse()

	cfg.apiKey = strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	if cfg.apiKey == "" {
		log.Fatal("GEMINI_API_KEY must be set")
	}
	if !strings.HasPrefix(cfg.BaseURL, "https://") {
		log.Fatal("--base-url must use https")
	}
	if host, _, err := net.SplitHostPort(cfg.Addr); err != nil || !(host == "127.0.0.1" || host == "localhost" || host == "::1") {
		log.Fatal("--addr must be a loopback address")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	h := newHub()
	go pollCluster(ctx, cfg, h)
	go tailController(ctx, cfg, h)

	s := &server{cfg: cfg, hub: h, client: &http.Client{}}
	sub, _ := fs.Sub(staticFS, "static")

	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(sub))
	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/events", h.serveSSE)
	mux.HandleFunc("POST /api/run", s.handleRun)
	mux.HandleFunc("POST /api/suspend", s.handleSuspend)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	log.Printf("demo listening on http://%s (context=%s atespace=%s)", cfg.Addr, cfg.KubeContext, cfg.Atespace)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// TODO(security): This demo intentionally has no user authentication; it is
// a single-operator tool bound to loopback. Anyone with local access to the
// port can spend the configured Gemini API key and run code in Substrate
// actors. Put real authN/Z in front of it before exposing it anywhere else.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hdr := w.Header()
		hdr.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		hdr.Set("X-Content-Type-Options", "nosniff")
		hdr.Set("X-Frame-Options", "DENY")
		hdr.Set("Referrer-Policy", "no-referrer")
		hdr.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		hdr.Set("Cache-Control", "no-store")
		if r.Method == http.MethodPost {
			// CSRF defense: only same-origin fetches with our custom header and
			// a JSON body are accepted.
			if r.Header.Get("X-Demo-Request") != "1" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if o := r.Header.Get("Origin"); o != "" && o != "http://"+r.Host {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// SSE hub

type sseMsg struct {
	event string
	data  []byte
}

type hub struct {
	mu          sync.Mutex
	subs        map[chan sseMsg]struct{}
	lastCluster []byte
}

func newHub() *hub { return &hub{subs: make(map[chan sseMsg]struct{})} }

func (h *hub) publish(event string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if event == "cluster" {
		if bytes.Equal(data, h.lastCluster) {
			return
		}
		h.lastCluster = data
	}
	for ch := range h.subs {
		select {
		case ch <- sseMsg{event, data}:
		default: // slow consumer; drop
		}
	}
}

func (h *hub) serveSSE(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")

	ch := make(chan sseMsg, 256)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	last := h.lastCluster
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
	}()

	if last != nil {
		writeSSE(w, "cluster", last)
	}
	fl.Flush()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case m := <-ch:
			writeSSE(w, m.event, m.data)
			fl.Flush()
		case <-ping.C:
			io.WriteString(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func writeSSE(w io.Writer, event string, data []byte) {
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
}

// ---------------------------------------------------------------------------
// Cluster polling

type actorView struct {
	Name       string `json:"name"`
	EnvID      string `json:"envId"`
	State      string `json:"state"`
	WorkerPod  string `json:"workerPod,omitempty"`
	CreateTime string `json:"createTime"`
	UpdateTime string `json:"updateTime"`
}

type podView struct {
	Name     string `json:"name"`
	Phase    string `json:"phase"`
	Ready    bool   `json:"ready"`
	IP       string `json:"ip,omitempty"`
	Deleting bool   `json:"deleting,omitempty"`
}

type clusterView struct {
	Context    string      `json:"context"`
	Actors     []actorView `json:"actors"`
	Workers    []podView   `json:"workers"`
	Controller *podView    `json:"controller,omitempty"`
	Error      string      `json:"error,omitempty"`
}

func kubectl(ctx context.Context, cfg config, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	full := append([]string{"--context", cfg.KubeContext}, args...)
	if len(args) > 0 && args[0] == "ate" {
		// kubectl plugins reject global flags placed before the plugin name.
		full = append([]string{"ate", "--context", cfg.KubeContext}, args[1:]...)
	}
	cmd := exec.CommandContext(ctx, "kubectl", full...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("kubectl %s: %w: %s", args[0], err, strings.TrimSpace(lastLine(stderr.String())))
	}
	return out, nil
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return s[i+1:]
	}
	return s
}

func pollCluster(ctx context.Context, cfg config, h *hub) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		h.publish("cluster", snapshotCluster(ctx, cfg))
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func snapshotCluster(ctx context.Context, cfg config) clusterView {
	view := clusterView{Context: cfg.KubeContext, Actors: []actorView{}, Workers: []podView{}}
	var wg sync.WaitGroup
	var actorsOut, podsOut []byte
	var actorsErr, podsErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		actorsOut, actorsErr = kubectl(ctx, cfg, "ate", "get", "actors", "-a", cfg.Atespace, "-o", "json")
	}()
	go func() {
		defer wg.Done()
		podsOut, podsErr = kubectl(ctx, cfg, "get", "pods", "-n", cfg.Namespace, "-o", "json")
	}()
	wg.Wait()

	var errs []string
	if actorsErr != nil {
		errs = append(errs, actorsErr.Error())
	} else {
		var resp struct {
			Actors []struct {
				Metadata struct {
					Name       string `json:"name"`
					CreateTime string `json:"createTime"`
					UpdateTime string `json:"updateTime"`
				} `json:"metadata"`
				Status struct {
					State            string `json:"state"`
					WorkerAssignment *struct {
						WorkerPod string `json:"workerPod"`
					} `json:"workerAssignment"`
				} `json:"status"`
			} `json:"actors"`
		}
		if err := json.Unmarshal(actorsOut, &resp); err != nil {
			errs = append(errs, "decoding actors: "+err.Error())
		}
		for _, a := range resp.Actors {
			v := actorView{
				Name:       a.Metadata.Name,
				State:      strings.TrimPrefix(a.Status.State, "ACTOR_STATE_"),
				CreateTime: a.Metadata.CreateTime,
				UpdateTime: a.Metadata.UpdateTime,
			}
			if m := actorEnvRe.FindStringSubmatch(v.Name); m != nil {
				v.EnvID = m[1]
			}
			if a.Status.WorkerAssignment != nil {
				v.WorkerPod = a.Status.WorkerAssignment.WorkerPod
			}
			view.Actors = append(view.Actors, v)
		}
		sort.Slice(view.Actors, func(i, j int) bool { return view.Actors[i].CreateTime < view.Actors[j].CreateTime })
	}

	if podsErr != nil {
		errs = append(errs, podsErr.Error())
	} else {
		var resp struct {
			Items []struct {
				Metadata struct {
					Name              string            `json:"name"`
					Labels            map[string]string `json:"labels"`
					DeletionTimestamp *string           `json:"deletionTimestamp"`
				} `json:"metadata"`
				Status struct {
					Phase      string `json:"phase"`
					PodIP      string `json:"podIP"`
					Conditions []struct {
						Type   string `json:"type"`
						Status string `json:"status"`
					} `json:"conditions"`
				} `json:"status"`
			} `json:"items"`
		}
		if err := json.Unmarshal(podsOut, &resp); err != nil {
			errs = append(errs, "decoding pods: "+err.Error())
		}
		for _, p := range resp.Items {
			pv := podView{Name: p.Metadata.Name, Phase: p.Status.Phase, IP: p.Status.PodIP, Deleting: p.Metadata.DeletionTimestamp != nil}
			for _, c := range p.Status.Conditions {
				if c.Type == "Ready" && c.Status == "True" {
					pv.Ready = true
				}
			}
			switch {
			case p.Metadata.Labels["ate.dev/worker-pool"] != "":
				view.Workers = append(view.Workers, pv)
			case p.Metadata.Labels["app"] == "gemini-substrate-controller":
				if view.Controller == nil || (pv.Ready && !view.Controller.Ready) {
					c := pv
					view.Controller = &c
				}
			}
		}
		sort.Slice(view.Workers, func(i, j int) bool { return view.Workers[i].Name < view.Workers[j].Name })
	}
	view.Error = strings.Join(errs, "; ")
	return view
}

// ---------------------------------------------------------------------------
// Controller log tailing

type controllerEvent struct {
	Kind        string `json:"kind"` // lease | dispatch | suspend | log
	Interaction string `json:"interaction,omitempty"`
	EnvID       string `json:"envId,omitempty"`
	Actor       string `json:"actor,omitempty"`
	Line        string `json:"line"`
	Time        string `json:"time"`
}

func tailController(ctx context.Context, cfg config, h *hub) {
	for ctx.Err() == nil {
		cmd := exec.CommandContext(ctx, "kubectl", "--context", cfg.KubeContext, "logs", "-f", "--tail=0",
			"-n", cfg.Namespace, "deploy/gemini-substrate-controller")
		out, err := cmd.StdoutPipe()
		if err == nil {
			err = cmd.Start()
		}
		if err != nil {
			log.Printf("tail controller: %v", err)
		} else {
			sc := bufio.NewScanner(out)
			sc.Buffer(make([]byte, 64*1024), 1024*1024)
			for sc.Scan() {
				h.publish("controller", parseControllerLine(sc.Text()))
			}
			_ = cmd.Wait()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func parseControllerLine(line string) controllerEvent {
	ev := controllerEvent{Kind: "log", Line: line, Time: time.Now().UTC().Format(time.RFC3339Nano)}
	if m := claimedRe.FindStringSubmatch(line); m != nil {
		ev.Kind, ev.Interaction, ev.EnvID = "lease", m[1], m[2]
	} else if m := dispatchedRe.FindStringSubmatch(line); m != nil {
		ev.Kind, ev.Interaction, ev.EnvID = "dispatch", m[1], m[2]
	} else if m := suspendedRe.FindStringSubmatch(line); m != nil {
		ev.Kind, ev.Actor = "suspend", m[1]
		if em := actorEnvRe.FindStringSubmatch(ev.Actor); em != nil {
			ev.EnvID = em[1]
		}
	}
	return ev
}

// ---------------------------------------------------------------------------
// HTTP handlers

type server struct {
	cfg    config
	hub    *hub
	client *http.Client
}

func (s *server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"context":  s.cfg.KubeContext,
		"atespace": s.cfg.Atespace,
		"template": s.cfg.Template,
		"agent":    s.cfg.Agent,
	})
}

type runRequest struct {
	Prompt string `json:"prompt"`
	EnvID  string `json:"envId"`
	Egress string `json:"egress"`
}

func (s *server) handleRun(w http.ResponseWriter, r *http.Request) {
	var req runRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	req.Prompt = strings.TrimSpace(req.Prompt)
	if n := len(req.Prompt); n == 0 || n > 8000 {
		http.Error(w, "prompt must be 1-8000 bytes", http.StatusBadRequest)
		return
	}
	if req.EnvID != "" && !envIDRe.MatchString(req.EnvID) {
		http.Error(w, "invalid envId", http.StatusBadRequest)
		return
	}
	if req.Egress == "" {
		req.Egress = "default"
	}
	rules, ok := egressPresets[req.Egress]
	if !ok {
		http.Error(w, "invalid egress preset", http.StatusBadRequest)
		return
	}

	body := map[string]any{"agent": s.cfg.Agent, "input": req.Prompt, "stream": true}
	if req.EnvID != "" {
		body["environment"] = req.EnvID
	} else {
		cc := map[string]any{"atespace": s.cfg.Atespace, "template": s.cfg.Template}
		if rules != nil {
			cc["egress_policy"] = map[string]any{"rules": rules}
		}
		body["environment"] = map[string]any{"type": "remote", "mode": "self_hosted", "custom_config": cc}
	}
	payload, _ := json.Marshal(body)

	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.cfg.BaseURL+"/v1beta/interactions?alt=sse", bytes.NewReader(payload))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("x-goog-api-key", s.cfg.apiKey)

	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	sendErr := func(msg string) {
		data, _ := json.Marshal(map[string]string{"message": msg})
		writeSSE(w, "error", data)
		if fl != nil {
			fl.Flush()
		}
	}

	resp, err := s.client.Do(upReq)
	if err != nil {
		log.Printf("run: upstream request failed: %v", err)
		sendErr("could not reach the Gemini API")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		log.Printf("run: upstream status %d: %s", resp.StatusCode, b)
		var apiErr struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		msg := fmt.Sprintf("Gemini API returned HTTP %d", resp.StatusCode)
		if json.Unmarshal(b, &apiErr) == nil && apiErr.Error.Message != "" {
			msg += ": " + apiErr.Error.Message
		}
		sendErr(msg)
		return
	}

	rd := bufio.NewReaderSize(resp.Body, 256*1024)
	event := "message"
	for {
		line, err := rd.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		switch {
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			writeSSE(w, event, stripSignatures([]byte(data)))
			if fl != nil {
				fl.Flush()
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && r.Context().Err() == nil {
				log.Printf("run: stream read error: %v", err)
				sendErr("stream interrupted")
			}
			return
		}
	}
}

// stripSignatures removes opaque "signature" blobs (large, useless to the UI).
func stripSignatures(data []byte) []byte {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return data
	}
	var walk func(any)
	walk = func(x any) {
		switch t := x.(type) {
		case map[string]any:
			delete(t, "signature")
			for _, c := range t {
				walk(c)
			}
		case []any:
			for _, c := range t {
				walk(c)
			}
		}
	}
	walk(v)
	out, err := json.Marshal(v)
	if err != nil {
		return data
	}
	return out
}

func (s *server) handleSuspend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Actor string `json:"actor"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil || !actorNameRe.MatchString(req.Actor) {
		http.Error(w, "invalid actor", http.StatusBadRequest)
		return
	}
	if _, err := kubectl(r.Context(), s.cfg, "ate", "suspend", "actor", req.Actor, "-a", s.cfg.Atespace); err != nil {
		log.Printf("suspend %s: %v", req.Actor, err)
		http.Error(w, "suspend failed", http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
