# Chrome Web Store Listing

This is the copy-and-paste source of truth for the Chrome Web Store listing and its private reviewer notes. Recheck it against the packaged release before every submission.

## Store listing

**Title**

ChatGPT Pro Effort Selector

**Short description**

Adds a per-chat Standard or Extended thinking-effort selector beside ChatGPT Pro.

**Single purpose**

Lets ChatGPT Pro users choose a per-chat Standard or Extended thinking effort for normal composer submissions on `chatgpt.com`.

**Detailed description**

ChatGPT Pro Effort Selector adds a compact Standard / Extended control beside ChatGPT's visible Pro model selector. Each saved conversation remembers its own selection.

Standard leaves ChatGPT requests unchanged and never attaches Chrome's debugger.

After you explicitly select Extended and send through ChatGPT's normal composer, the extension briefly uses Chrome's powerful `debugger` permission to handle one eligible ChatGPT Pro request locally. It validates the request, sets its thinking effort to Extended, continues it to ChatGPT, clears interception, and detaches. If the expected request lifecycle cannot be established safely, the extension blocks the operation or reports an uncertain outcome instead of claiming success.

The extension runs only on `chatgpt.com`. It contains no advertising, analytics, telemetry, remote code, or developer-operated service. Full request bodies and header values are processed locally and transiently during an Extended send; they are not persisted or sent to the developer. Only the redacted operational fields described in the privacy policy are retained.

An existing ChatGPT Pro subscription is required. This extension does not provide Pro access or bypass billing or account controls. It depends on unsupported ChatGPT page and request details, so changes to ChatGPT or Chrome may break it.

Unofficial; not affiliated with, endorsed by, or published by OpenAI.

## Permission justifications

### `debugger`

Required only for Extended mode. After the user selects Extended and performs a normal ChatGPT composer submission, the extension revalidates and attaches to that exact top-level `https://chatgpt.com` tab and enables two exact-origin request-stage Fetch patterns for ChatGPT's conversation endpoint. It validates exactly one fresh `POST /backend-api/f/conversation` request for `gpt-5-6-pro` or `gpt-6-pro`, preserves the selected model, sets only the top-level `thinking_effort` and `client_prepare_state` fields to their required Extended values, omits the `x-conduit-token` and `content-length` transport headers while preserving the other fresh headers, continues the request to ChatGPT, clears interception, and detaches. Unrelated paused requests are immediately continued. Standard mode never attaches the debugger. The extension also detaches or fails closed on timeout, mismatch, duplicate request, navigation, tab closure, or lost state. If Chrome repeatedly rejects detachment after a continued request, the full request body and header values have already been released, the extension reports a cleanup warning, and that tab remains blocked from another one-shot operation until the debugger session ends.

### `storage`

Stores a `standard` or `extended` choice under a key derived from each canonical ChatGPT conversation UUID so saved chats retain independent modes and matching tabs synchronize. It also stores browser-session-only redacted operation state needed to recover safely if the Manifest V3 service worker restarts. No prompt, request body, response text, cookie, authorization value, or header value is stored.

### `webNavigation`

Distinguishes same-document ChatGPT route transitions from reloads and committed navigations while an Extended one-shot operation is active. This keeps the operation bound to the correct top-level tab, document, and conversation and lets it cancel conservatively when navigation no longer matches.

### `https://chatgpt.com/*`

Restricts content scripts and host access for the selector, model detection, mode lifecycle, and navigation handling to the exact `https://chatgpt.com` origin. The service worker revalidates that origin before attaching, and the request qualifier rejects every other origin. Chrome's global `debugger` permission is still powerful and produces the warning disclosed above.

## Privacy-practices answers

Use these answers for the packaged code described above. If the package changes, audit the answers again before submission.

**Remote code:** Select **No, I am not using remote code**. All JavaScript is readable and shipped in the extension package. The code does not download executable code or use dynamic evaluation.

**User-data categories handled:** Disclose the following categories because Chrome treats local inspection or use as handling even when the developer never receives the data:

- **Authentication information:** outgoing ChatGPT request headers may contain authentication-related values during the one-shot operation.
- **Personal communications:** the outgoing request body includes the user's ChatGPT prompt and may include other conversation data.
- **Web history:** the current `chatgpt.com` path and conversation route are used to bind modes and active operations to the correct chat. During a new chat's first-send correlation, the content script also reads conversation links already present in ChatGPT's page and transiently extracts only canonical conversation UUID storage keys. A reload-recovery record is created only when there are no more than 512 keys and may hold them in that tab's page `sessionStorage`; it is never accepted after two minutes and does not retain titles or conversation content.
- **User activity:** the extension handles its selector interactions and normal composer-send activation so it can decide whether to pass through or arm Extended.
- **Website content:** the content script reads the visible model/composer state, and Extended transiently parses the eligible outgoing request body.

These categories are used only to provide the extension's single purpose. They are not sold, used for advertising, transferred to the developer, or used for creditworthiness or lending. Full request bodies and header values are never persisted. The only persistent data is the selected mode keyed by a ChatGPT conversation UUID; page-session correlation data is short-lived, and browser-session operational records are redacted as described in [the privacy policy](../PRIVACY.md).

Complete the Chrome Web Store Limited Use certifications consistently with those statements.

## No-remote-code declaration

All executable code is contained in the submitted ZIP. There are no third-party runtime libraries, remotely hosted scripts, WebAssembly downloads, `eval`, `new Function`, analytics SDKs, or developer-operated APIs. Extended mode continues the user's original request to `chatgpt.com`; doing so does not load executable code into the extension.

## Distribution and URLs

- **Visibility:** Public.
- **Pricing:** Free extension; an independently purchased ChatGPT Pro subscription is required.
- **Category:** Workflow & Planning.
- **Regions:** All regions.
- **Homepage:** `https://github.com/ahmedelami/chatgpt-pro-effort-selector`
- **Support:** `https://github.com/ahmedelami/chatgpt-pro-effort-selector/issues`
- **Privacy policy:** `https://github.com/ahmedelami/chatgpt-pro-effort-selector/blob/main/PRIVACY.md`

Verify that every URL is publicly reachable before submission. Use only original extension artwork and screenshots of the actual product; do not use OpenAI's logo or imply that OpenAI publishes or endorses the extension.

## Upload assets

- **Package icon:** `icons/icon-128.png`
- **Small promotional tile:** `store/assets/small-promo-440x280.png`
- **Primary product screenshot:** `store/assets/screenshot-selector-640x400.png`

The icon and promotional tile use the original monochrome two-bar effort mark. Editable SVG sources are kept beside the store assets and are not included in the runtime ZIP.

## Private reviewer test instructions

The dashboard limits **Additional instructions** to 500 characters. Paste this 472-character note:

> Requires Chrome 120+ and an authorized ChatGPT account with GPT-5.6 Pro or GPT-6 Pro; no credentials provided. Keep DevTools and other debugger tools detached. Open chatgpt.com, choose Pro or 6 Pro, and confirm Sta.. offers Standard/Extended. In Standard, send and confirm no debugger indicator. Select Extended, send, and confirm one message, a response, a brief debugger indicator, then detachment. Reload the saved chat to confirm Ext.. persists; return it to Standard.

Before submission, resolve how reviewers will obtain authorized ChatGPT Pro access. If Google requires publisher-supplied test credentials, provide only a dedicated, policy-compliant review account in the private dashboard field; never commit credentials to this repository or place them in the public listing.

## Submission checklist

- The packaged manifest description is no more than 132 characters.
- The manifest and ZIP include the required extension icons.
- `manifest.json` is at the ZIP root and the package contains only runtime and required legal files.
- `npm run validate` passes against the exact release contents.
- The 128 x 128 icon, 440 x 280 small promotional tile, and at least one 1280 x 800 or 640 x 400 product screenshot are ready.
- The public privacy-policy URL resolves without authentication.
- Store listing, privacy-practices answers, permission justifications, and reviewer notes match the exact packaged code.
- Publisher account registration, verified contact email, 2-Step Verification, trader status, distribution, and regions are complete.
- The release version is greater than every previously uploaded version.
- The listing clearly states that the extension is unofficial and requires ChatGPT Pro.
