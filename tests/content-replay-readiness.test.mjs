import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/content-replay-fixture.mjs";

test("a Send node replaced while arming is resolved freshly and clicked once", async () => {
  const f = fixture();
  const intent = f.descriptor();
  const replacement = f.makeButton();
  f.state.hooks.set("armExtended", () => {
    f.button.isConnected = false;
    f.state.buttons = [replacement];
  });
  await f.sandbox.gateAndReplay(intent);
  assert.deepEqual(f.calls.clicks, [replacement]);
});

for (const transient of ["disabled", "aria-disabled", "hidden", "unknown model", "missing composer"]) {
  test(`a transient ${transient} render settles before replay is acknowledged`, async () => {
    const f = fixture();
    const intent = f.descriptor();
    const originalEditable = f.state.editable;
    f.state.hooks.set("confirmArmed", () => {
      if (transient === "disabled") f.button.disabled = true;
      if (transient === "aria-disabled") f.button.setAttribute("aria-disabled", "true");
      if (transient === "hidden") f.button.visible = false;
      if (transient === "unknown model") f.state.model = "unknown";
      if (transient === "missing composer") f.state.editable = null;
    });
    f.after(100, () => {
      f.button.disabled = false;
      f.button.setAttribute("aria-disabled", "false");
      f.button.visible = true;
      f.state.model = "pro";
      f.state.editable = originalEditable;
    });
    f.state.hooks.set("markReplayStarting", () => {
      assert.ok(f.state.now >= 1_100, "do not start capture while the UI is still unready");
    });
    await f.sandbox.gateAndReplay(intent);
    assert.equal(f.calls.clicks.length, 1);
    assert.deepEqual(f.calls.messages, ["armExtended", "confirmArmed", "markReplayStarting"]);
  });
}

test("a composer rerender preserving its native identity and draft sends once", async () => {
  const f = fixture();
  const intent = f.descriptor();
  const original = f.state.editable;
  f.state.hooks.set("armExtended", () => {
    original.isConnected = false;
    f.state.editable = f.makeEditable(original.textContent);
  });
  await f.sandbox.gateAndReplay(intent);
  assert.equal(f.calls.clicks.length, 1);
});

test("a connected Send node reused as Stop is never clicked or submitted", async () => {
  const f = fixture();
  const intent = f.descriptor();
  f.state.hooks.set("armExtended", () => {
    f.button.type = "submit";
    f.button.setAttribute("aria-label", "Stop streaming");
  });
  await f.sandbox.gateAndReplay(intent);
  assert.equal(f.calls.clicks.length, 0);
  assert.equal(f.calls.submits, 0);
  assert.deepEqual(f.calls.messages, ["armExtended", "confirmArmed", "cancelArm"]);
  assert.equal(f.state.now, 2_500, "the UI readiness wait is bounded");
  assert.match(f.calls.errors.at(-1).message, /Send button did not become ready/);
});

test("a form without an enabled Send does not count as native replay", async () => {
  const f = fixture();
  const intent = f.descriptor();
  f.state.hooks.set("armExtended", () => { f.state.buttons = []; });
  await f.sandbox.gateAndReplay(intent);
  assert.equal(f.calls.clicks.length, 0);
  assert.equal(f.calls.submits, 0);
  assert.ok(!f.calls.messages.includes("markReplayStarting"));
  assert.match(f.calls.errors.at(-1).message, /action was not replayed/i);
});

for (const boundary of ["armExtended", "markReplayStarting"]) {
  for (const change of ["draft", "mode", "model", "route", "composer"]) {
    test(`${change} changing during ${boundary} cancels without a native action`, async () => {
      const f = fixture();
      const intent = f.descriptor();
      f.state.hooks.set(boundary, () => {
        if (change === "draft") f.state.editable.textContent = "a later edited draft";
        if (change === "mode") f.sandbox.preference = "standard";
        if (change === "model") f.state.model = "other";
        if (change === "route") f.setRoute("/c/different");
        if (change === "composer") f.state.editable = f.makeEditable();
      });
      await f.sandbox.gateAndReplay(intent);
      assert.equal(f.calls.clicks.length, 0);
      assert.equal(f.calls.submits, 0);
      assert.ok(f.calls.messages.includes("cancelArm"));
      if (boundary === "armExtended") assert.ok(!f.calls.messages.includes("markReplayStarting"));
      if (change === "draft") {
        assert.equal(f.state.editable.textContent, "a later edited draft");
        assert.match(f.calls.errors.at(-1).message, /draft changed/i);
      }
    });
  }
}

test("a UI readiness wait cannot replay a retired worker operation", async () => {
  const f = fixture();
  const intent = f.descriptor();
  f.state.hooks.set("confirmArmed", () => { f.state.model = "unknown"; });
  f.after(50, () => { f.sandbox.submissionBusy = false; });
  await f.sandbox.gateAndReplay(intent);
  assert.equal(f.calls.clicks.length, 0);
  assert.ok(!f.calls.messages.includes("markReplayStarting"));
  assert.match(f.calls.errors.at(-1).message, /operation ended/);
});

test("the immutable captured draft is not replaced by a later edit", () => {
  const f = fixture();
  const intent = f.descriptor();
  assert.ok(Object.isFrozen(intent) && Object.isFrozen(intent.intent));
  f.state.editable.textContent = "changed draft";
  assert.equal(intent.intent.draft, "captured prompt");
  assert.equal(f.sandbox.replayNormalUiAction(intent, false), false);
  assert.equal(f.calls.clicks.length, 0);
});

test("a button remaining disabled after replay acknowledgement cancels within the shared readiness budget", async () => {
  const f = fixture();
  f.state.hooks.set("markReplayStarting", () => { f.button.setAttribute("aria-disabled", "true"); });
  await f.sandbox.gateAndReplay(f.descriptor());
  assert.equal(f.calls.clicks.length, 0);
  assert.equal(f.state.now, 2_500);
  assert.match(f.calls.errors.at(-1).message, /Send button did not become ready/);
});

test("text-only Stop and an unlabelled submit control cannot qualify as a replay Send", async () => {
  for (const label of ["Stop generating", "Cancel", ""]) {
    const f = fixture();
    const intent = f.descriptor();
    f.state.hooks.set("armExtended", () => {
      f.button.type = "submit";
      f.button.attributes.clear();
      f.button.textContent = label;
    });
    await f.sandbox.gateAndReplay(intent);
    assert.equal(f.calls.clicks.length, 0, label);
    assert.equal(f.calls.submits, 0, label);
  }
});

test("switching to a different supported Pro label cancels the captured model intent", async () => {
  const f = fixture();
  const intent = f.descriptor();
  f.state.hooks.set("armExtended", () => { f.state.modelLabel = "GPT-5.6 Pro"; });
  await f.sandbox.gateAndReplay(intent);
  assert.equal(f.calls.clicks.length, 0);
  assert.match(f.calls.errors.at(-1).message, /model changed/);
});

test("a transient Pro render during replay acknowledgment uses the remaining shared readiness budget", async () => {
  const f = fixture();
  f.state.hooks.set("confirmArmed", () => { f.button.disabled = true; });
  f.after(100, () => { f.button.disabled = false; });
  f.state.hooks.set("markReplayStarting", () => {
    f.state.model = "unknown";
    f.after(100, () => { f.state.model = "pro"; });
  });
  await f.sandbox.gateAndReplay(f.descriptor());
  assert.equal(f.calls.clicks.length, 1);
  assert.equal(f.state.now, 1_200);
  assert.deepEqual(f.calls.messages, ["armExtended", "confirmArmed", "markReplayStarting"]);
});

test("a late cancel acknowledgment does not clear or overwrite a newer operation", async () => {
  const f = fixture();
  f.state.hooks.set("armExtended", () => { f.state.editable.textContent = "changed draft"; });
  f.state.hooks.set("cancelArm", () => {
    f.sandbox.submissionSerial += 1;
    f.sandbox.currentGenerationId = "new-generation";
    f.sandbox.submissionBusy = true;
  });
  await f.sandbox.gateAndReplay(f.descriptor());
  assert.equal(f.calls.clicks.length, 0);
  assert.equal(f.sandbox.submissionBusy, true);
  assert.equal(f.sandbox.currentGenerationId, "new-generation");
  assert.equal(f.calls.errors.length, 0);
});

for (const boundary of ["armExtended", "confirmArmed", "markReplayStarting"]) {
  test(`a stale ${boundary} acknowledgment cannot authorize or cancel a newer generation`, async () => {
    const f = fixture();
    f.state.hooks.set(boundary, () => {
      f.sandbox.submissionSerial += 1;
      f.sandbox.currentGenerationId = "new-generation";
      f.sandbox.submissionBusy = true;
    });
    await f.sandbox.gateAndReplay(f.descriptor());
    assert.equal(f.calls.clicks.length, 0);
    assert.ok(!f.calls.messages.includes("cancelArm"));
    if (boundary !== "markReplayStarting") assert.ok(!f.calls.messages.includes("markReplayStarting"));
    assert.equal(f.sandbox.currentGenerationId, "new-generation");
    assert.equal(f.sandbox.submissionBusy, true);
  });
}

test("paragraph line breaks changing without textContent changing still cancel the captured draft", async () => {
  const f = fixture();
  f.state.editable.textContent = "ab";
  f.state.editable.renderedText = "a\nb";
  const intent = f.descriptor();
  f.state.hooks.set("armExtended", () => { f.state.editable.renderedText = "ab"; });
  await f.sandbox.gateAndReplay(intent);
  assert.equal(f.calls.clicks.length, 0);
  assert.match(f.calls.errors.at(-1).message, /draft changed/);
});

test("a throttled readiness timer cannot send when its UI recovery arrives after the budget", async () => {
  const f = fixture();
  f.state.hooks.set("confirmArmed", () => { f.state.model = "unknown"; });
  f.state.timerStep = 2_000;
  f.after(100, () => { f.state.model = "pro"; });
  await f.sandbox.gateAndReplay(f.descriptor());
  assert.equal(f.calls.clicks.length, 0);
  assert.ok(!f.calls.messages.includes("markReplayStarting"));
});

test("worker acknowledgment latency does not consume the shared UI readiness budget", async () => {
  const f = fixture();
  f.state.hooks.set("markReplayStarting", () => { f.state.now += 5_000; });
  await f.sandbox.gateAndReplay(f.descriptor());
  assert.equal(f.calls.clicks.length, 1);
  assert.equal(f.state.waits, 0);
});

test("missing deadline acknowledges incompatible monitor state rather than a false expired clock", async () => {
  const f = fixture();
  f.state.deadline = undefined;
  await f.sandbox.gateAndReplay(f.descriptor());
  assert.equal(f.calls.clicks.length, 0);
  assert.match(f.calls.errors.at(-1).message, /did not return a valid send deadline/);
  assert.doesNotMatch(f.calls.errors.at(-1).message, /expired/);
});

for (const boundary of ["loadRouteMode", "cancelArm"]) {
  test(`production route invalidation does not clear a new generation during ${boundary}`, async () => {
    const f = fixture();
    f.sandbox.submissionSerial = 1;
    f.sandbox.submissionBusy = true;
    f.sandbox.currentGenerationId = "old-generation";
    const operation = { serial: 1, generationId: "old-generation" };
    f.state.route = { kind: "conversation", pathname: "/c/next" };
    f.sandbox.window.location.href = "https://chatgpt.com/c/next";
    f.state.hooks.set(boundary, () => {
      f.sandbox.submissionSerial = 2;
      f.sandbox.currentGenerationId = "new-generation";
      f.sandbox.submissionBusy = true;
    });
    await f.sandbox.invalidateArmedOperation(operation);
    assert.equal(f.sandbox.currentGenerationId, "new-generation");
    assert.equal(f.sandbox.submissionBusy, true);
    assert.ok(!f.calls.routeLoads.some(load => load.force));
    if (boundary === "loadRouteMode") {
      assert.equal(f.calls.clearedAdoptions.length, 0);
      assert.ok(!f.calls.messages.includes("cancelArm"));
    }
  });
}

test("production route invalidation retires only its own generation before restoring route mode", async () => {
  const f = fixture();
  f.sandbox.submissionSerial = 1;
  f.sandbox.submissionBusy = true;
  f.sandbox.currentGenerationId = "old-generation";
  f.state.route = { kind: "conversation", pathname: "/c/next" };
  f.sandbox.window.location.href = "https://chatgpt.com/c/next";
  await f.sandbox.invalidateArmedOperation({ serial: 1, generationId: "old-generation" });
  assert.deepEqual(f.calls.invalidations, ["old-generation"]);
  assert.deepEqual(f.calls.clearedAdoptions, ["old-generation"]);
  assert.deepEqual(f.calls.messages, ["cancelArm"]);
  assert.deepEqual(f.calls.routeLoads, [{ force: false }, { force: true }]);
});
