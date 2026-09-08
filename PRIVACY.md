# Privacy Policy

Effective date: August 9, 2026

ChatGPT Pro Effort Selector is an unofficial, locally running Chrome extension. It is not affiliated with, endorsed by, or published by OpenAI. The extension requires the user to have their own ChatGPT Pro access; it does not provide a subscription or bypass access controls.

## Summary

The extension runs only on `https://chatgpt.com/*`. It has no developer-operated server, analytics, advertising, telemetry, or remote code. Data handled by the extension stays in the browser except for the ChatGPT request that the user already chose to send to ChatGPT.

The developer does not receive, sell, rent, license, share, or use user data for advertising, credit decisions, or any purpose unrelated to the extension's single purpose.

## Single purpose

The extension lets ChatGPT Pro users choose a per-chat Standard or Extended thinking effort for normal composer submissions on `chatgpt.com`.

## Data handled locally

The content script reads the current ChatGPT URL, visible model controls, composer state, and the user's Standard or Extended selection so it can show the selector and apply the correct behavior.

In Standard mode, ChatGPT requests are left unchanged and the extension does not attach Chrome's debugger or inspect request bodies or headers.

When the user selects Extended and submits through ChatGPT's normal composer, the extension briefly uses Chrome's powerful `debugger` permission for that tab. It waits for one eligible ChatGPT conversation request, then locally and transiently:

- parses the outgoing JSON request body, which includes the user's prompt and may include other conversation data;
- handles the request headers supplied by Chrome, which may include authentication-related values;
- verifies that the request is a fresh GPT-5.6 Pro (`gpt-5-6-pro`) or GPT-6 Pro (`gpt-6-pro`) conversation request;
- preserves the selected `model`, sets the top-level `thinking_effort` to `extended` and `client_prepare_state` to `none`; and
- omits the `x-conduit-token` and `content-length` transport headers while preserving the other fresh headers, then continues that request to its original ChatGPT destination, clears interception, and detaches the debugger.

The full request body and header values exist only in memory during that operation. They are not logged, written to extension storage, sent to the developer, or sent to a new destination. The extension does not intercept ChatGPT response bodies.

## Data retained in the browser

The extension retains only the following operational data:

- **Persistent extension storage:** for each canonical saved conversation, the ChatGPT conversation UUID is used in a storage key whose value is `standard` or `extended`. This remains until it is changed, the extension's data is cleared, or the extension is removed.
- **Tab page-session storage:** an unsaved draft's selected mode and bounded temporary-to-canonical conversation bindings. To distinguish a newly created chat from an existing one, the content script reads conversation links already present in ChatGPT's page and transiently extracts only canonical conversation UUID storage keys. A reload-recovery record is created only when there are no more than 512 such keys; it may contain those keys, a generated operation ID, selected mode, ChatGPT route identifiers, and a timestamp. This record is stored in `chatgpt.com`'s page `sessionStorage`, is never conversation content, and is never accepted after two minutes. It is cleared when correlation finishes or fails, on an expired read, by a scheduled expiry callback when the page is running, or when the tab's page session ends.
- **Browser-session extension storage:** redacted one-shot state such as tab and document identifiers, a generated operation ID, lifecycle phase, ChatGPT pathname, timestamp, whether the request was continued, whether normal-UI replay was authorized and started, paused-request identifiers needed for safe recovery, HTTP method and resource type, the original and forced values of the three fields listed above, removed header names but never their values, the submitted user-message identifier, and status or error codes. This storage is browser-session-only.

The extension does not retain prompt text, full request bodies, ChatGPT response text, cookies, authorization values, or any other header values. The in-memory paused request object and the prepared continuation are released as soon as they have been processed, before debugger-cleanup retries.

## Chrome permissions

| Permission | Use |
| --- | --- |
| `https://chatgpt.com/*` | Shows the selector and observes only the ChatGPT page state needed for its single purpose. Content-script and host access are limited to this exact origin. |
| `debugger` | Briefly intercepts one eligible outgoing ChatGPT request after an explicit Extended composer submission. It is not attached in Standard mode. |
| `storage` | Stores per-conversation mode choices and browser-session-only redacted recovery and audit state. |
| `webNavigation` | Keeps an active one-shot operation bound to the correct ChatGPT tab, document, and conversation during navigation. |

## Security and data transfers

All executable extension code is included in the installed package. The extension does not download or execute remote code and does not use `eval` or `new Function`.

The extension makes no request to a developer-operated service. Its Extended operation continues the user's request to ChatGPT, the same service and destination selected by the user. OpenAI's handling of that request is governed by OpenAI's own terms and privacy policy, not this policy.

## User control and deletion

Selecting Standard prevents debugger attachment and request inspection. Per-chat selections can be changed at any time. Removing the extension or clearing its extension data deletes its persistent Chrome extension storage. Tab-session and browser-session operational state expire with their respective browser sessions.

After an Extended request is continued, the normal path immediately clears interception and detaches. If Chrome repeatedly rejects detachment, the extension keeps that tab blocked from another one-shot operation and reports a cleanup warning. Full request bodies and header values have already been released; closing the tab, reloading the extension, or ending the browser session releases the remaining debugger session.

## Changes

Material changes to this policy will be published in this repository with an updated effective date. Extension updates remain subject to Chrome Web Store review.

## Contact

For privacy questions or deletion help, open an issue in the [project's public issue tracker](https://github.com/ahmedelami/chatgpt-pro-effort-selector/issues).
