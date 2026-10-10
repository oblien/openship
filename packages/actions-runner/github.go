package main

// GitHub owns workflow scheduling, credentials, steps and Checks. This adapter
// supervises the unmodified official runner for one ephemeral registration.
import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

type githubRequest struct {
	Repository  string   `json:"repository"`
	Name        string   `json:"name"`
	Token       string   `json:"token"`
	Labels      []string `json:"labels"`
	DownloadURL string   `json:"downloadUrl"`
	SHA256      string   `json:"sha256"`
	Image       string   `json:"image"`
}

var githubOwner = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var githubRunnerName = regexp.MustCompile(`^openship-[a-zA-Z0-9_-]{8,80}$`)
var githubReleasePath = regexp.MustCompile(`^/actions/runner/releases/download/v[0-9.]+/actions-runner-(linux|osx)-(x64|arm64)-[0-9.]+\.tar\.gz$`)

func validateGitHubRequest(r jobRequest) error {
	g := r.GitHub
	if g == nil || !githubOwner.MatchString(g.Repository) || !githubRunnerName.MatchString(g.Name) || g.Token == "" || strings.ContainsAny(g.Token, "\r\n") || len(g.Token) > 4096 {
		return errors.New("invalid GitHub runner registration")
	}
	u, err := url.Parse(g.DownloadURL)
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || !githubReleasePath.MatchString(u.Path) {
		return errors.New("invalid official runner download")
	}
	digest, err := hex.DecodeString(g.SHA256)
	if err != nil || len(digest) != sha256.Size {
		return errors.New("official runner checksum is required")
	}
	if len(g.Labels) == 0 || len(g.Labels) > 100 {
		return errors.New("invalid GitHub runner labels")
	}
	for _, label := range g.Labels {
		if !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`).MatchString(label) {
			return errors.New("invalid GitHub runner label")
		}
	}
	if len(r.Environment) != 0 || len(r.Secrets) != 0 || len(r.Variables) != 0 || r.Workflow != "" {
		return errors.New("GitHub runner cannot receive independent workflow credentials")
	}
	return nil
}

// Downloads are cached by checksum outside the per-session directory. Only the
// public official release host may redirect this unauthenticated download.
func prepareGitHubRunner(ctx context.Context, g *githubRequest, directory string) error {
	cache := filepath.Join(filepath.Dir(directory), ".github-downloads")
	if err := os.MkdirAll(cache, 0700); err != nil {
		return err
	}
	archive := filepath.Join(cache, g.SHA256+".tar.gz")
	valid := func() bool {
		f, e := os.Open(archive)
		if e != nil {
			return false
		}
		defer f.Close()
		h := sha256.New()
		_, e = io.Copy(h, f)
		return e == nil && hex.EncodeToString(h.Sum(nil)) == g.SHA256
	}
	if !valid() {
		client := &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			host := req.URL.Hostname()
			if len(via) > 5 || req.URL.Scheme != "https" || req.URL.User != nil || !(host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")) {
				return errors.New("invalid official runner redirect")
			}
			return nil
		}}
		req, e := http.NewRequestWithContext(ctx, "GET", g.DownloadURL, nil)
		if e != nil {
			return e
		}
		response, e := client.Do(req)
		if e != nil {
			return errors.New("official runner download failed")
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return fmt.Errorf("official runner download returned HTTP %d", response.StatusCode)
		}
		f, e := os.CreateTemp(cache, "download-*")
		if e != nil {
			return e
		}
		defer os.Remove(f.Name())
		h := sha256.New()
		n, e := io.Copy(io.MultiWriter(f, h), io.LimitReader(response.Body, 512*1024*1024+1))
		closeErr := f.Close()
		if e != nil {
			return e
		}
		if closeErr != nil {
			return closeErr
		}
		if n > 512*1024*1024 || hex.EncodeToString(h.Sum(nil)) != g.SHA256 {
			return errors.New("official runner checksum verification failed")
		}
		if e = os.Rename(f.Name(), archive); e != nil {
			return e
		}
	}
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	root := filepath.Join(directory, "runner")
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	files, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer files.Close()
	var total int64
	for {
		header, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
		clean := filepath.Clean(header.Name)
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return errors.New("unsafe official runner archive path")
		}
		total += header.Size
		if total > 2*1024*1024*1024 {
			return errors.New("official runner archive is too large")
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if e = files.MkdirAll(clean, 0700); e != nil {
				return e
			}
		case tar.TypeReg:
			if e = files.MkdirAll(filepath.Dir(clean), 0700); e != nil {
				return e
			}
			out, e := files.OpenFile(clean, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(header.Mode)&0755)
			if e != nil {
				return e
			}
			_, e = io.Copy(out, tr)
			closeErr := out.Close()
			if e != nil {
				return e
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink:
			resolved := filepath.Clean(filepath.Join(filepath.Dir(clean), header.Linkname))
			if filepath.IsAbs(header.Linkname) || resolved == ".." || strings.HasPrefix(resolved, "../") {
				return errors.New("unsafe official runner archive link")
			}
			if e = files.Symlink(header.Linkname, clean); e != nil {
				return e
			}
		default:
			return errors.New("unsupported official runner archive entry")
		}
	}
	return nil
}

// Output is infrastructure diagnostics only. Workflow logs are fetched from
// GitHub, where its runner has applied secret masking.
func runGitHubRunner(parent context.Context, request jobRequest, events *eventWriter) (jobResult, error) {
	ctx, cancel := context.WithTimeout(parent, time.Duration(request.TimeoutSeconds)*time.Second)
	defer cancel()
	g := request.GitHub
	masks := []string{g.Token}
	events.masks = &masks
	result := jobResult{Conclusion: "success", Outputs: map[string]string{}, Steps: map[string]stepResult{}}
	_ = events.write("started", map[string]interface{}{})
	_ = events.write("log", map[string]interface{}{"message": "Preparing the official GitHub runner."})
	if err := os.MkdirAll(request.Directory, 0700); err != nil {
		return result, err
	}
	if err := prepareGitHubRunner(ctx, g, request.Directory); err != nil {
		return result, err
	}
	runnerRoot := filepath.Join(request.Directory, "runner")
	environment := append(os.Environ(), "OPENSHIP_ACTION_WORKER_ID="+request.ID, "RUNNER_ALLOW_RUNASROOT=1")
	dockerName := "openship-github-" + request.ID
	var proxy *dockerOwnershipProxy
	if request.DockerSocket || g.Image != "" {
		var err error
		proxy, err = startDockerOwnershipProxy(request.Directory, request.ID, request.ContainerCPU, request.ContainerRAM)
		if err != nil {
			return result, err
		}
		defer proxy.Close()
		environment = append(environment, "DOCKER_HOST=unix://"+proxy.path)
	}
	defer func() {
		cleanup, c := context.WithTimeout(context.Background(), 60*time.Second)
		defer c()
		if request.DockerSocket || g.Image != "" {
			_ = cleanOwnedDocker(cleanup, request.ID)
		}
		_ = cleanNativeProcesses(cleanup, request.ID)
	}()
	if g.Image != "" {
		args := []string{"run", "--detach", "--name", dockerName, "--label", "io.openship.actions.job=" + request.ID, "--cpus", fmt.Sprint(request.ContainerCPU), "--memory", fmt.Sprintf("%dm", request.ContainerRAM), "--user", "0:0", "--workdir", runnerRoot, "--volume", request.Directory + ":" + request.Directory, "--env", "RUNNER_ALLOW_RUNASROOT=1", "--env", "OPENSHIP_ACTION_WORKER_ID=" + request.ID}
		if request.DockerSocket {
			args = append(args, "--volume", proxy.path+":/var/run/docker.sock", "--env", "DOCKER_HOST=unix:///var/run/docker.sock")
		}
		if request.ContainerPlatform != "" {
			args = append(args, "--platform", request.ContainerPlatform)
		}
		args = append(args, "--entrypoint", "/bin/sh", g.Image, "-c", "while :; do sleep 3600; done")
		if err := githubCommand(ctx, environment, "", nil, nil, "docker", args...); err != nil {
			return result, fmt.Errorf("GitHub runner container could not start: %w", err)
		}
	}
	command := func(env []string, stdin io.Reader, args ...string) error {
		binary := filepath.Join(runnerRoot, "bin", "Runner.Listener")
		if g.Image != "" {
			if stdin != nil {
				return githubCommand(ctx, environment, runnerRoot, stdin, events, "docker", append([]string{"exec", "-i", dockerName, "/bin/sh", "-c", `IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN; exec "$@"`, "sh", binary}, args...)...)
			}
			return githubCommand(ctx, environment, runnerRoot, nil, events, "docker", append([]string{"exec", dockerName, binary}, args...)...)
		}
		return githubCommand(ctx, env, runnerRoot, nil, events, binary, args...)
	}
	args := []string{"configure", "--unattended", "--ephemeral", "--disableupdate", "--url", "https://github.com/" + g.Repository, "--name", g.Name, "--labels", strings.Join(g.Labels, ","), "--work", filepath.Join(runnerRoot, "_work")}
	if err := command(append(environment, "ACTIONS_RUNNER_INPUT_TOKEN="+g.Token), strings.NewReader(g.Token+"\n"), args...); err != nil {
		return result, fmt.Errorf("GitHub runner registration failed; verify the runner image dependencies and repository permissions: %w", err)
	}
	// The registration token is never inherited by user workflow steps.
	g.Token = ""
	_ = events.write("log", map[string]interface{}{"message": "Runner registered. Waiting for GitHub to assign one job."})
	if err := command(environment, nil, "run", "--once"); err != nil {
		if parent.Err() != nil {
			result.Conclusion = "cancelled"
			return result, nil
		}
		if ctx.Err() != nil {
			result.Conclusion = "timed_out"
			return result, nil
		}
		return result, fmt.Errorf("GitHub runner exited before confirming shutdown: %w", err)
	}
	return result, nil
}

func githubCommand(ctx context.Context, env []string, dir string, input io.Reader, events *eventWriter, binary string, args ...string) error {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = env
	cmd.Dir = dir
	cmd.Stdin = input
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	// A descendant retaining stdout cannot hold cancellation open forever.
	cmd.WaitDelay = 5 * time.Second
	reader, writer := io.Pipe()
	cmd.Stdout = writer
	cmd.Stderr = writer
	done := make(chan struct{})
	lastLine := ""
	go func() {
		defer close(done)
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), 256*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if events != nil {
				line = events.redact(line)
				_ = events.write("log", map[string]interface{}{"message": line})
			}
			if strings.TrimSpace(line) != "" {
				if len(line) > 1024 {
					line = line[:1024]
				}
				lastLine = line
			}
		}
		_, _ = io.Copy(io.Discard, reader)
	}()
	err := cmd.Run()
	_ = writer.Close()
	<-done
	_ = reader.Close()
	if err != nil && lastLine != "" {
		return fmt.Errorf("%w: %s", err, lastLine)
	}
	return err
}
