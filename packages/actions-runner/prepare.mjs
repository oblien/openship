// Reproducible, minimal upstream fixes in a generated module. Never modify the
// shared module cache or vendor another workflow engine into the application.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const directory = fileURLToPath(new URL(".", import.meta.url));
export function prepareRunnerModule() {
  // `go list -m` may succeed without a Dir when only go.mod is cached. Download
  // the pinned source (verified against go.sum) before reading or patching it.
  const module = spawnSync("go", ["mod", "download", "-json", "github.com/nektos/act"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (module.status !== 0)
    throw new Error(module.stderr || module.stdout || "Cannot download pinned act module", {
      cause: module.error,
    });
  const info = JSON.parse(module.stdout);
  if (info.Error || typeof info.Dir !== "string" || !info.Dir)
    throw new Error(info.Error || "Downloaded act module has no source directory");
  if (info.Version !== "v0.2.89")
    throw new Error("Review the native execution fixes when updating act");
  const original = join(info.Dir, "pkg/container/host_environment.go");
  let source = readFileSync(original, "utf8");
  const replace = (before, after) => {
    if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before))
      throw new Error("act patch does not match the pinned source");
    source = source.replace(before, after);
  };
  replace('\t"strings"\n', '\t"strings"\n\t"sync/atomic"\n\t"syscall"\n');
  replace("AutoStop  bool", "AutoStop  atomic.Bool");
  replace("if w.AutoStop &&", "if w.AutoStop.Load() &&");
  replace("writer.AutoStop = true", "writer.AutoStop.Store(true)");
  // The upstream native runner kills only the shell on cancellation. Both the
  // PTY and non-PTY paths create a private process group; reap its children too.
  replace(
    "\terr = cmd.Run()\n",
    `\tcmd.Cancel = func() error {
\t\tif cmd.Process == nil { return os.ErrProcessDone }
\t\terr := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
\t\tif errors.Is(err, syscall.ESRCH) { return os.ErrProcessDone }
\t\treturn err
\t}
\terr = cmd.Run()
`,
  );
  // Drain the PTY before returning a failed step as well as a successful one.
  replace(
    "\tif err != nil {\n\t\treturn err\n\t}\n\tif tty != nil {\n\t\twriter.AutoStop.Store(true)",
    "\tif tty != nil {\n\t\twriter.AutoStop.Store(true)",
  );
  const generated = join(directory, ".generated");
  mkdirSync(generated, { recursive: true });
  const output = mkdtempSync(join(generated, "build-"));
  process.once("exit", () => rmSync(output, { recursive: true, force: true }));
  const patched = join(output, "act");
  cpSync(info.Dir, patched, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes("testdata") && !path.endsWith("_test.go"),
  });
  // Go's module cache is read-only. Make only our generated directories
  // writable so cleanup works on macOS as well as Linux.
  const writableDirectories = (path) => {
    chmodSync(path, 0o755);
    for (const item of readdirSync(path, { withFileTypes: true }))
      if (item.isDirectory()) writableDirectories(join(path, item.name));
  };
  writableDirectories(patched);
  chmodSync(join(patched, "pkg/container/host_environment.go"), 0o644);
  writeFileSync(join(patched, "pkg/container/host_environment.go"), source);
  source = readFileSync(join(patched, "pkg/runner/run_context.go"), "utf8");
  replace(
    "\tMatrix              map[string]interface{}\n",
    "\tMatrix              map[string]interface{}\n\tRuntimeStrategy     map[string]interface{}\n\tRuntimeServices     map[string]model.ServiceContext\n\tRuntimeContainer    model.ContainerContext\n",
  );
  replace(
    'return createContainerName("act", rc.String())',
    "return container.ExecutionResourcePrefix(rc.Name)",
  );
  replace(
    '"act-toolcache": "/opt/hostedtoolcache",',
    'name + "-toolcache": "/opt/hostedtoolcache",',
  );
  // A workflow container must not discard the destination's resource limits.
  replace(
    "return rc.ExprEval.Interpolate(ctx, c.Options)",
    'return rc.ExprEval.Interpolate(ctx, c.Options) + " " + rc.Config.ContainerOptions',
  );
  replace(
    "Options:        rc.ExprEval.Interpolate(ctx, spec.Options),",
    'Options:        rc.ExprEval.Interpolate(ctx, spec.Options) + " " + rc.Config.ContainerOptions,',
  );
  replace(
    "\t\t\trc.waitForServiceContainers(),",
    "\t\t\trc.waitForServiceContainers(),\n\t\t\trc.loadContainerContext(),",
  );
  replace(
    "\t\tStatus: jobStatus,",
    "\t\tStatus: jobStatus,\n\t\tServices: rc.RuntimeServices,\n\t\tContainer: rc.RuntimeContainer,",
  );
  const contextPath = join(patched, "pkg/runner/run_context.go");
  chmodSync(contextPath, 0o644);
  writeFileSync(contextPath, source);
  // act does not populate job.services.*.ports. Preserve GitHub's dynamic port
  // context from Docker's actual bindings, instead of guessing free ports.
  chmodSync(join(patched, "pkg/model/job_context.go"), 0o644);
  writeFileSync(
    join(patched, "pkg/model/job_context.go"),
    `package model
type ContainerContext struct { ID string \`json:"id"\`; Network string \`json:"network"\` }
type ServiceContext struct { ID string \`json:"id"\`; Network string \`json:"network"\`; Ports map[string]string \`json:"ports"\` }
type JobContext struct { Status string \`json:"status"\`; Container ContainerContext \`json:"container"\`; Services map[string]ServiceContext \`json:"services"\` }
`,
  );
  writeFileSync(
    join(patched, "pkg/runner/openship_context.go"),
    `package runner
import ("context"; "github.com/nektos/act/pkg/common"; "github.com/nektos/act/pkg/container"; "github.com/nektos/act/pkg/model")
func (rc *RunContext) loadContainerContext() common.Executor {
  return func(ctx context.Context) error {
    rc.RuntimeServices = make(map[string]model.ServiceContext)
    for _, service := range rc.ServiceContainers {
      name, id, network, ports, err := container.ExecutionDetails(ctx, service)
      if err != nil { return err }
      rc.RuntimeServices[name] = model.ServiceContext{ID: id, Network: network, Ports: ports}
    }
    _, id, network, _, err := container.ExecutionDetails(ctx, rc.JobContainer)
    if err != nil { return err }
    rc.RuntimeContainer = model.ContainerContext{ID: id, Network: network}
    rc.ExprEval = rc.NewExpressionEvaluator(ctx)
    return nil
  }
}
`,
  );
  writeFileSync(
    join(patched, "pkg/container/openship_context.go"),
    `package container
import ("context"; "fmt"; "github.com/moby/moby/client")
func ExecutionDetails(ctx context.Context, environment ExecutionsEnvironment) (string, string, string, map[string]string, error) {
  cr, ok := environment.(*containerReference)
  if !ok { return "", "", "", nil, fmt.Errorf("container context requires a Docker environment") }
  result, err := cr.cli.ContainerInspect(ctx, cr.id, client.ContainerInspectOptions{})
  if err != nil { return "", "", "", nil, err }
  ports := make(map[string]string)
  network := ""
  if settings := result.Container.NetworkSettings; settings != nil {
    for port, bindings := range settings.Ports { if len(bindings) > 0 { ports[fmt.Sprint(port.Num())] = bindings[0].HostPort } }
    for _, endpoint := range settings.Networks { network = endpoint.NetworkID; break }
  }
  name := cr.input.Name
  if len(cr.input.NetworkAliases) > 0 { name = cr.input.NetworkAliases[0] }
  return name, result.Container.ID, network, ports, nil
}
`,
  );
  source = readFileSync(join(patched, "pkg/runner/expression.go"), "utf8");
  replace("Strategy:  strategy,", "Strategy:  rc.runtimeStrategy(strategy),");
  replace("Strategy: strategy,", "Strategy: rc.runtimeStrategy(strategy),");
  source += `
// OpenShip schedules the matrix; preserve its concrete strategy context.
func (rc *RunContext) runtimeStrategy(value map[string]interface{}) map[string]interface{} {
  for key, item := range rc.RuntimeStrategy { value[key] = item }
  return value
}
`;
  const expressionPath = join(patched, "pkg/runner/expression.go");
  chmodSync(expressionPath, 0o644);
  writeFileSync(expressionPath, source);
  // GitHub coerces numeric object indexes to strings (job.services.db.ports[5432]).
  // act handled numeric array indexes only, returning an empty value for ports.
  source = readFileSync(join(patched, "pkg/exprparser/interpreter.go"), "utf8");
  replace(
    "\tcase reflect.Int:\n\t\tswitch leftValue.Kind() {\n\t\tcase reflect.Slice:",
    "\tcase reflect.Int:\n\t\tswitch leftValue.Kind() {\n\t\tcase reflect.Map:\n\t\t\treturn impl.getPropertyValue(leftValue, fmt.Sprint(rightValue.Int()))\n\t\tcase reflect.Slice:",
  );
  const interpreterPath = join(patched, "pkg/exprparser/interpreter.go");
  chmodSync(interpreterPath, 0o644);
  writeFileSync(interpreterPath, source);
  // The controller recovers only resources explicitly owned by this attempt.
  // Apply the label after Docker option merging so workflow options cannot
  // replace it; this covers job, service and Docker-action containers.
  source = readFileSync(join(patched, "pkg/container/docker_run.go"), "utf8");
  // Emulated jobs must expose their execution architecture to setup actions and
  // runner.arch expressions, rather than the Docker daemon's physical CPU.
  replace(
    "func RunnerArch(ctx context.Context) string {\n",
    "func RunnerArch(ctx context.Context) string {\n\tif arch, ok := ctx.Value(executionPlatformKey{}).(string); ok { return arch }\n",
  );
  writeFileSync(
    join(patched, "pkg/container/openship_platform.go"),
    `package container
import "context"
type executionPlatformKey struct{}
func WithExecutionPlatform(ctx context.Context, platform string) context.Context {
  switch platform {
  case "linux/amd64": return context.WithValue(ctx, executionPlatformKey{}, "X64")
  case "linux/arm64": return context.WithValue(ctx, executionPlatformKey{}, "ARM64")
  default: return ctx
  }
}
`,
  );

  replace(
    "\t\tcreateResult, err := cr.cli.ContainerCreate(ctx,",
    "\t\tconfig.Labels = ExecutionLabels(ctx, config.Labels)\n\t\tcreateResult, err := cr.cli.ContainerCreate(ctx,",
  );
  const dockerPath = join(patched, "pkg/container/docker_run.go");
  chmodSync(dockerPath, 0o644);
  writeFileSync(dockerPath, source);
  source = readFileSync(join(patched, "pkg/container/docker_network.go"), "utf8");
  replace('Driver: "bridge",', 'Driver: "bridge",\n\t\t\tLabels: ExecutionLabels(ctx, nil),');
  const networkPath = join(patched, "pkg/container/docker_network.go");
  chmodSync(networkPath, 0o644);
  writeFileSync(networkPath, source);
  writeFileSync(
    join(patched, "pkg/container/openship_owner.go"),
    `package container
import ("context"; "crypto/sha256"; "fmt")
type executionOwnerKey struct{}
const ExecutionOwnerLabel = "io.openship.actions.job"
func WithExecutionOwner(ctx context.Context, id string) context.Context { return context.WithValue(ctx, executionOwnerKey{}, id) }
func ExecutionLabels(ctx context.Context, labels map[string]string) map[string]string {
  if id, ok := ctx.Value(executionOwnerKey{}).(string); ok && id != "" {
    if labels == nil { labels = make(map[string]string) }
    labels[ExecutionOwnerLabel] = id
  }
  return labels
}
func ExecutionResourcePrefix(id string) string { sum := sha256.Sum256([]byte(id)); return fmt.Sprintf("openship-actions-%x", sum[:16]) }
`,
  );
  const modfile = join(output, "runner.mod");
  writeFileSync(
    modfile,
    readFileSync(join(directory, "go.mod"), "utf8") +
      `\nreplace github.com/nektos/act => ${JSON.stringify(patched)}\n`,
  );
  cpSync(join(directory, "go.sum"), join(output, "runner.sum"));
  return modfile;
}
