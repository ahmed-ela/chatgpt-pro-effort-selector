(() => {
  "use strict";

  const STANDARD = "standard";
  const EXTENDED = "extended";

  const CHATGPT_ORIGIN =
    "https://chatgpt.com";
  const MODE_STORAGE_PREFIX =
    "proEffortMode.chat.";
  const DRAFT_SESSION_STORAGE_KEY =
    "proEffortMode.draft";
  const DRAFT_BINDING_SESSION_STORAGE_KEY =
    "proEffortMode.draftBinding";
  const DRAFT_PENDING_SESSION_STORAGE_KEY =
    "proEffortMode.pendingDraft";
  const PENDING_DRAFT_MAX_AGE_MS =
    120_000;

  const CONVERSATION_PATH_RE =
    /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  const TEMPORARY_CONVERSATION_PATH_RE =
    /^\/c\/(?:WEB:|local-chatgpt(?::|%3[Aa]))([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  const BLANK_DRAFT_PATHS =
    new Set(["/", "/new"]);
  const GENERATION_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const hasOwn = (value, propertyName) =>
    Object.prototype.hasOwnProperty.call(
      value,
      propertyName
    );

  function normalizeMode(value) {
    return value === EXTENDED
      ? EXTENDED
      : STANDARD;
  }

  function storageKeyForConversationId(
    conversationId
  ) {
    return `${MODE_STORAGE_PREFIX}${conversationId}`;
  }

  function readDraftModeFromSessionStorage(
    storage
  ) {
    try {
      return normalizeMode(
        storage?.getItem(
          DRAFT_SESSION_STORAGE_KEY
        )
      );
    } catch {
      return STANDARD;
    }
  }

  function persistDraftModeToSessionStorage(
    storage,
    value
  ) {
    const mode = normalizeMode(value);

    try {
      storage?.setItem(
        DRAFT_SESSION_STORAGE_KEY,
        mode
      );
    } catch {
      // The in-memory mode remains usable when session storage is blocked.
    }

    return mode;
  }

  function clearDraftModeFromSessionStorage(
    storage
  ) {
    try {
      storage?.removeItem(
        DRAFT_SESSION_STORAGE_KEY
      );
    } catch {
      // A blocked removal still resolves the active document to Standard.
    }

    return STANDARD;
  }

  function isBlankDraftRoute(route) {
    return (
      route?.kind === "draft" &&
      BLANK_DRAFT_PATHS.has(
        route.pathname
      )
    );
  }

  function isTemporaryChatRoute(route) {
    return (
      route?.kind === "draft" &&
      typeof route.pathname ===
        "string" &&
      TEMPORARY_CONVERSATION_PATH_RE.test(
        route.pathname
      )
    );
  }

  function isProvisionalDraftTransition(
    fromRoute,
    toRoute
  ) {
    return (
      isBlankDraftRoute(fromRoute) &&
      isTemporaryChatRoute(toRoute)
    );
  }

  function routeContinuesDraftLifecycle(
    sourceRoute,
    currentRoute
  ) {
    return (
      (sourceRoute?.kind === "draft" &&
        currentRoute?.kind === "draft" &&
        sourceRoute.pathname ===
          currentRoute.pathname) ||
      isProvisionalDraftTransition(
        sourceRoute,
        currentRoute
      )
    );
  }

  function createDraftBinding(
    temporaryRoute,
    conversationRoute
  ) {
    if (
      !isTemporaryChatRoute(
        temporaryRoute
      ) ||
      conversationRoute?.kind !==
        "conversation" ||
      typeof conversationRoute
        .conversationId !== "string" ||
      typeof conversationRoute.storageKey !==
        "string"
    ) {
      return null;
    }

    return Object.freeze({
      temporaryPath:
        temporaryRoute.pathname,
      conversationId:
        conversationRoute.conversationId,
      storageKey:
        conversationRoute.storageKey,
      pathname:
        conversationRoute.pathname
    });
  }

  function readDraftBindingFromSessionStorage(
    storage,
    route
  ) {
    if (!isTemporaryChatRoute(route)) {
      return null;
    }

    try {
      const rawValue = storage?.getItem(
        DRAFT_BINDING_SESSION_STORAGE_KEY
      );
      const parsed = JSON.parse(rawValue);
      const records =
        Array.isArray(parsed?.bindings)
          ? parsed.bindings
          : [parsed];
      const record = records.find(
        (candidate) =>
          candidate &&
          typeof candidate ===
            "object" &&
          candidate.temporaryPath ===
            route.pathname &&
          typeof candidate
            .conversationId ===
            "string"
      );

      if (!record) {
        return null;
      }

      const conversationRoute =
        parseChatRoute(
          `${CHATGPT_ORIGIN}/c/${record.conversationId}`
        );

      return createDraftBinding(
        route,
        conversationRoute
      );
    } catch {
      return null;
    }
  }

  function persistDraftBindingToSessionStorage(
    storage,
    temporaryRoute,
    conversationRoute
  ) {
    const binding = createDraftBinding(
      temporaryRoute,
      conversationRoute
    );

    if (!binding) {
      return null;
    }

    try {
      const rawValue = storage?.getItem(
        DRAFT_BINDING_SESSION_STORAGE_KEY
      );
      const parsed = JSON.parse(rawValue);
      const records =
        Array.isArray(parsed?.bindings)
          ? parsed.bindings
          : (
              parsed &&
              typeof parsed === "object"
            )
            ? [parsed]
            : [];
      const nextRecords = records
        .filter(
          (record) =>
            record &&
            typeof record === "object" &&
            typeof record.temporaryPath ===
              "string" &&
            typeof record.conversationId ===
              "string" &&
            record.temporaryPath !==
              binding.temporaryPath
        )
        .slice(-15);

      nextRecords.push({
        temporaryPath:
          binding.temporaryPath,
        conversationId:
          binding.conversationId
      });

      storage?.setItem(
        DRAFT_BINDING_SESSION_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          bindings: nextRecords
        })
      );
    } catch {
      // The in-memory binding remains usable when session storage is blocked.
    }

    return binding;
  }

  function clearDraftBindingFromSessionStorage(
    storage
  ) {
    try {
      storage?.removeItem(
        DRAFT_BINDING_SESSION_STORAGE_KEY
      );
    } catch {
      // The in-memory binding is still cleared by the caller.
    }

    return null;
  }

  function createPendingDraftAdoptionRecord({
    sourceRoute,
    temporaryRoute = null,
    targetRoute = null,
    generationId,
    draftMode,
    createdAt = Date.now(),
    preexistingConversationKeys = []
  }) {
    if (
      !isBlankDraftRoute(sourceRoute) ||
      (
        temporaryRoute !== null &&
        !isTemporaryChatRoute(
          temporaryRoute
        )
      ) ||
      (
        targetRoute !== null &&
        (
          targetRoute?.kind !==
            "conversation" ||
          typeof targetRoute
            .conversationId !==
            "string" ||
          targetRoute.storageKey !==
            storageKeyForConversationId(
              targetRoute.conversationId
            ) ||
          targetRoute.pathname !==
            `/c/${targetRoute.conversationId}`
        )
      ) ||
      typeof generationId !== "string" ||
      !GENERATION_ID_RE.test(
        generationId
      ) ||
      ![STANDARD, EXTENDED].includes(
        draftMode
      ) ||
      !Number.isFinite(createdAt) ||
      !Array.isArray(
        preexistingConversationKeys
      ) ||
      preexistingConversationKeys.length >
        512
    ) {
      return null;
    }

    const keys = [];
    const seen = new Set();

    for (
      const storageKey of
        preexistingConversationKeys
    ) {
      if (
        typeof storageKey !== "string" ||
        !storageKey.startsWith(
          MODE_STORAGE_PREFIX
        ) ||
        parseChatRoute(
          `${CHATGPT_ORIGIN}/c/${storageKey.slice(
            MODE_STORAGE_PREFIX.length
          )}`
        ).storageKey !== storageKey
      ) {
        return null;
      }

      if (!seen.has(storageKey)) {
        seen.add(storageKey);
        keys.push(storageKey);
      }
    }

    return Object.freeze({
      version: 1,
      sourcePath: sourceRoute.pathname,
      temporaryPath:
        temporaryRoute?.pathname ?? null,
      targetConversationId:
        targetRoute?.conversationId ?? null,
      generationId,
      draftMode,
      createdAt,
      preexistingConversationKeys:
        Object.freeze(keys)
    });
  }

  function pendingRecordMatchesRoute(
    record,
    route
  ) {
    const sourceRoute =
      parseChatRoute(
        `${CHATGPT_ORIGIN}${record.sourcePath}`
      );
    const temporaryRoute =
      typeof record.temporaryPath ===
        "string"
        ? parseChatRoute(
            `${CHATGPT_ORIGIN}${record.temporaryPath}`
          )
        : null;
    const targetRoute =
      typeof record.targetConversationId ===
        "string"
        ? parseChatRoute(
            `${CHATGPT_ORIGIN}/c/${record.targetConversationId}`
          )
        : null;

    return (
      routeContinuesDraftLifecycle(
        sourceRoute,
        route
      ) ||
      (
        temporaryRoute &&
        route?.kind === "draft" &&
        route.pathname ===
          temporaryRoute.pathname
      ) ||
      (
        targetRoute &&
        route?.kind === "conversation" &&
        route.storageKey ===
          targetRoute.storageKey
      )
    );
  }

  function persistPendingDraftAdoptionToSessionStorage(
    storage,
    value
  ) {
    const record =
      createPendingDraftAdoptionRecord(
        value
      );

    if (!record) {
      return null;
    }

    try {
      storage?.setItem(
        DRAFT_PENDING_SESSION_STORAGE_KEY,
        JSON.stringify(record)
      );
    } catch {
      // The current document can still finish the in-memory adoption.
    }

    return record;
  }

  function readPendingDraftAdoptionFromSessionStorage(
    storage,
    route,
    now = Date.now()
  ) {
    try {
      const parsed = JSON.parse(
        storage?.getItem(
          DRAFT_PENDING_SESSION_STORAGE_KEY
        )
      );
      const sourceRoute =
        parseChatRoute(
          `${CHATGPT_ORIGIN}${
            typeof parsed?.sourcePath ===
              "string"
              ? parsed.sourcePath
              : ""
          }`
        );
      const temporaryRoute =
        typeof parsed?.temporaryPath ===
          "string"
          ? parseChatRoute(
              `${CHATGPT_ORIGIN}${parsed.temporaryPath}`
            )
          : null;
      const targetRoute =
        typeof parsed?.targetConversationId ===
          "string"
          ? parseChatRoute(
              `${CHATGPT_ORIGIN}/c/${parsed.targetConversationId}`
            )
          : null;
      const record =
        createPendingDraftAdoptionRecord({
          sourceRoute,
          temporaryRoute,
          targetRoute,
          generationId:
            parsed?.generationId,
          draftMode: parsed?.draftMode,
          createdAt: parsed?.createdAt,
          preexistingConversationKeys:
            parsed
              ?.preexistingConversationKeys
        });

      if (
        !record ||
        !Number.isFinite(now) ||
        now < record.createdAt ||
        now - record.createdAt >
          PENDING_DRAFT_MAX_AGE_MS
      ) {
        clearPendingDraftAdoptionFromSessionStorage(
          storage
        );
        return null;
      }

      if (
        !pendingRecordMatchesRoute(
          record,
          route
        )
      ) {
        clearPendingDraftAdoptionFromSessionStorage(
          storage
        );
        return null;
      }

      return record;
    } catch {
      clearPendingDraftAdoptionFromSessionStorage(
        storage
      );
      return null;
    }
  }

  function clearPendingDraftAdoptionFromSessionStorage(
    storage
  ) {
    try {
      storage?.removeItem(
        DRAFT_PENDING_SESSION_STORAGE_KEY
      );
    } catch {
      // The in-memory record is still cleared by the caller.
    }

    return null;
  }

  function shouldRestorePendingDraftAdoption(
    pending,
    backgroundState
  ) {
    return (
      pending !== null &&
      typeof pending === "object" &&
      typeof pending.generationId ===
        "string" &&
      backgroundState?.ok === true &&
      backgroundState.generationId ===
        pending.generationId &&
      [
        "sent",
        "warning"
      ].includes(backgroundState.phase) &&
      typeof backgroundState
        .submittedUserMessageId ===
        "string" &&
      backgroundState
        .submittedUserMessageId
        .length > 0
    );
  }

  function conversationRouteForBinding(
    binding,
    route
  ) {
    if (
      !binding ||
      !isTemporaryChatRoute(route) ||
      binding.temporaryPath !==
        route.pathname
    ) {
      return null;
    }

    const conversationRoute =
      parseChatRoute(
        `${CHATGPT_ORIGIN}${binding.pathname}`
      );

    return (
      conversationRoute.kind ===
        "conversation" &&
      conversationRoute.storageKey ===
        binding.storageKey
    )
      ? conversationRoute
      : null;
  }

  function conversationRouteForDraftLifecycle({
    route,
    binding = null,
    sourceRoute = null,
    targetRoute = null,
    navigationDisqualified = false
  }) {
    if (route?.kind === "conversation") {
      return route;
    }

    const boundRoute =
      conversationRouteForBinding(
        binding,
        route
      );

    if (boundRoute) {
      return boundRoute;
    }

    if (
      navigationDisqualified === true ||
      !routeContinuesDraftLifecycle(
        sourceRoute,
        route
      ) ||
      targetRoute?.kind !==
        "conversation" ||
      typeof targetRoute.conversationId !==
        "string" ||
      targetRoute.storageKey !==
        storageKeyForConversationId(
          targetRoute.conversationId
        ) ||
      targetRoute.pathname !==
        `/c/${targetRoute.conversationId}`
    ) {
      return null;
    }

    /*
     * Once a successful draft send has exposed its unique canonical target,
     * mode changes must write through to that target even while the first
     * binding write is pending. This keeps the latest selection authoritative
     * if an SPA route change clears the ephemeral adoption record.
     */
    return targetRoute;
  }

  async function drainLatestModeWrite(
    readLatestMode,
    writeMode
  ) {
    let writtenMode;

    do {
      writtenMode = normalizeMode(
        readLatestMode()
      );
      await writeMode(writtenMode);
    } while (
      writtenMode !==
      normalizeMode(readLatestMode())
    );

    return writtenMode;
  }

  function createDraftRoute(pathname = "") {
    return Object.freeze({
      kind: "draft",
      conversationId: null,
      storageKey: null,
      pathname
    });
  }

  function parseChatRoute(rawUrl) {
    let parsedUrl;

    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return createDraftRoute();
    }

    if (parsedUrl.origin !== CHATGPT_ORIGIN) {
      return createDraftRoute();
    }

    const pathname = parsedUrl.pathname;
    const match = pathname.match(
      CONVERSATION_PATH_RE
    );

    if (!match) {
      return createDraftRoute(pathname);
    }

    const conversationId = match[1];

    return Object.freeze({
      kind: "conversation",
      conversationId,
      storageKey:
        storageKeyForConversationId(
          conversationId
        ),
      pathname
    });
  }

  function sameChatRoute(left, right) {
    if (!left || !right) {
      return false;
    }

    if (
      left.kind === "conversation" ||
      right.kind === "conversation"
    ) {
      return (
        left.kind === "conversation" &&
        right.kind === "conversation" &&
        typeof left.storageKey ===
          "string" &&
        typeof right.storageKey ===
          "string" &&
        left.storageKey === right.storageKey
      );
    }

    /*
     * All noncanonical, UUID-less paths in one tab share the tab-session
     * draft mode. Entering a draft from a saved chat is handled as a route
     * transition by the content script.
     */
    return (
      left.kind === "draft" &&
      right.kind === "draft"
    );
  }

  function readModeForRoute(
    storedValues,
    route,
    draftMode = STANDARD
  ) {
    if (route?.kind !== "conversation") {
      return normalizeMode(draftMode);
    }

    if (
      typeof route.storageKey !==
        "string" ||
      !storedValues ||
      typeof storedValues !== "object" ||
      !hasOwn(
        storedValues,
        route.storageKey
      )
    ) {
      return STANDARD;
    }

    return normalizeMode(
      storedValues[route.storageKey]
    );
  }

  function storageChangeAffectsRoute(
    changes,
    route
  ) {
    return (
      route?.kind === "conversation" &&
      typeof route.storageKey ===
        "string" &&
      changes !== null &&
      typeof changes === "object" &&
      hasOwn(changes, route.storageKey)
    );
  }

  function isDraftAdoptionTarget({
    fromRoute,
    toRoute,
    draftMode,
    activeDraftSend,
    alreadyAdopted = false,
    targetWasPreexisting = false,
    navigationDisqualified = false
  }) {
    return (
      fromRoute?.kind === "draft" &&
      toRoute?.kind === "conversation" &&
      typeof toRoute.storageKey ===
        "string" &&
      normalizeMode(draftMode) ===
        EXTENDED &&
      activeDraftSend === true &&
      alreadyAdopted !== true &&
      targetWasPreexisting !== true &&
      navigationDisqualified !== true
    );
  }

  function shouldAdoptDraftMode({
    fromRoute,
    toRoute,
    draftMode,
    activeDraftSend,
    sendSucceeded,
    alreadyAdopted = false,
    targetWasPreexisting = false,
    navigationDisqualified = false
  }) {
    return (
      isDraftAdoptionTarget({
        fromRoute,
        toRoute,
        draftMode,
        activeDraftSend,
        alreadyAdopted,
        targetWasPreexisting,
        navigationDisqualified
      }) &&
      sendSucceeded === true
    );
  }

  function shouldBindDraftConversation({
    fromRoute,
    toRoute,
    activeDraftSend,
    sendSucceeded,
    alreadyAdopted = false,
    targetWasPreexisting = false,
    navigationDisqualified = false
  }) {
    return (
      fromRoute?.kind === "draft" &&
      toRoute?.kind === "conversation" &&
      typeof toRoute.storageKey ===
        "string" &&
      activeDraftSend === true &&
      sendSucceeded === true &&
      alreadyAdopted !== true &&
      targetWasPreexisting !== true &&
      navigationDisqualified !== true
    );
  }

  function decideSubmissionForMode(
    mode,
    modelState
  ) {
    const normalizedMode =
      normalizeMode(mode);

    if (normalizedMode !== EXTENDED) {
      return Object.freeze({
        mode: normalizedMode,
        policy: "pass"
      });
    }

    if (modelState === "pro") {
      return Object.freeze({
        mode: normalizedMode,
        policy: "gate"
      });
    }

    if (modelState === "other") {
      return Object.freeze({
        mode: normalizedMode,
        policy: "pass"
      });
    }

    return Object.freeze({
      mode: normalizedMode,
      policy: "block_unknown"
    });
  }

  globalThis.ProEffortModeCore =
    Object.freeze({
      STANDARD,
      EXTENDED,
      MODE_STORAGE_PREFIX,
      DRAFT_SESSION_STORAGE_KEY,
      DRAFT_BINDING_SESSION_STORAGE_KEY,
      DRAFT_PENDING_SESSION_STORAGE_KEY,
      PENDING_DRAFT_MAX_AGE_MS,
      normalizeMode,
      storageKeyForConversationId,
      readDraftModeFromSessionStorage,
      persistDraftModeToSessionStorage,
      clearDraftModeFromSessionStorage,
      isBlankDraftRoute,
      isTemporaryChatRoute,
      isProvisionalDraftTransition,
      routeContinuesDraftLifecycle,
      readDraftBindingFromSessionStorage,
      persistDraftBindingToSessionStorage,
      clearDraftBindingFromSessionStorage,
      createPendingDraftAdoptionRecord,
      persistPendingDraftAdoptionToSessionStorage,
      readPendingDraftAdoptionFromSessionStorage,
      clearPendingDraftAdoptionFromSessionStorage,
      shouldRestorePendingDraftAdoption,
      conversationRouteForBinding,
      conversationRouteForDraftLifecycle,
      drainLatestModeWrite,
      parseChatRoute,
      sameChatRoute,
      readModeForRoute,
      storageChangeAffectsRoute,
      isDraftAdoptionTarget,
      shouldAdoptDraftMode,
      shouldBindDraftConversation,
      decideSubmissionForMode
    });
})();
