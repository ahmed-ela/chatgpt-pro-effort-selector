# ChatGPT Pro Effort Selector

## Table of contents

- [Why it exists](#why-it-exists)
- [Install with Codex](#install-with-codex-56-sol)
- [Use it](#use-it)
- [Safety and privacy](#safety-and-privacy)
- [Manual installation](#manual-installation)
- [Validate](#validate)
- [Technical documentation](#technical-documentation)
- [Known limitations](#known-limitations)
- [For curious readers](#for-curious-readers)
- [License](#license)

## Why it exists

> [!IMPORTANT]
> **OpenAI exposed Standard and Extended thinking in GPT-5.5 Pro. GPT-5.6 Pro hides that choice; this extension brings it back.**

<p align="center">
  <img src="docs/images/pro-effort-selector.png" alt="Standard and Extended effort selector beside ChatGPT Pro" width="318">
</p>

> [!TIP]
> **Verify it yourself after installing the extension**

<p align="center">
  <img src="docs/images/standard-to-extended-thinking-effort.png" alt="Chrome request metadata showing thinking effort changing from standard to extended" width="1200">
</p>

This dependency-free Manifest V3 extension adds a compact **Standard / Extended** selector beside ChatGPT's visible **Pro**, **GPT-5.6 Pro**, **6 Pro**, or **GPT-6 Pro** model control. It accepts the exact GPT-5.6 Pro and GPT-6 Pro request slugs and preserves the selected model. It does not replace ChatGPT's model menu.

> [!WARNING]
> This unofficial extension uses Chrome's powerful `debugger` permission. Review the source before installing it. ChatGPT or Chrome changes can break it without notice.

## Install with Codex 5.6 Sol

Copy the block below and paste it into Codex 5.6 Sol:

~~~text
Download or safely update the ChatGPT Pro Effort Selector from:
https://github.com/ahmedelami/chatgpt-pro-effort-selector

Work autonomously until it is installed and visibly verified in Google Chrome.

1. Read the repository README, `manifest.json`, and relevant source before installing. Explain that this unpacked extension requests Chrome's powerful debugger permission because Extended mode briefly intercepts one ChatGPT request at a time.
2. Use Git or the terminal to clone the repository into the stable local directory `~/chatgpt-pro-effort-selector`.
   - If that directory is absent, clone the repository's default branch there.
   - If it exists, verify it is a Git clone of exactly this repository. Never overwrite, delete, reset, or repurpose an unrelated directory.
   - If the correct clone is clean and on its default branch, fetch and update it with a fast-forward-only pull.
   - If it is dirty, diverged, on another branch, or has a different remote, stop and report the issue without modifying it.
3. From the repository root, run `npm run validate`. Do not run `npm install`; there are no dependencies or build steps. Stop and report any validation failure.
4. Use Computer Use for all Chrome UI actions. Do not use DevTools, Protocol Monitor, CDP, or a browser-control plugin that attaches a debugger to the ChatGPT tab.
5. Open `chrome://extensions`, enable Developer mode, and find ChatGPT Pro Effort Selector.
   - If this same clone is already loaded, click Reload.
   - If a copy from another directory or multiple copies exist, stop and ask me. Do not remove anything or load a duplicate.
   - Otherwise, click Load unpacked and choose the clone directory containing `manifest.json`.
6. If this is a first-time Load unpacked install, wait until immediately before clicking Load unpacked, then explain the debugger-permission risk and ask for the single action-time confirmation required by Computer Use. Batch that one confirmation to cover clicking Load unpacked, choosing exactly the verified `~/chatgpt-pro-effort-selector` directory containing `manifest.json`, and accepting only Chrome's expected debugger-related warning for this extension. After I confirm, continue autonomously without another confirmation. If the same clone is already loaded and only needs Reload, do not ask for confirmation.
7. Open or reload `https://chatgpt.com/`. Without sending a message, select the visible Pro model if needed and verify that a compact selector containing exactly Standard and Extended appears beside it.
8. Confirm Chrome's installed extension version matches `manifest.json`.
9. Do not send a ChatGPT message unless I explicitly ask for a live request test. If I do request one, keep DevTools and every other debugger-based browser tool detached during the Extended send because the extension needs exclusive temporary debugger access.
10. Report the clone path, extension version, validation result, and visible Chrome verification. Leave ChatGPT open and leave the current test chat in Standard mode.
~~~

## Use it

1. Select **Pro** in ChatGPT.
2. Choose **Standard** or **Extended**.
3. Send normally with the composer button or Enter.

### Standard

- It is the safe default.
- ChatGPT requests remain untouched.
- The debugger is not attached.

### Extended

- The extension briefly attaches immediately before a normal Pro composer send.
- It matches one fresh Pro request, changes its effort to Extended, clears interception, and detaches.
- Extended stays selected for that conversation until you switch it back.

Saved conversations keep independent modes and matching tabs stay synchronized. Blank drafts keep a tab-local mode until they become saved conversations. The selector is hidden for GPT-5.6 Sol and does not cover regenerate, retry, branch, or other non-composer actions.

Keep DevTools, Protocol Monitor, and other debugger-based tools detached during an Extended send. If the extension cannot safely prove the expected request lifecycle, it blocks or reports an uncertain outcome instead of silently claiming Extended succeeded.

## Safety and privacy

| Access | Why it is needed |
| --- | --- |
| `https://chatgpt.com/*` | Runs the selector only on ChatGPT |
| `debugger` | Briefly intercepts one Extended send |
| `storage` | Saves per-chat modes and redacted session state |
| `webNavigation` | Keeps an operation bound to the correct conversation |

- No telemetry or remote code.
- Prompts, responses, cookies, authorization values, and header values are not retained.
- The full request body is parsed transiently and never retained; browser-session storage keeps only redacted audit fields and the minimal operational identifiers described in the technical reference.
- The debugger is attached only for an Extended send and detached as quickly as the one-shot lifecycle permits.

See the [technical reference](docs/technical-reference.md) for the complete permission, redacted-audit, and recovery design.

## Manual installation

1. Clone the repository:

   ~~~bash
   git clone https://github.com/ahmedelami/chatgpt-pro-effort-selector.git
   cd chatgpt-pro-effort-selector
   ~~~

2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Choose the cloned repository root containing `manifest.json`.
6. Accept Chrome's debugger-related warning.
7. Open or reload [ChatGPT](https://chatgpt.com/).

No build step or package installation is required. Do not run `npm install`.

## Validate

Requires Node.js 18 or newer:

~~~bash
npm run validate
~~~

This checks every extension script and runs the complete automated test suite.

Create the deterministic Chrome Web Store upload ZIP with:

~~~bash
npm run package
~~~

The archive is written to `dist/` with `manifest.json` at its root.

## Technical documentation

- [Technical reference](docs/technical-reference.md) — storage, request lifecycle, navigation, recovery, permissions, privacy, and project structure.
- [Manual QA checklist](docs/manual-qa.md) — full browser, accessibility, mode, persistence, and failure test matrix.
- [Privacy policy](PRIVACY.md) — public disclosure of local processing, retained state, and user control.
- [Chrome Web Store listing](docs/store-listing.md) — listing copy, permission justifications, upload assets, and reviewer instructions.

## Known limitations

- The extension depends on unsupported ChatGPT DOM and request internals.
- ChatGPT or Chrome changes can break it.
- Shadow DOM isolates the selector's internal styling, but not model detection, mount-point discovery, or request schemas.
- The extension intentionally blocks Extended or reports an uncertain outcome when required structure no longer matches.

## For curious readers

<details>
<summary>Why did ChatGPT change its temporary conversation IDs?</summary>

**My best read: they’re reorganizing how ChatGPT manages conversations as application state.** That fits their broader move toward an app for ongoing work, but the URL change alone is a small signal.

I checked the current browser code. It creates a `local-chatgpt:<uuid>` identifier immediately, then maps it to the permanent server conversation ID when the chat is saved. It also explicitly treats the old `WEB:` URLs as obsolete. So this is a deliberate change to conversation identity handling. [Current conversation-state code](https://chatgpt.com/cdn/assets/184143.2270b2c39e.js)

| Before | Now |
|---|---|
| `WEB:<uuid>` emphasized where the temporary ID originated: the web client. | `local-chatgpt:<uuid>` explicitly identifies a local ChatGPT conversation. |
| The interface already had a temporary chat before receiving its permanent server ID. | The current code maintains explicit mappings between temporary and permanent identities. |
| Suggests a convention named around the browser. | Suggests a clearer convention that could be reused across different app surfaces. |

The important qualification: **the old design already supported creating the chat locally before the server finished.** We cannot infer that this capability is new, or that the old implementation lacked similar mappings.

Why would engineers do this? Likely reasons include making unsaved versus saved conversations harder to confuse, simplifying retries and navigation, or consolidating code used by several interfaces. A clearer identifier helps the app track “the conversation you already see” while its backend creation is still underway.

The broader direction has stronger evidence elsewhere: OpenAI publicly describes bringing Chat, Work, and Codex together, supporting work across devices, and handling longer tasks involving files, tools, and scheduled activity. That makes reliable conversation and task state increasingly central to the product. [OpenAI’s announcement](https://openai.com/index/chatgpt-for-your-most-ambitious-work/)

**My interpretation is that a conversation is becoming the container for an ongoing piece of work.** This naming change is consistent with that infrastructure becoming more general and shared. The alternative explanation—an ordinary cleanup during a frontend refactor—is also entirely plausible.

It gives us no evidence of on-device model inference, offline operation, or an intentional restriction on Extended. Our extension depended on an internal naming convention that changed.

Additional implementation reference: [legacy `WEB:` route handling](https://chatgpt.com/cdn/assets/16147.36a0f51980.js).

</details>

<details>
<summary>Does Extended still work when ChatGPT omits thinking_effort?</summary>

**Yes, in a controlled live test on September 28, 2026.** The normal GPT-6 Pro request we observed omitted `thinking_effort` entirely. The backend still accepted a corrected request that explicitly included:

~~~json
{
  "thinking_effort": "extended"
}
~~~

The test preserved `model: "gpt-6-pro"` and used the extension's existing unprepared request path, `client_prepare_state: "none"`. It returned `OK`, and the saved assistant response had `status: "finished_successfully"`, `model_slug: "gpt-6-pro"`, and `thinking_effort: "extended"` in the server data.

The old extension required `thinking_effort` to already exist as a string, so it aborted the new request shape before sending it. Version 1.0.17 adds the field when it is absent on a supported Pro request. It still rejects explicitly present non-string values, including `null`, and keeps the existing model and request validation.

Omitting the field from the normal frontend request therefore did not mean the backend had stopped accepting Extended. This is an observation of unsupported ChatGPT internals on that date; it does not establish why OpenAI changed the frontend or guarantee future support.

Verification scope: the corrected backend request succeeded through a controlled diagnostic interception, and all 89 automated checks passed. A live end-to-end check of the reloaded 1.0.17 extension was still pending at the time of this note.

## Uncertain-send diagnostics (1.0.18)

Uncertain sends now explain the observed trigger, such as a capture timeout or navigation, instead of always claiming Chrome detached or lost state. The session audit retains a sanitized cause, observation time, lifecycle flags, and Chrome detach reason when available. Worker recovery preserves an already recorded cause; legacy records receive neutral wording. The extension still refuses to report an unverified request as a successful Extended send. Check the conversation before retrying to avoid a duplicate.

</details>

## License

[MIT](LICENSE)
