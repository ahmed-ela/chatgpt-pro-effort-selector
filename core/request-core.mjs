export const CONVERSATION_PATH = "/backend-api/f/conversation";
export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const EXTENDED_EFFORT = "extended";
export const FORCED_CLIENT_PREPARE_STATE = "none";

const SUPPORTED_PRO_MODEL_SLUGS = new Set([
  "gpt-5-6-pro",
  "gpt-6-pro"
]);
const ALLOWED_RESOURCE_TYPES = new Set(["XHR", "Fetch"]);
const REMOVED_HEADER_NAMES = new Set([
  "x-conduit-token",
  "content-length"
]);

const hasOwn = (value, propertyName) =>
  Object.prototype.hasOwnProperty.call(value, propertyName);

export class RequestValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RequestValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RequestValidationError(code, message);
}

function requireRecord(value, code, message) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(code, message);
  }
}

function parseRequestUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    fail(
      "missing_request_url",
      "The paused request did not contain a URL."
    );
  }

  try {
    return new URL(rawUrl);
  } catch {
    fail(
      "invalid_request_url",
      "The paused request URL could not be parsed."
    );
  }
}

export function inspectPausedRequest(pausedEvent) {
  requireRecord(
    pausedEvent,
    "invalid_paused_event",
    "The CDP paused-request event was invalid."
  );

  requireRecord(
    pausedEvent.request,
    "missing_request",
    "The CDP event did not contain a request."
  );

  const parsedUrl = parseRequestUrl(pausedEvent.request.url);
  const method =
    typeof pausedEvent.request.method === "string"
      ? pausedEvent.request.method.toUpperCase()
      : "";
  const resourceType =
    typeof pausedEvent.resourceType === "string"
      ? pausedEvent.resourceType
      : "";

  return {
    method,
    origin: parsedUrl.origin,
    path: parsedUrl.pathname,
    resourceType,
    requestId:
      typeof pausedEvent.requestId === "string"
        ? pausedEvent.requestId
        : ""
  };
}

export function isQualifyingConversationPause(pausedEvent) {
  try {
    const identity = inspectPausedRequest(pausedEvent);

    return (
      identity.method === "POST" &&
      identity.origin === CHATGPT_ORIGIN &&
      identity.path === CONVERSATION_PATH &&
      ALLOWED_RESOURCE_TYPES.has(identity.resourceType)
    );
  } catch {
    return false;
  }
}

function getMessageRole(message) {
  if (
    message?.author &&
    typeof message.author === "object" &&
    typeof message.author.role === "string"
  ) {
    return message.author.role;
  }

  if (typeof message?.role === "string") {
    return message.role;
  }

  return "";
}

export function findNewestUserMessageId(body) {
  if (!Array.isArray(body?.messages)) {
    fail(
      "missing_messages",
      "The request body did not contain a messages array."
    );
  }

  for (
    let index = body.messages.length - 1;
    index >= 0;
    index -= 1
  ) {
    const message = body.messages[index];

    if (getMessageRole(message) !== "user") {
      continue;
    }

    if (
      typeof message?.id !== "string" ||
      message.id.trim().length === 0
    ) {
      fail(
        "missing_user_message_id",
        "The newest user message did not contain a nonempty id."
      );
    }

    return message.id;
  }

  fail(
    "missing_user_message",
    "The request body did not contain a user message."
  );
}

function requireOwnString(body, propertyName) {
  if (!hasOwn(body, propertyName)) {
    fail(
      `missing_${propertyName}`,
      `The request body did not own ${propertyName}.`
    );
  }

  if (typeof body[propertyName] !== "string") {
    fail(
      `invalid_${propertyName}`,
      `${propertyName} was not a string.`
    );
  }
}

export function filterFreshRequestHeaders(headers) {
  requireRecord(
    headers,
    "invalid_headers",
    "The paused request did not contain a valid header map."
  );

  const filteredHeaders = [];
  const removedHeaderNames = [];

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      fail(
        "invalid_header_value",
        "A paused request header did not contain a string value."
      );
    }

    if (REMOVED_HEADER_NAMES.has(name.toLowerCase())) {
      removedHeaderNames.push(name);
      continue;
    }

    filteredHeaders.push({
      name,
      value
    });
  }

  return {
    headers: filteredHeaders,
    removedHeaderNames
  };
}

export function utf8ToBase64(value) {
  if (typeof value !== "string") {
    fail(
      "invalid_encoding_input",
      "Only strings can be UTF-8/base64 encoded."
    );
  }

  const bytes = new TextEncoder().encode(value);
  const chunkSize = 0x8000;
  let binary = "";

  for (
    let offset = 0;
    offset < bytes.length;
    offset += chunkSize
  ) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function prepareExtendedContinuation(pausedEvent) {
  const identity = inspectPausedRequest(pausedEvent);

  if (
    identity.method !== "POST" ||
    identity.path !== CONVERSATION_PATH ||
    !ALLOWED_RESOURCE_TYPES.has(identity.resourceType)
  ) {
    fail(
      "unrelated_request",
      "The paused request was not the exact conversation POST."
    );
  }

  if (identity.requestId.length === 0) {
    fail(
      "missing_request_id",
      "The qualifying CDP event did not contain a request id."
    );
  }

  const request = pausedEvent.request;

  if (typeof request.postData !== "string") {
    fail(
      "missing_post_data",
      "The qualifying request did not contain postData."
    );
  }

  let parsedBody;

  try {
    parsedBody = JSON.parse(request.postData);
  } catch {
    fail(
      "malformed_json",
      "The qualifying request body was not valid JSON."
    );
  }

  requireRecord(
    parsedBody,
    "invalid_request_body",
    "The qualifying request body was not an object."
  );

  requireOwnString(parsedBody, "model");
  if (hasOwn(parsedBody, "thinking_effort")) {
    requireOwnString(parsedBody, "thinking_effort");
  }
  requireOwnString(parsedBody, "client_prepare_state");

  if (!SUPPORTED_PRO_MODEL_SLUGS.has(parsedBody.model)) {
    fail(
      "model_mismatch",
      "The fresh request was not a supported Pro model."
    );
  }

  const submittedUserMessageId =
    findNewestUserMessageId(parsedBody);

  const originalValues = {
    model: parsedBody.model,
    // A missing effort is distinct from an explicit Standard request.
    thinking_effort: hasOwn(parsedBody, "thinking_effort")
      ? parsedBody.thinking_effort
      : null,
    client_prepare_state: parsedBody.client_prepare_state
  };

  /*
   * parsedBody came from fresh JSON. This JSON round trip creates a fresh
   * semantic clone before the only two authorized top-level assignments.
   */
  const mutatedBody = JSON.parse(JSON.stringify(parsedBody));

  mutatedBody.thinking_effort = EXTENDED_EFFORT;
  mutatedBody.client_prepare_state =
    FORCED_CLIENT_PREPARE_STATE;

  const {
    headers,
    removedHeaderNames
  } = filterFreshRequestHeaders(request.headers);

  const serializedBody = JSON.stringify(mutatedBody);

  return {
    requestId: identity.requestId,
    postDataBase64: utf8ToBase64(serializedBody),
    headers,
    audit: {
      method: identity.method,
      path: identity.path,
      resourceType: identity.resourceType,
      original: originalValues,
      forced: {
        model: parsedBody.model,
        thinking_effort: EXTENDED_EFFORT,
        client_prepare_state: FORCED_CLIENT_PREPARE_STATE
      },
      removedHeaderNames,
      submittedUserMessageId,
      status: "prepared",
      error: null
    }
  };
}
