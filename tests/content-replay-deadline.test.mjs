import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/content-replay-fixture.mjs";

test("a delayed replay authorization cannot click Send after its absolute deadline", async () => {
  const { sandbox, calls, descriptor } = fixture({ now: 62_000, deadline: 61_000 });
  await sandbox.gateAndReplay(descriptor());
  assert.equal(calls.clicks.length, 0);
  assert.ok(calls.messages.includes("cancelArm"));
  assert.ok(calls.errors.length > 0);
});

test("a legacy or malformed replay acknowledgement cannot authorize an unbounded click", async () => {
  for (const deadline of [undefined, null, NaN, Infinity, "61000"]) {
    const { sandbox, state, calls, descriptor } = fixture();
    state.deadline = deadline;
    await sandbox.gateAndReplay(descriptor());
    assert.equal(calls.clicks.length, 0, String(deadline));
  }
});

test("a current replay acknowledgement performs exactly one native action", async () => {
  const { sandbox, calls, descriptor } = fixture();
  await sandbox.gateAndReplay(descriptor());
  assert.equal(calls.clicks.length, 1);
  assert.deepEqual(calls.messages, ["armExtended", "confirmArmed", "markReplayStarting"]);
});

test("the final native replay boundary rejects expiry without affecting Standard replay", () => {
  const { sandbox, calls, descriptor } = fixture({ now: 61_000 });
  assert.equal(sandbox.replayNormalUiAction(descriptor(), true, 61_000), false);
  assert.equal(calls.clicks.length, 0);
  assert.equal(sandbox.replayNormalUiAction(descriptor(), false), true);
  assert.equal(calls.clicks.length, 1);
});
