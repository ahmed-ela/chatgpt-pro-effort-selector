export class PhaseTransitionError extends Error {
  constructor(currentPhase, eventName) {
    super(
      `Invalid one-shot transition: ${currentPhase} + ${eventName}`
    );
    this.name = "PhaseTransitionError";
    this.currentPhase = currentPhase;
    this.eventName = eventName;
  }
}

const CHATGPT_ORIGIN =
  "https://chatgpt.com";
const TEMPORARY_CONVERSATION_PATH_RE =
  /^\/c\/(?:WEB:|local-chatgpt(?::|%3[Aa]))[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_CONVERSATION_PATH_RE =
  /^\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLANK_DRAFT_PATHS =
  new Set(["/", "/new"]);
const PROVISIONAL_TRANSITION_PHASES =
  new Set([
    "armed",
    "settling",
    "processing",
    "sent",
    "cleaning",
    "sent_warning"
  ]);

const TRANSITIONS = Object.freeze({
  idle: Object.freeze({
    begin: "attaching"
  }),
  attaching: Object.freeze({
    attached: "enabling",
    fail: "failed"
  }),
  enabling: Object.freeze({
    enabled: "armed",
    fail: "failed"
  }),
  armed: Object.freeze({
    candidate: "settling",
    fail: "failed"
  }),
  settling: Object.freeze({
    unique: "processing",
    fail: "failed"
  }),
  processing: Object.freeze({
    continued: "sent",
    fail: "failed"
  }),
  sent: Object.freeze({
    cleanup: "cleaning",
    warning: "sent_warning"
  }),
  cleaning: Object.freeze({
    cleaned: "complete",
    warning: "sent_warning"
  }),
  sent_warning: Object.freeze({
    cleaned: "complete"
  }),
  complete: Object.freeze({}),
  failed: Object.freeze({})
});

export function transitionPhase(currentPhase, eventName) {
  const nextPhase =
    TRANSITIONS[currentPhase]?.[eventName];

  if (!nextPhase) {
    throw new PhaseTransitionError(
      currentPhase,
      eventName
    );
  }

  return nextPhase;
}

export function isPreSendActivePhase(phase) {
  return (
    phase === "attaching" ||
    phase === "enabling" ||
    phase === "armed" ||
    phase === "settling" ||
    phase === "processing"
  );
}

export function decideActiveSessionNavigation({
  currentPath,
  nextUrl,
  status = null,
  sameDocument = false,
  replayAuthorized = false,
  uiReplayStarted = false,
  provisionalTransitionUsed = false,
  canonicalTransitionUsed = false,
  canonicalTargetPath = null,
  requestContinued = false,
  hasSubmittedUserMessageId = false,
  phase
}) {
  let parsedUrl;

  try {
    parsedUrl = new URL(nextUrl);
  } catch {
    return Object.freeze({
      action: "fail"
    });
  }

  if (
    parsedUrl.origin !== CHATGPT_ORIGIN
  ) {
    return Object.freeze({
      action: "fail"
    });
  }

  if (
    sameDocument === true &&
    replayAuthorized === true &&
    uiReplayStarted === true &&
    provisionalTransitionUsed !== true &&
    BLANK_DRAFT_PATHS.has(currentPath) &&
    TEMPORARY_CONVERSATION_PATH_RE.test(
      parsedUrl.pathname
    ) &&
    PROVISIONAL_TRANSITION_PHASES.has(
      phase
    )
  ) {
    return Object.freeze({
      action: "advance",
      pagePath: parsedUrl.pathname,
      transition: "provisional"
    });
  }

  if (
    sameDocument === true &&
    provisionalTransitionUsed === true &&
    TEMPORARY_CONVERSATION_PATH_RE.test(
      currentPath
    ) &&
    CANONICAL_CONVERSATION_PATH_RE.test(
      parsedUrl.pathname
    ) &&
    canonicalTransitionUsed !== true &&
    canonicalTargetPath ===
      parsedUrl.pathname &&
    requestContinued === true &&
    hasSubmittedUserMessageId === true &&
    [
      "sent",
      "cleaning",
      "sent_warning"
    ].includes(phase)
  ) {
    return Object.freeze({
      action: "advance",
      pagePath: parsedUrl.pathname,
      transition: "canonical"
    });
  }

  if (status === "loading") {
    return Object.freeze({
      action: "fail"
    });
  }

  if (parsedUrl.pathname === currentPath) {
    return Object.freeze({
      action: "keep",
      pagePath: currentPath
    });
  }

  return Object.freeze({
    action: "fail"
  });
}

export function classifyLostOperation({
  requestContinued,
  pausedRequestCount,
  abortSucceeded,
  replayAuthorized = false,
  replayCancelled = false
}) {
  if (requestContinued) {
    return {
      status: "sent_warning",
      error: "worker_state_lost_after_send"
    };
  }

  if (pausedRequestCount > 0 && !abortSucceeded) {
    return {
      status: "uncertain",
      error: "outcome_uncertain"
    };
  }

  if (replayAuthorized && !replayCancelled) {
    return {
      status: "uncertain",
      error: "outcome_uncertain"
    };
  }

  return {
    status: "failed",
    error: "worker_state_lost"
  };
}
