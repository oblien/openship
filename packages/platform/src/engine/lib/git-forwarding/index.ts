/**
 * Git credential forwarding — Desktop-only. One consumer:
 *   - `openDeployRelay` → project deployment (clone on a self-hosted server using
 *                          the operator's LOCAL `gh`, no build-local-then-upload).
 *
 * Forwards the local `gh` identity on demand over an SSH reverse tunnel, repo-pinned
 * to the deploy's repo; nothing is persisted on the remote. See ./README.md for the
 * design, the security model, and the out-of-folder touch points (the SSH reverse-
 * tunnel primitive, the deploy token fallback).
 */
export { openDeployRelay } from "./deploy";
export { type GitCredentialRelay } from "./relay";
