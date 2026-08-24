import {
  CHATGPT_ORIGIN,
  CONVERSATION_PATH,
  RequestValidationError,
  inspectPausedRequest,
  isQualifyingConversationPause,
  prepareExtendedContinuation
} from "../core/request-core.mjs";
import {
  classifyLostOperation,
  decideActiveSessionNavigation,
  isPreSendActivePhase,
  transitionPhase
} from "../core/state-core.mjs";

const MESSAGE_SOURCE = "chatgpt-pro-effort-selector";
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const CAPTURE_TIMEOUT_MS = 10_000;
const DUPLICATE_SETTLE_MS = 75;
const CLEANUP_RETRY_MS = 750;
const MAX_CLEANUP_ATTEMPTS = 3;
const NAVIGATION_CONFIRM_TIMEOUT_MS = 1_000;
const RECENT_HISTORY_CONFIRM_MS = 1_500;

const SESSION_STORAGE_KEY = "proEffortRuntimeV1";

const CONVERSATION_UUID_PATH_RE =
  /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const TEMPORARY_CONVERSATION_PATH_RE =
  /^\/c\/WEB:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const FETCH_PATTERNS = Object.freeze([
  Object.freeze({
    urlPattern: "https://chatgpt.com/backend-api/f/conversation*",
    resourceType: "XHR",
    requestStage: "Request"
  }),
  Object.freeze({
    urlPattern: "https://chatgpt.com/backend-api/f/conversation*",
    resourceType: "Fetch",
    requestStage: "Request"
  })
]);

/*
 * activeSessions contains live JS objects and fresh paused-event data only
 * while the service worker is alive. runtimeState is mirrored only into
 * chrome.storage.session, which is memory-scoped to the browser session.
 */
const activeSessions = new Map();

let runtimeState = {
  active: {},
  audits: {}
};

let persistQueue = Promise.resolve();

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(
      target,
      DEBUGGER_PROTOCOL_VERSION,
      () => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error("debugger_attach_failed"));
          return;
        }

        resolve();
      }
    );
  });
}

function debuggerCommand(target, method, parameters = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(
      target,
      method,
      parameters,
      (result) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error("debugger_command_failed"));
          return;
        }

        resolve(result);
      }
    );
  });
}

function debuggerDetach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error("debugger_detach_failed"));
        return;
      }

      resolve();
    });
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error("tab_lookup_failed"));
        return;
      }

      resolve(tab);
    });
  });
}

function tabsSendMessage(
  tabId,
  message,
  documentId = null
) {
  return new Promise((resolve) => {
    const callback = () => {
      /*
       * A missing receiver is expected after navigation, tab closure, or
       * extension reload. Reading lastError suppresses Chrome's warning.
       */
      void chrome.runtime.lastError;
      resolve();
    };

    if (
      typeof documentId === "string" &&
      documentId.length > 0
    ) {
      chrome.tabs.sendMessage(
        tabId,
        message,
        { documentId },
        callback
      );
      return;
    }

    chrome.tabs.sendMessage(
      tabId,
      message,
      callback
    );
  });
}

function storageSessionGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get([key], (values) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(
          new Error("session_storage_read_failed")
        );
        return;
      }

      resolve(values?.[key]);
    });
  });
}

function storageSessionSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.set(
      {
        [SESSION_STORAGE_KEY]: value
      },
      () => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(
            new Error("session_storage_write_failed")
          );
          return;
        }

        resolve();
      }
    );
  });
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function queuePersistRuntimeState() {
  const snapshot = cloneJsonValue(runtimeState);

  persistQueue = persistQueue
    .catch(() => undefined)
    .then(() => storageSessionSet(snapshot));

  return persistQueue;
}

async function persistRequired() {
  try {
    await queuePersistRuntimeState();
    return true;
  } catch {
    return false;
  }
}

function scalarOrNull(value) {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  )
    ? value
    : null;
}

function sanitizeTriple(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  return {
    model: scalarOrNull(value.model),
    thinking_effort:
      scalarOrNull(value.thinking_effort),
    client_prepare_state:
      scalarOrNull(value.client_prepare_state)
  };
}

function sanitizeAudit(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  return {
    generationId:
      typeof value.generationId === "string"
        ? value.generationId
        : null,
    method:
      typeof value.method === "string"
        ? value.method
        : null,
    path:
      typeof value.path === "string"
        ? value.path
        : null,
    resourceType:
      typeof value.resourceType === "string"
        ? value.resourceType
        : null,
    original: sanitizeTriple(value.original),
    forced: sanitizeTriple(value.forced),
    removedHeaderNames:
      Array.isArray(value.removedHeaderNames)
        ? value.removedHeaderNames
            .filter((name) => typeof name === "string")
            .slice(0, 32)
        : [],
    submittedUserMessageId:
      typeof value.submittedUserMessageId === "string"
        ? value.submittedUserMessageId
        : null,
    status:
      typeof value.status === "string"
        ? value.status
        : "failed",
    error:
      typeof value.error === "string"
        ? value.error
        : null
  };
}

function sanitizeActiveRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isInteger(value.tabId) ||
    value.tabId < 0 ||
    typeof value.generationId !== "string"
  ) {
    return null;
  }

  return {
    tabId: value.tabId,
    generationId: value.generationId,
    documentId:
      typeof value.documentId === "string"
        ? value.documentId
        : null,
    phase:
      typeof value.phase === "string"
        ? value.phase
        : "failed",
    pagePath:
      typeof value.pagePath === "string"
        ? value.pagePath
        : null,
    startedAt:
      Number.isFinite(value.startedAt)
        ? value.startedAt
        : 0,
    requestContinued:
      value.requestContinued === true,
    replayAuthorized:
      value.replayAuthorized === true,
    uiReplayStarted:
      value.uiReplayStarted === true,
    pausedRequestIds:
      Array.isArray(value.pausedRequestIds)
        ? value.pausedRequestIds
            .filter(
              (requestId) =>
                typeof requestId === "string" &&
                requestId.length > 0
            )
            .slice(0, 8)
        : []
  };
}

function sanitizeRuntimeState(value) {
  const next = {
    active: {},
    audits: {}
  };

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return next;
  }

  if (
    value.active &&
    typeof value.active === "object" &&
    !Array.isArray(value.active)
  ) {
    for (const [key, record] of Object.entries(value.active)) {
      const sanitized = sanitizeActiveRecord(record);

      if (sanitized) {
        next.active[String(sanitized.tabId)] =
          sanitized;
      }
    }
  }

  if (
    value.audits &&
    typeof value.audits === "object" &&
    !Array.isArray(value.audits)
  ) {
    for (const [key, audit] of Object.entries(value.audits)) {
      const sanitized = sanitizeAudit(audit);

      if (sanitized) {
        next.audits[String(key)] = sanitized;
      }
    }
  }

  return next;
}

function parseAllowedChatgptUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);

    if (parsed.origin !== CHATGPT_ORIGIN) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function senderMatchesSession(sender, session) {
  if (
    sender.tab?.id !== session.tabId ||
    sender.frameId !== 0
  ) {
    return false;
  }

  if (
    session.documentId &&
    sender.documentId &&
    session.documentId !== sender.documentId
  ) {
    return false;
  }

  const parsedUrl = parseAllowedChatgptUrl(
    sender.url ?? sender.tab?.url
  );

  return (
    parsedUrl !== null &&
    parsedUrl.pathname === session.pagePath
  );
}

function senderOwnsSessionDocument(
  sender,
  session
) {
  const parsedUrl = parseAllowedChatgptUrl(
    sender.url ?? sender.tab?.url
  );

  return (
    sender.tab?.id === session.tabId &&
    sender.frameId === 0 &&
    typeof session.documentId === "string" &&
    session.documentId.length > 0 &&
    sender.documentId === session.documentId &&
    parsedUrl !== null
  );
}

function createMinimalAudit(session, status, error) {
  return {
    generationId: session.generationId,
    method: session.audit?.method ?? null,
    path: session.audit?.path ?? null,
    resourceType:
      session.audit?.resourceType ?? null,
    original: session.audit?.original ?? null,
    forced: session.audit?.forced ?? null,
    removedHeaderNames:
      session.audit?.removedHeaderNames ?? [],
    submittedUserMessageId:
      session.audit?.submittedUserMessageId ?? null,
    status,
    error
  };
}

function setAudit(tabId, audit) {
  runtimeState.audits[String(tabId)] =
    sanitizeAudit(audit);
}

function deleteAudit(tabId) {
  delete runtimeState.audits[String(tabId)];
}

function recordActiveSession(session) {
  runtimeState.active[String(session.tabId)] = {
    tabId: session.tabId,
    generationId: session.generationId,
    documentId: session.documentId,
    phase: session.phase,
    pagePath: session.pagePath,
    startedAt: session.startedAt,
    requestContinued:
      session.requestContinued === true,
    replayAuthorized:
      session.replayAuthorized === true,
    uiReplayStarted:
      session.uiReplayStarted === true,
    pausedRequestIds: [
      ...session.qualifyingRequestIds
    ]
  };
}

function deleteActiveRecord(tabId) {
  delete runtimeState.active[String(tabId)];
}

function clearTimer(timerId) {
  if (timerId !== null) {
    clearTimeout(timerId);
  }
}

function clearSessionTimers(session) {
  clearTimer(session.captureTimer);
  clearTimer(session.settleTimer);
  clearTimer(session.cleanupTimer);
  clearTimer(session.navigationTimer);

  session.captureTimer = null;
  session.settleTimer = null;
  session.cleanupTimer = null;
  session.navigationTimer = null;
  session.pendingNavigationUrl = null;
}

function statusMessageFor(code, status) {
  if (status === "uncertain") {
    return (
      "Chrome detached or lost one-shot state after the normal UI action " +
      "had begun. The extension cannot honestly prove whether Chrome " +
      "released an untouched request. Treat the result as blocked or " +
      "uncertain; do not rely on it as proof of Extended."
    );
  }

  if (status === "sent_warning") {
    const sentWarnings = {
      cleanup_failed:
        "The request was sent as Extended, but complete interception cleanup was not confirmed. Do not open DevTools until Chrome's debugger indication disappears.",
      duplicate_qualifying_request:
        "One request was already sent as Extended and a later duplicate qualifying pause was blocked. Repeat the send without a warning before relying on it.",
      debugger_detached:
        "The request had already been continued as Extended when Chrome detached the debugger, but complete cleanup was not confirmed.",
      worker_state_lost_after_send:
        "The request had already been continued as Extended before service-worker state was lost, but complete cleanup was not confirmed."
    };

    return (
      sentWarnings[code] ??
      "The request was sent as Extended, but a debugger cleanup warning remains. Repeat the send without a warning before relying on it."
    );
  }

  const failures = {
    state_store_failed:
      "The extension could not establish restart-safe one-shot state, so it did not attach the debugger.",
    attach_failed:
      "Chrome could not attach its debugger to this ChatGPT tab. Close DevTools and try again.",
    enable_failed:
      "Chrome attached, but the exact two-pattern Fetch gate could not be enabled.",
    arm_not_current:
      "The one-shot arm was no longer current, so the original UI submission was not replayed.",
    replay_cancelled:
      "ChatGPT's original UI submission could not be replayed after arming, so the debugger gate was cancelled.",
    timeout:
      "No qualifying Pro conversation request appeared within 10 seconds. The one-shot operation was cancelled.",
    malformed_event:
      "The paused CDP event was malformed, so the operation was blocked.",
    malformed_request:
      "The fresh conversation request did not match the required schema, so it was blocked.",
    model_mismatch:
      "The fresh request was not exactly gpt-5-6-pro, so it was blocked.",
    duplicate_qualifying_request:
      "More than one qualifying conversation request was observed. The paused requests were aborted where Chrome still allowed it.",
    debugger_detached:
      "Chrome detached the debugger before the qualifying request was safely continued as Extended.",
    navigation:
      "The tab navigated while Extended was armed. The one-shot operation was cancelled.",
    tab_closed:
      "The ChatGPT tab closed while Extended was armed.",
    cdp_failure:
      "A Chrome debugger command failed. The qualifying request was aborted where Chrome still allowed it.",
    worker_state_lost:
      "The service worker lost an armed one-shot operation. Any retained paused request was aborted before cleanup where Chrome allowed it.",
    orphan_pause:
      "A paused request arrived without a current one-shot generation. It was handled conservatively and the debugger was detached."
  };

  return failures[code] ?? "The Extended operation failed closed.";
}

function publicStateFromAudit(audit) {
  if (!audit) {
    return {
      phase: "ready",
      label: "Ready",
      message:
        "Extended will arm immediately before the next normal Pro submission.",
      submittedUserMessageId: null
    };
  }

  if (audit.status === "sent") {
    return {
      phase: "sent",
      label: "Sent as Extended",
      message:
        "The fresh paused Pro request was continued with Extended effort.",
      submittedUserMessageId:
        audit.submittedUserMessageId
    };
  }

  if (audit.status === "sent_warning") {
    return {
      phase: "warning",
      label: "Sent as Extended; warning",
      message: statusMessageFor(
        audit.error,
        audit.status
      ),
      submittedUserMessageId:
        audit.submittedUserMessageId
    };
  }

  if (audit.status === "uncertain") {
    return {
      phase: "failed",
      label: "Extended outcome uncertain",
      message: statusMessageFor(
        audit.error,
        audit.status
      ),
      submittedUserMessageId:
        audit.submittedUserMessageId
    };
  }

  return {
    phase: "failed",
    label: "Extended blocked",
    message: statusMessageFor(
      audit.error,
      "failed"
    ),
    submittedUserMessageId:
      audit.submittedUserMessageId
  };
}

async function notifyTab(
  tabId,
  payload,
  documentId = null
) {
  await tabsSendMessage(
    tabId,
    {
      source: MESSAGE_SOURCE,
      type: "status",
      ...payload
    },
    documentId
  );
}

async function notifySession(session, payload) {
  await notifyTab(
    session.tabId,
    {
      generationId: session.generationId,
      ...payload
    },
    session.documentId
  );
}

async function tryAbortRequest(target, requestId) {
  if (
    typeof requestId !== "string" ||
    requestId.length === 0
  ) {
    return false;
  }

  try {
    await debuggerCommand(
      target,
      "Fetch.failRequest",
      {
        requestId,
        errorReason: "Aborted"
      }
    );
    return true;
  } catch {
    return false;
  }
}

async function tryClearPatterns(target) {
  try {
    await debuggerCommand(
      target,
      "Fetch.enable",
      {
        patterns: []
      }
    );
    return true;
  } catch {
    return false;
  }
}

async function tryDetachSession(session) {
  if (!session.attached || session.detached) {
    return true;
  }

  session.expectedDetach = true;

  try {
    await debuggerDetach(session.target);
    session.detached = true;
    return true;
  } catch {
    session.expectedDetach = false;
    return false;
  }
}

async function tryDetachTarget(target) {
  try {
    await debuggerDetach(target);
    return true;
  } catch {
    return false;
  }
}

function createSession(sender, parsedUrl) {
  const tabId = sender.tab.id;

  return {
    tabId,
    target: { tabId },
    documentId:
      typeof sender.documentId === "string"
        ? sender.documentId
        : null,
    generationId: crypto.randomUUID(),
    pagePath: parsedUrl.pathname,
    startedAt: Date.now(),
    phase: transitionPhase("idle", "begin"),
    attached: false,
    detached: false,
    expectedDetach: false,
    finalizing: false,
    requestContinued: false,
    replayAuthorized: false,
    uiReplayStarted: false,
    provisionalTransitionUsed: false,
    canonicalTransitionUsed: false,
    canonicalTargetPath: null,
    pendingNavigationUrl: null,
    navigationTimer: null,
    lastHistoryStatePath: null,
    lastHistoryStateAt: 0,
    qualifyingCount: 0,
    qualifyingRequestIds: new Set(),
    candidateEvent: null,
    captureTimer: null,
    settleTimer: null,
    cleanupTimer: null,
    cleanupAttempts: 0,
    audit: null
  };
}

function navigationDecisionForSession(
  session,
  nextUrl,
  {
    sameDocument,
    status = null
  }
) {
  return decideActiveSessionNavigation({
    currentPath: session.pagePath,
    nextUrl,
    status,
    sameDocument,
    replayAuthorized:
      session.replayAuthorized,
    uiReplayStarted:
      session.uiReplayStarted,
    provisionalTransitionUsed:
      session.provisionalTransitionUsed,
    canonicalTransitionUsed:
      session.canonicalTransitionUsed,
    canonicalTargetPath:
      session.canonicalTargetPath,
    requestContinued:
      session.requestContinued,
    hasSubmittedUserMessageId:
      typeof session.audit
        ?.submittedUserMessageId ===
        "string" &&
      session.audit
        .submittedUserMessageId
        .length > 0,
    phase: session.phase
  });
}

function clearPendingNavigation(session) {
  clearTimer(session.navigationTimer);
  session.navigationTimer = null;
  session.pendingNavigationUrl = null;
}

function assertPendingNavigationTarget(
  session,
  nextUrl
) {
  const parsedUrl =
    parseAllowedChatgptUrl(nextUrl);
  const targetChanged =
    parsedUrl !== null &&
    parsedUrl.pathname !== session.pagePath;

  console.assert(
    targetChanged,
    "Pending navigation must target a different allowed ChatGPT pathname."
  );

  return targetChanged;
}

function schedulePendingNavigation(
  session,
  nextUrl
) {
  if (
    !assertPendingNavigationTarget(
      session,
      nextUrl
    )
  ) {
    return false;
  }

  clearPendingNavigation(session);
  session.pendingNavigationUrl = nextUrl;
  session.navigationTimer = setTimeout(() => {
    session.navigationTimer = null;
    session.pendingNavigationUrl = null;

    if (
      activeSessions.get(session.tabId) ===
        session
    ) {
      void finalizeFailedSession(
        session,
        "navigation"
      );
    }
  }, NAVIGATION_CONFIRM_TIMEOUT_MS);

  return true;
}

function isCanonicalAuthorizationPending(
  session,
  nextUrl
) {
  const parsedUrl =
    parseAllowedChatgptUrl(nextUrl);

  return (
    parsedUrl !== null &&
    session.canonicalTargetPath === null &&
    session.provisionalTransitionUsed ===
      true &&
    TEMPORARY_CONVERSATION_PATH_RE.test(
      session.pagePath
    ) &&
    CONVERSATION_UUID_PATH_RE.test(
      parsedUrl.pathname
    ) &&
    session.canonicalTransitionUsed !==
      true &&
    session.requestContinued === true &&
    typeof session.audit
      ?.submittedUserMessageId ===
      "string" &&
    session.audit
      .submittedUserMessageId
      .length > 0 &&
    [
      "sent",
      "cleaning",
      "sent_warning"
    ].includes(session.phase)
  );
}

async function applyConfirmedHistoryNavigation(
  session,
  nextUrl
) {
  const decision =
    navigationDecisionForSession(
      session,
      nextUrl,
      {
        sameDocument: true
      }
    );

  if (decision.action === "fail") {
    if (
      isCanonicalAuthorizationPending(
        session,
        nextUrl
      )
    ) {
      schedulePendingNavigation(
        session,
        nextUrl
      );
      return false;
    }

    await finalizeFailedSession(
      session,
      "navigation"
    );
    return false;
  }

  clearPendingNavigation(session);

  if (decision.action === "advance") {
    session.pagePath = decision.pagePath;

    if (
      decision.transition ===
      "provisional"
    ) {
      session.provisionalTransitionUsed =
        true;
    } else if (
      decision.transition ===
      "canonical"
    ) {
      session.canonicalTransitionUsed =
        true;
    }

    recordActiveSession(session);

    if (!(await persistRequired())) {
      await finalizeFailedSession(
        session,
        "state_store_failed"
      );
      return false;
    }
  }

  session.lastHistoryStatePath =
    decision.pagePath;
  session.lastHistoryStateAt = Date.now();
  return true;
}

async function authorizeCanonicalPromotion(
  sender,
  message
) {
  const tabId = sender.tab?.id;
  const session =
    Number.isInteger(tabId)
      ? activeSessions.get(tabId)
      : null;
  const parsedTarget =
    parseAllowedChatgptUrl(
      `${CHATGPT_ORIGIN}${
        typeof message.targetPath ===
          "string"
          ? message.targetPath
          : ""
      }`
    );

  if (
    !session ||
    !senderOwnsSessionDocument(
      sender,
      session
    ) ||
    session.generationId !==
      message.generationId ||
    !parsedTarget ||
    !CONVERSATION_UUID_PATH_RE.test(
      parsedTarget.pathname
    ) ||
    session.provisionalTransitionUsed !==
      true ||
    !TEMPORARY_CONVERSATION_PATH_RE.test(
      session.pagePath
    ) ||
    session.requestContinued !== true ||
    typeof session.audit
      ?.submittedUserMessageId !==
      "string" ||
    session.audit
      .submittedUserMessageId
      .length === 0 ||
    ![
      "sent",
      "cleaning",
      "sent_warning"
    ].includes(session.phase)
  ) {
    return {
      ok: false,
      code: "canonical_promotion_not_current"
    };
  }

  if (
    session.canonicalTargetPath &&
    session.canonicalTargetPath !==
      parsedTarget.pathname
  ) {
    await finalizeFailedSession(
      session,
      "navigation"
    );

    return {
      ok: false,
      code: "canonical_target_conflict"
    };
  }

  session.canonicalTargetPath =
    parsedTarget.pathname;

  const pendingUrl =
    session.pendingNavigationUrl;

  if (pendingUrl) {
    const parsedPending =
      parseAllowedChatgptUrl(
        pendingUrl
      );

    if (
      parsedPending?.pathname ===
        session.pagePath
    ) {
      /*
       * A status-only loading update may have sampled the still-current WEB
       * URL before Chrome publishes the canonical History API update. It is
       * not a competing canonical target.
       */
      clearPendingNavigation(session);
      return {
        ok: true
      };
    }

    if (
      parsedPending?.pathname !==
        session.canonicalTargetPath
    ) {
      await finalizeFailedSession(
        session,
        "navigation"
      );

      return {
        ok: false,
        code: "canonical_target_conflict"
      };
    }

    const applied =
      await applyConfirmedHistoryNavigation(
        session,
        pendingUrl
      );

    if (!applied) {
      return {
        ok: false,
        code:
          "canonical_promotion_not_current"
      };
    }
  }

  return {
    ok: true
  };
}

async function retireCompletedSession(session) {
  setAudit(session.tabId, session.audit);

  activeSessions.delete(session.tabId);
  deleteActiveRecord(session.tabId);

  await persistRequired();

  await notifySession(session, {
    ...publicStateFromAudit(session.audit)
  });
}

async function finalizeFailedSession(
  session,
  code,
  additionalRequestId = null
) {
  if (!session || session.finalizing) {
    return;
  }

  session.finalizing = true;
  session.candidateEvent = null;
  clearSessionTimers(session);

  if (
    typeof additionalRequestId === "string" &&
    additionalRequestId.length > 0
  ) {
    session.qualifyingRequestIds.add(
      additionalRequestId
    );
  }

  if (isPreSendActivePhase(session.phase)) {
    try {
      session.phase = transitionPhase(
        session.phase,
        "fail"
      );
    } catch {
      session.phase = "failed";
    }
  }

  recordActiveSession(session);
  await persistRequired();

  let allAbortsSucceeded = true;

  for (const requestId of session.qualifyingRequestIds) {
    const aborted = await tryAbortRequest(
      session.target,
      requestId
    );

    if (!aborted) {
      allAbortsSucceeded = false;
    }
  }

  const patternsCleared =
    session.attached && !session.detached
      ? await tryClearPatterns(session.target)
      : false;

  const detachRequested =
    await tryDetachSession(session);
  const detachComplete =
    detachRequested || session.detached;

  const classification = classifyLostOperation({
    requestContinued: session.requestContinued,
    pausedRequestCount:
      session.qualifyingRequestIds.size,
    abortSucceeded: allAbortsSucceeded,
    replayAuthorized: session.replayAuthorized,
    replayCancelled:
      code === "replay_cancelled"
  });

  let status = classification.status;
  let error = classification.error;
  if (
    status === "failed" ||
    status === "sent_warning"
  ) {
    error = code;
  }

  /*
   * External detachment itself releases Fetch interception. A cleanup
   * warning is needed only when the debugger did not actually detach.
   */
  if (session.requestContinued && !detachComplete) {
    status = "sent_warning";
    error = "cleanup_failed";
  }

  const audit = createMinimalAudit(
    session,
    status,
    error
  );

  session.audit = audit;
  setAudit(session.tabId, audit);

  activeSessions.delete(session.tabId);
  deleteActiveRecord(session.tabId);

  await persistRequired();

  await notifySession(
    session,
    publicStateFromAudit(audit)
  );
}

async function completeSentSession(session) {
  if (!session || session.finalizing) {
    return;
  }

  session.finalizing = true;
  clearTimer(session.captureTimer);
  clearTimer(session.settleTimer);
  session.captureTimer = null;
  session.settleTimer = null;

  try {
    session.phase = transitionPhase(
      session.phase,
      "cleanup"
    );
  } catch {
    session.phase = "cleaning";
  }

  /*
   * The first operation after successful continueRequest is the required
   * Fetch.enable({patterns: []}) cleanup. Fetch.disable is never called.
   */
  const patternsCleared =
    await tryClearPatterns(session.target);
  const detachRequested =
    await tryDetachSession(session);
  const detachComplete =
    detachRequested || session.detached;

  const hasPostSendProblem = [
    "sent_warning",
    "uncertain"
  ].includes(session.audit.status);

  if (
    patternsCleared &&
    detachComplete &&
    !hasPostSendProblem
  ) {
    try {
      session.phase = transitionPhase(
        session.phase,
        "cleaned"
      );
    } catch {
      session.phase = "complete";
    }

    session.audit.status = "sent";
    session.audit.error = null;

    await retireCompletedSession(session);
    return;
  }

  session.phase = "sent_warning";

  if (!hasPostSendProblem) {
    session.audit.status = "sent_warning";
    session.audit.error = "cleanup_failed";
  }

  session.cleanupAttempts += 1;

  /*
   * Even if Fetch.enable({patterns: []}) was not acknowledged, successful
   * detachment releases interception. Preserve the warning/uncertain audit,
   * retire the active slot, and do not permanently block later submissions.
   */
  if (detachComplete) {
    await retireCompletedSession(session);
    return;
  }

  session.finalizing = false;
  setAudit(session.tabId, session.audit);
  recordActiveSession(session);
  await persistRequired();

  await notifySession(session, {
    ...publicStateFromAudit(session.audit)
  });

  if (
    session.cleanupAttempts <
    MAX_CLEANUP_ATTEMPTS
  ) {
    session.cleanupTimer = setTimeout(() => {
      void retrySentCleanup(session);
    }, CLEANUP_RETRY_MS);
  }
}

async function retrySentCleanup(session) {
  if (
    !session ||
    activeSessions.get(session.tabId) !== session ||
    session.finalizing
  ) {
    return;
  }

  if (session.detached) {
    await retireCompletedSession(session);
    return;
  }

  session.cleanupTimer = null;
  session.finalizing = true;

  const patternsCleared =
    await tryClearPatterns(session.target);
  const detachRequested =
    await tryDetachSession(session);
  const detachComplete =
    detachRequested || session.detached;

  const hasPostSendProblem = [
    "sent_warning",
    "uncertain"
  ].includes(session.audit.status);

  if (patternsCleared && detachComplete) {
    if (!hasPostSendProblem) {
      session.audit.status = "sent";
      session.audit.error = null;
    }

    session.phase = "complete";

    await retireCompletedSession(session);
    return;
  }

  if (detachComplete) {
    if (!hasPostSendProblem) {
      session.audit.status = "sent_warning";
      session.audit.error = "cleanup_failed";
    }

    session.phase = "sent_warning";
    await retireCompletedSession(session);
    return;
  }

  session.finalizing = false;
  session.cleanupAttempts += 1;

  if (session.audit.status !== "uncertain") {
    session.audit.status = "sent_warning";
    session.audit.error = "cleanup_failed";
  }

  session.phase = "sent_warning";

  setAudit(session.tabId, session.audit);
  recordActiveSession(session);
  await persistRequired();

  if (
    session.cleanupAttempts <
    MAX_CLEANUP_ATTEMPTS
  ) {
    session.cleanupTimer = setTimeout(() => {
      void retrySentCleanup(session);
    }, CLEANUP_RETRY_MS);
  }
}

async function armExtended(sender) {
  const parsedUrl = parseAllowedChatgptUrl(
    sender.url ?? sender.tab?.url
  );

  if (
    !parsedUrl ||
    !Number.isInteger(sender.tab?.id) ||
    sender.frameId !== 0
  ) {
    return {
      ok: false,
      code: "invalid_sender",
      message:
        "Extended can only arm from the top-level chatgpt.com page."
    };
  }

  const tabId = sender.tab.id;

  if (
    activeSessions.has(tabId) ||
    runtimeState.active[String(tabId)]
  ) {
    return {
      ok: false,
      code: "already_active",
      message:
        "An Extended one-shot operation is already active in this tab."
    };
  }

  const session = createSession(sender, parsedUrl);

  activeSessions.set(tabId, session);
  deleteAudit(tabId);
  recordActiveSession(session);

  if (!(await persistRequired())) {
    activeSessions.delete(tabId);
    deleteActiveRecord(tabId);

    const audit = createMinimalAudit(
      session,
      "failed",
      "state_store_failed"
    );

    setAudit(tabId, audit);
    await persistRequired();

    return {
      ok: false,
      code: "state_store_failed",
      message: statusMessageFor(
        "state_store_failed",
        "failed"
      )
    };
  }

  try {
    const currentTab = await tabsGet(tabId);
    const currentUrls = [
      currentTab.url,
      currentTab.pendingUrl
    ].filter(
      (value) =>
        typeof value === "string" &&
        value.length > 0
    );

    if (currentUrls.length === 0) {
      throw new Error("tab_url_unavailable");
    }

    for (const currentUrl of currentUrls) {
      const currentParsedUrl =
        parseAllowedChatgptUrl(currentUrl);

      if (
        !currentParsedUrl ||
        currentParsedUrl.pathname !==
          session.pagePath
      ) {
        throw new Error("tab_navigated");
      }
    }
  } catch {
    await finalizeFailedSession(
      session,
      "navigation"
    );

    return {
      ok: false,
      code: "navigation",
      message: statusMessageFor(
        "navigation",
        "failed"
      )
    };
  }

  try {
    await debuggerAttach(session.target);
    session.attached = true;
    session.phase = transitionPhase(
      session.phase,
      "attached"
    );
  } catch {
    await finalizeFailedSession(
      session,
      "attach_failed"
    );

    return {
      ok: false,
      code: "attach_failed",
      message: statusMessageFor(
        "attach_failed",
        "failed"
      )
    };
  }

  recordActiveSession(session);

  if (!(await persistRequired())) {
    await finalizeFailedSession(
      session,
      "state_store_failed"
    );

    return {
      ok: false,
      code: "state_store_failed",
      message: statusMessageFor(
        "state_store_failed",
        "failed"
      )
    };
  }

  try {
    await debuggerCommand(
      session.target,
      "Fetch.enable",
      {
        patterns: FETCH_PATTERNS.map(
          (pattern) => ({ ...pattern })
        )
      }
    );

    session.phase = transitionPhase(
      session.phase,
      "enabled"
    );
  } catch {
    await finalizeFailedSession(
      session,
      "enable_failed"
    );

    return {
      ok: false,
      code: "enable_failed",
      message: statusMessageFor(
        "enable_failed",
        "failed"
      )
    };
  }

  recordActiveSession(session);

  if (!(await persistRequired())) {
    await finalizeFailedSession(
      session,
      "state_store_failed"
    );

    return {
      ok: false,
      code: "state_store_failed",
      message: statusMessageFor(
        "state_store_failed",
        "failed"
      )
    };
  }

  session.captureTimer = setTimeout(() => {
    void finalizeFailedSession(
      session,
      "timeout"
    );
  }, CAPTURE_TIMEOUT_MS);

  return {
    ok: true,
    generationId: session.generationId
  };
}

async function confirmArmed(sender, message) {
  const tabId = sender.tab?.id;
  const session =
    Number.isInteger(tabId)
      ? activeSessions.get(tabId)
      : null;

  if (
    !session ||
    !senderMatchesSession(sender, session) ||
    session.generationId !== message.generationId ||
    session.phase !== "armed" ||
    !session.attached ||
    session.detached ||
    session.finalizing ||
    session.replayAuthorized
  ) {
    return {
      ok: false,
      code: "arm_not_current",
      message: statusMessageFor(
        "arm_not_current",
        "failed"
      )
    };
  }

  /*
   * Persist replay authorization before replying. Once this acknowledgement
   * reaches the content script, a detach, navigation, timeout, or worker
   * restart with no qualifying pause can no longer be called definitely
   * blocked: the normal UI action may already have begun.
   */
  session.replayAuthorized = true;
  recordActiveSession(session);

  if (!(await persistRequired())) {
    /*
     * The content script has not received approval yet, so no replay should
     * have occurred. Reset the flag before failing the arm.
     */
    session.replayAuthorized = false;

    await finalizeFailedSession(
      session,
      "state_store_failed"
    );

    return {
      ok: false,
      code: "state_store_failed",
      message: statusMessageFor(
        "state_store_failed",
        "failed"
      )
    };
  }

  return {
    ok: true,
    generationId: session.generationId
  };
}

async function markReplayStarting(
  sender,
  message
) {
  const tabId = sender.tab?.id;
  const session =
    Number.isInteger(tabId)
      ? activeSessions.get(tabId)
      : null;

  if (
    !session ||
    !senderMatchesSession(sender, session) ||
    session.generationId !==
      message.generationId ||
    session.phase !== "armed" ||
    !session.attached ||
    session.detached ||
    session.finalizing ||
    !session.replayAuthorized ||
    session.uiReplayStarted
  ) {
    return {
      ok: false,
      code: "replay_not_current",
      message:
        "The one-shot replay was no longer current."
    };
  }

  session.uiReplayStarted = true;
  recordActiveSession(session);

  if (!(await persistRequired())) {
    session.uiReplayStarted = false;
    await finalizeFailedSession(
      session,
      "state_store_failed"
    );

    return {
      ok: false,
      code: "state_store_failed",
      message: statusMessageFor(
        "state_store_failed",
        "failed"
      )
    };
  }

  return {
    ok: true,
    generationId:
      session.generationId
  };
}

async function cancelArm(sender, message) {
  const tabId = sender.tab?.id;
  const session =
    Number.isInteger(tabId)
      ? activeSessions.get(tabId)
      : null;

  if (
    !session ||
    !senderMatchesSession(sender, session) ||
    session.generationId !== message.generationId
  ) {
    return {
      ok: false,
      code: "stale_generation"
    };
  }

  await finalizeFailedSession(
    session,
    "replay_cancelled"
  );

  return {
    ok: true
  };
}

async function continueUnrelatedRequest(
  session,
  requestId
) {
  try {
    await debuggerCommand(
      session.target,
      "Fetch.continueRequest",
      { requestId }
    );
  } catch {
    await finalizeFailedSession(
      session,
      "cdp_failure"
    );
  }
}

async function handleLateDuplicate(
  session,
  requestId
) {
  session.qualifyingCount += 1;
  session.qualifyingRequestIds.add(requestId);
  recordActiveSession(session);
  await persistRequired();

  if (!session.requestContinued) {
    /*
     * Let finalizeFailedSession abort each retained request exactly once.
     * Pre-aborting this duplicate and then aborting it again incorrectly
     * turns a successful duplicate block into an uncertain outcome.
     */
    await finalizeFailedSession(
      session,
      "duplicate_qualifying_request",
      requestId
    );
    return;
  }

  const duplicateAborted =
    await tryAbortRequest(
      session.target,
      requestId
    );

  if (!session.audit) {
    session.audit = createMinimalAudit(
      session,
      "sent_warning",
      "duplicate_qualifying_request"
    );
  }

  if (duplicateAborted) {
    session.audit.status = "sent_warning";
    session.audit.error =
      "duplicate_qualifying_request";
  } else {
    /*
     * The original request is known to have been sent Extended, but Chrome
     * did not confirm that the duplicate was aborted. Do not describe this
     * as a mere cleanup warning.
     */
    session.audit.status = "uncertain";
    session.audit.error = "outcome_uncertain";
  }

  setAudit(session.tabId, session.audit);
  await persistRequired();

  /*
   * If cleanup is already awaiting CDP, it will observe the mutated audit
   * after that await. Otherwise, begin or retry cleanup now.
   */
  if (!session.finalizing) {
    await completeSentSession(session);
  }
}

async function processCandidate(session) {
  session.settleTimer = null;

  if (
    session.finalizing ||
    activeSessions.get(session.tabId) !== session ||
    session.phase !== "settling" ||
    !session.candidateEvent
  ) {
    return;
  }

  try {
    session.phase = transitionPhase(
      session.phase,
      "unique"
    );
  } catch {
    await finalizeFailedSession(
      session,
      "malformed_event"
    );
    return;
  }

  recordActiveSession(session);

  if (!(await persistRequired())) {
    await finalizeFailedSession(
      session,
      "state_store_failed"
    );
    return;
  }

  let candidateEvent =
    session.candidateEvent;
  session.candidateEvent = null;
  let continuation;

  try {
    continuation = prepareExtendedContinuation(
      candidateEvent
    );
  } catch (error) {
    const code =
      error instanceof RequestValidationError &&
      error.code === "model_mismatch"
        ? "model_mismatch"
        : "malformed_request";

    try {
      const identity = inspectPausedRequest(
        candidateEvent
      );

      session.audit = {
        generationId: session.generationId,
        method: identity.method,
        path: identity.path,
        resourceType: identity.resourceType,
        original: null,
        forced: null,
        removedHeaderNames: [],
        submittedUserMessageId: null,
        status: "failed",
        error: code
      };
    } catch {
      session.audit = null;
    }

    candidateEvent = null;

    await finalizeFailedSession(
      session,
      code
    );
    return;
  }

  candidateEvent = null;

  session.audit = {
    ...continuation.audit,
    generationId: session.generationId
  };

  setAudit(session.tabId, session.audit);
  recordActiveSession(session);

  /*
   * Persist only redacted audit fields and the operational paused request id
   * before the request is allowed to continue. No body or header values are
   * copied into storage.session.
   */
  if (!(await persistRequired())) {
    continuation = null;
    await finalizeFailedSession(
      session,
      "state_store_failed"
    );
    return;
  }

  if (
    session.finalizing ||
    activeSessions.get(session.tabId) !== session ||
    session.qualifyingCount !== 1
  ) {
    continuation = null;
    return;
  }

  try {
    await debuggerCommand(
      session.target,
      "Fetch.continueRequest",
      {
        requestId: continuation.requestId,
        postData: continuation.postDataBase64,
        headers: continuation.headers
      }
    );

    continuation = null;

    session.requestContinued = true;
    session.phase = transitionPhase(
      session.phase,
      "continued"
    );
    session.audit.status = "sent";
    session.audit.error = null;
  } catch {
    continuation = null;
    await finalizeFailedSession(
      session,
      "cdp_failure"
    );
    return;
  }

  /*
   * Do not persist or perform unrelated work here. Cleanup starts
   * immediately after Chrome acknowledges continuing the same paused request.
   */
  await completeSentSession(session);
}

async function acceptFirstCandidate(
  session,
  pausedEvent
) {
  const requestId = pausedEvent.requestId;

  session.qualifyingCount = 1;
  session.qualifyingRequestIds.add(requestId);
  session.candidateEvent = pausedEvent;

  try {
    session.phase = transitionPhase(
      session.phase,
      "candidate"
    );
  } catch {
    await finalizeFailedSession(
      session,
      "malformed_event",
      requestId
    );
    return;
  }

  clearTimer(session.captureTimer);
  session.captureTimer = null;

  recordActiveSession(session);

  if (!(await persistRequired())) {
    await finalizeFailedSession(
      session,
      "state_store_failed",
      requestId
    );
    return;
  }

  if (
    session.finalizing ||
    activeSessions.get(session.tabId) !== session
  ) {
    return;
  }

  /*
   * Keep the first request paused briefly so a duplicate qualifying pause
   * already in flight can be observed and both can be failed closed before
   * the first request is continued.
   */
  session.settleTimer = setTimeout(() => {
    void processCandidate(session);
  }, DUPLICATE_SETTLE_MS);
}

async function handleDebuggerEvent(
  source,
  method,
  parameters
) {
  await readyPromise;

  if (
    method !== "Fetch.requestPaused" ||
    !Number.isInteger(source.tabId)
  ) {
    return;
  }

  const session = activeSessions.get(source.tabId);

  if (!session) {
    await handleOrphanPause(source, parameters);
    return;
  }

  if (
    !parameters ||
    typeof parameters !== "object" ||
    typeof parameters.requestId !== "string" ||
    parameters.requestId.length === 0
  ) {
    await finalizeFailedSession(
      session,
      "malformed_event"
    );
    return;
  }

  if (!isQualifyingConversationPause(parameters)) {
    await continueUnrelatedRequest(
      session,
      parameters.requestId
    );
    return;
  }

  if (
    session.qualifyingCount > 0 ||
    session.phase !== "armed"
  ) {
    await handleLateDuplicate(
      session,
      parameters.requestId
    );
    return;
  }

  await acceptFirstCandidate(
    session,
    parameters
  );
}

async function handleOrphanPause(
  source,
  pausedEvent
) {
  const target = { tabId: source.tabId };
  const requestId =
    typeof pausedEvent?.requestId === "string"
      ? pausedEvent.requestId
      : "";

  const qualifying =
    isQualifyingConversationPause(pausedEvent);
  let qualifyingAbortSucceeded = true;

  if (requestId.length > 0) {
    if (qualifying) {
      qualifyingAbortSucceeded =
        await tryAbortRequest(
          target,
          requestId
        );
    } else {
      try {
        await debuggerCommand(
          target,
          "Fetch.continueRequest",
          { requestId }
        );
      } catch {
        // Cleanup below remains the final conservative action.
      }
    }
  }

  await tryClearPatterns(target);
  await tryDetachTarget(target);

  const previousAudit =
    runtimeState.audits[String(source.tabId)];

  let audit;

  if (
    qualifying &&
    previousAudit &&
    (
      previousAudit.status === "sent" ||
      previousAudit.status === "sent_warning"
    )
  ) {
    if (qualifyingAbortSucceeded) {
      audit = {
        ...previousAudit,
        status: "sent_warning",
        error: "duplicate_qualifying_request"
      };
    } else {
      audit = {
        ...previousAudit,
        status: "uncertain",
        error: "outcome_uncertain"
      };
    }
  } else {
    audit = {
      generationId:
        previousAudit?.generationId ?? null,
      method: qualifying ? "POST" : null,
      path: qualifying
        ? CONVERSATION_PATH
        : null,
      resourceType:
        typeof pausedEvent?.resourceType === "string"
          ? pausedEvent.resourceType
          : null,
      original: null,
      forced: null,
      removedHeaderNames: [],
      submittedUserMessageId:
        previousAudit?.submittedUserMessageId ?? null,
      status:
        qualifying && !qualifyingAbortSucceeded
          ? "uncertain"
          : "failed",
      error:
        qualifying && !qualifyingAbortSucceeded
          ? "outcome_uncertain"
          : "orphan_pause"
    };
  }

  setAudit(source.tabId, audit);
  deleteActiveRecord(source.tabId);
  await persistRequired();

  await notifyTab(source.tabId, {
    generationId: audit.generationId,
    ...publicStateFromAudit(audit)
  });
}

async function reconcileStaleActiveRecord(record) {
  const target = { tabId: record.tabId };
  let allAbortsSucceeded = true;

  for (const requestId of record.pausedRequestIds) {
    const aborted = await tryAbortRequest(
      target,
      requestId
    );

    if (!aborted) {
      allAbortsSucceeded = false;
    }
  }

  await tryClearPatterns(target);
  await tryDetachTarget(target);

  const previousAudit =
    runtimeState.audits[String(record.tabId)];

  const classification =
    previousAudit?.status === "uncertain"
      ? {
          status: "uncertain",
          error: "outcome_uncertain"
        }
      : classifyLostOperation({
          requestContinued: record.requestContinued,
          pausedRequestCount:
            record.pausedRequestIds.length,
          abortSucceeded: allAbortsSucceeded,
          replayAuthorized:
            record.replayAuthorized === true
        });

  const audit = {
    generationId: record.generationId,
    method: previousAudit?.method ?? null,
    path: previousAudit?.path ?? null,
    resourceType:
      previousAudit?.resourceType ?? null,
    original: previousAudit?.original ?? null,
    forced: previousAudit?.forced ?? null,
    removedHeaderNames:
      previousAudit?.removedHeaderNames ?? [],
    submittedUserMessageId:
      previousAudit?.submittedUserMessageId ?? null,
    status: classification.status,
    error: classification.error
  };

  setAudit(record.tabId, audit);
  deleteActiveRecord(record.tabId);

  await persistRequired();

  await notifyTab(record.tabId, {
    generationId: record.generationId,
    ...publicStateFromAudit(audit)
  });
}

async function initializeRuntimeState() {
  try {
    const stored = await storageSessionGet(
      SESSION_STORAGE_KEY
    );

    runtimeState = sanitizeRuntimeState(stored);
  } catch {
    runtimeState = {
      active: {},
      audits: {}
    };
  }

  const staleRecords = Object.values(
    runtimeState.active
  );

  for (const record of staleRecords) {
    await reconcileStaleActiveRecord(record);
  }

  await persistRequired();
}

function getTabState(sender) {
  const tabId = sender.tab?.id;
  const parsedSenderUrl =
    parseAllowedChatgptUrl(
      sender.url ?? sender.tab?.url
    );
  const senderPath =
    parsedSenderUrl?.pathname ?? null;

  if (!Number.isInteger(tabId)) {
    return {
      ok: false,
      code: "invalid_sender"
    };
  }

  const session = activeSessions.get(tabId);

  if (
    session &&
    senderPath !== session.pagePath
  ) {
    return {
      ok: true,
      generationId: null,
      activeOperation: false,
      pagePath: null,
      phase: "idle"
    };
  }

  if (session) {
    if (session.requestContinued) {
      const audit =
        session.audit ??
        runtimeState.audits[String(tabId)];

      return {
        ok: true,
        generationId: session.generationId,
        activeOperation: true,
        pagePath: session.pagePath,
        ...publicStateFromAudit(audit)
      };
    }

    return {
      ok: true,
      generationId: session.generationId,
      activeOperation: true,
      pagePath: session.pagePath,
      phase: "arming",
      label: "Arming",
      message:
        "Chrome is waiting for exactly one fresh Pro conversation POST.",
      submittedUserMessageId:
        session.audit?.submittedUserMessageId ?? null
    };
  }

  const audit =
    runtimeState.audits[String(tabId)];

  return {
    ok: true,
    generationId:
      audit?.generationId ?? null,
    activeOperation: false,
    pagePath: null,
    ...publicStateFromAudit(audit)
  };
}

async function handleRuntimeMessage(
  message,
  sender
) {
  await readyPromise;

  if (
    !message ||
    message.source !== MESSAGE_SOURCE
  ) {
    return {
      ok: false,
      code: "invalid_message"
    };
  }

  switch (message.type) {
    case "armExtended":
      return armExtended(sender);

    case "confirmArmed":
      return confirmArmed(sender, message);

    case "markReplayStarting":
      return markReplayStarting(
        sender,
        message
      );

    case "authorizeCanonicalPromotion":
      return authorizeCanonicalPromotion(
        sender,
        message
      );

    case "cancelArm":
      return cancelArm(sender, message);

    case "getState":
      return getTabState(sender);

    default:
      return {
        ok: false,
        code: "unknown_message"
      };
  }
}

const readyPromise = initializeRuntimeState();

async function handleTabNavigationUpdate(
  session,
  changeInfo
) {
  let nextUrl =
    typeof changeInfo.url === "string"
      ? changeInfo.url
      : null;

  if (
    !nextUrl &&
    changeInfo.status === "loading"
  ) {
    try {
      const tab =
        await tabsGet(session.tabId);
      nextUrl =
        typeof tab.url === "string"
          ? tab.url
          : null;
    } catch {
      await finalizeFailedSession(
        session,
        "navigation"
      );
      return;
    }
  }

  if (!nextUrl) {
    return;
  }

  const parsedUrl =
    parseAllowedChatgptUrl(nextUrl);

  if (!parsedUrl) {
    await finalizeFailedSession(
      session,
      "navigation"
    );
    return;
  }

  const decision =
    navigationDecisionForSession(
      session,
      nextUrl,
      {
        sameDocument: true
      }
    );
  const waitsForCanonicalTarget =
    decision.action === "fail" &&
    isCanonicalAuthorizationPending(
      session,
      nextUrl
    );

  if (
    decision.action === "fail" &&
    !waitsForCanonicalTarget
  ) {
    await finalizeFailedSession(
      session,
      "navigation"
    );
    return;
  }

  if (
    changeInfo.status === "loading" &&
    session.lastHistoryStatePath ===
      parsedUrl.pathname &&
    Date.now() -
      session.lastHistoryStateAt <=
      RECENT_HISTORY_CONFIRM_MS
  ) {
    return;
  }

  /*
   * A status-only `loading` update is not proof of navigation. ChatGPT can
   * emit one while the committed top-frame URL is unchanged. A real reload
   * still reaches webNavigation.onCommitted and fails closed below.
   */
  if (decision.action === "keep") {
    return;
  }

  /*
   * tabs.onUpdated does not distinguish a History API update from a real
   * document load, and Chrome may split its URL and loading properties across
   * events. Wait for webNavigation to prove that the original document
   * performed a same-document history update. A committed document navigation
   * is rejected immediately by the listener below.
   */
  schedulePendingNavigation(
    session,
    nextUrl
  );
}

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    void handleRuntimeMessage(message, sender)
      .then((response) => {
        sendResponse(response);
      })
      .catch(() => {
        sendResponse({
          ok: false,
          code: "internal_failure",
          message:
            "The extension failed closed while processing the request."
        });
      });

    return true;
  }
);

chrome.debugger.onEvent.addListener(
  (source, method, parameters) => {
    void handleDebuggerEvent(
      source,
      method,
      parameters
    );
  }
);

chrome.debugger.onDetach.addListener(
  (source) => {
    if (!Number.isInteger(source.tabId)) {
      return;
    }

    void readyPromise.then(async () => {
      const session =
        activeSessions.get(source.tabId);

      if (!session) {
        return;
      }

      session.detached = true;

      if (session.expectedDetach) {
        return;
      }

      await finalizeFailedSession(
        session,
        "debugger_detached"
      );
    });
  }
);

chrome.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    void readyPromise.then(async () => {
      const session = activeSessions.get(tabId);

      if (!session) {
        return;
      }

      await handleTabNavigationUpdate(
        session,
        changeInfo
      );
    });
  }
);

chrome.webNavigation.onHistoryStateUpdated
  .addListener((details) => {
    if (details.frameId !== 0) {
      return;
    }

    void readyPromise.then(async () => {
      const session =
        activeSessions.get(
          details.tabId
        );

      if (!session) {
        return;
      }

      if (
        typeof session.documentId !==
          "string" ||
        details.documentId !==
          session.documentId
      ) {
        await finalizeFailedSession(
          session,
          "navigation"
        );
        return;
      }

      await applyConfirmedHistoryNavigation(
        session,
        details.url
      );
    });
  });

chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) {
      return;
    }

    void readyPromise.then(async () => {
      const session =
        activeSessions.get(
          details.tabId
        );

      if (!session) {
        return;
      }

      /*
       * Any top-frame commit replaces or reloads the armed document. Only
       * onHistoryStateUpdated from the original document may advance a live
       * one-shot route.
       */
      await finalizeFailedSession(
        session,
        "navigation"
      );
    });
  }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  void readyPromise.then(async () => {
    const session = activeSessions.get(tabId);

    if (session) {
      await finalizeFailedSession(
        session,
        "tab_closed"
      );
    }

    activeSessions.delete(tabId);
    deleteActiveRecord(tabId);
    deleteAudit(tabId);
    await persistRequired();
  });
});
