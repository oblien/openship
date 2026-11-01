/** Mail-server administration is available only on a local control plane.
 * Cloud runs the generic webmail app against an existing IMAP/SMTP backend. */
export function canManageMailServers({
  selfHosted,
  deployMode,
}: {
  selfHosted: boolean;
  deployMode?: string;
}): boolean {
  return selfHosted || deployMode === "desktop";
}
