# Technical Reference

[Back to the main README](../README.md)

This document contains the complete technical behavior, lifecycle, safety, permissions, privacy, and compatibility reference for ChatGPT Pro Effort Selector.

## Project structure

The unpacked-extension directory is the cloned repository root:

```text
chatgpt-pro-effort-selector/
```

The complete layout is:

```text
chatgpt-pro-effort-selector/
├── LICENSE
├── PRIVACY.md
├── manifest.json
├── package.json
├── README.md
├── background/
│   └── service-worker.mjs
├── content/
│   ├── content-script.js
│   ├── shadow-ui.js
│   └── styles.css
├── core/
│   ├── mode-core.js
│   ├── request-core.mjs
│   └── state-core.mjs
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
├── docs/
│   ├── images/
│   │   ├── pro-effort-selector.png
│   │   └── standard-to-extended-thinking-effort.png
│   ├── manual-qa.md
│   ├── store-listing.md
│   └── technical-reference.md
├── scripts/
│   └── package-store.mjs
├── store/
│   └── assets/
│       ├── icon-source.svg
│       ├── small-promo-source.svg
│       ├── small-promo-440x280.png
│       └── screenshot-selector-640x400.png
└── tests/
    ├── mode-core.test.mjs
    ├── package-store.test.mjs
    ├── request-core.test.mjs
    ├── state-core.test.mjs
    ├── store-readiness.test.mjs
    ├── ui-core.test.mjs
    └── ui-shadow-contract.test.mjs
```

No build step, package installation, remote code, or third-party runtime dependency is used.

## UI integration

The selector mounts beside the model-control branch in the nearest horizontal composer-control layout rather than inserting inside the model control's internal vertical wrapper. Its popover is a viewport-aware, compact native-style picker containing only two rows: **Standard** and **Extended**.

## Standard mode

Standard is the default mode for every canonical saved conversation whose stored mode is missing, deleted, malformed, or otherwise unexpected.

In Standard mode:

- ChatGPT requests are untouched.
- No request body or header is inspected.
- `chrome.debugger` is not attached.
- Chrome's debugger infobar should not appear.
- Other ChatGPT models continue to work normally.

Each canonical saved conversation uses an independent `chrome.storage.local` key:

```text
proEffortMode.chat.<lowercase conversation UUID> = "standard" | "extended"
```

Chat A and Chat B therefore remain independent. Tabs showing the same canonical conversation synchronize mode changes through `chrome.storage.onChanged`, while storage changes for unrelated conversations are ignored.

### Legacy migration

Earlier versions used one global local-storage key:

```text
effortPreference
```

That legacy key is retired on startup and is never consulted as a fallback. In particular, an old global Extended value is not copied into every conversation. Existing conversations without a valid per-chat key safely default to Standard until explicitly changed.

### Blank new-chat draft

A blank new chat has no canonical conversation UUID, so its mode is kept in that tab's `sessionStorage` until the draft becomes a saved conversation:

- it defaults to Standard
- selecting either option survives reloads in the same tab
- selecting Extended applies to its first captured normal Pro composer submission
- ChatGPT's provisional `/c/WEB:<lowercase UUID>` URL is treated as the same new-chat lifecycle, so it does not cancel the first Extended send or become a persistent storage identity
- once that send is known to have succeeded and exactly one newly active canonical `/c/<lowercase UUID>` conversation appears, the selected mode is written to that conversation's independent key
- while ChatGPT still displays the provisional `WEB:` URL, a bounded tab-session path-to-conversation map points mode reads and changes at that canonical conversation; reloading or returning with Back therefore preserves the chat's current selection
- while first-send correlation is still finishing, the content script extracts canonical conversation UUID keys from links already present in ChatGPT's page; a generation-scoped reload-recovery record is created only when there are no more than 512 keys, lives only in the page's `sessionStorage`, is never accepted after two minutes, is cleared on completion, failure, an expired read, a scheduled expiry callback, or page-session end, and may resume binding only when the background reports that exact generation as sent or warning with a submitted user-message id
- a pass-through Standard first send is tracked across the draft-to-saved route boundary, so selecting Extended before ChatGPT finishes assigning the new URL still binds Extended to the created conversation
- merely navigating from a blank draft to an existing saved conversation does not copy the draft mode
- a later blank new chat defaults to Standard
- a fresh tab has its own Standard draft default, and closing the original tab clears its unsent draft mode with the browser session

## Extended mode

Extended applies to a captured composer submission only when:

1. the current canonical conversation's stored mode, or the current tab-session blank-chat draft mode, is Extended; and
2. the extension can identify the exact visible composer model as `Pro` or `GPT-5.6 Pro`.

The selector is not shown for GPT-5.6 Sol, and a fresh Sol request is never rewritten to Pro.

For every captured normal send-button, Enter, or form submission while that chat remains Extended:

1. The content script captures and stops the original UI event before ChatGPT can process it.
2. The background service worker creates browser-session-only one-shot state.
3. Immediately before attaching, the service worker re-reads the tab URL, requires the exact `https://chatgpt.com` origin and unchanged pathname, then attaches `chrome.debugger` to that exact tab and waits for Chrome's acknowledgement.
4. It calls `Fetch.enable` with exactly two request-stage patterns:
   - `https://chatgpt.com/backend-api/f/conversation*`, resource type `XHR`
   - `https://chatgpt.com/backend-api/f/conversation*`, resource type `Fetch`
5. The content script performs a final current-tab, current-document, current-path, and current-generation arm check.
6. Before acknowledging that check, the service worker records browser-session-only replay authorization.
7. The content script marks that exact generation as starting its native UI replay, and the service worker persists the generation-scoped handshake.
8. Only then does the content script replay the normal ChatGPT UI action once.
9. Every unrelated paused request is continued immediately.
10. The only qualifying request is a fresh `POST` from the exact `https://chatgpt.com` origin whose parsed pathname is exactly:
   - `/backend-api/f/conversation`
11. `/backend-api/f/conversation/prepare`, a trailing-slash route, and all other routes are unrelated.
12. Exactly one qualifying pause must occur within 10 seconds.
13. The fresh body must:
    - be valid JSON
    - have `model === "gpt-5-6-pro"`
    - own string property `thinking_effort`
    - own string property `client_prepare_state`
    - contain a nonempty newest user message id
14. A fresh semantic JSON clone is created.
15. Only these top-level values are assigned:
    - `model = "gpt-5-6-pro"`
    - `thinking_effort = "extended"`
    - `client_prepare_state = "none"`
16. All other fresh body fields, including the fresh user message id, are preserved.
17. Fresh request headers are preserved except:
    - `x-conduit-token`
    - `content-length`
18. Header-name matching is case-insensitive.
19. Header values are never logged or persisted.
20. The same paused request is continued with the modified UTF-8 JSON encoded as base64 and the filtered fresh headers.
21. Immediately after Chrome acknowledges that continuation, the extension clears interception with:

```text
Fetch.enable({ patterns: [] })
```

22. The extension never calls `Fetch.disable`.
23. The extension then detaches the debugger.

That debugger/request operation is one-shot for one fresh composer submission. After it ends, the conversation's Extended mode remains selected. A later captured composer submission in the same chat creates a new generation and freshly repeats the arm, confirmation, replay, mutation, continuation, and cleanup lifecycle.

Changing the current conversation back to Standard is the normal way to end its Extended mode. Request success, warning, failure, timeout, cleanup state, or uncertainty does not reset or consume the saved mode.

A malformed request, missing field, missing user id, model mismatch, duplicate qualifying pause, timeout, navigation, tab closure, attach failure, CDP failure, or pre-send debugger detach does not intentionally fall back to Standard.

After replay authorization has been acknowledged, a detach, navigation,
timeout, service-worker restart, or missing qualifying pause cannot always be
proved to have blocked the page's request. Such a case is reported as
**Extended outcome uncertain**, never as definitely blocked or as a clean
Extended success.

## SPA navigation and route isolation

ChatGPT can replace conversation routes without reloading the document.

On SPA navigation, the content script:

- treats a change between canonical conversations, or between a saved conversation and a draft route, as a route transition
- clears the prior route's generation, submitted-message, status, and related operation UI before presenting the destination route
- loads the destination saved conversation's independent mode before a captured submission is allowed to replay
- blocks rather than replaying a captured submission if the destination mode cannot be loaded or the route changes again during that load
- preserves conservative fail-closed or outcome-uncertain handling when navigation interrupts an active one-shot operation
- permits only one replay-authorized, same-document blank-chat to exact `/c/WEB:<lowercase UUID>` transition during the active first-send lifecycle
- uses `webNavigation` document identity to distinguish that History API transition from a reload or full-document navigation even when Chrome splits URL and `loading` updates across separate events
- ignores a status-only `tabs.onUpdated` loading signal when Chrome still reports the active operation's unchanged ChatGPT pathname
- evaluates a top-frame `webNavigation.onCommitted` event with the armed operation's same `documentId` through the strict same-document route policy, because BFCache or prerender activation can recommit an existing document; a missing or different `documentId` remains a fail-closed replacement or reload
- permits one later `WEB:` to canonical promotion only after the same generation continued a request with a submitted user-message id and the content script correlated the exact canonical target to the unique newly active conversation
- keeps full-document loading, unrelated paths, an uncorrelated canonical target, and a second provisional or canonical transition fail-closed

When an allowed history transition is accepted, the background updates the active operation's recorded pathname before persisting it. `tabs.onUpdated` alone never authorizes the route change. The background state API otherwise restores only a currently active operation whose recorded pathname matches the requesting page. A completed or unrelated tab audit is not restored into the destination chat.

## Duplicate protection

The first qualifying request is held paused for a short 75 ms settling interval.

This gives another qualifying pause already in flight a chance to surface before the first request is continued. A duplicate observed before continuation causes the retained qualifying requests to be aborted where Chrome still permits it.

If a later duplicate arrives after the first request has already been continued as Extended, the later pause is aborted and a temporary warning toast appears rather than pretending the first send never occurred. If Chrome does not confirm that the duplicate was aborted, the state becomes **Extended outcome uncertain**.

## Chrome debugger warning

The `debugger` permission is required and is not optional for this design.

Chrome can:

- show a strong extension-installation warning
- show an infobar while the extension is attached
- report that the tab is being debugged

The extension minimizes attachment duration by attaching only immediately before an Extended submission and detaching after the one qualifying request.

## DevTools conflict

Opening DevTools for a tab while this extension is attached to that tab detaches the extension debugger.

The extension handles `chrome.debugger.onDetach` conservatively:

- before a qualifying request is continued, a temporary toast reports a blocker or an explicitly uncertain outcome
- after the request is known to have been continued as Extended, a temporary toast reports a send warning

An external debugger detach is not transactionally atomic with a page request. Chrome can detach after replay authorization but before the resulting network pause. In that interval the extension cannot prove that an untouched request did not escape, so it reports **Extended outcome uncertain**.

Do not open DevTools while the state is **Arming** or while Chrome's debugger indication remains visible.

## Service-worker restart handling

The extension mirrors only redacted audit fields and minimal operational one-shot identifiers into `chrome.storage.session`.

`chrome.storage.session` is memory-scoped to the browser session. It is not the persistent per-conversation `chrome.storage.local` mode store.

The operational state can include:

- tab id
- document id
- one-shot generation id
- lifecycle phase
- tab pathname
- whether the request was already continued
- whether normal-UI replay had been authorized
- whether normal-UI replay had started
- paused CDP request ids needed to abort after a service-worker restart

It never contains:

- prompt text
- response text
- request bodies
- cookies
- authorization values
- header values
- full headers

When a new service-worker instance finds a stale active record, it:

1. aborts any retained paused request ids where Chrome still allows it
2. clears Fetch patterns using `Fetch.enable({ patterns: [] })`
3. detaches its debugger target
4. marks the operation blocked, uncertain, or sent-with-warning according to the last safely recorded phase

A stale paused request that cannot be conclusively aborted is reported as **Extended outcome uncertain**, not as Standard or as a clean Extended success. A stale operation with no paused request is also uncertain when replay authorization had already been acknowledged.

If detachment succeeds but explicit pattern clearing is not acknowledged, the
active tab slot is retired with a warning because detachment releases interception. If detachment itself repeatedly fails, the active slot remains blocked rather than permitting a second debugger operation over an unresolved first operation.

The full in-memory paused request object is released immediately after validation, and the prepared continuation body and headers are released immediately after the request is continued or the operation fails. Cleanup retries therefore retain only the redacted audit and minimal identifiers listed above.

Reloading or updating the extension clears `chrome.storage.session`. Chrome normally detaches debugger sessions when the extension reloads. Any later orphan pause is handled conservatively if Chrome delivers it to the new worker.

## Redacted audit

The latest operation for each tab uses only this redacted audit shape:

- method
- exact pathname
- resource type
- original and forced `model`
- original and forced `thinking_effort`
- original and forced `client_prepare_state`
- names, not values, of removed headers
- submitted user message id
- generation id
- status
- error code

No request body, prompt, response, cookie, authorization value, or header value is retained.

No telemetry is sent.

No sensitive data is written to the console.

## Permissions

### `https://chatgpt.com/*`

Restricts content-script access to ChatGPT.

### `storage`

Used for:

- independent persistent Standard / Extended modes for canonical saved conversations in `chrome.storage.local`
- same-conversation tab synchronization through `chrome.storage.onChanged`
- deterministic retirement of the obsolete global `effortPreference` key
- ephemeral redacted one-shot state in `chrome.storage.session`

The unsaved blank-chat mode uses the page's same-origin `sessionStorage`, not the extension `storage` permission. It stores the scalar string `standard` or `extended`. After a provisional `WEB:` chat is correlated to exactly one saved conversation, it also keeps a bounded map of recent temporary paths to canonical conversation UUIDs so reloads and same-tab Back navigation keep using each saved chat's mode. During first-send correlation, a maximum-two-minute pending record contains only the generation id, selected mode, route identifiers, timestamp, and preexisting conversation keys; recovery still requires matching successful background state. It never stores prompt or response content.

### `debugger`

Required for CDP Fetch interception of the single fresh Extended request.

This is a powerful permission and causes a Chrome warning.

### `webNavigation`

Distinguishes an exact same-document ChatGPT History API route update or same-`documentId` activation from a top-frame reload or replacement while a one-shot Extended operation is active. It is scoped by the extension's `https://chatgpt.com/*` host permission.

No remote script is loaded.

## Privacy

The debugger permission is powerful. A conversation may remain persistently Extended, but the debugger is not persistently attached. The extension attaches only for one fresh captured composer submission at a time in the exact ChatGPT tab, then detaches as quickly as the one-shot lifecycle permits.

The request body must be parsed transiently to validate and clone the fresh request, but it is never logged, persisted, or included in audit state.

There is no telemetry, remote code, dynamic code evaluation, `eval`, or `new Function`.

## Known limitations

This extension depends on unsupported ChatGPT internals:

- composer DOM structure
- accessible model-control semantics
- exact visible Pro labels
- the `/backend-api/f/conversation` request
- request JSON fields
- request header behavior

ChatGPT can change any of these without notice.

The trigger and picker use separate open Shadow DOM roots with extension-owned styles, so ordinary ChatGPT CSS changes cannot restyle their internal buttons, chevron, rows, or hover surface. The light-DOM toast remains outside that isolation. Shadow DOM is not a security boundary and does not protect the surrounding composer layout, model-control discovery, or mount-point selection from future ChatGPT DOM changes.

The extension intentionally blocks Extended when required structure no longer matches. Updates to ChatGPT may require maintenance.
