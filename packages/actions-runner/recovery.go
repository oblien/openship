package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/containerd/errdefs"
	"github.com/moby/moby/client"
	"github.com/nektos/act/pkg/container"
	"github.com/shirou/gopsutil/v4/process"
)

func usesDocker(request jobRequest) bool {
	for _, image := range request.Platforms {
		if image != "-self-hosted" {
			return true
		}
	}
	return false
}

func prepareOwnedVolumes(ctx context.Context, id string) error {
	cli, err := container.GetDockerClient(ctx)
	if err != nil {
		return err
	}
	defer cli.Close()
	for _, suffix := range []string{"", "-env", "-toolcache"} {
		result, err := cli.VolumeCreate(ctx, client.VolumeCreateOptions{Name: container.ExecutionResourcePrefix(id) + suffix, Labels: map[string]string{container.ExecutionOwnerLabel: id}})
		if err != nil {
			return err
		}
		if result.Volume.Labels[container.ExecutionOwnerLabel] != id {
			return errors.New("Actions volume ownership could not be verified")
		}
	}
	return nil
}

// Reconcile after success, cancellation or a killed runner. The file lock
// proves that no worker can still launch steps for this attempt. Like the
// GitHub runner, native orphan cleanup uses a per-job tracking environment.
// Native runners are for trusted code; they are not a host security sandbox.
func recoverWorker(directory string) error {
	lock, available, err := lockWorker(directory)
	if err != nil {
		return err
	}
	if !available {
		return errors.New("Actions worker is still running")
	}
	defer lock.Close()
	data, err := os.ReadFile(filepath.Join(directory, "state.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) > 4096 {
		return errors.New("Actions state is invalid")
	}
	var state workerState
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}
	if state.ID == "" {
		return errors.New("Actions state has no owner")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if state.Docker {
		if err := cleanOwnedDocker(ctx, state.ID); err != nil {
			return err
		}
	}
	return cleanNativeProcesses(ctx, state.ID)
}

func cleanOwnedDocker(ctx context.Context, id string) error {
	cli, err := container.GetDockerClient(ctx)
	if err != nil {
		return err
	}
	defer cli.Close()
	filter := make(client.Filters).Add("label", container.ExecutionOwnerLabel+"="+id)
	containers, err := cli.ContainerList(ctx, client.ContainerListOptions{All: true, Filters: filter})
	if err != nil {
		return err
	}
	for _, item := range containers.Items {
		if item.Labels[container.ExecutionOwnerLabel] != id {
			return errors.New("Actions container ownership changed")
		}
		if _, err := cli.ContainerRemove(ctx, item.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !errdefs.IsNotFound(err) {
			return err
		}
	}
	networks, err := cli.NetworkList(ctx, client.NetworkListOptions{Filters: filter})
	if err != nil {
		return err
	}
	for _, item := range networks.Items {
		if item.Labels[container.ExecutionOwnerLabel] != id {
			return errors.New("Actions network ownership changed")
		}
		if _, err := cli.NetworkRemove(ctx, item.ID, client.NetworkRemoveOptions{}); err != nil && !errdefs.IsNotFound(err) {
			return err
		}
	}
	volumes, err := cli.VolumeList(ctx, client.VolumeListOptions{Filters: filter})
	if err != nil {
		return err
	}
	for _, item := range volumes.Items {
		if item.Labels[container.ExecutionOwnerLabel] != id {
			return errors.New("Actions volume ownership changed")
		}
		// No force: a volume attached elsewhere retains the runner reservation.
		if _, err := cli.VolumeRemove(ctx, item.Name, client.VolumeRemoveOptions{}); err != nil && !errdefs.IsNotFound(err) {
			return err
		}
	}
	return nil
}

func cleanNativeProcesses(ctx context.Context, id string) error {
	marker := "RUNNER_TRACKING_ID=openship-action-" + id
	for pass := 0; pass < 10; pass++ {
		all, err := process.ProcessesWithContext(ctx)
		if err != nil {
			return err
		}
		found := 0
		for _, p := range all {
			if int(p.Pid) == os.Getpid() {
				continue
			}
			values, err := processEnvironment(ctx, p)
			if err != nil || !slices.Contains(values, marker) {
				continue
			}
			born, err := p.CreateTimeWithContext(ctx)
			if err != nil {
				return err
			}
			// Re-read process identity just before signalling: never act on a
			// stale PID captured by a previous reconciliation pass.
			current, err := process.NewProcessWithContext(ctx, p.Pid)
			if err != nil {
				continue
			}
			currentBorn, err := current.CreateTimeWithContext(ctx)
			if err != nil || currentBorn != born {
				continue
			}
			found++
			if err := current.KillWithContext(ctx); err != nil && !errors.Is(err, os.ErrProcessDone) && !errors.Is(err, process.ErrorProcessNotRunning) {
				return err
			}
		}
		if found == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("Actions native processes have not exited; runner capacity stays reserved")
}
