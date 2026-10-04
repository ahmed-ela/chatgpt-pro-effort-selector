const CAUSES = new Set([
  "state_store_failed", "attach_failed", "enable_failed", "arm_not_current",
  "replay_cancelled", "timeout", "malformed_event", "malformed_request",
  "model_mismatch", "duplicate_qualifying_request", "debugger_detached",
  "navigation", "tab_closed", "cdp_failure", "worker_state_lost",
  "cleanup_failed", "orphan_pause"
]);
const PHASES = new Set([
  "idle", "attaching", "enabling", "armed", "settling", "processing",
  "sent", "cleaning", "sent_warning", "complete", "failed"
]);

export function sanitizeDetachReason(reason) {
  return reason === "target_closed" || reason === "canceled_by_user"
    ? reason
    : null;
}

// Only bounded operational metadata is retained, never Chrome error text or
// request content. Older session records have no diagnostic and remain valid.
export function sanitizeDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    cause: CAUSES.has(value.cause) ? value.cause : null,
    observedAt: Number.isSafeInteger(value.observedAt) && value.observedAt > 0
      ? value.observedAt : null,
    phase: PHASES.has(value.phase) ? value.phase : null,
    replayAuthorized: value.replayAuthorized === true,
    uiReplayStarted: value.uiReplayStarted === true,
    requestContinued: value.requestContinued === true,
    pausedRequestCount: Number.isSafeInteger(value.pausedRequestCount)
      && value.pausedRequestCount >= 0
      ? Math.min(value.pausedRequestCount, 8) : 0,
    abortSucceeded: typeof value.abortSucceeded === "boolean"
      ? value.abortSucceeded : null,
    detachReason: sanitizeDetachReason(value.detachReason)
  };
}

export function createDiagnostic(state, cause, options = {}) {
  return sanitizeDiagnostic({
    cause,
    observedAt: Date.now(),
    phase: state.phase,
    replayAuthorized: state.replayAuthorized,
    uiReplayStarted: state.uiReplayStarted,
    requestContinued: state.requestContinued,
    pausedRequestCount: state.qualifyingRequestIds?.size
      ?? state.pausedRequestIds?.length ?? 0,
    abortSucceeded: options.abortSucceeded,
    detachReason: state.detachReason
  });
}

export function uncertainMessage(diagnostic) {
  const detail = sanitizeDiagnostic(diagnostic);
  const causes = {
    timeout: "The 10-second wait for a qualifying Pro request expired.",
    navigation: "The tab navigated while the request was being monitored.",
    tab_closed: "The ChatGPT tab closed while the request was being monitored.",
    debugger_detached: "Chrome detached the request monitor.",
    worker_state_lost: "An unfinished operation was recovered from session state.",
    duplicate_qualifying_request: detail?.requestContinued
      ? "The first request was continued as Extended, but an additional request could not be confirmed as blocked."
      : "Multiple matching requests were observed and their outcome could not be verified.",
    orphan_pause: "A request without an active operation could not be confirmed as blocked.",
    cdp_failure: "A Chrome debugger command failed.",
    state_store_failed: "The extension could not save the operation state.",
    malformed_event: "The captured request event could not be validated.",
    malformed_request: "The captured request did not match the expected format.",
    model_mismatch: "The captured request did not match a supported Pro model.",
    replay_cancelled: "The send action was cancelled, but a captured request could not be confirmed as blocked."
  };
  return [
    causes[detail?.cause],
    "Extended delivery could not be fully verified. Check the conversation before retrying to avoid a duplicate."
  ].filter(Boolean).join(" ");
}
