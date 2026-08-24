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
          url: TAB_URL
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
    storedValues
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

test("sends the exact Pro Extended body through Fetch.continueRequest", async () => {
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

  assert.deepEqual(replayResult, {
    generationId: armResult.generationId,
    ok: true
  });

  const submittedBody = {
    client_prepare_state: "ready",
    conversation_id: "conversation-id",
    messages: [
      {
        author: { role: "user" },
        id: "submitted-user-message"
      }
    ],
    model: "gpt-5-6-pro",
    thinking_effort: "standard"
  };

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
      model: "gpt-5-6-pro",
      thinking_effort: "extended"
    },
    "the continued body must preserve every field except the three authorized Pro Extended assignments"
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
      .audits[String(SEND_TAB_ID)].forced,
    {
      client_prepare_state: "none",
      model: "gpt-5-6-pro",
      thinking_effort: "extended"
    }
  );
});
