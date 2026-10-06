import assert from "node:assert/strict";
import test from "node:test";

const MESSAGE_SOURCE =
  "chatgpt-pro-effort-selector";
const TAB_ID = 41;
const SECOND_TAB_ID = 42;
const SEND_TAB_ID = 43;
const TAB_URL =
  "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const UNRELATED_URL =
  "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "document-1";

function createEvent() {
  const listeners = [];

  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...arguments_) {
      for (const listener of listeners) {
        listener(...arguments_);
      }
    },
    listeners
  };
}

function createChromeMock() {
  const events = {
    debuggerDetach: createEvent(),
    debuggerEvent: createEvent(),
    historyStateUpdated: createEvent(),
    navigationCommitted: createEvent(),
    runtimeMessage: createEvent(),
    tabRemoved: createEvent(),
    tabUpdated: createEvent()
  };
  const calls = {
    debuggerAttach: [],
    debuggerCommands: [],
    debuggerDetach: [],
    sentMessages: [],
    storageWrites: [],
    tabsGet: []
  };
  const storedValues = {};
  const tabUrls = new Map();

  const chrome = {
    debugger: {
      attach(target, protocolVersion, callback) {
        calls.debuggerAttach.push({
          target,
          protocolVersion
        });
        callback();
      },
      detach(target, callback) {
        calls.debuggerDetach.push(target);
        callback();
      },
      onDetach: events.debuggerDetach,
      onEvent: events.debuggerEvent,
      sendCommand(
        target,
        method,
        parameters,
        callback
      ) {
        calls.debuggerCommands.push({
          target,
          method,
          parameters
        });
        callback({});
      }
    },
    runtime: {
      lastError: null,
      onMessage: events.runtimeMessage
    },
    storage: {
      session: {
        get(keys, callback) {
          const result = {};

          for (const key of keys) {
            if (
              Object.hasOwn(storedValues, key)
            ) {
              result[key] =
                structuredClone(
                  storedValues[key]
                );
            }
          }

          callback(result);
        },
        set(values, callback) {
          for (const [key, value] of
            Object.entries(values)) {
            storedValues[key] =
              structuredClone(value);
          }

          calls.storageWrites.push(
            structuredClone(values)
          );
          callback();
        }
      }
    },
    tabs: {
      get(tabId, callback) {
        calls.tabsGet.push(tabId);
        callback({
          id: tabId,
          url:
            tabUrls.get(tabId) ?? TAB_URL
        });
      },
      onRemoved: events.tabRemoved,
      onUpdated: events.tabUpdated,
      sendMessage(
        tabId,
        message,
        optionsOrCallback,
        callback
      ) {
        const options =
          typeof optionsOrCallback ===
          "function"
            ? null
            : optionsOrCallback;
        const completion =
          typeof optionsOrCallback ===
          "function"
            ? optionsOrCallback
            : callback;

        calls.sentMessages.push({
          tabId,
          message:
            structuredClone(message),
          options:
            options === null
              ? null
              : structuredClone(options)
        });
        completion();
      }
    },
    webNavigation: {
      onCommitted:
        events.navigationCommitted,
      onHistoryStateUpdated:
        events.historyStateUpdated
    }
  };

  return {
    calls,
    chrome,
    events,
    storedValues,
    tabUrls
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;

  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      "timed out waiting for service-worker listener"
    );
    await delay(10);
  }
}

function sendRuntimeMessage(
  runtimeMessageEvent,
  message,
  sender
) {
  assert.equal(
    runtimeMessageEvent.listeners.length,
    1,
    "service worker must register one runtime message listener"
  );

  return new Promise((resolve) => {
    const keepChannelOpen =
      runtimeMessageEvent.listeners[0](
        message,
        sender,
        resolve
      );

    assert.equal(keepChannelOpen, true);
  });
}

const mock = createChromeMock();
globalThis.chrome = mock.chrome;

await import(
  "../background/service-worker.mjs"
);

test("keeps same-document commit noise armed and fails closed on real navigation", async () => {
  const sender = {
    documentId: DOCUMENT_ID,
    frameId: 0,
    tab: {
      id: TAB_ID,
      url: TAB_URL
    },
    url: TAB_URL
  };
  const armResult = await sendRuntimeMessage(
    mock.events.runtimeMessage,
    {
      source: MESSAGE_SOURCE,
      type: "armExtended"
    },
    sender
  );

  assert.equal(armResult.ok, true);
  assert.equal(
    typeof armResult.generationId,
    "string"
  );
  assert.deepEqual(
    mock.calls.debuggerAttach,
    [
      {
        target: { tabId: TAB_ID },
        protocolVersion: "1.3"
      }
    ]
  );

  mock.events.tabUpdated.emit(
    TAB_ID,
    { status: "loading" }
  );

  await delay(1_150);

  assert.deepEqual(
    mock.calls.tabsGet,
    [TAB_ID, TAB_ID],
    "the status-only update must resolve the current URL through tabs.get"
  );
  assert.equal(
    mock.calls.debuggerDetach.length,
    0,
    "an unchanged URL must not trigger the one-second navigation failure"
  );

  const activeState = await sendRuntimeMessage(
    mock.events.runtimeMessage,
    {
      source: MESSAGE_SOURCE,
      type: "getState"
    },
    sender
  );

  assert.equal(activeState.ok, true);
  assert.equal(
    activeState.activeOperation,
    true,
    "the armed session must not be retired"
  );
  assert.equal(
    activeState.generationId,
    armResult.generationId
  );
  assert.equal(activeState.phase, "arming");

  mock.events.navigationCommitted.emit({
    documentId: DOCUMENT_ID,
    frameId: 0,
    tabId: TAB_ID,
    url: TAB_URL
  });

  await delay(25);

  const sameDocumentState =
    await sendRuntimeMessage(
      mock.events.runtimeMessage,
      {
        source: MESSAGE_SOURCE,
        type: "getState"
      },
      sender
    );

  assert.equal(
    mock.calls.debuggerDetach.length,
    0,
    "an unchanged commit from the armed document must not detach"
  );
  assert.equal(
    sameDocumentState.activeOperation,
    true,
    "an unchanged commit from the armed document must preserve the session"
  );
  assert.equal(
    sameDocumentState.generationId,
    armResult.generationId
  );

  mock.events.navigationCommitted.emit({
    documentId: "document-2",
    frameId: 0,
    tabId: TAB_ID,
    url: TAB_URL
  });

  await waitFor(() =>
    mock.calls.sentMessages.some(
      ({ message }) =>
        message.type === "status" &&
        message.phase === "failed"
    )
  );

  assert.deepEqual(
    mock.calls.debuggerDetach,
    [{ tabId: TAB_ID }],
    "a top-frame commit must detach the debugger"
  );

  const failedState = await sendRuntimeMessage(
    mock.events.runtimeMessage,
    {
      source: MESSAGE_SOURCE,
      type: "getState"
    },
    sender
  );

  assert.equal(failedState.ok, true);
  assert.equal(
    failedState.activeOperation,
    false,
    "a committed navigation must retire the armed session"
  );
  assert.equal(failedState.phase, "failed");
  assert.equal(
    failedState.label,
    "Extended blocked"
  );
  assert.match(
    failedState.message,
    /tab navigated while Extended was armed/
  );

  const storedRuntime =
    mock.storedValues.proEffortRuntimeV1;
  assert.deepEqual(storedRuntime.active, {});
  assert.equal(
    storedRuntime.audits[String(TAB_ID)]
      .error,
    "navigation"
  );

  const unrelatedSender = {
    ...sender,
    tab: {
      ...sender.tab,
      id: SECOND_TAB_ID
    }
  };
  const unrelatedArmResult =
    await sendRuntimeMessage(
      mock.events.runtimeMessage,
      {
        source: MESSAGE_SOURCE,
        type: "armExtended"
      },
      unrelatedSender
    );

  assert.equal(unrelatedArmResult.ok, true);

  mock.events.navigationCommitted.emit({
    documentId: DOCUMENT_ID,
    frameId: 0,
    tabId: SECOND_TAB_ID,
    url: UNRELATED_URL
  });

  await waitFor(() =>
    mock.calls.sentMessages.some(
      ({ message, tabId }) =>
        tabId === SECOND_TAB_ID &&
        message.type === "status" &&
        message.phase === "failed"
    )
  );

  assert.deepEqual(
    mock.calls.debuggerDetach,
    [
      { tabId: TAB_ID },
      { tabId: SECOND_TAB_ID }
    ],
    "a same-document commit to an unrelated URL must still detach"
  );

  const unrelatedState =
    await sendRuntimeMessage(
      mock.events.runtimeMessage,
      {
        source: MESSAGE_SOURCE,
        type: "getState"
      },
      unrelatedSender
    );

  assert.equal(
    unrelatedState.activeOperation,
    false
  );
  assert.equal(unrelatedState.phase, "failed");
  assert.equal(
    mock.storedValues.proEffortRuntimeV1
      .audits[String(SECOND_TAB_ID)]
      .error,
    "navigation"
  );
});

async function verifyExtendedContinuation(model, prepareState, omitEffort = false) {
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;

  await import(
    `../background/service-worker.mjs?extended-model=${model}&omit-effort=${omitEffort}`
  );

  const sender = {
    documentId: DOCUMENT_ID,
    frameId: 0,
    tab: {
      id: SEND_TAB_ID,
      url: TAB_URL
    },
    url: TAB_URL
  };
  const armResult = await sendRuntimeMessage(
    mock.events.runtimeMessage,
    {
      source: MESSAGE_SOURCE,
      type: "armExtended"
    },
    sender
  );

  assert.equal(armResult.ok, true);

  const confirmResult =
    await sendRuntimeMessage(
      mock.events.runtimeMessage,
      {
        generationId:
          armResult.generationId,
        source: MESSAGE_SOURCE,
        type: "confirmArmed"
      },
      sender
    );

  assert.deepEqual(confirmResult, {
    generationId: armResult.generationId,
    ok: true
  });

  const replayResult =
    await sendRuntimeMessage(
      mock.events.runtimeMessage,
      {
        generationId:
          armResult.generationId,
        source: MESSAGE_SOURCE,
        type: "markReplayStarting"
      },
      sender
    );

  assert.equal(replayResult.ok, true);
  assert.equal(replayResult.generationId, armResult.generationId);
  assert.ok(Number.isSafeInteger(replayResult.replayDeadlineAt));
  assert.ok(replayResult.replayDeadlineAt > Date.now());
  assert.ok(replayResult.replayDeadlineAt <= Date.now() + 60_000);

  const submittedBody = {
    client_prepare_state: prepareState,
    conversation_id: "conversation-id",
    messages: [
      {
        author: { role: "user" },
        id: "submitted-user-message"
      }
    ],
    model,
    thinking_effort: "standard"
  };
  if (omitEffort) {
    delete submittedBody.thinking_effort;
  }

  mock.events.debuggerEvent.emit(
    { tabId: SEND_TAB_ID },
    "Fetch.requestPaused",
    {
      requestId: "paused-pro-request",
      request: {
        headers: {
          "Content-Length": "321",
          "X-Conduit-Token":
            "do-not-replay",
          "content-type":
            "application/json",
          "x-preserved": "yes"
        },
        method: "POST",
        postData: JSON.stringify(
          submittedBody
        ),
        url:
          "https://chatgpt.com/backend-api/f/conversation"
      },
      resourceType: "Fetch"
    }
  );

  await waitFor(() =>
    mock.calls.debuggerCommands.some(
      ({ method, target }) =>
        target.tabId === SEND_TAB_ID &&
        method === "Fetch.continueRequest"
    )
  );

  const continuationCommands =
    mock.calls.debuggerCommands.filter(
      ({ method, target }) =>
        target.tabId === SEND_TAB_ID &&
        method === "Fetch.continueRequest"
    );

  assert.equal(
    continuationCommands.length,
    1,
    "the qualifying request must be continued exactly once"
  );

  const continuation =
    continuationCommands[0];
  assert.equal(
    continuation.parameters.requestId,
    "paused-pro-request"
  );

  const continuedBody = JSON.parse(
    Buffer.from(
      continuation.parameters.postData,
      "base64"
    ).toString("utf8")
  );

  assert.deepEqual(
    continuedBody,
    {
      ...submittedBody,
      client_prepare_state: "none",
      thinking_effort: "extended"
    },
    "the continued body must preserve every field except the two authorized effort assignments"
  );
  assert.deepEqual(
    continuation.parameters.headers,
    [
      {
        name: "content-type",
        value: "application/json"
      },
      {
        name: "x-preserved",
        value: "yes"
      }
    ]
  );

  await waitFor(() =>
    mock.calls.sentMessages.some(
      ({ message, tabId }) =>
        tabId === SEND_TAB_ID &&
        message.phase === "sent"
    )
  );

  assert.deepEqual(
    mock.calls.debuggerDetach.filter(
      ({ tabId }) =>
        tabId === SEND_TAB_ID
    ),
    [{ tabId: SEND_TAB_ID }],
    "successful continuation must detach exactly once after cleanup"
  );

  const sentState = await sendRuntimeMessage(
    mock.events.runtimeMessage,
    {
      source: MESSAGE_SOURCE,
      type: "getState"
    },
    sender
  );

  assert.equal(sentState.activeOperation, false);
  assert.equal(sentState.phase, "sent");
  assert.equal(
    sentState.label,
    "Sent as Extended"
  );
  assert.equal(
    sentState.submittedUserMessageId,
    "submitted-user-message"
  );
  assert.deepEqual(
    mock.storedValues.proEffortRuntimeV1
      .audits[String(SEND_TAB_ID)].original,
    {
      client_prepare_state: prepareState,
      model,
      thinking_effort: omitEffort ? null : "standard"
    }
  );
  assert.deepEqual(
    mock.storedValues.proEffortRuntimeV1
      .audits[String(SEND_TAB_ID)].forced,
    {
      client_prepare_state: "none",
      model,
      thinking_effort: "extended"
    }
  );
}

test("sends GPT-5.6 Pro Extended through Fetch.continueRequest without changing model", () =>
  verifyExtendedContinuation("gpt-5-6-pro", "ready")
);

test("sends GPT-6 Pro Extended through Fetch.continueRequest without changing model", () =>
  verifyExtendedContinuation("gpt-6-pro", "success")
);

test("sends GPT-6 Pro Extended when the native request omits effort and persists a null original", () =>
  verifyExtendedContinuation("gpt-6-pro", "success", true)
);

test("continues new GPT-6 chats through local routes and correlated canonical promotion", async () => {
  for (const separator of [":", "%3A", "%3a"]) {
    const routeMock = createChromeMock();
    globalThis.chrome = routeMock.chrome;
    let releaseCleanup;
    const sendCommand = routeMock.chrome.debugger.sendCommand;
    routeMock.chrome.debugger.sendCommand = (target, method, parameters, callback) => {
      sendCommand(target, method, parameters, (result) => {
        if (method === "Fetch.enable" && parameters.patterns.length === 0) {
          // Hold cleanup so navigation can exercise the post-send promotion window.
          releaseCleanup = () => callback(result);
        } else {
          callback(result);
        }
      });
    };

    await import(`../background/service-worker.mjs?local-route=${encodeURIComponent(separator)}`);

    const temporaryPath = `/c/local-chatgpt${separator}33333333-3333-4333-8333-333333333333`;
    const temporaryUrl = `https://chatgpt.com${temporaryPath}`;
    const sender = {
      documentId: DOCUMENT_ID,
      frameId: 0,
      tab: { id: SEND_TAB_ID, url: "https://chatgpt.com/" },
      url: "https://chatgpt.com/"
    };
    routeMock.tabUrls.set(SEND_TAB_ID, sender.tab.url);
    const arm = await sendRuntimeMessage(routeMock.events.runtimeMessage, {
      source: MESSAGE_SOURCE,
      type: "armExtended"
    }, sender);
    assert.equal(arm.ok, true);
    for (const type of ["confirmArmed", "markReplayStarting"]) {
      const result = await sendRuntimeMessage(routeMock.events.runtimeMessage, {
        source: MESSAGE_SOURCE,
        generationId: arm.generationId,
        type
      }, sender);
      assert.equal(result.ok, true);
    }

    sender.tab.url = temporaryUrl;
    routeMock.tabUrls.set(SEND_TAB_ID, temporaryUrl);
    routeMock.events.historyStateUpdated.emit({
      documentId: DOCUMENT_ID,
      frameId: 0,
      tabId: SEND_TAB_ID,
      url: temporaryUrl
    });
    await waitFor(() =>
      routeMock.storedValues.proEffortRuntimeV1.active[SEND_TAB_ID]?.pagePath === temporaryPath
    );
    assert.equal(routeMock.calls.debuggerDetach.length, 0);

    routeMock.events.debuggerEvent.emit({ tabId: SEND_TAB_ID }, "Fetch.requestPaused", {
      requestId: "new-chat-request",
      resourceType: "Fetch",
      request: {
        method: "POST",
        url: "https://chatgpt.com/backend-api/f/conversation",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          model: "gpt-6-pro",
          client_prepare_state: "success",
          messages: [{ id: "new-chat-user", author: { role: "user" } }]
        })
      }
    });
    await waitFor(() => typeof releaseCleanup === "function");

    const canonicalPath = new URL(TAB_URL).pathname;
    sender.tab.url = TAB_URL;
    routeMock.tabUrls.set(SEND_TAB_ID, TAB_URL);
    routeMock.events.historyStateUpdated.emit({
      documentId: DOCUMENT_ID,
      frameId: 0,
      tabId: SEND_TAB_ID,
      url: TAB_URL
    });
    await delay(25);
    assert.equal(
      routeMock.storedValues.proEffortRuntimeV1.active[SEND_TAB_ID].pagePath,
      temporaryPath,
      "the canonical route must wait for correlation authorization"
    );
    const promotion = await sendRuntimeMessage(routeMock.events.runtimeMessage, {
      source: MESSAGE_SOURCE,
      type: "authorizeCanonicalPromotion",
      generationId: arm.generationId,
      targetPath: canonicalPath
    }, sender);
    assert.equal(promotion.ok, true);
    await waitFor(() =>
      routeMock.storedValues.proEffortRuntimeV1.active[SEND_TAB_ID]?.pagePath === canonicalPath
    );
    const repeatedPromotion = await sendRuntimeMessage(routeMock.events.runtimeMessage, {
      source: MESSAGE_SOURCE,
      type: "authorizeCanonicalPromotion",
      generationId: arm.generationId,
      targetPath: canonicalPath
    }, sender);
    assert.equal(repeatedPromotion.ok, false);
    assert.equal(repeatedPromotion.code, "canonical_promotion_not_current");

    releaseCleanup();
    await waitFor(() => routeMock.calls.sentMessages.some(
      ({ message }) => message.generationId === arm.generationId && message.phase === "sent"
    ));
    assert.equal(routeMock.calls.debuggerDetach.length, 1);
    assert.equal(routeMock.calls.debuggerCommands.some(
      ({ method }) => method === "Fetch.failRequest"
    ), false);
    const continuations = routeMock.calls.debuggerCommands.filter(
      ({ method }) => method === "Fetch.continueRequest"
    );
    assert.equal(continuations.length, 1);
    const body = JSON.parse(Buffer.from(
      continuations[0].parameters.postData, "base64"
    ).toString("utf8"));
    assert.equal(body.model, "gpt-6-pro");
    assert.equal(body.thinking_effort, "extended");
    assert.equal(body.messages[0].id, "new-chat-user");
    assert.equal(routeMock.storedValues.proEffortRuntimeV1.active[SEND_TAB_ID], undefined);
  }
});

test("uses the current tab URL when MessageSender.url is stale", async () => {
  const staleUrlMock = createChromeMock();
  globalThis.chrome = staleUrlMock.chrome;

  await import(
    "../background/service-worker.mjs?stale-message-sender-url"
  );

  const staleUrlTabId = 51;
  const staleUrlSender = {
    documentId: "stale-url-document",
    frameId: 0,
    tab: {
      id: staleUrlTabId,
      url: TAB_URL
    },
    url: "https://chatgpt.com/"
  };

  staleUrlMock.tabUrls.set(
    staleUrlTabId,
    TAB_URL
  );

  const armResult = await sendRuntimeMessage(
    staleUrlMock.events.runtimeMessage,
    {
      source: MESSAGE_SOURCE,
      type: "armExtended"
    },
    staleUrlSender
  );

  assert.equal(armResult.ok, true);
  assert.equal(
    staleUrlMock.storedValues
      .proEffortRuntimeV1
      .active[String(staleUrlTabId)]
      .pagePath,
    new URL(TAB_URL).pathname,
    "the generation must bind to the current canonical tab path"
  );
  assert.equal(
    staleUrlMock.storedValues
      .proEffortRuntimeV1
      .active[String(staleUrlTabId)]
      .documentId,
    staleUrlSender.documentId
  );
  assert.deepEqual(
    staleUrlMock.calls.debuggerAttach.filter(
      ({ target }) =>
        target.tabId === staleUrlTabId
    ),
    [
      {
        protocolVersion: "1.3",
        target: { tabId: staleUrlTabId }
      }
    ],
    "the stale sender URL must not prevent attachment to the current canonical tab"
  );

  const confirmResult =
    await sendRuntimeMessage(
      staleUrlMock.events.runtimeMessage,
      {
        generationId:
          armResult.generationId,
        source: MESSAGE_SOURCE,
        type: "confirmArmed"
      },
      staleUrlSender
    );
  const replayResult =
    await sendRuntimeMessage(
      staleUrlMock.events.runtimeMessage,
      {
        generationId:
          armResult.generationId,
        source: MESSAGE_SOURCE,
        type: "markReplayStarting"
      },
      staleUrlSender
    );

  assert.deepEqual(confirmResult, {
    generationId: armResult.generationId,
    ok: true
  });
  assert.equal(replayResult.ok, true);
  assert.equal(replayResult.generationId, armResult.generationId);
  assert.ok(Number.isSafeInteger(replayResult.replayDeadlineAt));
  assert.ok(replayResult.replayDeadlineAt > Date.now());
  assert.ok(replayResult.replayDeadlineAt <= Date.now() + 60_000);

  staleUrlMock.events.debuggerEvent.emit(
    { tabId: staleUrlTabId },
    "Fetch.requestPaused",
    {
      requestId: "stale-url-pro-request",
      request: {
        headers: {
          "content-type":
            "application/json"
        },
        method: "POST",
        postData: JSON.stringify({
          client_prepare_state: "ready",
          messages: [
            {
              author: { role: "user" },
              id: "stale-url-user-message"
            }
          ],
          model: "gpt-5-6-pro",
          thinking_effort: "standard"
        }),
        url:
          "https://chatgpt.com/backend-api/f/conversation"
      },
      resourceType: "Fetch"
    }
  );

  await waitFor(() =>
    staleUrlMock.calls.debuggerCommands.some(
      ({ method, parameters, target }) =>
        target.tabId === staleUrlTabId &&
        method === "Fetch.continueRequest" &&
        parameters.requestId ===
          "stale-url-pro-request"
    )
  );

  const continuations =
    staleUrlMock.calls.debuggerCommands.filter(
      ({ method, parameters, target }) =>
        target.tabId === staleUrlTabId &&
        method === "Fetch.continueRequest" &&
        parameters.requestId ===
          "stale-url-pro-request"
    );
  assert.equal(
    continuations.length,
    1,
    "the stale context must still continue exactly one qualifying request"
  );
  const [continuation] = continuations;
  const continuedBody = JSON.parse(
    Buffer.from(
      continuation.parameters.postData,
      "base64"
    ).toString("utf8")
  );

  assert.equal(
    continuedBody.model,
    "gpt-5-6-pro"
  );
  assert.equal(
    continuedBody.thinking_effort,
    "extended"
  );
  assert.equal(
    continuedBody.client_prepare_state,
    "none"
  );

  await waitFor(() =>
    staleUrlMock.calls.sentMessages.some(
      ({ message, tabId }) =>
        tabId === staleUrlTabId &&
        message.generationId ===
          armResult.generationId &&
        message.phase === "sent"
    )
  );

  assert.deepEqual(
    staleUrlMock.calls.debuggerDetach.filter(
      ({ tabId }) =>
        tabId === staleUrlTabId
    ),
    [{ tabId: staleUrlTabId }]
  );

  const sentState = await sendRuntimeMessage(
    staleUrlMock.events.runtimeMessage,
    {
      source: MESSAGE_SOURCE,
      type: "getState"
    },
    staleUrlSender
  );

  assert.equal(sentState.activeOperation, false);
  assert.equal(sentState.phase, "sent");
  assert.equal(
    sentState.generationId,
    armResult.generationId
  );
  assert.equal(
    staleUrlMock.storedValues
      .proEffortRuntimeV1
      .audits[String(staleUrlTabId)]
      .status,
    "sent"
  );
  assert.equal(
    staleUrlMock.storedValues
      .proEffortRuntimeV1
      .audits[String(staleUrlTabId)]
      .error,
    null
  );

  const differentPathTabId = 52;
  const differentPathSender = {
    ...staleUrlSender,
    documentId: "different-path-document",
    tab: {
      id: differentPathTabId,
      url: TAB_URL
    }
  };

  staleUrlMock.tabUrls.set(
    differentPathTabId,
    UNRELATED_URL
  );

  const differentPathResult =
    await sendRuntimeMessage(
      staleUrlMock.events.runtimeMessage,
      {
        source: MESSAGE_SOURCE,
        type: "armExtended"
      },
      differentPathSender
    );

  assert.equal(differentPathResult.ok, false);
  assert.equal(
    differentPathResult.code,
    "navigation"
  );
  assert.equal(
    staleUrlMock.calls.debuggerAttach.some(
      ({ target }) =>
        target.tabId === differentPathTabId
    ),
    false,
    "a live tab on a different path must fail before debugger attachment"
  );

  for (const [tabId, contextUrl] of [
    [54, "https://example.com/"],
    [55, undefined]
  ]) {
    const invalidContextSender = {
      ...staleUrlSender,
      documentId:
        `invalid-context-document-${tabId}`,
      tab: {
        id: tabId,
        url: TAB_URL
      },
      url: contextUrl
    };

    staleUrlMock.tabUrls.set(tabId, TAB_URL);

    const invalidContextResult =
      await sendRuntimeMessage(
        staleUrlMock.events.runtimeMessage,
        {
          source: MESSAGE_SOURCE,
          type: "armExtended"
        },
        invalidContextSender
      );

    assert.equal(
      invalidContextResult.ok,
      false
    );
    assert.equal(
      invalidContextResult.code,
      "invalid_sender"
    );
    assert.equal(
      staleUrlMock.calls.debuggerAttach.some(
        ({ target }) => target.tabId === tabId
      ),
      false,
      "an allowed tab URL must not authenticate a foreign or missing sender context"
    );
  }

  const differentDocumentTabId = 53;
  const originalDocumentSender = {
    ...staleUrlSender,
    documentId: "original-document",
    tab: {
      id: differentDocumentTabId,
      url: TAB_URL
    }
  };

  staleUrlMock.tabUrls.set(
    differentDocumentTabId,
    TAB_URL
  );

  const documentArmResult =
    await sendRuntimeMessage(
      staleUrlMock.events.runtimeMessage,
      {
        source: MESSAGE_SOURCE,
        type: "armExtended"
      },
      originalDocumentSender
    );

  assert.equal(documentArmResult.ok, true);

  const wrongDocumentConfirmation =
    await sendRuntimeMessage(
      staleUrlMock.events.runtimeMessage,
      {
        generationId:
          documentArmResult.generationId,
        source: MESSAGE_SOURCE,
        type: "confirmArmed"
      },
      {
        ...originalDocumentSender,
        documentId: "replacement-document"
      }
    );

  assert.equal(
    wrongDocumentConfirmation.ok,
    false
  );
  assert.equal(
    wrongDocumentConfirmation.code,
    "arm_not_current"
  );

  const cancelResult = await sendRuntimeMessage(
    staleUrlMock.events.runtimeMessage,
    {
      generationId:
        documentArmResult.generationId,
      source: MESSAGE_SOURCE,
      type: "cancelArm"
    },
    originalDocumentSender
  );

  assert.equal(cancelResult.ok, true);
  assert.deepEqual(
    staleUrlMock.calls.debuggerDetach.filter(
      ({ tabId }) =>
        tabId === differentDocumentTabId
    ),
    [{ tabId: differentDocumentTabId }]
  );
});
