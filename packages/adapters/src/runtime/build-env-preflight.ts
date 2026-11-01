import { shellQuote } from "@repo/core";

/** Advisory only: an empty example value can be optional. Never source a dotenv
 * file or print values. Works in Node, Python, PHP, Ruby and compiled builders. */
export function buildEnvironmentPreflight(env: Record<string, string>): string {
  const configured = Object.entries(env)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== "")
    .map(([key]) => key);
  return `if [ -f .env.example ]; then awk -F= '/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ { key=$1; sub(/^[[:space:]]*export[[:space:]]+/, "", key); gsub(/[[:space:]]/, "", key); value=substr($0,index($0,"=")+1); sub(/[[:space:]]*#.*/, "", value); gsub(/[[:space:]]/, "", value); if (value == "" || value == "\\\"\\\"" || value == "\\047\\047") print key }' .env.example | while IFS= read -r key; do case ${shellQuote(` ${configured.join(" ")} `)} in *" $key "*) ;; *) if ! printenv "$key" >/dev/null 2>&1; then printf 'Environment warning: %s has an empty .env.example value and is not configured. Add it in Environment if required.\\n' "$key"; fi ;; esac; done; fi`;
}
