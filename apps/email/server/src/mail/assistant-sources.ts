export type MailSource = { id: string; folder: string; subject: string };
const active = new Map<string, Map<string, MailSource>>();

export function collectMailSources(grantId: string) {
  const sources = new Map<string, MailSource>();
  active.set(grantId, sources);
  return { values: () => [...sources.values()], close: () => active.delete(grantId) };
}

export function recordMailSource(grantId: string, source: MailSource) {
  const sources = active.get(grantId);
  if (sources && sources.size < 20) sources.set(`${source.folder}:${source.id}`, source);
}
