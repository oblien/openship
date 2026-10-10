package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

type workerState struct {
	ID        string `json:"id"`
	StartedAt string `json:"startedAt"`
	Docker    bool   `json:"docker"`
}

type workerSnapshot struct {
	State   string            `json:"state"`
	Events  []json.RawMessage `json:"events"`
	HasMore bool              `json:"hasMore"`
	Result  *jobResult        `json:"result,omitempty"`
}

// Persist the accepted-attempt marker before any user command can execute.
// A buffered WriteFile is insufficient when the destination loses power. The
// result uses the same atomic write so a torn file cannot look like completion.
func writeWorkerRecord(path string, data []byte) error {
	temporary := path + ".tmp"
	f, err := os.OpenFile(temporary, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer func() { f.Close(); os.Remove(temporary) }()
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	// Sync the record's directory and the entry for this newly created job
	// directory. Both already exist before the worker is launched.
	parent := filepath.Dir(path)
	for _, name := range []string{parent, filepath.Dir(parent)} {
		directory, err := os.Open(name)
		if err != nil {
			return err
		}
		err = directory.Sync()
		directory.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func lockWorker(directory string) (*os.File, bool, error) {
	lock, err := os.OpenFile(filepath.Join(directory, "worker.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, false, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return lock, true, nil
}

func inspectWorker(directory string, after int) (workerSnapshot, error) {
	snapshot := workerSnapshot{State: "idle", Events: []json.RawMessage{}}
	if _, err := os.Stat(directory); os.IsNotExist(err) {
		return snapshot, nil
	}
	lock, available, err := lockWorker(directory)
	if err != nil {
		return snapshot, err
	}
	if lock != nil {
		defer lock.Close()
	}
	if !available {
		snapshot.State = "running"
	} else if _, err := os.Stat(filepath.Join(directory, "state.json")); err == nil {
		snapshot.State = "interrupted"
	}
	if available {
		if resultFile, err := os.Open(filepath.Join(directory, "result.json")); err == nil {
			content, err := io.ReadAll(io.LimitReader(resultFile, 128*1024+1))
			resultFile.Close()
			if err != nil {
				return snapshot, err
			}
			if len(content) > 128*1024 {
				return snapshot, errors.New("job result exceeded its limit")
			}
			var result jobResult
			if err := json.Unmarshal(content, &result); err != nil {
				return snapshot, err
			}
			snapshot.State, snapshot.Result = "finished", &result
		}
	}
	journal, err := os.Open(filepath.Join(directory, "events.jsonl"))
	if os.IsNotExist(err) {
		return snapshot, nil
	}
	if err != nil {
		return snapshot, err
	}
	defer journal.Close()
	scanner := bufio.NewScanner(io.LimitReader(journal, 10*1024*1024))
	scanner.Buffer(make([]byte, 64*1024), 256*1024)
	bytes := 0
	for scanner.Scan() {
		var head struct {
			Sequence int `json:"sequence"`
		}
		line := scanner.Bytes()
		if json.Unmarshal(line, &head) != nil {
			continue
		} // Last line can still be in flight.
		if head.Sequence <= after {
			continue
		}
		if len(snapshot.Events) == 200 || bytes > 256*1024 {
			snapshot.HasMore = true
			break
		}
		bytes += len(line)
		snapshot.Events = append(snapshot.Events, append(json.RawMessage{}, line...))
	}
	return snapshot, scanner.Err()
}

func watchCancellation(ctx context.Context, directory string, cancel context.CancelFunc) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(filepath.Join(directory, "cancel")); err == nil {
			cancel()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func controlCommand(args []string) (bool, error) {
	if len(args) < 3 {
		return false, nil
	}
	switch args[1] {
	case "clean":
		return true, recoverWorker(args[2])
	case "inspect":
		after := 0
		if len(args) == 4 {
			var err error
			after, err = strconv.Atoi(args[3])
			if err != nil || after < 0 {
				return true, errors.New("invalid event cursor")
			}
		}
		snapshot, err := inspectWorker(args[2], after)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(os.Stdout).Encode(snapshot)
	case "cancel":
		return true, os.WriteFile(filepath.Join(args[2], "cancel"), []byte("cancel\n"), 0o600)
	}
	return false, nil
}
