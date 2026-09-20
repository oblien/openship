import { IssuesView } from "../issues/IssuesView";

/** Canonical operator-facing route. `/issues` remains available for old links. */
export default function MonitoringPage() {
  return <IssuesView />;
}
