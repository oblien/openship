/**
 * The daemon adds its own desktop MCP after turn options. Codex thread config takes
 * precedence over CLI config, so enforce the server allowlist at the native stdio
 * boundary as well. Mindwire still owns every request, response and event.
 *
 * This standalone Node program is installed beside the private harness wrapper. It
 * contains no app data, credentials or alternate implementation of agent execution.
 */
export const CODEX_GUARD = String.raw`
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['pipe', 'inherit', 'inherit'] })
const exited = new Promise(resolve => { child.on('exit', code => resolve(code ?? 1)); child.on('error', () => resolve(1)) })
const stop = () => child.kill('SIGTERM')
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
const deny = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unavailable in OpenShip scoped conversations.' } }) + '\n')
function restrict(message) {
  if (['config/value/write', 'config/batchWrite', 'command/exec', 'fs/readFile', 'fs/writeFile'].includes(message.method)) return false
  if (!['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) return true
  const params = message.params ??= {}
  params.approvalPolicy = 'never'
  params.sandbox = 'read-only'
  delete params.dynamicTools
  const config = params.config ??= {}
  const allowed = new Set(['model_providers', 'model_reasoning_summary', 'model_auto_compact_token_limit', 'mcp_servers'])
  for (const key of Object.keys(config)) if (!allowed.has(key)) delete config[key]
  // Code Mode's collaboration controls use this setting, not features.multi_agent.
  config.agents = { enabled: false }
  const server = config.mcp_servers?.openship
  config.mcp_servers = {}
  if (server) {
    const url = new URL(server.url)
    const endpoint = process.env.OPENSHIP_ASSISTANT_MCP_URL
    const allowedUrl = endpoint ? server.url === endpoint && url.protocol === 'https:' : url.hostname === '127.0.0.1' && url.protocol === 'http:' && url.pathname === '/mcp'
    if (!allowedUrl || url.username || url.password || url.search || url.hash || server.command) return false
    if (!server.http_headers?.Authorization?.startsWith('Bearer ')) return false
    config.mcp_servers.openship = { url: server.url, http_headers: server.http_headers, enabled: true, default_tools_approval_mode: 'approve' }
  }
  // Replacing the MCP map does not remove lower configuration layers. Explicitly
  // disable the daemon's built-in server in the winning thread configuration.
  config.mcp_servers.mindwire_desktop = { url: 'http://127.0.0.1:1/disabled', enabled: false }
  return true
}
let buffer = ''
const input = (async () => {
  try {
    for await (const chunk of process.stdin) {
      buffer += chunk.toString()
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error('Native frame too large')
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (!restrict(message)) { deny(message); continue }
        if (!child.stdin.write(JSON.stringify(message) + '\n')) await once(child.stdin, 'drain')
      }
    }
    child.stdin.end()
  } catch { stop() }
})()
const status = await exited
process.off('SIGTERM', stop)
process.off('SIGINT', stop)
process.exit(status ?? 1)
`;
