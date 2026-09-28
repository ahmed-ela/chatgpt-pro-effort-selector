import test from "node:test";
import assert from "node:assert/strict";

import {
  PhaseTransitionError,
  classifyLostOperation,
  decideActiveSessionNavigation,
  isPreSendActivePhase,
  transitionPhase
} from "../core/state-core.mjs";

const TEMPORARY_URL =
  "https://chatgpt.com/c/WEB:11111111-1111-4111-8111-111111111111";

test("models the successful one-shot lifecycle", () => {
  let phase = "idle";

  phase = transitionPhase(phase, "begin");
  assert.equal(phase, "attaching");

  phase = transitionPhase(
    phase,
    "attached"
  );
  assert.equal(phase, "enabling");

  phase = transitionPhase(
    phase,
    "enabled"
  );
  assert.equal(phase, "armed");

  phase = transitionPhase(
    phase,
    "candidate"
  );
  assert.equal(phase, "settling");

  phase = transitionPhase(
    phase,
    "unique"
  );
  assert.equal(phase, "processing");

  phase = transitionPhase(
    phase,
    "continued"
  );
  assert.equal(phase, "sent");

  phase = transitionPhase(
    phase,
    "cleanup"
  );
  assert.equal(phase, "cleaning");

  phase = transitionPhase(
    phase,
    "cleaned"
  );
  assert.equal(phase, "complete");
});

test("allows all pre-send active phases to fail closed", () => {
  for (const phase of [
    "attaching",
    "enabling",
    "armed",
    "settling",
    "processing"
  ]) {
    assert.equal(
      transitionPhase(phase, "fail"),
      "failed"
    );
  }
});

test("rejects duplicate and backwards transitions", () => {
  assert.throws(
    () =>
      transitionPhase("armed", "enabled"),
    PhaseTransitionError
  );

  assert.throws(
    () =>
      transitionPhase(
        "processing",
        "candidate"
      ),
    PhaseTransitionError
  );

  assert.throws(
    () =>
      transitionPhase("complete", "cleanup"),
    PhaseTransitionError
  );

  assert.throws(
    () =>
      transitionPhase("failed", "begin"),
    PhaseTransitionError
  );
});

test("identifies only pre-send debugger-active phases", () => {
  for (const phase of [
    "attaching",
    "enabling",
    "armed",
    "settling",
    "processing"
  ]) {
    assert.equal(
      isPreSendActivePhase(phase),
      true
    );
  }

  for (const phase of [
    "idle",
    "sent",
    "cleaning",
    "sent_warning",
    "complete",
    "failed"
  ]) {
    assert.equal(
      isPreSendActivePhase(phase),
      false
    );
  }
});

test("allows one authorized same-document blank-to-WEB transition", () => {
  for (const currentPath of [
    "/",
    "/new"
  ]) {
    for (const phase of [
      "armed",
      "settling",
      "processing",
      "sent",
      "cleaning",
      "sent_warning"
    ]) {
      assert.deepEqual(
        decideActiveSessionNavigation({
          currentPath,
          nextUrl: TEMPORARY_URL,
          sameDocument: true,
          replayAuthorized: true,
          uiReplayStarted: true,
          provisionalTransitionUsed:
            false,
          phase
        }),
        {
          action: "advance",
          pagePath:
            "/c/WEB:11111111-1111-4111-8111-111111111111",
          transition: "provisional"
        }
      );

      assert.deepEqual(
        decideActiveSessionNavigation({
          currentPath,
          nextUrl: TEMPORARY_URL,
          status: "loading",
          replayAuthorized: true,
          uiReplayStarted: true,
          provisionalTransitionUsed:
            false,
          phase
        }),
        {
          action: "fail"
        }
      );
    }
  }

  assert.deepEqual(
    decideActiveSessionNavigation({
      currentPath:
        "/c/WEB:11111111-1111-4111-8111-111111111111",
      nextUrl: `${TEMPORARY_URL}?model=pro`,
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed: true,
      phase: "settling"
    }),
    {
      action: "keep",
      pagePath:
        "/c/WEB:11111111-1111-4111-8111-111111111111"
    }
  );
});

test("allows a continued WEB send to promote once to a canonical route", () => {
  for (const phase of [
    "sent",
    "cleaning",
    "sent_warning"
  ]) {
    assert.deepEqual(
      decideActiveSessionNavigation({
        currentPath:
          "/c/WEB:11111111-1111-4111-8111-111111111111",
        nextUrl:
          "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
        sameDocument: true,
        replayAuthorized: true,
        uiReplayStarted: true,
        provisionalTransitionUsed: true,
        canonicalTransitionUsed: false,
        canonicalTargetPath:
          "/c/22222222-2222-4222-8222-222222222222",
        requestContinued: true,
        hasSubmittedUserMessageId:
          true,
        phase
      }),
      {
        action: "advance",
        pagePath:
          "/c/22222222-2222-4222-8222-222222222222",
        transition: "canonical"
      }
    );
  }
});

test("allows local-chatgpt provisional routes and only their correlated promotion", () => {
  const canonicalPath = "/c/22222222-2222-4222-8222-222222222222";
  for (const separator of [":", "%3A", "%3a"]) {
    const temporaryPath = `/c/local-chatgpt${separator}11111111-1111-4111-8111-111111111111`;
    const provisional = {
      currentPath: "/",
      nextUrl: `https://chatgpt.com${temporaryPath}`,
      sameDocument: true,
      replayAuthorized: true,
      uiReplayStarted: true,
      phase: "armed"
    };
    assert.deepEqual(decideActiveSessionNavigation(provisional), {
      action: "advance",
      pagePath: temporaryPath,
      transition: "provisional"
    });
    for (const overrides of [
      { sameDocument: false },
      { replayAuthorized: false },
      { uiReplayStarted: false },
      { provisionalTransitionUsed: true },
      { nextUrl: `https://example.com${temporaryPath}` },
      { nextUrl: `https://chatgpt.com${temporaryPath}/` },
      { nextUrl: "https://chatgpt.com/c/local-chatgpt%3Abad" }
    ]) {
      assert.deepEqual(decideActiveSessionNavigation({ ...provisional, ...overrides }), {
        action: "fail"
      });
    }

    const promotion = {
      ...provisional,
      currentPath: temporaryPath,
      nextUrl: `https://chatgpt.com${canonicalPath}`,
      provisionalTransitionUsed: true,
      canonicalTargetPath: canonicalPath,
      requestContinued: true,
      hasSubmittedUserMessageId: true,
      phase: "cleaning"
    };
    assert.deepEqual(decideActiveSessionNavigation(promotion), {
      action: "advance",
      pagePath: canonicalPath,
      transition: "canonical"
    });
    for (const overrides of [
      { sameDocument: false },
      { canonicalTransitionUsed: true },
      { canonicalTargetPath: null },
      { requestContinued: false },
      { hasSubmittedUserMessageId: false }
    ]) {
      assert.deepEqual(decideActiveSessionNavigation({ ...promotion, ...overrides }), {
        action: "fail"
      });
    }
  }
});

test("keeps full loads and unrelated active-session navigation fail-closed", () => {
  const variants = [
    {
      currentPath: "/",
      nextUrl: TEMPORARY_URL,
      status: "loading",
      sameDocument: false,
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        false,
      phase: "armed"
    },
    {
      currentPath: "/",
      nextUrl: "https://chatgpt.com/",
      status: "loading",
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        false,
      phase: "armed"
    },
    {
      currentPath: "/",
      nextUrl: TEMPORARY_URL,
      replayAuthorized: false,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        false,
      phase: "armed"
    },
    {
      currentPath: "/",
      nextUrl: TEMPORARY_URL,
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        true,
      phase: "armed"
    },
    {
      currentPath: "/library",
      nextUrl: TEMPORARY_URL,
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        false,
      phase: "armed"
    },
    {
      currentPath: "/",
      nextUrl:
        "https://example.com/c/WEB:11111111-1111-4111-8111-111111111111",
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        false,
      phase: "armed"
    },
    {
      currentPath:
        "/c/11111111-1111-4111-8111-111111111111",
      nextUrl:
        "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        false,
      phase: "settling"
    },
    {
      currentPath: "/",
      nextUrl:
        "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        false,
      phase: "settling"
    },
    {
      currentPath:
        "/c/WEB:11111111-1111-4111-8111-111111111111",
      nextUrl:
        "https://chatgpt.com/c/WEB:22222222-2222-4222-8222-222222222222",
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed: true,
      phase: "settling"
    },
    {
      currentPath:
        "/c/WEB:11111111-1111-4111-8111-111111111111",
      nextUrl:
        "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed: true,
      canonicalTransitionUsed: false,
      requestContinued: false,
      hasSubmittedUserMessageId:
        true,
      phase: "processing"
    },
    {
      currentPath:
        "/c/WEB:11111111-1111-4111-8111-111111111111",
      nextUrl:
        "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
      sameDocument: true,
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        false,
      canonicalTransitionUsed: false,
      canonicalTargetPath:
        "/c/22222222-2222-4222-8222-222222222222",
      requestContinued: true,
      hasSubmittedUserMessageId:
        true,
      phase: "cleaning"
    },
    {
      currentPath:
        "/c/WEB:11111111-1111-4111-8111-111111111111",
      nextUrl:
        "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
      sameDocument: true,
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        true,
      canonicalTransitionUsed: false,
      canonicalTargetPath:
        "/c/33333333-3333-4333-8333-333333333333",
      requestContinued: true,
      hasSubmittedUserMessageId:
        true,
      phase: "cleaning"
    },
    {
      currentPath:
        "/c/WEB:11111111-1111-4111-8111-111111111111",
      nextUrl:
        "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed: true,
      canonicalTransitionUsed: true,
      requestContinued: true,
      hasSubmittedUserMessageId:
        true,
      phase: "cleaning"
    },
    {
      currentPath:
        "/c/WEB:11111111-1111-4111-8111-111111111111",
      nextUrl:
        "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed: true,
      canonicalTransitionUsed: false,
      requestContinued: true,
      hasSubmittedUserMessageId:
        false,
      phase: "cleaning"
    },
    {
      currentPath: "/",
      nextUrl: TEMPORARY_URL,
      replayAuthorized: true,
      uiReplayStarted: true,
      provisionalTransitionUsed:
        false,
      phase: "attaching"
    }
  ];

  variants.push({
    currentPath: "/",
    nextUrl: TEMPORARY_URL,
    replayAuthorized: true,
    uiReplayStarted: false,
    provisionalTransitionUsed: false,
    phase: "armed"
  });

  for (const variant of variants) {
    assert.deepEqual(
      decideActiveSessionNavigation(
        variant
      ),
      {
        action: "fail"
      }
    );
  }
});

test("classifies service-worker loss after a known continued request as sent warning", () => {
  assert.deepEqual(
    classifyLostOperation({
      requestContinued: true,
      pausedRequestCount: 0,
      abortSucceeded: false
    }),
    {
      status: "sent_warning",
      error: "worker_state_lost_after_send"
    }
  );
});

test("classifies state loss after replay authorization but before a pause as uncertain", () => {
  assert.deepEqual(
    classifyLostOperation({
      requestContinued: false,
      pausedRequestCount: 0,
      abortSucceeded: true,
      replayAuthorized: true
    }),
    {
      status: "uncertain",
      error: "outcome_uncertain"
    }
  );
});

test("an explicitly cancelled replay remains a definite failure", () => {
  assert.deepEqual(
    classifyLostOperation({
      requestContinued: false,
      pausedRequestCount: 0,
      abortSucceeded: true,
      replayAuthorized: true,
      replayCancelled: true
    }),
    {
      status: "failed",
      error: "worker_state_lost"
    }
  );
});

test("classifies an unabortable retained paused request as uncertain", () => {
  assert.deepEqual(
    classifyLostOperation({
      requestContinued: false,
      pausedRequestCount: 1,
      abortSucceeded: false
    }),
    {
      status: "uncertain",
      error: "outcome_uncertain"
    }
  );
});

test("classifies a pre-send stale arm with no escaped request as failed", () => {
  assert.deepEqual(
    classifyLostOperation({
      requestContinued: false,
      pausedRequestCount: 1,
      abortSucceeded: true
    }),
    {
      status: "failed",
      error: "worker_state_lost"
    }
  );

  assert.deepEqual(
    classifyLostOperation({
      requestContinued: false,
      pausedRequestCount: 0,
      abortSucceeded: true
    }),
    {
      status: "failed",
      error: "worker_state_lost"
    }
  );
});
