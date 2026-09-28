import test from "node:test";
import assert from "node:assert/strict";

import {
  CHATGPT_ORIGIN,
  CONVERSATION_PATH,
  RequestValidationError,
  filterFreshRequestHeaders,
  findNewestUserMessageId,
  isQualifyingConversationPause,
  prepareExtendedContinuation
} from "../core/request-core.mjs";

function makeBody(overrides = {}) {
  return {
    model: "gpt-5-6-pro",
    thinking_effort: "standard",
    client_prepare_state: "ready",
    conversation_id: "conversation-id",
    messages: [
      {
        id: "older-user",
        author: {
          role: "user"
        },
        content: {
          content_type: "text",
          parts: ["older prompt"]
        }
      },
      {
        id: "assistant-context",
        author: {
          role: "assistant"
        }
      },
      {
        id: "fresh-user-id",
        author: {
          role: "user"
        },
        content: {
          content_type: "text",
          parts: ["sensitive prompt value"]
        }
      }
    ],
    nested: {
      preserved: true,
      values: [1, 2, 3]
    },
    ...overrides
  };
}

function makePause({
  url = `${CHATGPT_ORIGIN}${CONVERSATION_PATH}`,
  method = "POST",
  resourceType = "Fetch",
  body = makeBody(),
  headers = {
    "content-type": "application/json",
    "X-Conduit-Token": "secret-token",
    "Content-Length": "1234",
    "x-other-header": "preserve-me"
  }
} = {}) {
  return {
    requestId: "cdp-request-id",
    resourceType,
    request: {
      url,
      method,
      headers,
      postData: JSON.stringify(body)
    }
  };
}

test("qualifies only the exact POST pathname and allowed resource type", () => {
  assert.equal(
    isQualifyingConversationPause(makePause()),
    true
  );

  assert.equal(
    isQualifyingConversationPause(
      makePause({
        url:
          "https://chatgpt.com/backend-api/f/conversation?source=test"
      })
    ),
    true
  );

  assert.equal(
    isQualifyingConversationPause(
      makePause({
        url:
          "https://chatgpt.com/backend-api/f/conversation/prepare"
      })
    ),
    false
  );

  assert.equal(
    isQualifyingConversationPause(
      makePause({
        url:
          "https://chatgpt.com/backend-api/f/conversation/"
      })
    ),
    false
  );

  assert.equal(
    isQualifyingConversationPause(
      makePause({
        method: "GET"
      })
    ),
    false
  );

  assert.equal(
    isQualifyingConversationPause(
      makePause({
        resourceType: "Document"
      })
    ),
    false
  );

  assert.equal(
    isQualifyingConversationPause(
      makePause({
        url:
          "https://example.invalid/backend-api/f/conversation",
        resourceType: "XHR"
      })
    ),
    false
  );

  assert.equal(
    isQualifyingConversationPause(
      makePause({
        url:
          "http://chatgpt.com/backend-api/f/conversation"
      })
    ),
    false
  );

  assert.equal(
    isQualifyingConversationPause(
      makePause({
        url:
          "https://subdomain.chatgpt.com/backend-api/f/conversation"
      })
    ),
    false
  );
});

test("finds the newest user message id without reading message content", () => {
  assert.equal(
    findNewestUserMessageId(makeBody()),
    "fresh-user-id"
  );
});

test("fails when the newest user message has no nonempty id", () => {
  const missing = makeBody();
  delete missing.messages.at(-1).id;

  assert.throws(
    () => findNewestUserMessageId(missing),
    (error) =>
      error instanceof RequestValidationError &&
      error.code ===
        "missing_user_message_id"
  );

  const empty = makeBody();
  empty.messages.at(-1).id = "   ";

  assert.throws(
    () => findNewestUserMessageId(empty),
    (error) =>
      error instanceof RequestValidationError &&
      error.code ===
        "missing_user_message_id"
  );
});

test("filters only x-conduit-token and content-length case-insensitively", () => {
  const result = filterFreshRequestHeaders({
    "Content-Type": "application/json",
    "X-Conduit-Token": "do-not-retain",
    "content-LENGTH": "900",
    Accept: "application/json"
  });

  assert.deepEqual(result.headers, [
    {
      name: "Content-Type",
      value: "application/json"
    },
    {
      name: "Accept",
      value: "application/json"
    }
  ]);

  assert.deepEqual(
    result.removedHeaderNames,
    [
      "X-Conduit-Token",
      "content-LENGTH"
    ]
  );
});

test("rejects non-string fresh header values instead of fabricating them", () => {
  assert.throws(
    () =>
      filterFreshRequestHeaders({
        Accept: 123
      }),
    (error) =>
      error instanceof RequestValidationError &&
      error.code ===
        "invalid_header_value"
  );
});

test("preserves GPT-5.6 Pro and changes only the two effort fields", () => {
  const originalBody = makeBody();
  const originalClone =
    JSON.parse(JSON.stringify(originalBody));

  const result =
    prepareExtendedContinuation(
      makePause({
        body: originalBody
      })
    );

  const mutatedBody = JSON.parse(
    Buffer.from(
      result.postDataBase64,
      "base64"
    ).toString("utf8")
  );

  assert.equal(
    mutatedBody.model,
    "gpt-5-6-pro"
  );
  assert.equal(
    mutatedBody.thinking_effort,
    "extended"
  );
  assert.equal(
    mutatedBody.client_prepare_state,
    "none"
  );

  const restored = JSON.parse(
    JSON.stringify(mutatedBody)
  );

  restored.thinking_effort =
    originalClone.thinking_effort;
  restored.client_prepare_state =
    originalClone.client_prepare_state;

  assert.deepEqual(restored, originalClone);

  assert.equal(
    result.requestId,
    "cdp-request-id"
  );
  assert.equal(
    result.audit.submittedUserMessageId,
    "fresh-user-id"
  );
  assert.deepEqual(
    result.audit.original,
    {
      model: "gpt-5-6-pro",
      thinking_effort: "standard",
      client_prepare_state: "ready"
    }
  );
  assert.deepEqual(
    result.audit.forced,
    {
      model: "gpt-5-6-pro",
      thinking_effort: "extended",
      client_prepare_state: "none"
    }
  );
  assert.deepEqual(
    result.audit.removedHeaderNames,
    [
      "X-Conduit-Token",
      "Content-Length"
    ]
  );

  assert.deepEqual(result.headers, [
    {
      name: "content-type",
      value: "application/json"
    },
    {
      name: "x-other-header",
      value: "preserve-me"
    }
  ]);
});

test("preserves GPT-6 Pro and rewrites its observed Standard request shape", () => {
  const originalBody = makeBody({
    model: "gpt-6-pro",
    client_prepare_state: "success"
  });
  const result = prepareExtendedContinuation(
    makePause({ body: originalBody })
  );
  const mutatedBody = JSON.parse(
    Buffer.from(result.postDataBase64, "base64").toString("utf8")
  );

  assert.deepEqual(mutatedBody, {
    ...originalBody,
    thinking_effort: "extended",
    client_prepare_state: "none"
  });
  assert.deepEqual(result.audit.original, {
    model: "gpt-6-pro",
    thinking_effort: "standard",
    client_prepare_state: "success"
  });
  assert.deepEqual(result.audit.forced, {
    model: "gpt-6-pro",
    thinking_effort: "extended",
    client_prepare_state: "none"
  });
});

test("adds Extended when an allowlisted Pro request omits thinking_effort", () => {
  for (const model of ["gpt-5-6-pro", "gpt-6-pro"]) {
    const originalBody = makeBody({ model, client_prepare_state: "success" });
    delete originalBody.thinking_effort;
    const result = prepareExtendedContinuation(makePause({ body: originalBody }));
    const mutatedBody = JSON.parse(
      Buffer.from(result.postDataBase64, "base64").toString("utf8")
    );

    assert.equal(Object.hasOwn(originalBody, "thinking_effort"), false);
    assert.deepEqual(mutatedBody, {
      ...originalBody,
      thinking_effort: "extended",
      client_prepare_state: "none"
    });
    assert.deepEqual(result.audit.original, {
      model,
      thinking_effort: null,
      client_prepare_state: "success"
    });
    assert.equal(result.audit.forced.thinking_effort, "extended");
    assert.equal(result.audit.submittedUserMessageId, "fresh-user-id");
  }

  for (const model of ["gpt-5-6-sol", "gpt-6-astra", "gpt-7-pro"]) {
    const body = makeBody({ model });
    delete body.thinking_effort;
    assert.throws(
      () => prepareExtendedContinuation(makePause({ body })),
      (error) => error instanceof RequestValidationError && error.code === "model_mismatch"
    );
  }
});

test("rejects an explicitly non-string thinking_effort on supported Pro models", () => {
  for (const model of ["gpt-5-6-pro", "gpt-6-pro"]) {
    for (const thinking_effort of [null, false, 0, [], {}]) {
      assert.throws(
        () => prepareExtendedContinuation(makePause({
          body: makeBody({ model, thinking_effort })
        })),
        (error) => error instanceof RequestValidationError && error.code === "invalid_thinking_effort"
      );
    }
  }
});

test("rejects non-Pro and unknown model slugs", () => {
  for (const model of [
    "gpt-5-6-sol",
    "gpt-6",
    "gpt-6-astra",
    "gpt-7-pro",
    "gpt-6-pro-preview",
    "GPT-6-Pro",
    ""
  ]) {
    assert.throws(
      () =>
        prepareExtendedContinuation(
          makePause({ body: makeBody({ model }) })
        ),
      (error) =>
        error instanceof RequestValidationError &&
        error.code === "model_mismatch",
      `unsupported model ${JSON.stringify(model)} must remain blocked`
    );
  }
});

test("requires model and client_prepare_state as own strings", () => {
  const inherited = Object.create({
    thinking_effort: "standard",
    client_prepare_state: "ready"
  });

  Object.assign(inherited, {
    model: "gpt-5-6-pro",
    messages: [
      {
        id: "fresh-id",
        author: {
          role: "user"
        }
      }
    ]
  });

  assert.throws(
    () =>
      prepareExtendedContinuation(
        makePause({
          body: inherited
        })
      ),
    (error) =>
      error instanceof RequestValidationError &&
      error.code ===
        "missing_client_prepare_state"
  );

  const invalidType = makeBody({
    client_prepare_state: null
  });

  assert.throws(
    () =>
      prepareExtendedContinuation(
        makePause({
          body: invalidType
        })
      ),
    (error) =>
      error instanceof RequestValidationError &&
      error.code ===
        "invalid_client_prepare_state"
  );
});

test("rejects malformed JSON, missing postData, and missing request id", () => {
  const malformed = makePause();
  malformed.request.postData = "{invalid";

  assert.throws(
    () =>
      prepareExtendedContinuation(
        malformed
      ),
    (error) =>
      error instanceof RequestValidationError &&
      error.code === "malformed_json"
  );

  const missingPostData = makePause();
  delete missingPostData.request.postData;

  assert.throws(
    () =>
      prepareExtendedContinuation(
        missingPostData
      ),
    (error) =>
      error instanceof RequestValidationError &&
      error.code ===
        "missing_post_data"
  );

  const missingRequestId = makePause();
  missingRequestId.requestId = "";

  assert.throws(
    () =>
      prepareExtendedContinuation(
        missingRequestId
      ),
    (error) =>
      error instanceof RequestValidationError &&
      error.code ===
        "missing_request_id"
  );
});
