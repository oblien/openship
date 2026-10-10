package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/sirupsen/logrus"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Println("openship-actions/1 act/0.2.89")
		return
	}
	if handled, err := controlCommand(os.Args); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, "Actions worker control failed")
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 3 || os.Args[1] != "run" {
		fmt.Fprintln(os.Stderr, "usage: openship-actions run <request.json>")
		os.Exit(2)
	}
	if err := executeFile(os.Args[2]); err != nil {
		// Error messages from action code are already emitted through the masked
		// protocol. This final message must not contain the request or credentials.
		fmt.Fprintln(os.Stderr, "Actions worker could not complete its protocol")
		os.Exit(1)
	}
}

func executeFile(path string) error {
	root := filepath.Dir(path)
	lock, available, err := lockWorker(root)
	if err != nil {
		return err
	}
	if !available {
		return nil
	} // Another invocation owns this exact attempt.
	defer lock.Close()
	if _, err := os.Stat(filepath.Join(root, "state.json")); err == nil {
		return nil
	} // Never replay an interrupted job's side effects.
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	stat, err := f.Stat()
	if err != nil || stat.Size() > maxRequestBytes {
		f.Close()
		return fmt.Errorf("invalid request size")
	}
	var request jobRequest
	decoder := json.NewDecoder(io.LimitReader(f, maxRequestBytes+1))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&request)
	if err == nil {
		var extra interface{}
		if next := decoder.Decode(&extra); next != io.EOF {
			err = fmt.Errorf("request must contain exactly one JSON value")
		}
	}
	f.Close()
	// The controller provisions this one-use file with 0600 permissions.
	if removeErr := os.Remove(path); err == nil {
		err = removeErr
	}
	if err != nil {
		return err
	}
	if err = validateRequest(request); err != nil {
		return err
	}
	state, _ := json.Marshal(workerState{ID: request.ID, Docker: usesDocker(request), StartedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	if err = writeWorkerRecord(filepath.Join(root, "state.json"), state); err != nil {
		return err
	}
	journal, err := os.OpenFile(filepath.Join(filepath.Dir(path), "events.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer journal.Close()
	// The durable journal is the transport. A lost SSH/browser connection cannot
	// break logging or cancel a job; the controller resumes from its event cursor.
	events := &eventWriter{out: journal}
	// act's host environment inherits its process environment. Keep only host
	// runtime prerequisites; never inherit the controller's or SSH session's keys.
	allowed := map[string]string{}
	for _, key := range []string{"PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL"} {
		if value, ok := os.LookupEnv(key); ok {
			allowed[key] = value
		}
	}
	os.Clearenv()
	for key, value := range allowed {
		os.Setenv(key, value)
	}
	// Unscoped library debug output must not disclose command environments.
	logrus.SetOutput(io.Discard)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go watchCancellation(ctx, root, cancel)
	var result jobResult
	if request.GitHub != nil {
		result, err = runGitHubRunner(ctx, request, events)
	} else {
		result, err = runJob(ctx, request, events)
	}
	if err != nil {
		result = jobResult{Conclusion: "failure", Outputs: map[string]string{}, Steps: map[string]stepResult{}, Error: events.redact(err.Error())}
	}
	result = boundedResult(result)
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	resultPath := filepath.Join(filepath.Dir(path), "result.json")
	if err := writeWorkerRecord(resultPath, data); err != nil {
		return err
	}
	if err := events.write("result", map[string]interface{}{"result": result}); err != nil {
		return err
	}
	return journal.Sync()
}
