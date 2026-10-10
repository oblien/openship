package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func officialRequest(t *testing.T) jobRequest {
	r := nativeRequest(t, "")
	r.Environment = nil
	r.Secrets = nil
	r.GitHub = &githubRequest{Repository: "owner/repo", Name: "openship-session_12345", Token: "temporary-registration-token", Labels: []string{"self-hosted", "openship"}, DownloadURL: "https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz", SHA256: strings.Repeat("a", 64)}
	return r
}
func TestOfficialRunnerRequestTrustBoundary(t *testing.T) {
	r := officialRequest(t)
	if err := validateGitHubRequest(r); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*jobRequest){
		func(r *jobRequest) { r.GitHub.DownloadURL = "https://example.com/runner.tar.gz" },
		func(r *jobRequest) {
			r.GitHub.DownloadURL = "https://github.com.evil.example/actions/runner/releases/download/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz"
		},
		func(r *jobRequest) { r.GitHub.SHA256 = "" },
		func(r *jobRequest) { r.GitHub.Token = "token\ninjected" },
		func(r *jobRequest) { r.GitHub.Repository = "owner/../../other" },
		func(r *jobRequest) { r.Secrets = map[string]string{"TOKEN": "independent-secret"} },
		func(r *jobRequest) { r.Workflow = "independent workflow" },
	} {
		changed := officialRequest(t)
		mutate(&changed)
		if validateGitHubRequest(changed) == nil {
			t.Fatal("invalid registration accepted")
		}
	}
}
func TestOfficialDockerChildrenKeepOwnershipAndLimits(t *testing.T) {
	req := httptest.NewRequest("POST", "http://docker/v1.47/containers/create", strings.NewReader(`{"Image":"node:22","Labels":{"app":"test","io.openship.actions.job":"spoofed"},"HostConfig":{"NanoCpus":8000000000,"Memory":8589934592,"Binds":["/var/run/docker.sock:/var/run/docker.sock","/data:/data"]}}`))
	if err := labelDockerCreation(req, "owned-job", "/private/proxy.sock", 2, 1024); err != nil {
		t.Fatal(err)
	}
	var body map[string]interface{}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	labels := body["Labels"].(map[string]interface{})
	host := body["HostConfig"].(map[string]interface{})
	if labels["app"] != "test" || labels["io.openship.actions.job"] != "owned-job" {
		t.Fatalf("ownership: %v", labels)
	}
	if host["NanoCpus"] != float64(2e9) || host["Memory"] != float64(1024*1024*1024) {
		t.Fatalf("limits: %v", host)
	}
	if host["Binds"].([]interface{})[0] != "/private/proxy.sock:/var/run/docker.sock" {
		t.Fatal("child bypassed ownership proxy")
	}
	smaller := httptest.NewRequest("POST", "http://docker/containers/create", strings.NewReader(`{"HostConfig":{"CpuQuota":25000,"CpuPeriod":100000,"Memory":268435456}}`))
	if err := labelDockerCreation(smaller, "owned-job", "/private/proxy.sock", 2, 1024); err != nil {
		t.Fatal(err)
	}
	_ = json.NewDecoder(smaller.Body).Decode(&body)
	host = body["HostConfig"].(map[string]interface{})
	if host["NanoCpus"] != float64(250000000) || host["Memory"] != float64(268435456) {
		t.Fatal("smaller user limits were lost")
	}
	for _, path := range []string{"networks", "volumes"} {
		req := httptest.NewRequest("POST", "http://docker/"+path+"/create", strings.NewReader(`{"Name":"test"}`))
		if err := labelDockerCreation(req, "owned-job", "/private/proxy.sock", 2, 1024); err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(req.Body)
		if strings.Contains(string(raw), "HostConfig") {
			t.Fatal("container options leaked into another Docker resource")
		}
	}
}
func TestOfficialSupervisorCancellationReapsCommandGroup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := githubCommand(ctx, os.Environ(), t.TempDir(), nil, nil, "sh", "-c", "sleep 60 & wait")
	if err == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("cancellation blocked: %v", err)
	}
}
func TestOfficialSupervisorKeepsMaskedFailureReason(t *testing.T) {
	masks := []string{"registration-secret"}
	var buf bytes.Buffer
	events := &eventWriter{out: &buf, masks: &masks}
	err := githubCommand(context.Background(), os.Environ(), t.TempDir(), nil, events, "sh", "-c", "echo 'failure: registration-secret'; exit 7")
	if err == nil || !strings.Contains(err.Error(), "failure:") || strings.Contains(err.Error(), "registration-secret") || strings.Contains(buf.String(), "registration-secret") {
		t.Fatalf("unsafe or missing failure detail: %v", err)
	}
}
func TestOfficialCachedArchiveRejectsTraversal(t *testing.T) {
	for _, name := range []string{"../escape", "/tmp/escape"} {
		t.Run(strings.ReplaceAll(name, "/", "_"), func(t *testing.T) {
			r := officialRequest(t)
			var data bytes.Buffer
			gz := gzip.NewWriter(&data)
			tw := tar.NewWriter(gz)
			_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: 1})
			_, _ = tw.Write([]byte("x"))
			_ = tw.Close()
			_ = gz.Close()
			sum := sha256.Sum256(data.Bytes())
			r.GitHub.SHA256 = hex.EncodeToString(sum[:])
			cache := filepath.Join(filepath.Dir(r.Directory), ".github-downloads")
			_ = os.MkdirAll(cache, 0700)
			target := filepath.Join(cache, r.GitHub.SHA256+".tar.gz")
			if err := os.WriteFile(target, data.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			defer os.Remove(target)
			if err := prepareGitHubRunner(context.Background(), r.GitHub, r.Directory); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}
func TestOfficialDockerProxyRemovesShortSocketDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), strings.Repeat("long", 30))
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	p, err := startDockerOwnershipProxy(directory, "job", 1, 512)
	if err != nil {
		t.Fatal(err)
	}
	temp := p.temporaryDirectory
	if temp == "" {
		t.Fatal("expected short socket directory")
	}
	p.Close()
	if _, err = os.Stat(temp); !os.IsNotExist(err) {
		t.Fatal("temporary socket directory retained")
	}
}
