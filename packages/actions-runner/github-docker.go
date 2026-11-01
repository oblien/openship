package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// The official runner uses Docker's public API unchanged. A private Unix socket
// adds our existing cleanup ownership label to its creates. This is resource
// tracking, not a security sandbox: Docker-enabled runners execute trusted code.
type dockerOwnershipProxy struct {
	path               string
	server             *http.Server
	listener           net.Listener
	temporaryDirectory string
}

func (p *dockerOwnershipProxy) Close() {
	_ = p.server.Close()
	_ = p.listener.Close()
	_ = os.Remove(p.path)
	if p.temporaryDirectory != "" {
		_ = os.Remove(p.temporaryDirectory)
	}
}

var dockerAPIVersion = regexp.MustCompile(`^/v[0-9.]+`)

func startDockerOwnershipProxy(directory, id string, cpu float64, memoryMB int) (*dockerOwnershipProxy, error) {
	socket := filepath.Join(directory, "docker.sock")
	temporaryDirectory := ""
	// Unix socket paths have a small OS limit; use a private short directory.
	if len(socket) > 95 {
		base, err := os.MkdirTemp("", "openship-docker-*")
		if err != nil {
			return nil, err
		}
		socket = filepath.Join(base, "docker.sock")
		temporaryDirectory = base
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		if temporaryDirectory != "" {
			_ = os.Remove(temporaryDirectory)
		}
		return nil, err
	}
	if err = os.Chmod(socket, 0600); err != nil {
		_ = listener.Close()
		_ = os.Remove(socket)
		if temporaryDirectory != "" {
			_ = os.Remove(temporaryDirectory)
		}
		return nil, err
	}
	endpoint, _ := url.Parse("http://docker")
	proxy := httputil.NewSingleHostReverseProxy(endpoint)
	proxy.Transport = &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/docker.sock")
	}}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "Runner Docker connection failed", http.StatusBadGateway)
	}
	server := &http.Server{ReadHeaderTimeout: 15 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := dockerAPIVersion.ReplaceAllString(r.URL.Path, "")
		if r.Method == "POST" && (path == "/containers/create" || path == "/networks/create" || path == "/volumes/create") {
			if err := labelDockerCreation(r, id, socket, cpu, memoryMB); err != nil {
				http.Error(w, "Invalid runner Docker resource", 400)
				return
			}
		}
		proxy.ServeHTTP(w, r)
	})}
	p := &dockerOwnershipProxy{path: socket, server: server, listener: listener, temporaryDirectory: temporaryDirectory}
	go func() { _ = server.Serve(listener) }()
	return p, nil
}
func labelDockerCreation(r *http.Request, id, socket string, cpu float64, memoryMB int) error {
	data, err := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024+1))
	_ = r.Body.Close()
	if err != nil {
		return err
	}
	if len(data) > 2*1024*1024 {
		return errors.New("Docker request too large")
	}
	var value map[string]interface{}
	if err = json.Unmarshal(data, &value); err != nil {
		return err
	}
	if value == nil {
		return errors.New("Docker request is empty")
	}
	labels, _ := value["Labels"].(map[string]interface{})
	if labels == nil {
		labels = map[string]interface{}{}
	}
	labels["io.openship.actions.job"] = id
	value["Labels"] = labels
	if dockerAPIVersion.ReplaceAllString(r.URL.Path, "") == "/containers/create" {
		host, _ := value["HostConfig"].(map[string]interface{})
		if host == nil {
			host = map[string]interface{}{}
			value["HostConfig"] = host
		}
		// GitHub creates service/job containers as siblings. Apply the same
		// per-container limits as the shared Docker runner instead of leaving
		// those children unlimited; a Cloud VM also bounds their aggregate.
		nanoCPU := cpu * 1e9
		if current, ok := host["NanoCpus"].(float64); ok && current > 0 && current < nanoCPU {
			nanoCPU = current
		}
		if quota, ok := host["CpuQuota"].(float64); ok && quota > 0 {
			period, ok := host["CpuPeriod"].(float64)
			if !ok || period <= 0 {
				period = 100000
			}
			if current := quota / period * 1e9; current < nanoCPU {
				nanoCPU = current
			}
		}
		delete(host, "CpuQuota")
		delete(host, "CpuPeriod")
		host["NanoCpus"] = int64(nanoCPU)
		memory := float64(memoryMB) * 1024 * 1024
		if current, ok := host["Memory"].(float64); ok && current > 0 && current < memory {
			memory = current
		}
		host["Memory"] = int64(memory)
		host["MemorySwap"] = int64(memory)
		if binds, ok := host["Binds"].([]interface{}); ok {
			for i, entry := range binds {
				bind, ok := entry.(string)
				if ok && strings.HasPrefix(bind, "/var/run/docker.sock:") {
					binds[i] = socket + strings.TrimPrefix(bind, "/var/run/docker.sock")
				}
			}
		}
	}
	data, err = json.Marshal(value)
	if err != nil {
		return err
	}
	r.Body = io.NopCloser(bytes.NewReader(data))
	r.ContentLength = int64(len(data))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Del("Content-Length")
	return nil
}
