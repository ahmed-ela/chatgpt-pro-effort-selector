import test from "node:test";
import assert from "node:assert/strict";

await import("../core/mode-core.js");

const {
  STANDARD,
  EXTENDED,
  MODE_STORAGE_PREFIX,
  DRAFT_SESSION_STORAGE_KEY,
  DRAFT_BINDING_SESSION_STORAGE_KEY,
  DRAFT_PENDING_SESSION_STORAGE_KEY,
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
} = globalThis.ProEffortModeCore;

const CHAT_A =
  "11111111-1111-4111-8111-111111111111";
const CHAT_B =
  "22222222-2222-4222-8222-222222222222";
const CHAT_WITH_HEX =
  "abcdefab-cdef-4abc-8def-abcdefabcdef";
const TEMP_CHAT_A =
  `https://chatgpt.com/c/WEB:${CHAT_A}`;

function createMemoryStorage(
  initialValues = {}
) {
  const values = new Map(
    Object.entries(initialValues)
  );

  return {
    getItem(key) {
      return values.has(key)
        ? values.get(key)
        : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test("parses only canonical lowercase saved-conversation URLs", () => {
  const route = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}?model=pro`
  );

  assert.deepEqual(route, {
    kind: "conversation",
    conversationId: CHAT_A,
    storageKey:
      `${MODE_STORAGE_PREFIX}${CHAT_A}`,
    pathname: `/c/${CHAT_A}`
  });

  for (const rawUrl of [
    "https://chatgpt.com/",
    "https://chatgpt.com/new",
    `https://chatgpt.com/c/${CHAT_A}/`,
    `https://chatgpt.com/c/${CHAT_WITH_HEX.toUpperCase()}`,
    `https://example.com/c/${CHAT_A}`,
    "not a URL"
  ]) {
    assert.equal(
      parseChatRoute(rawUrl).kind,
      "draft"
    );
  }
});

test("preserves the parsed pathname for noncanonical routes", () => {
  assert.deepEqual(
    parseChatRoute(
      "https://chatgpt.com/new?model=pro"
    ),
    {
      kind: "draft",
      conversationId: null,
      storageKey: null,
      pathname: "/new"
    }
  );

  assert.deepEqual(
    parseChatRoute("not a URL"),
    {
      kind: "draft",
      conversationId: null,
      storageKey: null,
      pathname: ""
    }
  );
});

test("recognizes only the narrow blank-to-WEB provisional lifecycle", () => {
  const rootDraft = parseChatRoute(
    "https://chatgpt.com/"
  );
  const newDraft = parseChatRoute(
    "https://chatgpt.com/new"
  );
  const temporary = parseChatRoute(
    TEMP_CHAT_A
  );
  const otherTemporary = parseChatRoute(
    `https://chatgpt.com/c/WEB:${CHAT_B}`
  );
  const saved = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  assert.equal(
    isBlankDraftRoute(rootDraft),
    true
  );
  assert.equal(
    isBlankDraftRoute(newDraft),
    true
  );
  assert.equal(
    isTemporaryChatRoute(temporary),
    true
  );
  assert.equal(
    isTemporaryChatRoute(
      parseChatRoute(
        `https://chatgpt.com/c/web:${CHAT_A}`
      )
    ),
    false
  );
  assert.equal(
    isProvisionalDraftTransition(
      rootDraft,
      temporary
    ),
    true
  );
  assert.equal(
    routeContinuesDraftLifecycle(
      rootDraft,
      temporary
    ),
    true
  );
  assert.equal(
    routeContinuesDraftLifecycle(
      temporary,
      temporary
    ),
    true
  );

  for (const [fromRoute, toRoute] of [
    [temporary, otherTemporary],
    [temporary, saved],
    [saved, temporary],
    [
      parseChatRoute(
        "https://chatgpt.com/library"
      ),
      temporary
    ]
  ]) {
    assert.equal(
      isProvisionalDraftTransition(
        fromRoute,
        toRoute
      ),
      false
    );
  }
});

test("persists a WEB route binding to exactly one canonical conversation", () => {
  const storage = createMemoryStorage();
  const temporary = parseChatRoute(
    TEMP_CHAT_A
  );
  const savedA = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );
  const savedB = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_B}`
  );

  assert.equal(
    readDraftBindingFromSessionStorage(
      storage,
      temporary
    ),
    null
  );

  const binding =
    persistDraftBindingToSessionStorage(
      storage,
      temporary,
      savedA
    );

  assert.deepEqual(binding, {
    temporaryPath:
      `/c/WEB:${CHAT_A}`,
    conversationId: CHAT_A,
    storageKey:
      `${MODE_STORAGE_PREFIX}${CHAT_A}`,
    pathname: `/c/${CHAT_A}`
  });
  assert.deepEqual(
    readDraftBindingFromSessionStorage(
      storage,
      temporary
    ),
    binding
  );
  assert.deepEqual(
    conversationRouteForBinding(
      binding,
      temporary
    ),
    savedA
  );
  assert.equal(
    conversationRouteForBinding(
      binding,
      parseChatRoute(
        `https://chatgpt.com/c/WEB:${CHAT_B}`
      )
    ),
    null
  );
  assert.equal(
    persistDraftBindingToSessionStorage(
      storage,
      temporary,
      parseChatRoute(
        "https://chatgpt.com/"
      )
    ),
    null
  );

  const temporaryB = parseChatRoute(
    `https://chatgpt.com/c/WEB:${CHAT_B}`
  );

  persistDraftBindingToSessionStorage(
    storage,
    temporaryB,
    savedB
  );

  assert.equal(
    readDraftBindingFromSessionStorage(
      storage,
      temporary
    )?.storageKey,
    savedA.storageKey,
    "adding another provisional chat must preserve Back navigation to the first"
  );
  assert.equal(
    readDraftBindingFromSessionStorage(
      storage,
      temporaryB
    )?.storageKey,
    savedB.storageKey
  );

  storage.setItem(
    DRAFT_BINDING_SESSION_STORAGE_KEY,
    JSON.stringify({
      temporaryPath:
        temporary.pathname,
      conversationId:
        savedB.conversationId
    })
  );
  assert.equal(
    conversationRouteForBinding(
      readDraftBindingFromSessionStorage(
        storage,
        temporary
      ),
      temporary
    )?.storageKey,
    savedB.storageKey
  );

  assert.equal(
    clearDraftBindingFromSessionStorage(
      storage
    ),
    null
  );
  assert.equal(
    storage.getItem(
      DRAFT_BINDING_SESSION_STORAGE_KEY
    ),
    null
  );
});

test("preserves local-chatgpt draft adoption and saved mode across reloads", () => {
  const blank = parseChatRoute("https://chatgpt.com/");
  const saved = parseChatRoute(`https://chatgpt.com/c/${CHAT_B}`);
  const generationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  for (const separator of [":", "%3A", "%3a"]) {
    const url = `https://chatgpt.com/c/local-chatgpt${separator}${CHAT_A}`;
    const temporary = parseChatRoute(url);
    const storage = createMemoryStorage();
    persistDraftModeToSessionStorage(storage, EXTENDED);

    assert.equal(isTemporaryChatRoute(temporary), true);
    assert.equal(isProvisionalDraftTransition(blank, temporary), true);
    assert.equal(routeContinuesDraftLifecycle(blank, temporary), true);
    assert.equal(readDraftModeFromSessionStorage(storage), EXTENDED);
    assert.equal(temporary.storageKey, null);

    const pending = persistPendingDraftAdoptionToSessionStorage(storage, {
      sourceRoute: blank,
      temporaryRoute: temporary,
      targetRoute: saved,
      generationId,
      draftMode: EXTENDED,
      createdAt: 10_000,
      preexistingConversationKeys: []
    });
    assert.ok(pending);
    for (const route of [parseChatRoute(url), saved]) {
      assert.deepEqual(
        readPendingDraftAdoptionFromSessionStorage(storage, route, 10_001),
        pending
      );
    }
    assert.equal(shouldRestorePendingDraftAdoption(pending, {
      ok: true,
      generationId,
      phase: "sent",
      submittedUserMessageId: "submitted-user-message"
    }), true);

    persistDraftBindingToSessionStorage(storage, temporary, saved);
    const reloadedRoute = parseChatRoute(url);
    const binding = readDraftBindingFromSessionStorage(storage, reloadedRoute);
    const boundRoute = conversationRouteForBinding(binding, reloadedRoute);
    assert.deepEqual(boundRoute, saved);
    assert.equal(readModeForRoute({ [saved.storageKey]: EXTENDED }, boundRoute), EXTENDED);
    assert.equal(conversationRouteForBinding(binding, parseChatRoute(
      `https://chatgpt.com/c/local-chatgpt${separator}${CHAT_B}`
    )), null);
  }
});

test("rejects foreign and malformed temporary conversation routes", () => {
  for (const url of [
    `https://example.com/c/local-chatgpt%3A${CHAT_A}`,
    `http://chatgpt.com/c/local-chatgpt%3A${CHAT_A}`,
    `https://example.com/c/WEB:${CHAT_A}`,
    `https://chatgpt.com/c/local-chatgpt%3A${CHAT_WITH_HEX.toUpperCase()}`,
    `https://chatgpt.com/c/LOCAL-CHATGPT:${CHAT_A}`,
    `https://chatgpt.com/c/local-chatgpt%253A${CHAT_A}`,
    `https://chatgpt.com/c/local-chatgpt%3A${CHAT_A}/`,
    `https://chatgpt.com/c/local-chatgpt%3A${CHAT_A}%2Fextra`,
    "https://chatgpt.com/c/local-chatgpt%3Anot-a-uuid"
  ]) {
    assert.equal(isTemporaryChatRoute(parseChatRoute(url)), false, url);
  }
});

test("restores only a fresh generation-scoped pending draft adoption", () => {
  const storage = createMemoryStorage();
  const blank = parseChatRoute(
    "https://chatgpt.com/"
  );
  const temporary = parseChatRoute(
    TEMP_CHAT_A
  );
  const savedA = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );
  const savedB = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_B}`
  );
  const generationId =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const createdAt = 10_000;

  const record =
    persistPendingDraftAdoptionToSessionStorage(
      storage,
      {
        sourceRoute: blank,
        temporaryRoute: temporary,
        targetRoute: savedA,
        generationId,
        draftMode: EXTENDED,
        createdAt,
        preexistingConversationKeys: [
          savedB.storageKey
        ]
      }
    );

  assert.deepEqual(record, {
    version: 1,
    sourcePath: "/",
    temporaryPath:
      `/c/WEB:${CHAT_A}`,
    targetConversationId: CHAT_A,
    generationId,
    draftMode: EXTENDED,
    createdAt,
    preexistingConversationKeys: [
      savedB.storageKey
    ]
  });

  for (const route of [
    blank,
    temporary,
    savedA
  ]) {
    assert.deepEqual(
      readPendingDraftAdoptionFromSessionStorage(
        storage,
        route,
        createdAt + 1
      ),
      record
    );
  }

  assert.equal(
    readPendingDraftAdoptionFromSessionStorage(
      storage,
      savedB,
      createdAt + 1
    ),
    null,
    "a pending generation must never adopt a preexisting chat"
  );
  assert.equal(
    storage.getItem(
      DRAFT_PENDING_SESSION_STORAGE_KEY
    ),
    null,
    "route-mismatched recovery evidence must be removed from session storage"
  );

  assert.deepEqual(
    persistPendingDraftAdoptionToSessionStorage(
      storage,
      {
        sourceRoute: blank,
        temporaryRoute: temporary,
        targetRoute: savedA,
        generationId,
        draftMode: EXTENDED,
        createdAt,
        preexistingConversationKeys: [
          savedB.storageKey
        ]
      }
    ),
    record
  );

  assert.equal(
    readPendingDraftAdoptionFromSessionStorage(
      storage,
      temporary,
      createdAt + 120_001
    ),
    null,
    "stale recovery evidence must expire"
  );
  assert.equal(
    storage.getItem(
      DRAFT_PENDING_SESSION_STORAGE_KEY
    ),
    null,
    "expired recovery evidence must be removed from session storage"
  );

  for (const phase of [
    "sent",
    "warning"
  ]) {
    assert.equal(
      shouldRestorePendingDraftAdoption(
        record,
        {
          ok: true,
          generationId,
          phase,
          submittedUserMessageId:
            "user-message"
        }
      ),
      true
    );
  }

  for (const state of [
    {
      ok: true,
      generationId:
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      phase: "sent",
      submittedUserMessageId:
        "user-message"
    },
    {
      ok: true,
      generationId,
      phase: "failed",
      submittedUserMessageId:
        "user-message"
    },
    {
      ok: true,
      generationId,
      phase: "uncertain",
      submittedUserMessageId:
        "user-message"
    },
    {
      ok: true,
      generationId,
      phase: "sent",
      submittedUserMessageId: ""
    }
  ]) {
    assert.equal(
      shouldRestorePendingDraftAdoption(
        record,
        state
      ),
      false
    );
  }

  storage.setItem(
    DRAFT_PENDING_SESSION_STORAGE_KEY,
    JSON.stringify({
      ...record,
      generationId: "not-a-generation"
    })
  );
  assert.equal(
    readPendingDraftAdoptionFromSessionStorage(
      storage,
      temporary,
      createdAt + 1
    ),
    null
  );

  assert.equal(
    clearPendingDraftAdoptionFromSessionStorage(
      storage
    ),
    null
  );
  assert.equal(
    storage.getItem(
      DRAFT_PENDING_SESSION_STORAGE_KEY
    ),
    null
  );
});

test("keeps a discovered draft target writable while its first binding write is pending", () => {
  const blank = parseChatRoute(
    "https://chatgpt.com/"
  );
  const temporary = parseChatRoute(
    TEMP_CHAT_A
  );
  const saved = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  for (const route of [
    blank,
    temporary
  ]) {
    assert.deepEqual(
      conversationRouteForDraftLifecycle({
        route,
        sourceRoute: blank,
        targetRoute: saved
      }),
      saved
    );
  }

  assert.equal(
    conversationRouteForDraftLifecycle({
      route: temporary,
      sourceRoute: blank,
      targetRoute: saved,
      navigationDisqualified: true
    }),
    null
  );

});

test("drains a target-scoped mode write to the latest selection after route teardown", async () => {
  for (const [
    initialMode,
    changedMode
  ] of [
    [EXTENDED, STANDARD],
    [STANDARD, EXTENDED]
  ]) {
    let desiredMode = initialMode;
    const pendingWrites = [];
    const writtenModes = [];

    const drainPromise =
      drainLatestModeWrite(
        () => desiredMode,
        (mode) =>
          new Promise((resolve) => {
            writtenModes.push(mode);
            pendingWrites.push(resolve);
          })
      );

    await Promise.resolve();
    assert.deepEqual(
      writtenModes,
      [initialMode]
    );

    desiredMode = changedMode;
    pendingWrites.shift()();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(
      writtenModes,
      [initialMode, changedMode]
    );

    pendingWrites.shift()();
    assert.equal(
      await drainPromise,
      changedMode
    );
  }
});

test("coalesces a selection that returns to the mode already being written", async () => {
  let desiredMode = EXTENDED;
  let releaseWrite;
  const writtenModes = [];

  const drainPromise =
    drainLatestModeWrite(
      () => desiredMode,
      (mode) =>
        new Promise((resolve) => {
          writtenModes.push(mode);
          releaseWrite = resolve;
        })
    );

  await Promise.resolve();
  desiredMode = STANDARD;
  desiredMode = EXTENDED;
  releaseWrite();

  assert.equal(
    await drainPromise,
    EXTENDED
  );
  assert.deepEqual(
    writtenModes,
    [EXTENDED]
  );
});

test("rejects a failed target-scoped mode write without pretending it drained", async () => {
  await assert.rejects(
    drainLatestModeWrite(
      () => EXTENDED,
      async () => {
        throw new Error("write failed");
      }
    ),
    /write failed/
  );
});

test("gives each saved conversation an independent storage key and mode", () => {
  const routeA = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );
  const routeB = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_B}`
  );

  assert.notEqual(
    routeA.storageKey,
    routeB.storageKey
  );
  assert.equal(
    routeA.storageKey,
    storageKeyForConversationId(CHAT_A)
  );
  assert.equal(
    routeB.storageKey,
    storageKeyForConversationId(CHAT_B)
  );

  const storedValues = {
    [routeA.storageKey]: EXTENDED,
    [routeB.storageKey]: STANDARD
  };

  assert.equal(
    readModeForRoute(
      storedValues,
      routeA
    ),
    EXTENDED
  );
  assert.equal(
    readModeForRoute(
      storedValues,
      routeB
    ),
    STANDARD
  );
});

test("preserves all four saved-chat mode transitions across reload", () => {
  const route = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  for (const previousMode of [
    STANDARD,
    EXTENDED
  ]) {
    for (const selectedMode of [
      STANDARD,
      EXTENDED
    ]) {
      const storedValues = {
        [route.storageKey]:
          previousMode
      };

      assert.equal(
        readModeForRoute(
          storedValues,
          route
        ),
        previousMode
      );

      storedValues[route.storageKey] =
        selectedMode;

      assert.equal(
        readModeForRoute(
          {
            ...storedValues
          },
          parseChatRoute(
            `https://chatgpt.com/c/${CHAT_A}`
          )
        ),
        selectedMode,
        `${previousMode} -> ${selectedMode} should survive reload`
      );
    }
  }
});

test("missing and corrupt stored values default to Standard", () => {
  const route = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  for (const storedValues of [
    undefined,
    null,
    {},
    {
      [route.storageKey]: "unexpected"
    },
    {
      [route.storageKey]: null
    },
    {
      [route.storageKey]: true
    }
  ]) {
    assert.equal(
      readModeForRoute(
        storedValues,
        route
      ),
      STANDARD
    );
  }

  assert.equal(
    readModeForRoute(
      {
        [route.storageKey]: EXTENDED
      },
      {
        kind: "conversation",
        storageKey: null
      }
    ),
    STANDARD
  );

  assert.equal(
    normalizeMode(EXTENDED),
    EXTENDED
  );
  assert.equal(
    normalizeMode(STANDARD),
    STANDARD
  );
  assert.equal(
    normalizeMode("extended "),
    STANDARD
  );
});

test("legacy global preference is not a per-chat fallback", () => {
  const route = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  assert.equal(
    readModeForRoute(
      {
        effortPreference: EXTENDED
      },
      route
    ),
    STANDARD
  );

  assert.equal(
    storageChangeAffectsRoute(
      {
        effortPreference: {
          oldValue: STANDARD,
          newValue: EXTENDED
        }
      },
      route
    ),
    false
  );
});

test("keeps UUID-less draft routes in one tab-scoped mode", () => {
  const rootDraft = parseChatRoute(
    "https://chatgpt.com/"
  );
  const newDraft = parseChatRoute(
    "https://chatgpt.com/new"
  );
  const saved = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  assert.equal(
    sameChatRoute(rootDraft, newDraft),
    true
  );
  assert.equal(
    sameChatRoute(rootDraft, saved),
    false
  );
  assert.equal(
    readModeForRoute(
      {},
      rootDraft,
      EXTENDED
    ),
    EXTENDED
  );
  assert.equal(
    readModeForRoute(
      {},
      rootDraft,
      "corrupt"
    ),
    STANDARD
  );
});

test("persists every Standard and Extended blank-draft transition across a same-tab reload", () => {
  for (const initialMode of [
    STANDARD,
    EXTENDED
  ]) {
    for (const selectedMode of [
      STANDARD,
      EXTENDED
    ]) {
      const storage =
        createMemoryStorage();

      persistDraftModeToSessionStorage(
        storage,
        initialMode
      );

      assert.equal(
        readDraftModeFromSessionStorage(
          storage
        ),
        initialMode,
        `${initialMode} should survive its first reconstruction`
      );

      persistDraftModeToSessionStorage(
        storage,
        selectedMode
      );

      assert.equal(
        readDraftModeFromSessionStorage(
          storage
        ),
        selectedMode,
        `${initialMode} -> ${selectedMode} should survive reload`
      );
    }
  }
});

test("blank-draft session state is isolated, normalized, and clearable", () => {
  const firstTab = createMemoryStorage();
  const secondTab = createMemoryStorage();

  assert.equal(
    readDraftModeFromSessionStorage(
      firstTab
    ),
    STANDARD
  );

  assert.equal(
    persistDraftModeToSessionStorage(
      firstTab,
      EXTENDED
    ),
    EXTENDED
  );
  assert.equal(
    firstTab.getItem(
      DRAFT_SESSION_STORAGE_KEY
    ),
    EXTENDED
  );
  assert.equal(
    readDraftModeFromSessionStorage(
      firstTab
    ),
    EXTENDED
  );
  assert.equal(
    readDraftModeFromSessionStorage(
      secondTab
    ),
    STANDARD
  );

  assert.equal(
    clearDraftModeFromSessionStorage(
      firstTab
    ),
    STANDARD
  );
  assert.equal(
    readDraftModeFromSessionStorage(
      firstTab
    ),
    STANDARD
  );

  persistDraftModeToSessionStorage(
    firstTab,
    "corrupt"
  );
  assert.equal(
    readDraftModeFromSessionStorage(
      firstTab
    ),
    STANDARD
  );
});

test("blocked blank-draft session storage fails safely without changing mode normalization", () => {
  const blockedStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    }
  };

  assert.equal(
    readDraftModeFromSessionStorage(
      blockedStorage
    ),
    STANDARD
  );
  assert.equal(
    persistDraftModeToSessionStorage(
      blockedStorage,
      EXTENDED
    ),
    EXTENDED
  );
  assert.equal(
    persistDraftModeToSessionStorage(
      blockedStorage,
      "corrupt"
    ),
    STANDARD
  );
  assert.equal(
    clearDraftModeFromSessionStorage(
      blockedStorage
    ),
    STANDARD
  );
});

test("distinguishes saved conversations while treating equivalent saved routes as the same chat", () => {
  const routeA = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );
  const routeAWithQuery = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}?model=pro`
  );
  const routeB = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_B}`
  );

  assert.equal(
    sameChatRoute(
      routeA,
      routeAWithQuery
    ),
    true
  );
  assert.equal(
    sameChatRoute(routeA, routeB),
    false
  );
  assert.equal(
    sameChatRoute(null, routeA),
    false
  );
});

test("adopts an Extended draft only for its active successful first send", () => {
  const draft = parseChatRoute(
    "https://chatgpt.com/"
  );
  const saved = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  assert.equal(
    isDraftAdoptionTarget({
      fromRoute: draft,
      toRoute: saved,
      draftMode: EXTENDED,
      activeDraftSend: true
    }),
    true
  );

  assert.equal(
    shouldAdoptDraftMode({
      fromRoute: draft,
      toRoute: saved,
      draftMode: EXTENDED,
      activeDraftSend: true,
      sendSucceeded: true
    }),
    true
  );

  for (const variant of [
    {
      draftMode: STANDARD,
      activeDraftSend: true,
      sendSucceeded: true
    },
    {
      draftMode: EXTENDED,
      activeDraftSend: false,
      sendSucceeded: true
    },
    {
      draftMode: EXTENDED,
      activeDraftSend: true,
      sendSucceeded: false
    },
    {
      draftMode: EXTENDED,
      activeDraftSend: true,
      sendSucceeded: true,
      alreadyAdopted: true
    },
    {
      draftMode: EXTENDED,
      activeDraftSend: true,
      sendSucceeded: true,
      targetWasPreexisting: true
    },
    {
      draftMode: EXTENDED,
      activeDraftSend: true,
      sendSucceeded: true,
      navigationDisqualified: true
    }
  ]) {
    assert.equal(
      shouldAdoptDraftMode({
        fromRoute: draft,
        toRoute: saved,
        ...variant
      }),
      false
    );
  }

  assert.equal(
    shouldAdoptDraftMode({
      fromRoute: saved,
      toRoute: parseChatRoute(
        `https://chatgpt.com/c/${CHAT_B}`
      ),
      draftMode: EXTENDED,
      activeDraftSend: true,
      sendSucceeded: true
    }),
    false
  );
});

test("a Standard first send can adopt a later Extended selection at the new-chat route boundary", () => {
  const draft = parseChatRoute(
    "https://chatgpt.com/"
  );
  const createdChat = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  assert.equal(
    isDraftAdoptionTarget({
      fromRoute: draft,
      toRoute: createdChat,
      draftMode: STANDARD,
      activeDraftSend: true
    }),
    false
  );

  assert.equal(
    shouldAdoptDraftMode({
      fromRoute: draft,
      toRoute: createdChat,
      draftMode: EXTENDED,
      activeDraftSend: true,
      sendSucceeded: true
    }),
    true
  );

  for (const disqualifier of [
    {
      targetWasPreexisting: true
    },
    {
      navigationDisqualified: true
    }
  ]) {
    assert.equal(
      shouldAdoptDraftMode({
        fromRoute: draft,
        toRoute: createdChat,
        draftMode: EXTENDED,
        activeDraftSend: true,
        sendSucceeded: true,
        ...disqualifier
      }),
      false
    );
  }
});

test("binds either selected mode only after a unique successful draft send", () => {
  const draft = parseChatRoute(
    "https://chatgpt.com/"
  );
  const saved = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  for (const mode of [
    STANDARD,
    EXTENDED
  ]) {
    assert.equal(
      shouldBindDraftConversation({
        fromRoute: draft,
        toRoute: saved,
        draftMode: mode,
        activeDraftSend: true,
        sendSucceeded: true
      }),
      true
    );
  }

  for (const disqualifier of [
    {
      activeDraftSend: false,
      sendSucceeded: true
    },
    {
      activeDraftSend: true,
      sendSucceeded: false
    },
    {
      activeDraftSend: true,
      sendSucceeded: true,
      alreadyAdopted: true
    },
    {
      activeDraftSend: true,
      sendSucceeded: true,
      targetWasPreexisting: true
    },
    {
      activeDraftSend: true,
      sendSucceeded: true,
      navigationDisqualified: true
    }
  ]) {
    assert.equal(
      shouldBindDraftConversation({
        fromRoute: draft,
        toRoute: saved,
        ...disqualifier
      }),
      false
    );
  }
});

test("does not adopt a draft mode into another draft or an invalid saved-route shape", () => {
  const draft = parseChatRoute(
    "https://chatgpt.com/"
  );

  assert.equal(
    isDraftAdoptionTarget({
      fromRoute: draft,
      toRoute: parseChatRoute(
        "https://chatgpt.com/new"
      ),
      draftMode: EXTENDED,
      activeDraftSend: true
    }),
    false
  );

  assert.equal(
    isDraftAdoptionTarget({
      fromRoute: draft,
      toRoute: {
        kind: "conversation",
        storageKey: null
      },
      draftMode: EXTENDED,
      activeDraftSend: true
    }),
    false
  );
});

test("does not adopt an Extended draft into a preexisting or explicitly navigated conversation", () => {
  const draft = parseChatRoute(
    "https://chatgpt.com/"
  );
  const saved = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );

  assert.equal(
    isDraftAdoptionTarget({
      fromRoute: draft,
      toRoute: saved,
      draftMode: EXTENDED,
      activeDraftSend: true,
      targetWasPreexisting: true
    }),
    false
  );

  assert.equal(
    isDraftAdoptionTarget({
      fromRoute: draft,
      toRoute: saved,
      draftMode: EXTENDED,
      activeDraftSend: true,
      navigationDisqualified: true
    }),
    false
  );
});

test("same-chat storage changes synchronize while unrelated changes are ignored", () => {
  const routeA = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_A}`
  );
  const routeB = parseChatRoute(
    `https://chatgpt.com/c/${CHAT_B}`
  );

  assert.equal(
    storageChangeAffectsRoute(
      {
        [routeA.storageKey]: {
          oldValue: STANDARD,
          newValue: EXTENDED
        }
      },
      routeA
    ),
    true
  );

  assert.equal(
    storageChangeAffectsRoute(
      {
        [routeA.storageKey]: {
          oldValue: EXTENDED
        }
      },
      routeA
    ),
    true
  );

  assert.equal(
    storageChangeAffectsRoute(
      {
        [routeB.storageKey]: {
          oldValue: STANDARD,
          newValue: EXTENDED
        }
      },
      routeA
    ),
    false
  );

  assert.equal(
    storageChangeAffectsRoute(
      null,
      routeA
    ),
    false
  );

  assert.equal(
    storageChangeAffectsRoute(
      {
        [routeA.storageKey]: {
          oldValue: STANDARD,
          newValue: EXTENDED
        }
      },
      {
        kind: "conversation",
        storageKey: null
      }
    ),
    false
  );
});

test("submission policy follows mode and current visible model state", () => {
  assert.deepEqual(
    decideSubmissionForMode(
      STANDARD,
      "pro"
    ),
    {
      mode: STANDARD,
      policy: "pass"
    }
  );

  assert.deepEqual(
    decideSubmissionForMode(
      EXTENDED,
      "pro"
    ),
    {
      mode: EXTENDED,
      policy: "gate"
    }
  );

  assert.deepEqual(
    decideSubmissionForMode(
      EXTENDED,
      "other"
    ),
    {
      mode: EXTENDED,
      policy: "pass"
    }
  );

  assert.deepEqual(
    decideSubmissionForMode(
      EXTENDED,
      "unknown"
    ),
    {
      mode: EXTENDED,
      policy: "block_unknown"
    }
  );

  assert.deepEqual(
    decideSubmissionForMode(
      "corrupt",
      "pro"
    ),
    {
      mode: STANDARD,
      policy: "pass"
    }
  );
});

test("repeated gate decisions and failures never reset an Extended chat mode", () => {
  let mode = EXTENDED;

  for (const [modelState, policy] of [
    ["pro", "gate"],
    ["unknown", "block_unknown"],
    ["pro", "gate"],
    ["other", "pass"],
    ["pro", "gate"]
  ]) {
    const decision =
      decideSubmissionForMode(
        mode,
        modelState
      );

    assert.equal(
      decision.policy,
      policy
    );
    assert.equal(
      decision.mode,
      EXTENDED
    );

    mode = decision.mode;
  }

  assert.equal(mode, EXTENDED);
});
