import { AuditLog } from "./_components/AuditLog";

/**
 * Audit log — its own page in the rail, not a Settings tab.
 *
 * Nothing on it is a setting: you never change anything here, you read what already
 * happened. As a settings tab it sat three clicks from anywhere, which is how a review
 * surface goes unread. This route used to redirect INTO Settings; it now serves the page,
 * so old links keep working and land on the same content.
 */
export default function AuditPage() {
  return <AuditLog />;
}
