/** Components every remote deployment target needs.
 *
 * DEPLOY_MODE describes the control plane, not the remote server. Remote
 * deployments use Docker and the managed edge is a container even when the
 * OpenShip control plane itself was installed in bare mode.
 */
export function resolveRequiredComponents(): string[] {
  return ["docker", "git"];
}
