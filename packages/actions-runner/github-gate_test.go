package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func admissionFixture(t *testing.T) (string, string) {
	t.Helper()
	directory := t.TempDir()
	id := strings.Repeat("a", 64)
	data, _ := json.Marshal(githubAdmissionRequest{ID: id, Repository: "owner/private", RepositoryID: "41", RunID: "42", Attempt: 2})
	if err := os.WriteFile(filepath.Join(directory, "github-admission.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	return directory, id
}

func TestGitHubAdmissionDecisionIsImmutableAcrossConcurrentRetries(t *testing.T) {
	directory, id := admissionFixture(t)
	var group sync.WaitGroup
	for i := 0; i < 20; i++ {
		group.Add(1)
		go func(allow bool) { defer group.Done(); _ = decideGitHubAdmission(directory, id, allow) }(i%2 == 0)
	}
	group.Wait()
	data, err := readAdmissionRecord(filepath.Join(directory, "github-admission-decision.json"))
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		ID    string `json:"id"`
		Allow bool   `json:"allow"`
	}
	if err := json.Unmarshal(data, &result); err != nil || result.ID != id {
		t.Fatalf("invalid durable decision: %v", err)
	}
	if err := decideGitHubAdmission(directory, id, result.Allow); err != nil {
		t.Fatal(err)
	}
	if err := decideGitHubAdmission(directory, id, !result.Allow); err == nil {
		t.Fatal("decision was overwritten")
	}
	if err := decideGitHubAdmission(directory, strings.Repeat("b", 64), result.Allow); err == nil {
		t.Fatal("another assignment consumed the decision")
	}
}

func TestGitHubAdmissionInspectOnlyExposesPendingIdentity(t *testing.T) {
	directory, id := admissionFixture(t)
	lock, _, err := lockWorker(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	before, err := inspectWorker(directory, 0)
	if err != nil || before.GitHubAdmission == nil || before.GitHubAdmission.ID != id {
		t.Fatalf("pending identity missing: %v", err)
	}
	if err := decideGitHubAdmission(directory, id, true); err != nil {
		t.Fatal(err)
	}
	after, err := inspectWorker(directory, 0)
	if err != nil || after.GitHubAdmission != nil {
		t.Fatalf("an admitted worker was presented as pending again: %v", err)
	}
}

func TestGitHubAdmissionRejectsOversizedRecordsAndCancellation(t *testing.T) {
	directory, id := admissionFixture(t)
	if err := os.WriteFile(filepath.Join(directory, "cancel"), []byte("cancel"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := decideGitHubAdmission(directory, id, true); err == nil {
		t.Fatal("cancelled assignment was allowed")
	}
	if err := os.WriteFile(filepath.Join(directory, "github-admission.json"), []byte(strings.Repeat("x", 8192)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readGitHubAdmission(directory); err == nil {
		t.Fatal("oversized identity was accepted")
	}
}
