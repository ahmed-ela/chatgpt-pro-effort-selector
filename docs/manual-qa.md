# Manual QA Checklist

Use a unique marker in every test prompt. When checking backend metadata, keep DevTools, Protocol Monitor, and other debugger-based browser tooling detached until the response is complete and Chrome's Extended debugger indication is gone. Detach the inspector again before every later Extended send.

## Exact Pro visibility

1. Open ChatGPT with a non-Pro model selected.
2. Confirm the extension selector is absent.
3. Select the visible Pro model.
4. Confirm the selector appears beside the composer model control.
5. Select GPT-5.6 Sol.
6. Confirm the selector disappears.
7. Confirm no GPT-5.6 Sol request is rewritten to Pro.
8. Navigate between chats using ChatGPT's SPA navigation.
9. Confirm only one selector exists after rerenders.

## Native visual behavior

1. Test in light mode.
2. Test in dark mode.
3. Confirm Pro and the effort selector remain in one horizontal composer-control row.
4. Confirm the selector never stacks underneath Pro or overlaps the mic, voice, or send controls.
5. Confirm the closed selector clearly shows `Sta..` or `Ext..` with a compact menu chevron.
6. Confirm the selector is a borderless 36 px composer control that is transparent at rest, uses the nearby model control's font and foreground tokens where available, and shows a restrained background only while hovered.
7. Confirm the open picker is approximately 152 px wide with a 16 px radius and exactly two 36 px single-line choice rows: Standard and Extended.
8. Confirm selection is communicated by the right-side checkmark, with no persistent selected-row fill and only a restrained hover surface.
9. Confirm the picker never adds a heading, descriptions, status text, operational controls, or a wider operational section.
10. Resize to a narrow viewport and confirm the popover remains fully on-screen and scrolls internally when necessary.
11. Resize or scroll the composer and confirm the open popover continues tracking the trigger.

## Accessibility

1. Reach the selector with Tab.
2. Press Enter or Space to open it.
3. Confirm focus enters the selected radio option.
4. Confirm the options expose:
   - `role="radio"`
   - `aria-checked`
5. Use Left, Right, Up, and Down arrows.
6. Use Home and End.
7. Press Escape.
8. Confirm the popover closes and focus returns to its trigger.
9. Reopen it and click outside.
10. Confirm outside-click dismissal.
11. Confirm the selected option is announced through `aria-checked` and shown with a right-side checkmark rather than a persistent filled card.
12. Change the preference and exercise operational phases with the picker both open and closed.
13. Confirm each non-error phase change is announced once politely and each error is announced once as an alert without adding visible picker text.

## Standard

1. Select Standard.
2. Submit through the send button.
3. Submit with Enter.
4. Confirm Shift+Enter still inserts a newline.
5. Confirm no debugger infobar appears.
6. Confirm ChatGPT requests behave normally.
7. Reload the page.
8. Confirm Standard remains selected for that conversation.

## Extended send button

1. Select the exact visible Pro model.
2. Select Extended.
3. Reopen the selector and confirm Extended has the selected check and the picker still contains only Standard and Extended.
4. Enter a prompt.
5. Press the normal ChatGPT send button.
6. Confirm Chrome briefly shows its debugger indication.
7. Confirm exactly one user submission occurs.
8. Confirm the picker never adds status text during the send.
9. Confirm the debugger indication disappears promptly.
10. Enter a second prompt in the same conversation without changing the selector.
11. Press the normal send button again.
12. Confirm a fresh one-shot generation is armed and the second request is also sent Extended.
13. Confirm the conversation remains Extended after success, warning, failure, or timeout.

## Extended keyboard send

1. Select Pro and Extended.
2. Enter a prompt.
3. Press Enter.
4. Confirm exactly one submission occurs.
5. Confirm Extended remains selected after the submission.
6. Confirm Shift+Enter does not arm and still inserts a newline.

## Independent saved-conversation modes

1. Open canonical saved Chat A and canonical saved Chat B.
2. Select Extended in Chat A.
3. Leave Chat B Standard.
4. Navigate from A to B using ChatGPT's SPA navigation.
5. Confirm B loads Standard before any captured submission is replayed.
6. Confirm neither chat adds operational text to the picker.
7. Submit normally in B and confirm no debugger attachment occurs.
8. Navigate back to A.
9. Confirm A remains Extended.
10. Reload both conversations while A is Extended and B is Standard, then confirm both modes.
11. Select Standard in A and Extended in B.
12. Reload both conversations again and confirm A is Standard and B is Extended.
13. Confirm each chat's marked backend result matches its selected mode.

## Saved-chat reload transition matrix

Run this five-send sequence in one canonical chat, using a unique marker for every prompt:

1. Start Standard, send marker 1, and confirm its backend metadata is Standard.
2. Reload, confirm Standard, send marker 2, and confirm backend Standard. This proves Standard → Standard.
3. Select Extended, reload, confirm Extended, send marker 3, and confirm durable backend Extended proof. This proves Standard → Extended.
4. Reload, confirm Extended, send marker 4, and confirm durable backend Extended proof. This proves Extended → Extended.
5. Select Standard, reload, confirm Standard, send marker 5, and confirm backend Standard. This proves Extended → Standard.
6. Rapidly select Standard → Extended → Standard, reload, and confirm the last selection wins.
7. Rapidly select Extended → Standard → Extended, reload, and confirm the last selection wins, then restore Standard after backend inspection is detached.

## Same-conversation tab synchronization

1. Open the same canonical saved conversation in two tabs.
2. Select Extended in the first tab.
3. Confirm the second tab changes to Extended.
4. Reload the second tab, confirm Extended, then submit and verify backend Extended.
5. Select Standard in the second tab.
6. Confirm the first tab changes to Standard.
7. Reload the first tab, confirm Standard, then submit and verify backend Standard.
8. Change a different conversation in a third tab.
9. Confirm the first two tabs ignore that unrelated storage change.

## Blank new-chat adoption

1. Open a fresh blank new chat with no canonical `/c/<UUID>` path and confirm Standard.
2. Reload, confirm Standard, send a unique marker, wait for the canonical route, confirm backend Standard, reload, and confirm the saved chat remains Standard.
3. Open a later blank new chat and confirm it defaults to Standard.
4. Select Extended but do not send, reload, and confirm the same blank draft remains Extended.
5. Send a unique marker, wait for success and the canonical route, confirm durable backend Extended proof, reload, and confirm the saved chat remains Extended.
6. Open a later blank new chat and confirm it defaults to Standard.
7. Select Extended in a blank draft without sending, navigate directly to an existing saved Standard conversation, and confirm the existing conversation remains Standard.
8. Open another blank new chat in that same tab and confirm it starts Standard rather than resurrecting the abandoned draft selection.
9. Open a separate fresh ChatGPT tab and confirm its blank draft starts Standard.
10. In a controlled harness, or manually when the timing is reproducible, submit a Standard first message and select Extended before ChatGPT assigns the canonical route.
11. Confirm that first marked request remained backend Standard, reload and confirm the created chat is Extended, then send a second marker and confirm backend Extended.

## Legacy migration QA

1. Before loading the revised extension, create the old local-storage value `effortPreference = "extended"`.
2. Load or reload the revised extension.
3. Confirm the legacy key is removed, or remains inert if Chrome reports a removal failure.
4. Open multiple saved conversations with no per-chat mode keys.
5. Confirm none silently inherit the old global Extended value.
6. Confirm each missing or corrupt per-chat value resolves to Standard.

## Click activation, cancellation, and recursion

1. Press and hold the primary mouse button on the send control.
2. Move the pointer away from the control and release it.
3. Confirm the cancelled click neither arms Extended nor submits the prompt.
4. Use a complete physical mouse click on the send button.
5. Confirm exactly one one-shot operation and one user submission occur.
6. Double-click rapidly.
7. Confirm only one one-shot operation is active.
8. Confirm a later physical click is blocked while Arming.

## Timeout

1. Select Extended.
2. Trigger a send in a state where ChatGPT does not produce the exact conversation POST.
3. Wait approximately 10 seconds.
4. Confirm the operation reports **Extended outcome uncertain** after replay authorization, or a definite blocker if replay was explicitly cancelled before dispatch.
5. Confirm it never reports a clean Extended success.

## Model mismatch

1. Select Extended while Pro is visible.
2. Change the model during the arm/replay boundary if reproducible.
3. Confirm a fresh non-Pro body is aborted rather than rewritten.
4. Confirm the error names the Pro model mismatch.

## Duplicate qualifying requests

1. Use a controlled test harness or breakpoint-free environment capable of generating two matching conversation POSTs from one replay.
2. Confirm a second pause observed before continuation causes the paused qualifying requests to be aborted where possible.
3. If the duplicate arrives after the first request was already sent Extended, confirm a temporary warning toast appears while the picker remains unchanged.

## DevTools detach

1. Open DevTools before submitting.
2. Attempt Extended.
3. Confirm attachment fails clearly.
4. Close DevTools.
5. Start another Extended send.
6. Open DevTools while Arming.
7. Confirm the extension reports a blocker or explicitly uncertain outcome.
8. Confirm it never labels the result as a clean Extended success.

## Navigation and tab closure

1. In the listener regression harness, arm Extended on a saved chat and emit a status-only `tabs.onUpdated` loading signal while `tabs.get()` still returns the same URL.
2. Advance past the one-second navigation-confirmation deadline and confirm the generation remains armed, no navigation audit is created, and the debugger is not detached.
3. Emit a top-frame `webNavigation.onCommitted` event with the armed document's same `documentId` and URL, and confirm the generation remains armed without a detach.
4. Emit the same event with a different `documentId` and confirm that actual document replacement cancels the operation and detaches once.
5. Confirm that a same-`documentId` commit to an unrelated ChatGPT route is still rejected by the strict same-document route policy.
6. Start another Extended operation.
7. Navigate to another ChatGPT route immediately.
8. Confirm the one-shot operation is cancelled or marked uncertain.
9. Start another operation and close the tab.
10. Confirm no other ChatGPT tab is affected.
11. During an A-to-B SPA transition, attempt a normal composer submission before B's storage read completes.
12. Confirm the original event is stopped and is replayed only after B's mode is loaded, or remains blocked if loading fails or the route changes again.
13. Confirm a terminal status from A's retired generation cannot overwrite B's UI.
14. Confirm the destination route does not restore an unrelated completed tab audit as its own Sent or warning state.

## Multiple tabs

1. Open two ChatGPT tabs.
2. Select Pro in both.
3. Submit Extended in each independently.
4. Confirm each operation is bound to its own tab and generation.
5. Confirm a failure in one tab does not alter the other tab's audit.
6. Confirm a detached cleanup-warning session does not permanently prevent a later operation in that tab.

## Service-worker restart

1. Start an Extended operation.
2. From `chrome://serviceworker-internals` or the extension inspection page, stop the service worker without reloading the extension.
3. Cause the worker to wake.
4. Confirm stale paused request ids are aborted where possible.
5. Confirm the debugger patterns are cleared and detachment is attempted.
6. Confirm the result is blocked, uncertain, or sent-with-warning according to the safely retained phase.
7. Confirm it never silently reports a clean Extended send.

## Extension reload

1. Start an Extended operation.
2. Reload the extension from `chrome://extensions`.
3. Confirm no request body, header values, prompt, or response is restored.
4. Confirm each canonical conversation's persistent mode remains.
5. Confirm the page can recover to a new Ready state after reload.

[Back to the main README](../README.md)
