import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

const SOURCE = "chatgpt-pro-effort-selector";
const STORAGE_KEY = "proEffortRuntimeV1";
const TAB_ID = 91;
const TAB_URL = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "diagnostic-test-document";
const DIAGNOSTIC_KEYS = [
  "cause", "observedAt", "phase", "replayAuthorized", "uiReplayStarted",
  "requestContinued", "pausedRequestCount", "abortSucceeded", "detachReason"
].sort();
const PHASES = new Set([
  "idle", "attaching", "enabling", "armed", "settling", "processing",
  "sent", "cleaning", "sent_warning", "complete", "failed"
]);
let instance = 0;

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); },
    listeners
  };
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

// This fixture never contacts Chrome or the network. Worker deadlines are
// controlled explicitly, and all debugger/storage callbacks are local mocks.
async function createFixture(t, { stored, attachError = false, failCommand = () => false } = {}) {
  const originalChrome = globalThis.chrome;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const timers = new Map();
  let timerId = 0;
  globalThis.setTimeout = (callback, milliseconds) => {
    const id = ++timerId;
    timers.set(id, { callback, milliseconds, deadlineAt: now + milliseconds });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => {
    globalThis.chrome = originalChrome;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalNow;
    timers.clear();
  });

  const events = {
    message: event(), detach: event(), debuggerEvent: event(),
    committed: event(), history: event(), removed: event(), updated: event()
  };
  const values = stored ? { [STORAGE_KEY]: structuredClone(stored) } : {};
  const calls = { attach: [], detach: [], commands: [], writes: [], notifications: [] };
  const behavior = { failCommand, failDetach: false, holdCleanup: false, heldCleanup: null, holdAbort: false, heldAbort: null,
    holdNextStorage: false, heldStorage: null };
  const chrome = {
    runtime: { lastError: null, onMessage: events.message },
    debugger: {
      attach(target, version, callback) {
        calls.attach.push({ target, version });
        if (attachError) chrome.runtime.lastError = { message: "SYNTHETIC_PRIVATE_ATTACH_ERROR" };
        callback();
        chrome.runtime.lastError = null;
      },
      detach(target, callback) {
        calls.detach.push(target);
        if (behavior.failDetach) chrome.runtime.lastError = { message: "SYNTHETIC_PRIVATE_DETACH_ERROR" };
        callback();
        chrome.runtime.lastError = null;
      },
      sendCommand(target, method, parameters, callback) {
        calls.commands.push({ target, method, parameters: structuredClone(parameters) });
        if (behavior.holdCleanup && method === "Fetch.enable" && parameters.patterns.length === 0) {
          behavior.heldCleanup = callback;
          return;
        }
        if (behavior.holdAbort && method === "Fetch.failRequest") {
          behavior.heldAbort = callback;
          return;
        }
        if (behavior.failCommand(method, parameters)) {
          chrome.runtime.lastError = { message: "SYNTHETIC_PRIVATE_COMMAND_ERROR" };
        }
        callback({});
        chrome.runtime.lastError = null;
      },
      onDetach: events.detach,
      onEvent: events.debuggerEvent
    },
    storage: { session: {
      get(keys, callback) {
        const result = {};
        for (const key of keys) {
          if (Object.hasOwn(values, key)) result[key] = structuredClone(values[key]);
        }
        callback(result);
      },
      set(update, callback) {
        Object.assign(values, structuredClone(update));
        calls.writes.push(structuredClone(update));
        if (behavior.holdNextStorage) {
          behavior.holdNextStorage = false;
          behavior.heldStorage = callback;
          return;
        }
        callback();
      }
    } },
    tabs: {
      get(id, callback) { callback({ id, url: TAB_URL }); },
      sendMessage(id, message, optionsOrCallback, callback) {
        calls.notifications.push({ id, message: structuredClone(message) });
        (typeof optionsOrCallback === "function" ? optionsOrCallback : callback)();
      },
      onRemoved: events.removed,
      onUpdated: events.updated
    },
    webNavigation: { onCommitted: events.committed, onHistoryStateUpdated: events.history }
  };
  globalThis.chrome = chrome;
  await import(`../background/service-worker.mjs?diagnostics=${++instance}`);
  const sender = {
    frameId: 0, documentId: DOCUMENT_ID,
    tab: { id: TAB_ID, url: TAB_URL }, url: TAB_URL
  };
  const send = (type, extra = {}) => new Promise((resolve) => {
    assert.equal(events.message.listeners.length, 1);
    assert.equal(events.message.listeners[0]({ source: SOURCE, type, ...extra }, sender, resolve), true);
  });
  await send("getState"); // Wait for initialization/recovery before assertions.
  return {
    calls, events, values, behavior, send, timers,
    advance(milliseconds) { now += milliseconds; },
    releaseStorage() {
      assert.equal(typeof behavior.heldStorage, "function");
      const callback = behavior.heldStorage;
      behavior.heldStorage = null;
      callback();
    },
    releaseCleanup(failed = false) {
      assert.equal(typeof behavior.heldCleanup, "function");
      const callback = behavior.heldCleanup;
      behavior.heldCleanup = null;
      behavior.holdCleanup = false;
      if (failed) chrome.runtime.lastError = { message: "SYNTHETIC_PRIVATE_CLEANUP_ERROR" };
      callback({});
      chrome.runtime.lastError = null;
    },
    releaseAbort(failed = false) {
      assert.equal(typeof behavior.heldAbort, "function");
      const callback = behavior.heldAbort;
      behavior.heldAbort = null;
      behavior.holdAbort = false;
      if (failed) chrome.runtime.lastError = { message: "SYNTHETIC_PRIVATE_ABORT_ERROR" };
      callback({});
      chrome.runtime.lastError = null;
    },
    audit: () => values[STORAGE_KEY]?.audits?.[String(TAB_ID)],
    async arm({ authorize = true, replay = true } = {}) {
      const result = await send("armExtended");
      assert.equal(result.ok, true);
      if (authorize) {
        assert.equal((await send("confirmArmed", { generationId: result.generationId })).ok, true);
      }
      if (replay) {
        assert.equal((await send("markReplayStarting", { generationId: result.generationId })).ok, true);
      }
      return result;
    },
    async fireTimer(milliseconds) {
      await waitFor(() => [...timers.values()].some((timer) => timer.milliseconds === milliseconds), `timer ${milliseconds}`);
      const [id, timer] = [...timers].find(([, timer]) => timer.milliseconds === milliseconds);
      timers.delete(id);
      now = Math.max(now, timer.deadlineAt);
      timer.callback();
      await nextTurn();
    },
    async finished() {
      await waitFor(() => calls.notifications.some(({ message }) => ["failed", "sent", "warning"].includes(message.phase)), "final notification");
      return send("getState");
    },
    pause(requestId = "synthetic-request") {
      events.debuggerEvent.emit({ tabId: TAB_ID }, "Fetch.requestPaused", {
        requestId, resourceType: "Fetch",
        request: {
          url: "https://chatgpt.com/backend-api/f/conversation", method: "POST",
          headers: { "content-type": "application/json", "x-conduit-token": "PRIVATE_HEADER_VALUE" },
          postData: JSON.stringify({
            model: "gpt-6-pro", thinking_effort: "standard", client_prepare_state: "ready",
            messages: [{ id: "synthetic-user-id", author: { role: "user" }, content: "PRIVATE_MESSAGE_BODY" }]
          })
        }
      });
    }
  };
}

function assertDiagnostic(diagnostic, expected) {
  assert.ok(diagnostic && typeof diagnostic === "object", "diagnostic must be available");
  assert.deepEqual(Object.keys(diagnostic).sort(), DIAGNOSTIC_KEYS);
  assert.ok(Number.isFinite(diagnostic.observedAt) && diagnostic.observedAt > 0);
  assert.ok(diagnostic.phase === null || PHASES.has(diagnostic.phase));
  assert.equal(typeof diagnostic.replayAuthorized, "boolean");
  assert.equal(typeof diagnostic.uiReplayStarted, "boolean");
  assert.equal(typeof diagnostic.requestContinued, "boolean");
  assert.ok(Number.isInteger(diagnostic.pausedRequestCount) && diagnostic.pausedRequestCount >= 0);
  assert.ok(diagnostic.abortSucceeded === null || typeof diagnostic.abortSucceeded === "boolean");
  assert.ok([null, "target_closed", "canceled_by_user"].includes(diagnostic.detachReason));
  for (const [key, value] of Object.entries(expected)) assert.equal(diagnostic[key], value, key);
}

function assertNoPrivateData(fixture, state) {
  const exposed = JSON.stringify({ writes: fixture.calls.writes, notifications: fixture.calls.notifications, state });
  assert.doesNotMatch(exposed, /PRIVATE_MESSAGE_BODY|PRIVATE_HEADER_VALUE|SYNTHETIC_PRIVATE_/);
}

function assertUncertain(fixture, state, cause, messagePattern, expected = {}) {
  assert.equal(fixture.audit().status, "uncertain");
  assert.equal(fixture.audit().error, "outcome_uncertain");
  assert.equal(state.phase, "failed");
  assert.equal(state.label, "Extended outcome uncertain");
  assert.equal(state.activeOperation, false);
  assert.match(state.message, messagePattern);
  assert.doesNotMatch(state.message, /Chrome detached or lost one-shot state|normal UI action had begun/);
  assert.match(state.message, /cannot confirm.*Extended|Extended.*cannot.*confirm|could not confirm.*Extended|Extended.*could not.*verif/i);
  assert.match(state.message, /check.*conversation.*before.*(?:retry|again)/i);
  assertDiagnostic(state.diagnostic, { cause, ...expected });
  assert.deepEqual(state.diagnostic, fixture.audit().diagnostic);
  assertNoPrivateData(fixture, state);
}

test("an attach failure stays safely blocked and retains a redacted attach cause", async (t) => {
  const fixture = await createFixture(t, { attachError: true });
  const started = Date.now();
  assert.equal((await fixture.send("armExtended")).code, "attach_failed");
  const state = await fixture.send("getState");
  assert.equal(fixture.audit().status, "failed");
  assert.equal(fixture.audit().error, "attach_failed");
  assert.equal(state.label, "Extended blocked");
  assertDiagnostic(state.diagnostic, { cause: "attach_failed", replayAuthorized: false, uiReplayStarted: false, requestContinued: false });
  assert.ok(state.diagnostic.observedAt >= started && state.diagnostic.observedAt <= Date.now());
  assertNoPrivateData(fixture, state);
});

test("detach before authorization remains blocked and keeps Chrome's bounded reason", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm({ authorize: false, replay: false });
  fixture.events.detach.emit({ tabId: TAB_ID }, "canceled_by_user");
  const state = await fixture.finished();
  assert.equal(fixture.audit().status, "failed");
  assert.equal(fixture.audit().error, "debugger_detached");
  assert.equal(state.label, "Extended blocked");
  assertDiagnostic(state.diagnostic, { cause: "debugger_detached", detachReason: "canceled_by_user", replayAuthorized: false, uiReplayStarted: false });
});

for (const replay of [false, true]) {
  test(`detach after authorization with replayStarted=${replay} stays uncertain`, async (t) => {
    const fixture = await createFixture(t);
    await fixture.arm({ replay });
    fixture.events.detach.emit({ tabId: TAB_ID }, "target_closed");
    const state = await fixture.finished();
    assertUncertain(fixture, state, "debugger_detached", /detach|debugger|connection/i, {
      phase: "armed", detachReason: "target_closed", replayAuthorized: true,
      uiReplayStarted: replay, requestContinued: false, pausedRequestCount: 0
    });
    assert.equal(fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest").length, 0);
  });
}

test("a late replay acknowledgement receives the full capture window and sends once", async (t) => {
  const fixture = await createFixture(t);
  const arm = await fixture.arm({ authorize: false, replay: false });
  const oldWatchdog = [...fixture.timers.values()].find(timer => timer.milliseconds === 10_000);
  assert.ok(oldWatchdog, "the unreplayed arm must have a bounded watchdog");
  fixture.advance(9_000);
  assert.equal((await fixture.send("confirmArmed", { generationId: arm.generationId })).ok, true);
  const replay = await fixture.send("markReplayStarting", { generationId: arm.generationId });
  assert.equal(replay.ok, true);
  const expectedDeadline = Date.now() + 60_000;

  fixture.advance(2_000);
  // A canceled timer can already be queued on the event loop. Calling it here
  // must not retire the now-replayed generation or consume its capture budget.
  oldWatchdog.callback();
  await nextTurn();
  assert.equal((await fixture.send("getState")).activeOperation, true);
  assert.equal(replay.replayDeadlineAt, expectedDeadline);
  assert.ok([...fixture.timers.values()].some(timer => timer.deadlineAt === replay.replayDeadlineAt));
  assert.equal(fixture.calls.detach.length, 0);
  fixture.pause("request-after-original-ten-seconds");
  await fixture.fireTimer(75);
  const state = await fixture.finished();
  assert.equal(state.phase, "sent");
  assert.equal(fixture.audit().status, "sent");
  const sends = fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].parameters.requestId, "request-after-original-ten-seconds");
});

for (const messageType of ["confirmArmed", "markReplayStarting"]) {
  for (const fireWatchdog of [false, true]) {
    test(`${messageType} rejects a persisted acknowledgement after arm expiry with timer fired=${fireWatchdog}`, async (t) => {
      const fixture = await createFixture(t);
      const arm = await fixture.arm({ authorize: messageType === "markReplayStarting", replay: false });
      fixture.behavior.holdNextStorage = true;
      const pending = fixture.send(messageType, { generationId: arm.generationId });
      await waitFor(() => fixture.behavior.heldStorage !== null, "held authorization storage acknowledgement");
      if (fireWatchdog) await fixture.fireTimer(10_000);
      else fixture.advance(10_001); // A delayed timer cannot grant expired replay.
      fixture.releaseStorage();
      const reply = await pending;
      // Quiesce the old buggy implementation too so red test results report
      // the stale acknowledgement, without unrelated teardown rejections.
      if (!fireWatchdog && reply.ok) await fixture.fireTimer(10_000);
      const state = await fixture.finished();
      assert.equal(reply.ok, false, "retired or expired authorization must never reach the native Send action");
      assert.equal(state.activeOperation, false);
      assert.equal(state.diagnostic.cause, "arm_timeout");
      assert.equal(fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest").length, 0);
      assertNoPrivateData(fixture, state);
    });
  }
}

for (const loss of ["navigation", "debugger_detached"]) {
  test(`markReplayStarting rejects an acknowledgement retired by ${loss}`, async (t) => {
    const fixture = await createFixture(t);
    const arm = await fixture.arm({ replay: false });
    fixture.behavior.holdNextStorage = true;
    const pending = fixture.send("markReplayStarting", { generationId: arm.generationId });
    await waitFor(() => fixture.behavior.heldStorage !== null, "held replay storage acknowledgement");
    if (loss === "navigation") {
      fixture.events.committed.emit({ tabId: TAB_ID, frameId: 0, documentId: "replacement-document", url: TAB_URL });
    } else {
      fixture.events.detach.emit({ tabId: TAB_ID }, "target_closed");
    }
    await nextTurn();
    fixture.releaseStorage();
    const reply = await pending;
    const state = await fixture.finished();
    assert.equal(reply.ok, false);
    assert.equal(state.activeOperation, false);
    assert.equal(state.diagnostic.cause, loss);
    assert.equal(fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest").length, 0);
  });
}

test("repeated replay markers cannot extend the capture deadline", async (t) => {
  const fixture = await createFixture(t);
  const arm = await fixture.arm({ replay: false });
  const replay = await fixture.send("markReplayStarting", { generationId: arm.generationId });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayDeadlineAt, Date.now() + 60_000);
  fixture.advance(5_000);
  assert.equal((await fixture.send("markReplayStarting", { generationId: arm.generationId })).ok, false);
  assert.equal([...fixture.timers.values()].find(timer => timer.milliseconds === 60_000)?.deadlineAt, replay.replayDeadlineAt);
  await fixture.fireTimer(60_000);
  const state = await fixture.finished();
  assertUncertain(fixture, state, "timeout", /qualifying.*request|deadline|expired/i);
  assert.equal(fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest").length, 0);
});

test("a request arriving after the capture deadline is aborted before a delayed timer fires", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  fixture.advance(60_001);
  fixture.pause("request-after-capture-expiry");
  await nextTurn();
  if ([...fixture.timers.values()].some(timer => timer.milliseconds === 75)) {
    // The prior implementation accepted this late candidate. Let that path
    // finish so the assertion exposes its continuation after expiry directly.
    await fixture.fireTimer(75);
  }
  const state = await fixture.finished();
  assert.equal(state.activeOperation, false);
  assert.equal(fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest").length, 0);
  assert.equal(state.diagnostic.cause, "timeout");
  assert.equal(fixture.calls.commands.filter(({ method, parameters }) =>
    method === "Fetch.failRequest" && parameters.requestId === "request-after-capture-expiry").length, 1);
});

test("a native request delayed beyond ten seconds is captured exactly once", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  fixture.advance(20_000);
  fixture.pause("delayed-native-request");
  await fixture.fireTimer(75);
  const state = await fixture.finished();
  assert.equal(state.phase, "sent");
  const continuations = fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest");
  assert.equal(continuations.length, 1);
  assert.equal(continuations[0].parameters.requestId, "delayed-native-request");
  const body = JSON.parse(Buffer.from(continuations[0].parameters.postData, "base64").toString("utf8"));
  assert.equal(body.model, "gpt-6-pro");
  assert.equal(body.thinking_effort, "extended");
});

test("stale capture callbacks cannot cancel an accepted candidate or replace its successful audit", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  const capture = [...fixture.timers.values()].find(timer => timer.milliseconds === 60_000);
  assert.ok(capture);
  fixture.pause("candidate-before-stale-callback");
  await nextTurn();
  capture.callback();
  await fixture.fireTimer(75);
  const state = await fixture.finished();
  assert.equal(state.phase, "sent");
  const audit = structuredClone(fixture.audit());
  const detachCount = fixture.calls.detach.length;
  capture.callback();
  await nextTurn();
  assert.deepEqual(fixture.audit(), audit);
  assert.equal(fixture.calls.detach.length, detachCount);
  assert.equal(fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest").length, 1);
});

test("capture timeout reports its deadline rather than asserting an external detach", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  const started = Date.now();
  await fixture.fireTimer(60_000);
  const state = await fixture.finished();
  assertUncertain(fixture, state, "timeout", /tim(?:e|ed).*out|deadline|qualifying.*request/i, {
    phase: "armed", detachReason: null, replayAuthorized: true, uiReplayStarted: true
  });
  assert.ok(state.diagnostic.observedAt >= started && state.diagnostic.observedAt <= Date.now());
  assert.doesNotMatch(state.message, /Chrome detached|worker.*(?:lost|restart)/i);
  assert.doesNotMatch(state.message, /10.second/i);
  assert.ok(fixture.calls.writes.some((write) => write[STORAGE_KEY].active[String(TAB_ID)]?.diagnostic?.cause === "timeout"), "persist cause in active recovery record before cleanup");
});

test("real navigation preserves a navigation cause without weakening uncertainty", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  fixture.events.committed.emit({ tabId: TAB_ID, frameId: 0, documentId: "replacement-document", url: TAB_URL });
  const state = await fixture.finished();
  assertUncertain(fixture, state, "navigation", /navigat|document|reload/i, {
    phase: "armed", detachReason: null, replayAuthorized: true, uiReplayStarted: true
  });
  assert.doesNotMatch(state.message, /Chrome detached|worker.*(?:lost|restart)/i);
});

function staleRecord(extra = {}) {
  return {
    tabId: TAB_ID, generationId: "recovered-operation", documentId: DOCUMENT_ID,
    phase: "armed", pagePath: new URL(TAB_URL).pathname, startedAt: 1,
    requestContinued: false, replayAuthorized: true, uiReplayStarted: true,
    pausedRequestIds: [], ...extra
  };
}

test("restart with an authorized arm records recovery now and remains uncertain", async (t) => {
  const started = Date.now();
  const fixture = await createFixture(t, { stored: { active: { [TAB_ID]: staleRecord() }, audits: {} } });
  const state = await fixture.send("getState");
  assertUncertain(fixture, state, "worker_state_lost", /worker|restart|recover|lost.*state/i, {
    phase: "armed", replayAuthorized: true, uiReplayStarted: true, requestContinued: false
  });
  assert.ok(state.diagnostic.observedAt >= started && state.diagnostic.observedAt <= Date.now());
  assert.doesNotMatch(state.message, /Chrome detached/i);
});

test("unknown detach reason is dropped instead of entering storage or public state", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  fixture.events.detach.emit({ tabId: TAB_ID }, "SYNTHETIC_PRIVATE_UNKNOWN_DETACH_REASON");
  const state = await fixture.finished();
  assertUncertain(fixture, state, "debugger_detached", /detach|debugger|connection/i, { detachReason: null });
});

test("restart retains a recorded timeout cause and time instead of fabricating worker loss", async (t) => {
  const diagnostic = {
    cause: "timeout", observedAt: 1_000, phase: "armed", replayAuthorized: true,
    uiReplayStarted: true, requestContinued: false, pausedRequestCount: 0,
    abortSucceeded: null, detachReason: null
  };
  const fixture = await createFixture(t, { stored: {
    active: { [TAB_ID]: staleRecord({ phase: "failed", diagnostic }) }, audits: {}
  } });
  const state = await fixture.send("getState");
  assertUncertain(fixture, state, "timeout", /tim(?:e|ed).*out|deadline|10.seconds|qualifying.*request/i);
  assert.equal(state.diagnostic.observedAt, 1_000);
  assert.equal(state.diagnostic.phase, "armed");
  assert.doesNotMatch(state.message, /worker.*(?:lost|restart)|Chrome detached/i);
});

test("legacy uncertain audit has neutral wording and no invented cause or timestamp", async (t) => {
  const fixture = await createFixture(t, { stored: {
    active: {}, audits: { [TAB_ID]: {
      generationId: "legacy-operation", status: "uncertain", error: "outcome_uncertain"
    } }
  } });
  const state = await fixture.send("getState");
  assert.equal(fixture.audit().status, "uncertain");
  assert.equal(state.label, "Extended outcome uncertain");
  assert.equal(state.diagnostic, null);
  assert.doesNotMatch(state.message, /Chrome detached|normal UI action had begun|timed out|tab navigated/i);
  assert.match(state.message, /cannot confirm.*Extended|Extended.*cannot.*confirm|could not confirm.*Extended|Extended.*could not.*verif/i);
});

test("persisted diagnostic drops extra properties and invalid bounded values", async (t) => {
  const fixture = await createFixture(t, { stored: {
    active: {}, audits: { [TAB_ID]: {
      generationId: "sanitization-operation", status: "uncertain", error: "outcome_uncertain",
      diagnostic: {
        cause: "timeout", observedAt: 1_000, phase: "PRIVATE_MESSAGE_BODY",
        replayAuthorized: true, uiReplayStarted: true, requestContinued: false,
        pausedRequestCount: -1, abortSucceeded: "PRIVATE_HEADER_VALUE",
        detachReason: "SYNTHETIC_PRIVATE_REASON", rawRequest: "PRIVATE_MESSAGE_BODY"
      }
    } }
  } });
  const state = await fixture.send("getState");
  if (state.diagnostic !== null) {
    assertDiagnostic(state.diagnostic, { cause: "timeout", observedAt: 1_000, detachReason: null, abortSucceeded: null });
  }
  assertNoPrivateData(fixture, state);
});

test("successful continuation remains sent and stores no request body or header values", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  fixture.pause();
  await fixture.fireTimer(75);
  const state = await fixture.finished();
  assert.equal(state.phase, "sent");
  assert.equal(state.label, "Sent as Extended");
  assert.equal(state.activeOperation, false);
  assert.equal(fixture.audit().status, "sent");
  assert.equal(fixture.audit().error, null);
  assert.equal(state.diagnostic ?? null, null);
  const continuations = fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest");
  assert.equal(continuations.length, 1);
  const continued = JSON.parse(Buffer.from(continuations[0].parameters.postData, "base64").toString("utf8"));
  assert.equal(continued.thinking_effort, "extended");
  assert.equal(continued.model, "gpt-6-pro");
  assertNoPrivateData(fixture, state);
});

test("failed duplicate abort remains uncertain after successful cleanup of the known first send", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  fixture.behavior.holdCleanup = true;
  fixture.pause("first-request");
  await fixture.fireTimer(75);
  await waitFor(() => fixture.behavior.heldCleanup !== null, "first send awaiting cleanup");
  fixture.behavior.failCommand = (method) => method === "Fetch.failRequest";
  fixture.pause("duplicate-request");
  await waitFor(() => fixture.audit()?.status === "uncertain", "duplicate outcome uncertainty");
  const diagnosticBeforeCleanup = structuredClone(fixture.audit().diagnostic);
  fixture.behavior.holdCleanup = false;
  fixture.behavior.heldCleanup({});
  const state = await fixture.finished();
  assertUncertain(fixture, state, "duplicate_qualifying_request", /duplicate|additional|more than one/i, {
    requestContinued: true, abortSucceeded: false
  });
  assert.deepEqual(state.diagnostic, diagnosticBeforeCleanup, "successful cleanup must not replace the cause or timestamp");
  assert.equal(fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest").length, 1);
});

test("restart from a snapshot captured during timeout cleanup retains its actual cause", async (t) => {
  let snapshot;
  let capturedDiagnostic;
  await t.test("capture the real worker's durable state while cleanup is pending", async (t) => {
    const fixture = await createFixture(t);
    await fixture.arm();
    fixture.behavior.holdCleanup = true;
    await fixture.fireTimer(60_000);
    await waitFor(() => fixture.behavior.heldCleanup !== null, "timeout cleanup acknowledgement");
    snapshot = structuredClone(fixture.values[STORAGE_KEY]);
    capturedDiagnostic = snapshot.active[String(TAB_ID)].diagnostic;
    assertDiagnostic(capturedDiagnostic, { cause: "timeout", phase: "armed", requestContinued: false });
    // Quiesce this mock instance; the next subtest starts only from the captured
    // snapshot, which predates this acknowledgement and all later writes.
    fixture.behavior.holdCleanup = false;
    fixture.behavior.heldCleanup({});
    await fixture.finished();
  });
  await t.test("recovery does not replace the durable timeout with worker loss", async (t) => {
    const fixture = await createFixture(t, { stored: snapshot });
    const state = await fixture.send("getState");
    assertUncertain(fixture, state, "timeout", /qualifying.*request|expired|deadline|timed out/i);
    assert.equal(state.diagnostic.observedAt, capturedDiagnostic.observedAt);
    assert.equal(state.diagnostic.phase, capturedDiagnostic.phase);
  });
});

test("restart during a pending duplicate abort preserves cause and the additional request uncertainty", async (t) => {
  let snapshot;
  let capturedDiagnostic;
  await t.test("persist the duplicate observation before awaiting its abort", async (t) => {
    const fixture = await createFixture(t);
    await fixture.arm();
    fixture.behavior.holdCleanup = true;
    fixture.pause("first-before-restart");
    await fixture.fireTimer(75);
    await waitFor(() => fixture.behavior.heldCleanup !== null, "continued first request");
    fixture.behavior.holdAbort = true;
    fixture.pause("duplicate-before-restart");
    await waitFor(() => fixture.behavior.heldAbort !== null, "unacknowledged duplicate abort");
    snapshot = structuredClone(fixture.values[STORAGE_KEY]);
    capturedDiagnostic = snapshot.active[String(TAB_ID)].diagnostic;
    // Settle the original instance even if the snapshot assertion fails.
    fixture.releaseAbort(true);
    await waitFor(() => fixture.audit()?.status === "uncertain", "original duplicate uncertainty");
    fixture.behavior.holdCleanup = false;
    fixture.behavior.heldCleanup({});
    await fixture.finished();
    assertDiagnostic(capturedDiagnostic, {
      cause: "duplicate_qualifying_request", requestContinued: true,
      pausedRequestCount: 2, abortSucceeded: null
    });
  });
  await t.test("unconfirmed recovered duplicate does not downgrade to a send warning", async (t) => {
    const fixture = await createFixture(t, {
      stored: snapshot, failCommand: (method) => method === "Fetch.failRequest"
    });
    const state = await fixture.send("getState");
    assertUncertain(fixture, state, "duplicate_qualifying_request", /duplicate|additional/i, { requestContinued: true });
    assert.equal(state.diagnostic.observedAt, capturedDiagnostic.observedAt);
  });
});

test("a later successfully aborted duplicate cannot erase earlier duplicate uncertainty", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  fixture.behavior.holdCleanup = true;
  fixture.pause("original-before-two-duplicates");
  await fixture.fireTimer(75);
  await waitFor(() => fixture.behavior.heldCleanup !== null, "held first cleanup");
  fixture.behavior.failCommand = (method) => method === "Fetch.failRequest";
  fixture.pause("unconfirmed-duplicate");
  await waitFor(() => fixture.audit()?.status === "uncertain", "first duplicate uncertainty");
  const firstDiagnostic = structuredClone(fixture.audit().diagnostic);
  fixture.behavior.failCommand = () => false;
  fixture.pause("successfully-blocked-later-duplicate");
  await waitFor(() => fixture.calls.commands.some(({ method, parameters }) => method === "Fetch.failRequest" && parameters.requestId === "successfully-blocked-later-duplicate"), "second duplicate abort");
  await nextTurn();
  fixture.behavior.holdCleanup = false;
  fixture.behavior.heldCleanup({});
  const state = await fixture.finished();
  assertUncertain(fixture, state, "duplicate_qualifying_request", /duplicate|additional/i, { abortSucceeded: false });
  assert.deepEqual(state.diagnostic, firstDiagnostic);
});

test("unexpected detach during cleanup retry cannot downgrade a previous uncertain duplicate", async (t) => {
  const fixture = await createFixture(t);
  await fixture.arm();
  fixture.behavior.holdCleanup = true;
  fixture.pause("first-before-failed-cleanup");
  await fixture.fireTimer(75);
  await waitFor(() => fixture.behavior.heldCleanup !== null, "held cleanup before duplicate");
  fixture.behavior.failCommand = (method) => method === "Fetch.failRequest";
  fixture.pause("unconfirmed-before-detach");
  await waitFor(() => fixture.audit()?.status === "uncertain", "duplicate uncertainty before cleanup failure");
  const originalDiagnostic = structuredClone(fixture.audit().diagnostic);
  fixture.behavior.failDetach = true;
  fixture.releaseCleanup(true);
  await waitFor(() => [...fixture.timers.values()].some(({ milliseconds }) => milliseconds === 750), "scheduled cleanup retry");
  assert.equal((await fixture.send("getState")).activeOperation, true);
  fixture.events.detach.emit({ tabId: TAB_ID }, "target_closed");
  await waitFor(() => !fixture.values[STORAGE_KEY].active[String(TAB_ID)], "retired operation after external detach");
  const state = await fixture.send("getState");
  assertUncertain(fixture, state, "duplicate_qualifying_request", /duplicate|additional/i, { requestContinued: true, abortSucceeded: false });
  assert.deepEqual(state.diagnostic, originalDiagnostic, "cleanup detach must not replace the first unresolved failure");
});

test("restart after a confirmed duplicate abort preserves the confirmed abort result", async (t) => {
  let snapshot;
  let capturedDiagnostic;
  await t.test("update the active recovery record after the duplicate abort succeeds", async (t) => {
    const fixture = await createFixture(t);
    await fixture.arm();
    fixture.behavior.holdCleanup = true;
    fixture.pause("first-already-continued");
    await fixture.fireTimer(75);
    await waitFor(() => fixture.behavior.heldCleanup !== null, "first continued request awaiting cleanup");
    fixture.pause("duplicate-already-aborted");
    await waitFor(() => fixture.audit()?.status === "sent_warning", "confirmed duplicate abort");
    snapshot = structuredClone(fixture.values[STORAGE_KEY]);
    capturedDiagnostic = structuredClone(fixture.audit().diagnostic);
    fixture.releaseCleanup();
    await fixture.finished();
    assertDiagnostic(capturedDiagnostic, {
      cause: "duplicate_qualifying_request", requestContinued: true, abortSucceeded: true
    });
    assert.deepEqual(snapshot.active[String(TAB_ID)].diagnostic, capturedDiagnostic, "active and audit recovery records must agree after confirmed abort");
  });
  await t.test("failure to re-abort an already continued request does not invent duplicate uncertainty", async (t) => {
    const fixture = await createFixture(t, {
      stored: snapshot,
      failCommand: (method, parameters) => method === "Fetch.failRequest" && parameters.requestId === "first-already-continued"
    });
    const state = await fixture.send("getState");
    assert.equal(fixture.audit().status, "sent_warning");
    assert.equal(state.phase, "warning");
    assertDiagnostic(state.diagnostic, {
      cause: "duplicate_qualifying_request", requestContinued: true, abortSucceeded: true
    });
    assert.deepEqual(state.diagnostic, capturedDiagnostic);
    assert.equal(fixture.calls.commands.filter(({ method }) => method === "Fetch.continueRequest").length, 0);
  });
});
