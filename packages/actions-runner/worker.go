// Package main is the execution-only bridge to act. Workflow scheduling and
// authorization belong to Openship; one invocation runs one concrete job.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nektos/act/pkg/common"
	"github.com/nektos/act/pkg/container"
	"github.com/nektos/act/pkg/model"
	"github.com/nektos/act/pkg/runner"
	"github.com/sirupsen/logrus"
)

const protocolVersion = 1
const maxRequestBytes = 2 * 1024 * 1024
const maxMessageBytes = 32 * 1024

type dependency struct {
	Result  string            `json:"result"`
	Outputs map[string]string `json:"outputs"`
}

type jobRequest struct {
	Version        int                    `json:"version"`
	ID             string                 `json:"id"`
	Workflow       string                 `json:"workflow"`
	WorkflowPath   string                 `json:"workflowPath"`
	Job            string                 `json:"job"`
	Directory      string                 `json:"directory"`
	EventName      string                 `json:"eventName"`
	Event          json.RawMessage        `json:"event"`
	Actor          string                 `json:"actor"`
	DefaultBranch  string                 `json:"defaultBranch"`
	Matrix         map[string]interface{} `json:"matrix"`
	Strategy       map[string]interface{} `json:"strategy"`
	Needs          map[string]dependency  `json:"needs"`
	Environment    map[string]string      `json:"environment"`
	Secrets        map[string]string      `json:"secrets"`
	Variables      map[string]string      `json:"variables"`
	Inputs         map[string]string      `json:"inputs"`
	Platforms      map[string]string      `json:"platforms"`
	TimeoutSeconds int                    `json:"timeoutSeconds"`
	ContainerCPU   float64                `json:"containerCpu"`
	ContainerRAM   int                    `json:"containerMemoryMb"`
	DockerSocket   bool                   `json:"dockerSocket"`
}

type jobResult struct {
	Conclusion string                `json:"conclusion"`
	Outputs    map[string]string     `json:"outputs"`
	Steps      map[string]stepResult `json:"steps"`
	Error      string                `json:"error,omitempty"`
}

type stepResult struct {
	Outcome    string `json:"outcome"`
	Conclusion string `json:"conclusion"`
}

// Only protocol events reach stdout. Action output always remains log data;
// it cannot masquerade as a worker result, even if it prints valid JSON.
type eventWriter struct {
	mu        sync.Mutex
	out       io.Writer
	seq       int
	masks     *[]string
	bytes     int
	truncated bool
}

func (w *eventWriter) redact(value string) string {
	if w.masks != nil {
		for _, secret := range *w.masks {
			if secret != "" {
				value = strings.ReplaceAll(value, secret, "***")
			}
		}
	}
	if len(value) > maxMessageBytes {
		value = value[:maxMessageBytes] + " [truncated]"
	}
	return value
}

func (w *eventWriter) write(kind string, fields map[string]interface{}) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.seq++
	if kind == "log" && w.bytes >= 8*1024*1024 {
		if w.truncated {
			return nil
		}
		w.truncated = true
		fields = map[string]interface{}{"level": "warning", "message": "Job log limit reached (8 MiB). Execution continues; additional output is not retained."}
	}
	fields["version"] = protocolVersion
	fields["sequence"] = w.seq
	fields["type"] = kind
	fields["time"] = time.Now().UTC().Format(time.RFC3339Nano)
	value, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	w.bytes += len(value) + 1
	_, err = w.out.Write(append(value, '\n'))
	return err
}

type protocolFormatter struct{ events *eventWriter }

func (f *protocolFormatter) Format(entry *logrus.Entry) ([]byte, error) {
	fields := map[string]interface{}{
		"level": entry.Level.String(), "message": f.events.redact(entry.Message),
	}
	// act attaches context values to its logger. Deliberately allow only step
	// identity and status fields, never arbitrary environments or secret maps.
	for _, key := range []string{"step", "stage", "stepResult", "jobResult"} {
		if value, ok := entry.Data[key]; ok {
			fields[key] = f.events.redact(fmt.Sprint(value))
		}
	}
	if value, ok := entry.Data["stepID"].([]string); ok && len(value) > 0 {
		fields["stepId"] = f.events.redact(strings.Join(value, "/"))
	}
	return nil, f.events.write("log", fields)
}

type loggerFactory struct{ events *eventWriter }

func (f loggerFactory) WithJobLogger() *logrus.Logger {
	l := logrus.New()
	l.SetLevel(logrus.InfoLevel)
	l.SetOutput(io.Discard)
	l.SetFormatter(&protocolFormatter{events: f.events})
	return l
}

func validateRequest(r jobRequest) error {
	if r.Version != protocolVersion || r.ID == "" || r.Job == "" || r.Workflow == "" {
		return errors.New("invalid Actions worker request")
	}
	if !filepath.IsAbs(r.Directory) || r.Directory == string(filepath.Separator) {
		return errors.New("Actions requires an absolute job directory")
	}
	if r.TimeoutSeconds < 1 || r.TimeoutSeconds > 6*60*60 {
		return errors.New("job timeout must be between 1 second and 6 hours")
	}
	if len(r.Platforms) == 0 {
		return errors.New("job has no authorized execution platform")
	}
	return nil
}

func runJob(parent context.Context, request jobRequest, events *eventWriter) (jobResult, error) {
	if err := validateRequest(request); err != nil {
		return jobResult{}, err
	}
	workflow, err := model.ReadWorkflow(strings.NewReader(request.Workflow), true)
	if err != nil {
		return jobResult{}, fmt.Errorf("invalid workflow: %w", err)
	}
	workflow.File = request.WorkflowPath
	job := workflow.GetJob(request.Job)
	if job == nil {
		return jobResult{}, errors.New("requested job is absent from the workflow")
	}
	// Reusable workflows are expanded by the controller. Running one here would
	// dispatch its jobs on this machine without capability or authorization checks.
	if job.Uses != "" {
		return jobResult{}, errors.New("reusable workflow jobs must be expanded before dispatch")
	}
	// The durable scheduler already evaluated this condition against every
	// ancestor. act sees one job only; re-evaluating here loses that context.
	job.If.Value = "always()"
	for _, name := range job.Needs() {
		value, ok := request.Needs[name]
		if !ok || workflow.Jobs[name] == nil {
			return jobResult{}, fmt.Errorf("missing dependency result for %s", name)
		}
		workflow.Jobs[name].Result = value.Result
		workflow.Jobs[name].Outputs = value.Outputs
	}
	if err := os.MkdirAll(request.Directory, 0o700); err != nil {
		return jobResult{}, err
	}
	options := ""
	if request.ContainerCPU > 0 {
		options += fmt.Sprintf(" --cpus=%g", request.ContainerCPU)
	}
	if request.ContainerRAM > 0 {
		options += fmt.Sprintf(" --memory=%dm", request.ContainerRAM)
	}
	socket := "-"
	if request.DockerSocket {
		socket = "/var/run/docker.sock"
	}
	config := &runner.Config{
		Workdir: request.Directory, ActionCacheDir: filepath.Join(request.Directory, ".actions-cache"),
		EventName: request.EventName, Actor: request.Actor, DefaultBranch: request.DefaultBranch,
		Env: request.Environment, Secrets: request.Secrets, Vars: request.Variables, Inputs: request.Inputs,
		Token: request.Secrets["GITHUB_TOKEN"], Platforms: request.Platforms,
		GitHubInstance: "github.com", RemoteName: "origin", LogOutput: true,
		AutoRemove: true, NoSkipCheckout: true, ForcePull: false, ConcurrentJobs: 1,
		ContainerDaemonSocket: socket, ContainerOptions: strings.TrimSpace(options),
		ContainerNetworkMode: "bridge",
	}
	// Match GitHub's two service addressing modes. An explicit job container
	// shares the service network; a host-style job uses published localhost
	// ports. Persistent runners accept trusted code only, and Cloud workers
	// have a private VM for each job.
	if len(job.Services) > 0 && job.Container() == nil {
		config.ContainerNetworkMode = "host"
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(request.TimeoutSeconds)*time.Second)
	defer cancel()
	ctx = container.WithExecutionOwner(ctx, request.ID)
	if usesDocker(request) {
		if err := prepareOwnedVolumes(ctx, request.ID); err != nil {
			return jobResult{}, err
		}
	}
	if request.Environment == nil {
		request.Environment = map[string]string{}
		config.Env = request.Environment
	}
	request.Environment["RUNNER_TRACKING_ID"] = "openship-action-" + request.ID
	rc := &runner.RunContext{
		Name: request.ID, JobName: request.Job, Config: config,
		Run: &model.Run{Workflow: workflow, JobID: request.Job}, Matrix: request.Matrix, RuntimeStrategy: request.Strategy,
		EventJSON: string(request.Event), StepResults: make(map[string]*model.StepResult),
	}
	for _, value := range request.Secrets {
		if value != "" {
			rc.Masks = append(rc.Masks, value)
		}
	}
	if token := request.Environment["ACTIONS_RUNTIME_TOKEN"]; token != "" {
		rc.Masks = append(rc.Masks, token)
	}
	events.masks = &rc.Masks
	ctx = runner.WithJobLoggerFactory(ctx, loggerFactory{events})
	ctx = common.WithJobErrorContainer(runner.WithJobLogger(ctx, request.Job, request.ID, config, &rc.Masks, request.Matrix))
	rc.ExprEval = rc.NewExpressionEvaluator(ctx)
	execute, err := rc.Executor()
	if err != nil {
		return jobResult{}, err
	}
	if err := events.write("started", map[string]interface{}{"job": request.Job}); err != nil {
		return jobResult{}, err
	}
	err = execute(ctx)
	if err == nil {
		err = common.JobError(ctx)
	}
	conclusion := job.Result
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		conclusion = "timed_out"
	} else if parent.Err() != nil {
		conclusion = "cancelled"
	} else if err != nil {
		conclusion = "failure"
	} else if conclusion == "" {
		conclusion = "skipped"
	}
	outputs := make(map[string]string)
	for key, value := range job.Outputs {
		// GitHub does not forward secret-valued outputs to downstream jobs.
		if value == events.redact(value) {
			outputs[key] = value
		}
	}
	steps := make(map[string]stepResult)
	for id, step := range rc.StepResults {
		steps[id] = stepResult{Outcome: fmt.Sprint(step.Outcome), Conclusion: fmt.Sprint(step.Conclusion)}
	}
	result := jobResult{Conclusion: conclusion, Outputs: outputs, Steps: steps}
	if err != nil {
		result.Error = events.redact(err.Error())
	}
	return result, nil
}

func boundedResult(result jobResult) jobResult {
	if result.Outputs == nil {
		result.Outputs = map[string]string{}
	}
	if result.Steps == nil {
		result.Steps = map[string]stepResult{}
	}
	data, err := json.Marshal(result)
	if err != nil || len(data) > 128*1024 {
		return jobResult{Conclusion: "failure", Outputs: map[string]string{}, Steps: map[string]stepResult{}, Error: "Job outputs exceeded the 128 KiB result limit. Upload large results as artifacts."}
	}
	return result
}
