/** Compose/Docker service identifiers are also written as discovery hostnames. */
export function isValidServiceName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}
