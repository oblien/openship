package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nektos/act/pkg/model"
	"github.com/nektos/act/pkg/runner"
)

func TestServicePortContextSupportsGitHubNumericAndStringIndexes(t *testing.T) {
	workflow, err := model.ReadWorkflow(strings.NewReader("on: workflow_dispatch\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: true\n"), true)
	if err != nil {
		t.Fatal(err)
	}
	rc := &runner.RunContext{
		Run: &model.Run{Workflow: workflow, JobID: "test"}, Config: &runner.Config{},
		RuntimeServices: map[string]model.ServiceContext{"site": {Ports: map[string]string{"80": "32145"}}},
	}
	evaluator := rc.NewExpressionEvaluator(context.Background())
	for _, expression := range []string{"${{ job.services.site.ports[80] }}", "${{ job.services.site.ports['80'] }}"} {
		if value := evaluator.Interpolate(context.Background(), expression); value != "32145" {
			t.Fatalf("%s = %q", expression, value)
		}
	}
}

func nativeRequest(t *testing.T, workflow string) jobRequest {
	t.Helper()
	directory := t.TempDir()
	return jobRequest{
		Version: protocolVersion, ID: "job_" + strings.ReplaceAll(t.Name(), "/", "_"),
		Job: "test", Workflow: workflow, WorkflowPath: ".github/workflows/ci.yml",
		Directory: directory, EventName: "workflow_dispatch", Event: []byte(`{"inputs":{}}`),
		DefaultBranch: "main", Actor: "tester", TimeoutSeconds: 30,
		Platforms:   map[string]string{"self-hosted": "-self-hosted"},
		Environment: map[string]string{"ASSERT_PATH": directory, "GITHUB_REPOSITORY": "example/repo", "GITHUB_REPOSITORY_OWNER": "example", "GITHUB_REF": "refs/heads/main", "SHA_REF": strings.Repeat("a", 40)},
	}
}

func TestNativeJobUsesActForStepsAndEnvironment(t *testing.T) {
	r := nativeRequest(t, `name: CI
on: workflow_dispatch
jobs:
  test:
    runs-on: self-hosted
    outputs:
      answer: ${{ steps.answer.outputs.value }}
    steps:
      - run: echo 'MESSAGE=from-earlier-step' >> "$GITHUB_ENV"
      - id: answer
        run: |
          test "$MESSAGE" = 'from-earlier-step'
          echo "value=42" >> "$GITHUB_OUTPUT"
          echo done > "$ASSERT_PATH/result.txt"
`)
	var logs bytes.Buffer
	result, err := runJob(context.Background(), r, &eventWriter{out: &logs})
	if err != nil || result.Conclusion != "success" || result.Outputs["answer"] != "42" {
		t.Fatalf("result=%+v err=%v logs=%s", result, err, logs.String())
	}
	if _, err := os.Stat(filepath.Join(r.Directory, "result.txt")); err != nil {
		t.Fatal(err)
	}
}

func TestOnlyRequestedJobRunsAndReceivesDependencyOutputs(t *testing.T) {
	r := nativeRequest(t, `on: workflow_dispatch
jobs:
  prepare:
    runs-on: self-hosted
    steps:
      - run: exit 90
  test:
    needs: prepare
    runs-on: self-hosted
    steps:
      - run: test "${{ needs.prepare.outputs.version }}" = "previous-result"
`)
	r.Needs = map[string]dependency{"prepare": {Result: "success", Outputs: map[string]string{"version": "previous-result"}}}
	var logs bytes.Buffer
	result, err := runJob(context.Background(), r, &eventWriter{out: &logs})
	if err != nil || result.Conclusion != "success" {
		t.Fatalf("result=%+v err=%v logs=%s", result, err, logs.String())
	}
}

func TestFailureDoesNotRunSuccessOnlySteps(t *testing.T) {
	r := nativeRequest(t, `on: workflow_dispatch
jobs:
  test:
    runs-on: self-hosted
    steps:
      - run: exit 7
      - run: touch "$ASSERT_PATH/should-not-exist"
      - if: always()
        run: touch "$ASSERT_PATH/cleanup-ran"
`)
	var logs bytes.Buffer
	result, err := runJob(context.Background(), r, &eventWriter{out: &logs})
	if err != nil || result.Conclusion != "failure" {
		t.Fatalf("result=%+v err=%v logs=%s", result, err, logs.String())
	}
	if _, err := os.Stat(filepath.Join(r.Directory, "should-not-exist")); !os.IsNotExist(err) {
		t.Fatal("ran success-only step")
	}
	if _, err := os.Stat(filepath.Join(r.Directory, "cleanup-ran")); err != nil {
		t.Fatal(err)
	}
}

func TestSecretsAreMaskedAndNotReturnedAsOutputs(t *testing.T) {
	r := nativeRequest(t, `on: workflow_dispatch
jobs:
  test:
    runs-on: self-hosted
    outputs:
      secret: ${{ steps.output.outputs.secret }}
    steps:
      - id: output
        name: Test masking
        env:
          TOKEN: ${{ secrets.TOKEN }}
        run: |
          echo "$TOKEN"
          echo "secret=$TOKEN" >> "$GITHUB_OUTPUT"
          echo '::add-mask::dynamic-sensitive-value'
          echo 'dynamic-sensitive-value'
`)
	r.Secrets = map[string]string{"TOKEN": "private-test-value-123"}
	var logs bytes.Buffer
	result, err := runJob(context.Background(), r, &eventWriter{out: &logs})
	if err != nil || result.Conclusion != "success" {
		t.Fatalf("unexpected result %s %v", result.Conclusion, err)
	}
	if result.Outputs["secret"] != "" || strings.Contains(logs.String(), r.Secrets["TOKEN"]) || strings.Contains(logs.String(), "dynamic-sensitive-value") {
		t.Fatal("secret escaped the worker")
	}
}

func TestCancellationStopsTheNativeJob(t *testing.T) {
	r := nativeRequest(t, `on: workflow_dispatch
jobs:
  test:
    runs-on: self-hosted
    steps:
      - run: (sleep 1; touch "$ASSERT_PATH/late-side-effect") & wait
`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(500*time.Millisecond, cancel)
	defer timer.Stop()
	var logs bytes.Buffer
	started := time.Now()
	result, err := runJob(ctx, r, &eventWriter{out: &logs})
	if err != nil || result.Conclusion != "cancelled" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("cancel did not promptly stop execution")
	}
	time.Sleep(1100 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(r.Directory, "late-side-effect")); !os.IsNotExist(err) {
		t.Fatal("cancelled command completed its side effect")
	}
}
