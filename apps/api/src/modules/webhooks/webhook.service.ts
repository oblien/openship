/**
 * Webhook service — verifies signatures and dispatches events.
 */

export async function verifyGitHubSignature(payload: string, signature: string, secret: string) {
  // TODO: HMAC-SHA256 verification
}

export async function handlePushEvent(projectId: string, branch: string, commitSha: string) {
  // TODO: Queue new deployment
}
