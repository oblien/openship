import {
  diagnosticPath,
  errorReporter,
  reportError,
} from "@repo/core/diagnostics";

// Marketing has no authenticated instance/session. Its browser diagnostics use
// the same local reporter; this does not send visitors' data to Cloud analytics.
errorReporter.setContextProvider(() => ({
  source: "web",
  kind: "client",
  route: diagnosticPath(window.location.pathname),
}));

window.addEventListener("error", (event) => {
  if (event instanceof ErrorEvent) {
    reportError(event.error ?? event.message, {
      component: "web-browser",
      handled: false,
    });
  }
});
window.addEventListener("unhandledrejection", (event) => {
  reportError(event.reason, { component: "web-browser", handled: false });
});
