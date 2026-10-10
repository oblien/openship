package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestWorkerSubprocess(t *testing.T) {
	if os.Getenv("OPENSHIP_ACTIONS_TEST_CHILD") != "yes" {
		return
	}
	if err := executeFile(os.Getenv("OPENSHIP_ACTIONS_TEST_REQUEST")); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

func TestNoExecutionWithoutDurableStartRecord(t *testing.T) {
	r := nativeRequest(t, `on: workflow_dispatch
jobs:
  test:
    runs-on: self-hosted
    steps:
      - run: touch "$ASSERT_PATH/must-not-run"
`)
	directory := r.Directory
	r.Directory = filepath.Join(directory, "work")
	request := filepath.Join(directory, "request.json")
	data, _ := json.Marshal(r)
	if err := os.WriteFile(request, data, 0o600); err != nil {
		t.Fatal(err)
	}
	// This fails even when the test runs as root: the state file's staging
	// destination cannot be written. No workflow step may have started.
	if err := os.Mkdir(filepath.Join(directory, "state.json.tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestWorkerSubprocess$")
	child.Env = append(os.Environ(), "OPENSHIP_ACTIONS_TEST_CHILD=yes", "OPENSHIP_ACTIONS_TEST_REQUEST="+request)
	if err := child.Run(); err == nil {
		t.Fatal("worker accepted an unrecorded attempt")
	}
	if _, err := os.Stat(filepath.Join(directory, "must-not-run")); !os.IsNotExist(err) {
		t.Fatal("workflow ran without a persisted start record")
	}
	if _, err := os.Stat(filepath.Join(directory, "events.jsonl")); !os.IsNotExist(err) {
		t.Fatal("execution journal started before its accepted-attempt record")
	}
}

func TestRecoveryReapsOnlyThisKilledAttempt(t *testing.T) {
	r := nativeRequest(t, `on: workflow_dispatch
jobs:
  test:
    runs-on: self-hosted
    steps:
      - run: |
          touch "$ASSERT_PATH/started"
          (sleep 5; touch "$ASSERT_PATH/orphan-side-effect") & wait
`)
	directory := r.Directory
	r.Directory = filepath.Join(directory, "work")
	request := filepath.Join(directory, "request.json")
	data, _ := json.Marshal(r)
	if err := os.WriteFile(request, data, 0o600); err != nil {
		t.Fatal(err)
	}
	other := exec.Command("sleep", "30")
	other.Env = append(os.Environ(), "RUNNER_TRACKING_ID=openship-action-another-job")
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { other.Process.Kill(); other.Wait() }()
	child := exec.Command(os.Args[0], "-test.run=^TestWorkerSubprocess$")
	child.Env = append(os.Environ(), "OPENSHIP_ACTIONS_TEST_CHILD=yes", "OPENSHIP_ACTIONS_TEST_REQUEST="+request)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { child.Process.Kill(); child.Wait() }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(directory, "started")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("worker never started")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := recoverWorker(directory); err == nil {
		t.Fatal("cleanup succeeded while the worker was still running")
	}
	child.Process.Kill()
	child.Wait()
	snapshot, err := inspectWorker(directory, 0)
	if err != nil || snapshot.State != "interrupted" {
		t.Fatalf("snapshot=%+v err=%v", snapshot, err)
	}
	if err := recoverWorker(directory); err != nil {
		t.Fatal(err)
	}
	if err := other.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("another job was affected", err)
	}
	time.Sleep(5 * time.Second)
	if _, err := os.Stat(filepath.Join(directory, "orphan-side-effect")); !os.IsNotExist(err) {
		t.Fatal("orphan survived recovery")
	}
	// Another launch of the same persisted attempt cannot replay side effects.
	if err := executeFile(request); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeCredentialsAndConcreteStrategy(t *testing.T) {
	r := nativeRequest(t, `on: workflow_dispatch
jobs:
  test:
    runs-on: self-hosted
    if: failure()
    steps:
      - run: |
          test '${{ strategy.job-index }}' = '1'
          test '${{ strategy.job-total }}' = '3'
          echo "$ACTIONS_RUNTIME_TOKEN"
`)
	r.Strategy = map[string]interface{}{"job-index": 1, "job-total": 3}
	r.Environment["ACTIONS_RUNTIME_TOKEN"] = "private-runtime-test-credential"
	var output strings.Builder
	result, err := runJob(context.Background(), r, &eventWriter{out: &output})
	if err != nil || result.Conclusion != "success" {
		t.Fatalf("result=%+v error=%v", result, err)
	}
	if strings.Contains(output.String(), r.Environment["ACTIONS_RUNTIME_TOKEN"]) {
		t.Fatal("runtime credential escaped masking")
	}
}

func TestOversizedResultsRemainTerminalAndBounded(t *testing.T) {
	result := boundedResult(jobResult{Conclusion: "success", Outputs: map[string]string{"large": strings.Repeat("x", 200*1024)}})
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > 128*1024 || result.Conclusion != "failure" || result.Steps == nil {
		t.Fatal("oversized result was not bounded")
	}
}
