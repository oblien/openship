/** Agent URLs stay shareable, while opening in place above a chat or flow draft. */
export function agentDrawerHref(href: string, pathname = "/assistant", search = "") {
  const match = /^\/assistant\/agents(?:\/([^/?#]+)(\/edit)?)?(?:\?([^#]*))?$/.exec(href);
  if (!match) return href;
  const params = new URLSearchParams(search);
  const options = new URLSearchParams(match[3]);
  params.set("agents", match[1] ? `${match[1]}${match[2] ?? ""}` : "all");
  for (const key of ["template", "project"]) {
    params.delete(`agent-${key}`);
    const value = options.get(key);
    if (value) params.set(`agent-${key}`, value);
  }
  return `${pathname}?${params}`;
}

export function closeAgentDrawerHref(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  for (const key of ["agents", "agent-template", "agent-project"]) params.delete(key);
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

export function agentDrawerView(search: string) {
  const params = new URLSearchParams(search);
  const route = params.get("agents");
  if (!route) return null;
  const [id, action] = route.split("/");
  return {
    id: id === "all" || id === "new" ? undefined : id,
    editing: id === "new" || action === "edit",
    template: params.get("agent-template") ?? undefined,
    project: params.get("agent-project") ?? undefined,
  };
}
