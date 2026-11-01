package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

//go:embed github-gate.cjs
var githubGate []byte

type githubAdmissionRequest struct {
	ID           string `json:"id"`
	Repository   string `json:"repository"`
	RepositoryID string `json:"repositoryId"`
	RunID        string `json:"runId"`
	Attempt      int    `json:"attempt"`
}

func installGitHubGate(directory string) error {
	root := filepath.Join(directory, "runner")
	node := ""
	for _, version := range []string{"node24", "node20"} {
		candidate := filepath.Join(root, "externals", version, "bin", "node")
		if file, err := os.Stat(candidate); err == nil && file.Mode().IsRegular() {
			node = candidate
			break
		}
	}
	if node == "" {
		return errors.New("official runner has no supported admission runtime")
	}
	worker := filepath.Join(root, "bin", "Runner.Worker")
	original := worker + ".openship"
	if err := os.Rename(worker, original); err != nil {
		return err
	}
	script := filepath.Join(directory, "github-gate.cjs")
	if err := os.WriteFile(script, githubGate, 0600); err != nil {
		return err
	}
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	entry := "#!/bin/sh\nexec " + quote(node) + " " + quote(script) + " " + quote(directory) + " " + quote(original) + " \"$@\"\n"
	return os.WriteFile(worker, []byte(entry), 0700)
}

func readGitHubAdmission(directory string) (*githubAdmissionRequest, error) {
	data, err := readAdmissionRecord(filepath.Join(directory, "github-admission.json"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) > 4096 {
		return nil, errors.New("invalid GitHub admission request")
	}
	var request githubAdmissionRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return nil, err
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(request.ID) || !githubOwner.MatchString(request.Repository) ||
		!regexp.MustCompile(`^[1-9][0-9]{0,15}$`).MatchString(request.RepositoryID) || !regexp.MustCompile(`^[1-9][0-9]{0,15}$`).MatchString(request.RunID) || request.Attempt < 1 {
		return nil, errors.New("invalid GitHub admission identity")
	}
	return &request, nil
}

func readAdmissionRecord(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return nil, err
	}
	if len(data) > 4096 {
		return nil, errors.New("invalid GitHub admission record")
	}
	return data, nil
}

func decideGitHubAdmission(directory, id string, allow bool) error {
	// A separate short-lived lock serializes transport retries. The supervisor
	// holds worker.lock throughout the run, so it cannot guard this decision.
	lock, err := os.OpenFile(filepath.Join(directory, "github-admission.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	request, err := readGitHubAdmission(directory)
	if err != nil {
		return err
	}
	if request == nil || request.ID != id {
		return errors.New("GitHub admission changed")
	}
	decision := filepath.Join(directory, "github-admission-decision.json")
	data, _ := json.Marshal(struct {
		ID    string `json:"id"`
		Allow bool   `json:"allow"`
	}{id, allow})
	if previous, err := readAdmissionRecord(decision); err == nil {
		if string(previous) != string(data) {
			return errors.New("GitHub admission already decided")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if _, err := os.Stat(filepath.Join(directory, "cancel")); allow && !os.IsNotExist(err) {
		return errors.New("GitHub assignment was cancelled")
	}
	return writeWorkerRecord(decision, data)
}
