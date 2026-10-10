import { isMap, isScalar, isSeq } from "yaml";
import { workflowDocument, workflowEventConfig as object } from "./workflow-yaml";

export class WorkflowEditError extends Error {
  constructor(
    public readonly code: "cycle" | "missingJob" | "lastJob" | "referencedJob" | "jobMapping",
  ) {
    super(code);
  }
}

export function workflowJobs(source: string) {
  const doc = workflowDocument(source);
  const jobs = doc.get("jobs", true);
  if (!isMap(jobs)) throw new WorkflowEditError("jobMapping");
  const values = object(doc.toJS({ maxAliasCount: 50 }));
  return Object.entries(object(values.jobs)).map(([id, value]) => ({ id, value: object(value) }));
}

function jobDocument(source: string, id: string) {
  const doc = workflowDocument(source);
  if (!isMap(doc.getIn(["jobs", id], true))) throw new WorkflowEditError("missingJob");
  return doc;
}

/** Each inspector edit changes only its YAML node, preserving unrelated fields and comments. */
export function editWorkflowJob(source: string, id: string, field: string, value: unknown) {
  const doc = jobDocument(source, id);
  if (value === undefined || value === "") doc.deleteIn(["jobs", id, field]);
  else doc.setIn(["jobs", id, field], value);
  return String(doc);
}

export function addWorkflowJob(source: string) {
  const doc = workflowDocument(source);
  const jobs = doc.get("jobs", true);
  if (!isMap(jobs)) throw new WorkflowEditError("jobMapping");
  let id = "job";
  for (let n = 2; jobs.has(id); n++) id = `job_${n}`;
  doc.setIn(["jobs", id], {
    "runs-on": ["self-hosted", "linux"],
    steps: [{ run: "echo 'Ready to run'" }],
  });
  return { source: String(doc), id };
}

function needs(value: unknown): string[] {
  return typeof value === "string" ? [value] : Array.isArray(value) ? value.map(String) : [];
}

export function editWorkflowDependency(source: string, from: string, to: string, enabled: boolean) {
  const doc = jobDocument(source, to);
  const jobs = new Map(workflowJobs(source).map(({ id, value }) => [id, value]));
  if (!jobs.has(from)) throw new WorkflowEditError("missingJob");
  const reaches = (id: string, seen = new Set<string>()): boolean => {
    if (id === to) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return needs(jobs.get(id)?.needs).some((next) => reaches(next, seen));
  };
  if (enabled && reaches(from)) throw new WorkflowEditError("cycle");
  const previous = needs(jobs.get(to)?.needs);
  if (previous.includes(from) === enabled) return source;
  const values = enabled ? [...previous, from] : previous.filter((id) => id !== from);
  if (!values.length) doc.deleteIn(["jobs", to, "needs"]);
  else {
    const sequence = doc.getIn(["jobs", to, "needs"], true);
    if (isSeq(sequence)) {
      if (enabled) sequence.add(from);
      else sequence.items = sequence.items.filter((node) => !isScalar(node) || node.value !== from);
    } else doc.setIn(["jobs", to, "needs"], values);
  }
  return String(doc);
}

export function removeWorkflowJob(source: string, id: string) {
  const doc = jobDocument(source, id);
  const jobs = doc.get("jobs", true);
  if (!isMap(jobs)) throw new WorkflowEditError("jobMapping");
  if (jobs.items.length < 2) throw new WorkflowEditError("lastJob");
  // Deleting a node must not leave expressions reading outputs from a missing job.
  const safeId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = new RegExp(`\\bneeds(?:\\.${safeId}\\b|\\[\\s*['\"]${safeId}['\"]\\s*\\])`);
  const referencesJob = (value: unknown, field = ""): boolean => {
    if (typeof value === "string")
      return field === "if"
        ? reference.test(value)
        : [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].some((match) => reference.test(match[1]!));
    if (Array.isArray(value)) return value.some((item) => referencesJob(item));
    return Object.entries(object(value)).some(([key, item]) => referencesJob(item, key));
  };
  if (workflowJobs(source).some((job) => job.id !== id && referencesJob(job.value)))
    throw new WorkflowEditError("referencedJob");
  // Reuse the dependency edit so shorthand and sequence forms stay equivalent.
  let updated = source;
  for (const job of workflowJobs(source))
    if (job.id !== id && needs(job.value.needs).includes(id))
      updated = editWorkflowDependency(updated, id, job.id, false);
  const next = jobDocument(updated, id);
  next.deleteIn(["jobs", id]);
  return String(next);
}

export function workflowJobOffset(source: string, id: string) {
  const node = jobDocument(source, id).getIn(["jobs", id], true);
  return isMap(node) ? (node.range?.[0] ?? 0) : 0;
}

export function editWorkflowStep(
  source: string,
  id: string,
  index: number,
  patch: Record<string, unknown>,
) {
  const doc = jobDocument(source, id);
  if (!isMap(doc.getIn(["jobs", id, "steps", index], true)))
    throw new WorkflowEditError("jobMapping");
  for (const [key, value] of Object.entries(patch)) {
    const path = ["jobs", id, "steps", index, key];
    if (value === undefined) doc.deleteIn(path);
    else doc.setIn(path, value);
  }
  return String(doc);
}

export function changeWorkflowSteps(
  source: string,
  id: string,
  index: number,
  action: "add" | "remove" | "up" | "down",
) {
  const doc = jobDocument(source, id);
  const steps = doc.getIn(["jobs", id, "steps"], true);
  if (!isSeq(steps)) throw new WorkflowEditError("jobMapping");
  if (action === "add") steps.add({ run: "echo 'New step'" });
  else if (action === "remove") steps.delete(index);
  else {
    const target = index + (action === "up" ? -1 : 1);
    if (target < 0 || target >= steps.items.length) return source;
    [steps.items[index], steps.items[target]] = [steps.items[target]!, steps.items[index]!];
  }
  return String(doc);
}
