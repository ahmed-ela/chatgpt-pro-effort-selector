(() => {
  "use strict";

  const MESSAGE_SOURCE =
    "chatgpt-pro-effort-selector";

  const LEGACY_STORAGE_KEY =
    "effortPreference";

  const {
    STANDARD,
    EXTENDED,
    PENDING_DRAFT_MAX_AGE_MS,
    normalizeMode,
    parseChatRoute,
    sameChatRoute,
    readModeForRoute,
    readDraftModeFromSessionStorage,
    persistDraftModeToSessionStorage,
    clearDraftModeFromSessionStorage,
    isTemporaryChatRoute,
    isProvisionalDraftTransition,
    routeContinuesDraftLifecycle,
    readDraftBindingFromSessionStorage,
    persistDraftBindingToSessionStorage,
    persistPendingDraftAdoptionToSessionStorage,
    readPendingDraftAdoptionFromSessionStorage,
    clearPendingDraftAdoptionFromSessionStorage,
    shouldRestorePendingDraftAdoption,
    conversationRouteForBinding,
    conversationRouteForDraftLifecycle,
    drainLatestModeWrite,
    storageChangeAffectsRoute,
    isDraftAdoptionTarget,
    shouldBindDraftConversation,
    decideSubmissionForMode
  } = globalThis.ProEffortModeCore;

  const {
    TRIGGER_SHADOW_STYLES,
    POPOVER_SHADOW_STYLES,
    TRIGGER_HOST_STYLES,
    POPOVER_HOST_STYLES,
    applyImportantStyles,
    adoptShadowStyles,
    eventOccursWithin,
    getDeepActiveElement
  } = globalThis.ProEffortShadowUi;

  const ROOT_ATTRIBUTE =
    "data-pro-effort-selector-root";
  const POPOVER_HOST_ATTRIBUTE =
    "data-pro-effort-selector-popover-host";
  const TOAST_ATTRIBUTE =
    "data-pro-effort-selector-toast";
  const POPOVER_ID =
    "pro-effort-selector-popover";

  const EDITABLE_SELECTOR = [
    "textarea",
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"][contenteditable]'
  ].join(",");

  const BUTTON_SELECTOR = [
    "button",
    '[role="button"]'
  ].join(",");

  const MODEL_CONTROL_SELECTOR = [
    "button",
    '[role="button"]',
    '[aria-haspopup="menu"]',
    '[aria-haspopup="listbox"]'
  ].join(",");

  function getDraftSessionStorage() {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  }

  const draftSessionStorage =
    getDraftSessionStorage();

  let preference = STANDARD;
  let modelState = "unknown";
  let modelControl = null;

  let activeRoute =
    parseChatRoute(window.location.href);
  let routeLoaded = false;
  let routeEpoch = 0;
  let routeLoadSerial = 0;
  let routeLoadPromise = null;
  let routeLoadTarget = null;
  let modeRevision = 0;
  let selectionSerial = 0;
  let modeWriteQueue =
    Promise.resolve();
  let draftPreference =
    activeRoute.kind === "draft"
      ? readDraftModeFromSessionStorage(
          draftSessionStorage
        )
      : clearDraftModeFromSessionStorage(
          draftSessionStorage
        );
  let draftBinding =
    activeRoute.kind === "draft"
      ? readDraftBindingFromSessionStorage(
          draftSessionStorage,
          activeRoute
        )
      : null;
  let pendingDraftStorageExpiryTimer =
    null;
  let pendingDraftAdoptionRecord =
    readPendingDraftAdoptionFromSessionStorage(
      draftSessionStorage,
      activeRoute
    );

  schedulePendingDraftStorageExpiry(
    pendingDraftAdoptionRecord
  );

  if (
    activeRoute.kind === "draft" &&
    !draftBinding &&
    !isTemporaryChatRoute(activeRoute)
  ) {
    draftBinding = null;
  }
  let draftAdoption = null;
  let navigationInvalidatedOperation =
    false;
  let lastObservedHref =
    window.location.href;
  const retiredGenerationIds =
    new Set();

  let root = null;
  let rootShadow = null;
  let trigger = null;
  let triggerLabel = null;
  let politeLiveRegion = null;
  let alertLiveRegion = null;
  let popoverHost = null;
  let popoverShadow = null;
  let popover = null;
  let rootMountParent = null;
  let rootMountReference = null;
  let popoverResizeObserver = null;
  let openingFocusEpoch = 0;
  let openingFocusTimers = [];
  let returnFocusEpoch = 0;
  let returnFocusTimer = null;
  let returnFocusCleanup = null;
  let popoverRenderSignature = null;
  let announcementTimer = null;
  let announcementClearTimer = null;
  let lastAnnouncementSignature = null;
  let observer = null;

  let scanScheduled = false;
  let submissionBusy = false;
  let submissionSerial = 0;
  let replayDepth = 0;
  let currentGenerationId = null;
  let toastTimer = null;

  let viewState = {
    kind: "standard",
    label: "Standard",
    message: "ChatGPT requests are left untouched."
  };

  function runtimeSend(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          source: MESSAGE_SOURCE,
          ...message
        },
        (response) => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(
              new Error("runtime_message_failed")
            );
            return;
          }

          resolve(response);
        }
      );
    });
  }

  function storageGetMode(storageKey) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(
        [storageKey],
        (values) => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(
              new Error("storage_read_failed")
            );
            return;
          }

          resolve(
            readModeForRoute(
              values,
              {
                kind: "conversation",
                storageKey
              }
            )
          );
        }
      );
    });
  }

  function storageSetMode(
    storageKey,
    value
  ) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          [storageKey]:
            normalizeMode(value)
        },
        () => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(
              new Error("storage_write_failed")
            );
            return;
          }

          resolve();
        }
      );
    });
  }

  function enqueueModeWrite(
    storageKey,
    value
  ) {
    const write =
      modeWriteQueue
        .catch(() => {})
        .then(() =>
          storageSetMode(
            storageKey,
            value
          )
        );

    modeWriteQueue = write;

    return write;
  }

  function retireLegacyPreference() {
    return new Promise((resolve) => {
      chrome.storage.local.remove(
        [LEGACY_STORAGE_KEY],
        () => {
          void chrome.runtime.lastError;
          resolve();
        }
      );
    });
  }

  function normalizeText(value) {
    return typeof value === "string"
      ? value.replace(/\s+/g, " ").trim()
      : "";
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = getComputedStyle(element);

    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();

    return rect.width > 0 && rect.height > 0;
  }

  function getVisibleControlText(element) {
    const visibleText = normalizeText(
      element.innerText
    );

    if (visibleText.length > 0) {
      return visibleText;
    }

    return normalizeText(
      element.getAttribute("aria-label")
    );
  }

  function isExactVisibleProLabel(value) {
    const text = normalizeText(value);

    return (
      text === "Pro" ||
      text === "GPT-5.6 Pro" ||
      text === "6 Pro" ||
      text === "GPT-6 Pro"
    );
  }

  function findComposerEditable() {
    const candidates = Array.from(
      document.querySelectorAll(
        EDITABLE_SELECTOR
      )
    ).filter(isVisible);

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      const leftRect =
        left.getBoundingClientRect();
      const rightRect =
        right.getBoundingClientRect();

      return rightRect.bottom - leftRect.bottom;
    });

    return candidates[0];
  }

  function getCandidateScopes(editable) {
    const scopes = [];
    const seen = new Set();

    const add = (element) => {
      if (
        element instanceof Element &&
        !seen.has(element)
      ) {
        seen.add(element);
        scopes.push(element);
      }
    };

    add(editable.closest("form"));

    let cursor = editable.parentElement;

    for (
      let depth = 0;
      cursor && depth < 9;
      depth += 1
    ) {
      add(cursor);

      if (cursor === document.body) {
        break;
      }

      cursor = cursor.parentElement;
    }

    return scopes;
  }

  function scoreModelControl(candidate, editable) {
    if (
      !isVisible(candidate) ||
      candidate.closest(
        `[${ROOT_ATTRIBUTE}]`
      )
    ) {
      return Number.NEGATIVE_INFINITY;
    }

    const visibleLabel =
      getVisibleControlText(candidate);

    if (!isExactVisibleProLabel(visibleLabel)) {
      return Number.NEGATIVE_INFINITY;
    }

    const ariaLabel = normalizeText(
      candidate.getAttribute("aria-label")
    );
    const title = normalizeText(
      candidate.getAttribute("title")
    );
    const testId = normalizeText(
      candidate.getAttribute("data-testid")
    );
    const hasPopup = normalizeText(
      candidate.getAttribute("aria-haspopup")
    ).toLowerCase();

    const semanticText = [
      ariaLabel,
      title,
      testId
    ].join(" ");

    let score = 100;

    if (/\bmodel\b/i.test(semanticText)) {
      score += 80;
    }

    if (
      hasPopup === "menu" ||
      hasPopup === "listbox"
    ) {
      score += 45;
    }

    const candidateRect =
      candidate.getBoundingClientRect();
    const editableRect =
      editable.getBoundingClientRect();

    const horizontalDistance = Math.min(
      Math.abs(
        candidateRect.left -
        editableRect.left
      ),
      Math.abs(
        candidateRect.right -
        editableRect.right
      )
    );

    const verticalDistance = Math.abs(
      candidateRect.bottom -
      editableRect.bottom
    );

    if (
      horizontalDistance < 750 &&
      verticalDistance < 260
    ) {
      score += 40;
    } else {
      score -= 200;
    }

    return score;
  }

  function findComposerModelControl() {
    const editable = findComposerEditable();

    if (!editable) {
      return null;
    }

    let bestCandidate = null;
    let bestScore = 119;

    for (const scope of getCandidateScopes(editable)) {
      const candidates = scope.querySelectorAll(
        MODEL_CONTROL_SELECTOR
      );

      for (const candidate of candidates) {
        const score = scoreModelControl(
          candidate,
          editable
        );

        if (score > bestScore) {
          bestScore = score;
          bestCandidate = candidate;
        }
      }
    }

    return bestCandidate;
  }

  function inspectCurrentModel() {
    const control = findComposerModelControl();

    if (control) {
      return {
        state: "pro",
        control
      };
    }

    const editable = findComposerEditable();

    if (!editable) {
      return {
        state: "unknown",
        control: null
      };
    }

    /*
     * A visible composer with no exact visible Pro model control is treated
     * as non-Pro only if another model-like control can be found.
     */
    for (const scope of getCandidateScopes(editable)) {
      const candidates = scope.querySelectorAll(
        MODEL_CONTROL_SELECTOR
      );

      for (const candidate of candidates) {
        if (
          !isVisible(candidate) ||
          candidate.closest(
            `[${ROOT_ATTRIBUTE}]`
          )
        ) {
          continue;
        }

        const semanticText = [
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("title"),
          candidate.getAttribute("data-testid")
        ]
          .map(normalizeText)
          .join(" ");

        const hasPopup = normalizeText(
          candidate.getAttribute("aria-haspopup")
        ).toLowerCase();

        if (
          /\bmodel\b/i.test(semanticText) ||
          hasPopup === "menu" ||
          hasPopup === "listbox"
        ) {
          const label =
            getVisibleControlText(candidate);

          if (
            label.length > 0 &&
            !isExactVisibleProLabel(label)
          ) {
            return {
              state: "other",
              control: candidate
            };
          }
        }
      }
    }

    return {
      state: "unknown",
      control: null
    };
  }

  function findOpaqueBackground(anchor) {
    let cursor = anchor;

    while (cursor instanceof Element) {
      const style = getComputedStyle(cursor);
      const background = style.backgroundColor;

      if (
        background &&
        background !== "transparent" &&
        background !== "rgba(0, 0, 0, 0)"
      ) {
        return background;
      }

      cursor = cursor.parentElement;
    }

    return "Canvas";
  }

  function applyNativeTokens(target, anchor) {
    if (
      !(target instanceof HTMLElement) ||
      !(anchor instanceof Element)
    ) {
      return;
    }

    const style = getComputedStyle(anchor);
    const borderWidth = Number.parseFloat(
      style.borderWidth
    );
    const hasVisibleBorder =
      style.borderStyle !== "none" &&
      Number.isFinite(borderWidth) &&
      borderWidth > 0 &&
      style.borderColor &&
      style.borderColor !== "transparent" &&
      style.borderColor !==
        "rgba(0, 0, 0, 0)";
    const borderColor =
      hasVisibleBorder
        ? style.borderColor
        : "color-mix(in srgb, currentColor 18%, transparent)";
    const parsedRadius = Number.parseFloat(
      style.borderTopLeftRadius
    );
    const controlRadius =
      Number.isFinite(parsedRadius) &&
      parsedRadius > 0
        ? `${Math.min(parsedRadius, 10)}px`
        : "10px";

    target.style.setProperty(
      "--pe-native-font-family",
      style.fontFamily || "inherit",
      "important"
    );
    target.style.setProperty(
      "--pe-native-font-size",
      style.fontSize || "14px",
      "important"
    );
    target.style.setProperty(
      "--pe-native-font-weight",
      style.fontWeight || "500",
      "important"
    );
    target.style.setProperty(
      "--pe-native-foreground",
      style.color || "CanvasText",
      "important"
    );
    target.style.setProperty(
      "--pe-native-control-background",
      style.backgroundColor &&
        style.backgroundColor !== "transparent" &&
        style.backgroundColor !==
          "rgba(0, 0, 0, 0)"
        ? style.backgroundColor
        : "transparent",
      "important"
    );
    target.style.setProperty(
      "--pe-native-surface",
      findOpaqueBackground(anchor),
      "important"
    );
    target.style.setProperty(
      "--pe-native-border-color",
      borderColor,
      "important"
    );
    target.style.setProperty(
      "--pe-native-control-radius",
      controlRadius,
      "important"
    );
    target.style.setProperty(
      "--pe-native-direction",
      style.direction || "ltr",
      "important"
    );
    target.style.setProperty(
      "--pe-native-color-scheme",
      style.colorScheme || "normal",
      "important"
    );
  }

  function removeDuplicateRoots() {
    for (const candidate of document.querySelectorAll(
      `[${ROOT_ATTRIBUTE}]`
    )) {
      if (candidate !== root) {
        candidate.remove();
      }
    }

    for (const candidate of document.querySelectorAll(
      `[${POPOVER_HOST_ATTRIBUTE}]`
    )) {
      if (candidate !== popoverHost) {
        candidate.remove();
      }
    }
  }

  function findRootMount(anchor) {
    if (!(anchor instanceof Element)) {
      return null;
    }

    let reference = anchor;
    let parent = anchor.parentElement;

    for (
      let depth = 0;
      parent && depth < 9;
      depth += 1
    ) {
      const style = getComputedStyle(parent);
      const horizontalFlex =
        (
          style.display === "flex" ||
          style.display === "inline-flex"
        ) &&
        (
          style.flexDirection === "row" ||
          style.flexDirection === "row-reverse"
        );
      const horizontalGrid =
        (
          style.display === "grid" ||
          style.display === "inline-grid"
        ) &&
        (
          style.gridAutoFlow === "column" ||
          style.gridAutoFlow ===
            "column dense"
        );

      if (
        (horizontalFlex || horizontalGrid) &&
        !parent.matches(BUTTON_SELECTOR)
      ) {
        return {
          parent,
          reference
        };
      }

      reference = parent;
      parent = parent.parentElement;
    }

    return null;
  }

  function stopPopoverTracking() {
    popoverResizeObserver?.disconnect();
    popoverResizeObserver = null;

    window.visualViewport?.removeEventListener(
      "resize",
      positionPopover
    );
    window.visualViewport?.removeEventListener(
      "scroll",
      positionPopover
    );
  }

  function startPopoverTracking() {
    stopPopoverTracking();

    if (!popover) {
      return;
    }

    if (
      typeof ResizeObserver === "function"
    ) {
      popoverResizeObserver =
        new ResizeObserver(() => {
          positionPopover();
        });

      popoverResizeObserver.observe(popover);

      if (trigger instanceof Element) {
        popoverResizeObserver.observe(trigger);
      }

      if (modelControl instanceof Element) {
        popoverResizeObserver.observe(
          modelControl
        );
      }

      if (
        rootMountParent instanceof Element
      ) {
        popoverResizeObserver.observe(
          rootMountParent
        );
      }
    }

    window.visualViewport?.addEventListener(
      "resize",
      positionPopover
    );
    window.visualViewport?.addEventListener(
      "scroll",
      positionPopover
    );
  }

  function cancelOpeningFocusHandoff() {
    openingFocusEpoch += 1;

    for (const timer of openingFocusTimers) {
      clearTimeout(timer);
    }

    openingFocusTimers = [];
  }

  function focusSelectedRadioForOpening(epoch) {
    if (
      epoch !== openingFocusEpoch ||
      !popover?.isConnected
    ) {
      return;
    }

    const activeElement =
      getDeepActiveElement(document);

    if (
      activeElement instanceof Node &&
      popover.contains(activeElement)
    ) {
      return;
    }

    focusRadio(preference);
  }

  function beginOpeningFocusHandoff() {
    cancelOpeningFocusHandoff();

    const epoch = openingFocusEpoch;
    const attempt = () => {
      focusSelectedRadioForOpening(epoch);
    };

    queueMicrotask(attempt);

    for (const delay of [50, 150, 300]) {
      openingFocusTimers.push(
        window.setTimeout(attempt, delay)
      );
    }
  }

  function cancelReturnFocusHandoff() {
    returnFocusEpoch += 1;

    if (returnFocusTimer !== null) {
      clearTimeout(returnFocusTimer);
      returnFocusTimer = null;
    }

    if (returnFocusCleanup) {
      const cleanup = returnFocusCleanup;
      returnFocusCleanup = null;
      cleanup();
    }
  }

  function beginReturnFocusHandoff(
    focusTarget
  ) {
    cancelReturnFocusHandoff();

    if (
      !(focusTarget instanceof HTMLElement)
    ) {
      return;
    }

    const epoch = returnFocusEpoch;

    const resolveFocusTarget = () => {
      if (focusTarget.isConnected) {
        return focusTarget;
      }

      if (
        trigger instanceof HTMLElement &&
        trigger.isConnected
      ) {
        return trigger;
      }

      return null;
    };

    const restoreFocus = () => {
      if (epoch !== returnFocusEpoch) {
        return;
      }

      resolveFocusTarget()?.focus();
    };

    const handleFocusIn = () => {
      const currentFocusTarget =
        resolveFocusTarget();

      if (
        epoch !== returnFocusEpoch ||
        getDeepActiveElement(document) ===
          currentFocusTarget
      ) {
        return;
      }

      queueMicrotask(restoreFocus);
    };

    const cancelOnUserIntent = () => {
      cancelReturnFocusHandoff();
    };

    /*
     * Start on the next task, not a microtask. This guarantees that the
     * composer-originating Escape keydown has fully finished dispatching
     * before cancellation listeners are installed or focus is restored.
     * Genuinely subsequent pointer or keyboard intent still cancels the
     * bounded handoff before that intent changes focus.
     */
    window.setTimeout(() => {
      if (epoch !== returnFocusEpoch) {
        return;
      }

      document.addEventListener(
        "focusin",
        handleFocusIn,
        true
      );
      document.addEventListener(
        "pointerdown",
        cancelOnUserIntent,
        true
      );
      document.addEventListener(
        "keydown",
        cancelOnUserIntent,
        true
      );

      returnFocusCleanup = () => {
        document.removeEventListener(
          "focusin",
          handleFocusIn,
          true
        );
        document.removeEventListener(
          "pointerdown",
          cancelOnUserIntent,
          true
        );
        document.removeEventListener(
          "keydown",
          cancelOnUserIntent,
          true
        );
      };

      restoreFocus();
    }, 0);

    returnFocusTimer = window.setTimeout(
      () => {
        if (epoch !== returnFocusEpoch) {
          return;
        }

        restoreFocus();
        cancelReturnFocusHandoff();
      },
      1000
    );
  }

  function closePopover(returnFocus) {
    if (!popover && !popoverHost) {
      return;
    }

    cancelReturnFocusHandoff();

    const previousTrigger = trigger;

    cancelOpeningFocusHandoff();
    popoverRenderSignature = null;
    stopPopoverTracking();

    document.removeEventListener(
      "pointerdown",
      handleOutsidePointer,
      true
    );
    window.removeEventListener(
      "resize",
      positionPopover,
      true
    );
    window.removeEventListener(
      "scroll",
      positionPopover,
      true
    );

    popoverHost?.remove();
    popoverHost = null;
    popoverShadow = null;
    popover = null;

    previousTrigger?.setAttribute(
      "aria-expanded",
      "false"
    );

    if (
      returnFocus &&
      previousTrigger?.isConnected
    ) {
      beginReturnFocusHandoff(
        previousTrigger
      );
    }
  }

  function removeInjectedUi(returnFocus) {
    closePopover(Boolean(returnFocus));

    if (announcementTimer !== null) {
      clearTimeout(announcementTimer);
      announcementTimer = null;
    }

    if (announcementClearTimer !== null) {
      clearTimeout(announcementClearTimer);
      announcementClearTimer = null;
    }

    if (root?.isConnected) {
      root.remove();
    }

    root = null;
    rootShadow = null;
    trigger = null;
    triggerLabel = null;
    politeLiveRegion = null;
    alertLiveRegion = null;
    rootMountParent = null;
    rootMountReference = null;
  }

  function createInjectedUi(anchor) {
    removeInjectedUi(false);

    const mount = findRootMount(anchor);

    if (!mount) {
      return;
    }

    root = document.createElement("span");
    root.setAttribute(ROOT_ATTRIBUTE, "");
    applyImportantStyles(
      root,
      TRIGGER_HOST_STYLES
    );

    rootShadow = root.attachShadow({
      mode: "open"
    });
    adoptShadowStyles(
      rootShadow,
      TRIGGER_SHADOW_STYLES
    );

    trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "pe-trigger";
    trigger.setAttribute(
      "aria-haspopup",
      "dialog"
    );
    trigger.setAttribute(
      "aria-expanded",
      "false"
    );

    triggerLabel =
      document.createElement("span");
    triggerLabel.className =
      "pe-trigger-label";

    const triggerChevron =
      document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg"
      );
    triggerChevron.classList.add(
      "pe-trigger-chevron"
    );
    triggerChevron.setAttribute(
      "viewBox",
      "0 0 10 10"
    );
    triggerChevron.setAttribute(
      "aria-hidden",
      "true"
    );
    triggerChevron.setAttribute(
      "focusable",
      "false"
    );

    const triggerChevronPath =
      document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path"
      );
    triggerChevronPath.setAttribute(
      "d",
      "M2 3.5 5 6.5 8 3.5"
    );
    triggerChevronPath.setAttribute(
      "fill",
      "none"
    );
    triggerChevronPath.setAttribute(
      "stroke",
      "currentColor"
    );
    triggerChevronPath.setAttribute(
      "stroke-width",
      "1.5"
    );
    triggerChevronPath.setAttribute(
      "stroke-linecap",
      "round"
    );
    triggerChevronPath.setAttribute(
      "stroke-linejoin",
      "round"
    );
    triggerChevron.append(
      triggerChevronPath
    );
    trigger.append(
      triggerLabel,
      triggerChevron
    );

    politeLiveRegion =
      document.createElement("span");
    politeLiveRegion.className =
      "pe-live-region";
    politeLiveRegion.setAttribute(
      "role",
      "status"
    );
    politeLiveRegion.setAttribute(
      "aria-atomic",
      "true"
    );

    alertLiveRegion =
      document.createElement("span");
    alertLiveRegion.className =
      "pe-live-region";
    alertLiveRegion.setAttribute(
      "role",
      "alert"
    );
    alertLiveRegion.setAttribute(
      "aria-atomic",
      "true"
    );

    trigger.addEventListener("click", () => {
      if (popover) {
        closePopover(true);
      } else {
        openPopover();
      }
    });

    rootShadow.append(
      trigger,
      politeLiveRegion,
      alertLiveRegion
    );

    rootMountParent = mount.parent;
    rootMountReference = mount.reference;

    applyNativeTokens(root, anchor);

    rootMountReference.insertAdjacentElement(
      "afterend",
      root
    );

    renderUi();

    /*
     * ChatGPT can replace the composer-control branch while handling Escape
     * from its textbox. Preserve the active bounded return-focus handoff and
     * transfer focus to the newly mounted trigger immediately.
     */
    if (
      returnFocusTimer !== null ||
      returnFocusCleanup
    ) {
      queueMicrotask(() => {
        if (
          (
            returnFocusTimer !== null ||
            returnFocusCleanup
          ) &&
          trigger?.isConnected
        ) {
          trigger.focus();
        }
      });
    }
  }

  function announceViewState() {
    const signature = JSON.stringify([
      viewState.kind,
      viewState.label,
      viewState.message
    ]);

    if (
      signature ===
      lastAnnouncementSignature
    ) {
      return;
    }

    lastAnnouncementSignature = signature;

    if (announcementTimer !== null) {
      clearTimeout(announcementTimer);
      announcementTimer = null;
    }

    if (announcementClearTimer !== null) {
      clearTimeout(announcementClearTimer);
      announcementClearTimer = null;
    }

    if (
      !politeLiveRegion?.isConnected ||
      !alertLiveRegion?.isConnected
    ) {
      return;
    }

    politeLiveRegion.textContent = "";
    alertLiveRegion.textContent = "";

    const target =
      viewState.kind === "error"
        ? alertLiveRegion
        : politeLiveRegion;
    const announcement = normalizeText(
      `${viewState.label}. ${viewState.message}`
    );

    if (announcement.length === 0) {
      return;
    }

    /*
     * The stable live regions already exist in the accessibility tree.
     * Populate the appropriate one on the next task so polite status
     * changes are announced reliably and errors are announced once through
     * the dedicated alert region.
     */
    announcementTimer = window.setTimeout(
      () => {
        announcementTimer = null;

        if (
          signature !==
            lastAnnouncementSignature ||
          !target.isConnected
        ) {
          return;
        }

        target.textContent = announcement;

        announcementClearTimer =
          window.setTimeout(() => {
            announcementClearTimer = null;

            if (
              signature ===
                lastAnnouncementSignature &&
              target.isConnected &&
              target.textContent ===
                announcement
            ) {
              target.textContent = "";
            }
          }, 1000);
      },
      0
    );
  }

  function setViewState(nextState) {
    viewState = {
      ...viewState,
      ...nextState
    };

    renderUi();
    announceViewState();
  }

  function getEffectiveTriggerPreference() {
    return preference;
  }

  function renderTrigger() {
    if (!trigger || !triggerLabel) {
      return;
    }

    const displayedPreference =
      getEffectiveTriggerPreference();
    const preferenceLabel =
      displayedPreference === EXTENDED
        ? "Extended"
        : "Standard";
    const compactPreferenceLabel =
      `${preferenceLabel.slice(0, 3)}..`;

    triggerLabel.textContent =
      compactPreferenceLabel;
    trigger.dataset.preference =
      displayedPreference;
    trigger.setAttribute(
      "aria-label",
      `Pro effort: ${preferenceLabel}`
    );
  }

  function createRadioOption(
    value,
    title
  ) {
    const selected = preference === value;
    const option = document.createElement("button");

    option.type = "button";
    option.className = "pe-option";
    option.dataset.value = value;
    option.setAttribute("role", "radio");
    option.setAttribute(
      "aria-checked",
      String(selected)
    );
    option.setAttribute(
      "aria-disabled",
      String(submissionBusy)
    );
    option.tabIndex = selected ? 0 : -1;

    const optionTitle =
      document.createElement("span");
    optionTitle.className =
      "pe-option-title";
    optionTitle.textContent = title;

    const optionCheck =
      document.createElement("span");
    optionCheck.className =
      "pe-option-check";
    optionCheck.setAttribute(
      "aria-hidden",
      "true"
    );
    optionCheck.textContent = "✓";

    option.append(
      optionTitle,
      optionCheck
    );

    option.addEventListener("click", () => {
      if (submissionBusy) {
        return;
      }

      void selectPreference(value, true);
    });

    return option;
  }

  function focusRadio(value) {
    const option = popover?.querySelector(
      `.pe-option[data-value="${value}"]`
    );

    if (option instanceof HTMLElement) {
      option.focus();
    }
  }

  function handleRadioGroupKeydown(event) {
    const values = [STANDARD, EXTENDED];
    const currentValue =
      event.target instanceof Element
        ? event.target
            .closest(".pe-option")
            ?.getAttribute("data-value")
        : null;

    let targetValue = null;

    if (
      event.key === "ArrowLeft" ||
      event.key === "ArrowUp" ||
      event.key === "Home"
    ) {
      targetValue = values[0];
    }

    if (
      event.key === "ArrowRight" ||
      event.key === "ArrowDown" ||
      event.key === "End"
    ) {
      targetValue = values[1];
    }

    if (!targetValue) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (targetValue === currentValue) {
      focusRadio(targetValue);
      return;
    }

    void selectPreference(
      targetValue,
      true
    );
  }

  function renderPopoverContents() {
    if (!popover) {
      return;
    }

    const nextRenderSignature =
      JSON.stringify([
        preference,
        submissionBusy
      ]);

    if (
      nextRenderSignature ===
      popoverRenderSignature
    ) {
      return;
    }

    let focusSelector = null;
    const activeElement =
      getDeepActiveElement(document);

    if (
      activeElement instanceof Element &&
      popover.contains(activeElement)
    ) {
      const activeOption =
        activeElement.closest(".pe-option");
      const activeOptionValue =
        activeOption?.getAttribute(
          "data-value"
        );

      if (
        activeOptionValue === STANDARD ||
        activeOptionValue === EXTENDED
      ) {
        focusSelector =
          `.pe-option[data-value="${activeOptionValue}"]`;
      }
    }

    popoverRenderSignature =
      nextRenderSignature;
    popover.replaceChildren();

    const group = document.createElement("div");
    group.className = "pe-options";
    group.setAttribute("role", "radiogroup");
    group.setAttribute(
      "aria-label",
      "Pro effort"
    );
    group.addEventListener(
      "keydown",
      handleRadioGroupKeydown
    );

    group.append(
      createRadioOption(
        STANDARD,
        "Standard"
      ),
      createRadioOption(
        EXTENDED,
        "Extended"
      )
    );

    popover.append(group);

    positionPopover();

    if (focusSelector) {
      queueMicrotask(() => {
        const focusTarget =
          popover?.querySelector(
            focusSelector
          );

        if (
          focusTarget instanceof HTMLElement
        ) {
          focusTarget.focus();
        }
      });
    }
  }

  function renderUi() {
    renderTrigger();
    renderPopoverContents();
  }

  function positionPopover() {
    if (
      !popover?.isConnected ||
      !trigger?.isConnected
    ) {
      return;
    }

    const triggerRect =
      trigger.getBoundingClientRect();
    const margin = 8;
    const viewportPadding = 12;
    const visualViewport =
      window.visualViewport;
    const viewportLeft =
      visualViewport?.offsetLeft ?? 0;
    const viewportTop =
      visualViewport?.offsetTop ?? 0;
    const viewportWidth =
      visualViewport?.width ??
      window.innerWidth;
    const viewportHeight =
      visualViewport?.height ??
      window.innerHeight;
    const viewportRight =
      viewportLeft + viewportWidth;
    const viewportBottom =
      viewportTop + viewportHeight;
    const maximumHeight = Math.max(
      64,
      viewportHeight -
        viewportPadding * 2
    );

    popover.style.left = "0px";
    popover.style.top = "0px";
    popover.style.maxHeight =
      `${Math.floor(maximumHeight)}px`;

    const popoverRect =
      popover.getBoundingClientRect();

    let left =
      triggerRect.right -
      popoverRect.width;
    let top = triggerRect.bottom + margin;

    if (
      left + popoverRect.width >
      viewportRight - viewportPadding
    ) {
      left =
        viewportRight -
        popoverRect.width -
        viewportPadding;
    }

    if (
      left <
      viewportLeft + viewportPadding
    ) {
      left =
        viewportLeft + viewportPadding;
    }

    if (
      top + popoverRect.height >
      viewportBottom - viewportPadding
    ) {
      top =
        triggerRect.top -
        popoverRect.height -
        margin;
    }

    if (
      top <
      viewportTop + viewportPadding
    ) {
      top =
        viewportTop + viewportPadding;
    }

    popover.style.left =
      `${Math.round(left)}px`;
    popover.style.top =
      `${Math.round(top)}px`;
  }

  function handleOutsidePointer(event) {
    if (!popover) {
      return;
    }

    cancelOpeningFocusHandoff();

    if (
      eventOccursWithin(event, [
        root,
        trigger,
        popoverHost,
        popover
      ])
    ) {
      return;
    }

    closePopover(false);
  }

  function handlePopoverKeydown(event) {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closePopover(true);
  }

  function openPopover() {
    if (!root || !trigger || popover) {
      return;
    }

    cancelReturnFocusHandoff();

    popoverHost =
      document.createElement("div");
    popoverHost.setAttribute(
      POPOVER_HOST_ATTRIBUTE,
      ""
    );
    applyImportantStyles(
      popoverHost,
      POPOVER_HOST_STYLES
    );

    popoverShadow =
      popoverHost.attachShadow({
        mode: "open"
      });
    adoptShadowStyles(
      popoverShadow,
      POPOVER_SHADOW_STYLES
    );

    popover = document.createElement("div");
    popoverRenderSignature = null;
    popover.id = POPOVER_ID;
    popover.className = "pe-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute(
      "aria-modal",
      "false"
    );
    popover.setAttribute(
      "aria-label",
      "Pro effort"
    );
    popover.addEventListener(
      "keydown",
      handlePopoverKeydown
    );

    if (modelControl) {
      applyNativeTokens(
        popoverHost,
        modelControl
      );
    }

    popoverShadow.append(popover);
    document.body.append(popoverHost);

    trigger.setAttribute(
      "aria-expanded",
      "true"
    );

    renderPopoverContents();
    positionPopover();

    document.addEventListener(
      "pointerdown",
      handleOutsidePointer,
      true
    );
    window.addEventListener(
      "resize",
      positionPopover,
      true
    );
    window.addEventListener(
      "scroll",
      positionPopover,
      true
    );

    startPopoverTracking();
    beginOpeningFocusHandoff();
  }

  function showToast(
    message,
    announce = true
  ) {
    document
      .querySelector(`[${TOAST_ATTRIBUTE}]`)
      ?.remove();

    if (toastTimer !== null) {
      clearTimeout(toastTimer);
    }

    const toast = document.createElement("div");
    toast.className = "pe-toast";
    toast.setAttribute(
      TOAST_ATTRIBUTE,
      ""
    );

    if (
      announce ||
      !alertLiveRegion?.isConnected
    ) {
      toast.setAttribute("role", "alert");
      toast.setAttribute(
        "aria-atomic",
        "true"
      );
    }

    toast.textContent = message;

    document.body.append(toast);

    toastTimer = window.setTimeout(() => {
      toast.remove();
      toastTimer = null;
    }, 7000);
  }

  function sameRouteLocation(left, right) {
    return (
      sameChatRoute(left, right) &&
      left?.pathname === right?.pathname
    );
  }

  function conversationRouteForPageRoute(
    route
  ) {
    return conversationRouteForDraftLifecycle({
      route,
      binding: draftBinding,
      sourceRoute:
        draftAdoption?.sourceRoute ??
        null,
      targetRoute:
        draftAdoption?.targetRoute ??
        null,
      navigationDisqualified:
        draftAdoption
          ?.navigationDisqualified ===
        true
    });
  }

  function routeBelongsToDraftAdoption(
    route,
    adoption = draftAdoption
  ) {
    return (
      adoption !== null &&
      routeContinuesDraftLifecycle(
        adoption.sourceRoute,
        route
      )
    );
  }

  function routeMatchesOperation(
    route,
    operationRoute
  ) {
    return (
      sameRouteLocation(
        route,
        operationRoute
      ) ||
      isProvisionalDraftTransition(
        operationRoute,
        route
      )
    );
  }

  function getExtendedReadyMessage() {
    if (
      conversationRouteForPageRoute(
        activeRoute
      )
    ) {
      return (
        "Extended mode is active for this chat. " +
        "Each normal Pro composer submission uses a fresh one-shot gate."
      );
    }

    return (
      "Extended mode is active for this new chat. " +
      "Its first successful normal Pro composer submission will bind Extended to the created chat."
    );
  }

  function setNeutralModeView() {
    rememberRetiredGeneration(
      currentGenerationId
    );
    currentGenerationId = null;

    if (preference === EXTENDED) {
      setViewState({
        kind: "ready",
        label: "Extended",
        message:
          getExtendedReadyMessage()
      });
      return;
    }

    setViewState({
      kind: "standard",
      label: "Standard",
      message:
        conversationRouteForPageRoute(
          activeRoute
        )
          ? "ChatGPT requests in this chat are left untouched."
          : "New-chat requests are left untouched."
    });
  }

  function rememberRetiredGeneration(
    generationId
  ) {
    if (
      typeof generationId !== "string" ||
      generationId.length === 0
    ) {
      return;
    }

    retiredGenerationIds.add(
      generationId
    );

    while (
      retiredGenerationIds.size > 32
    ) {
      const oldest =
        retiredGenerationIds
          .values()
          .next().value;

      retiredGenerationIds.delete(
        oldest
      );
    }
  }

  function isTerminalStatusPhase(phase) {
    return [
      "sent",
      "warning",
      "failed"
    ].includes(phase);
  }

  function clearDraftAdoption(
    generationId = null
  ) {
    if (!draftAdoption) {
      return;
    }

    if (
      generationId &&
      draftAdoption.generationId &&
      draftAdoption.generationId !==
        generationId
    ) {
      return;
    }

    if (
      draftAdoption.expiryTimer !==
        null
    ) {
      window.clearTimeout(
        draftAdoption.expiryTimer
      );
    }

    if (
      draftAdoption
        .requiresStatusConfirmation ===
      true
    ) {
      clearPendingDraftAdoption();
    }

    draftAdoption = null;
  }

  function clearPendingDraftAdoption() {
    if (
      pendingDraftStorageExpiryTimer !==
      null
    ) {
      window.clearTimeout(
        pendingDraftStorageExpiryTimer
      );
      pendingDraftStorageExpiryTimer =
        null;
    }

    pendingDraftAdoptionRecord =
      clearPendingDraftAdoptionFromSessionStorage(
        draftSessionStorage
      );
  }

  function schedulePendingDraftStorageExpiry(
    record
  ) {
    if (
      pendingDraftStorageExpiryTimer !==
      null
    ) {
      window.clearTimeout(
        pendingDraftStorageExpiryTimer
      );
      pendingDraftStorageExpiryTimer =
        null;
    }

    if (
      !record ||
      !Number.isFinite(record.createdAt) ||
      typeof record.generationId !==
        "string"
    ) {
      return;
    }

    const generationId =
      record.generationId;
    const delay = Math.max(
      0,
      record.createdAt +
        PENDING_DRAFT_MAX_AGE_MS -
        Date.now()
    );

    pendingDraftStorageExpiryTimer =
      window.setTimeout(() => {
        pendingDraftStorageExpiryTimer =
          null;

        if (
          pendingDraftAdoptionRecord
            ?.generationId ===
          generationId
        ) {
          clearPendingDraftAdoption();
        }
      }, delay);
  }

  function persistPendingDraftAdoption(
    adoption = draftAdoption
  ) {
    if (
      !adoption ||
      adoption
        .requiresStatusConfirmation !==
        true ||
      adoption.replayStarted !== true ||
      adoption.navigationDisqualified ||
      typeof adoption.generationId !==
        "string"
    ) {
      return null;
    }

    pendingDraftAdoptionRecord =
      persistPendingDraftAdoptionToSessionStorage(
        draftSessionStorage,
        {
          sourceRoute:
            adoption.sourceRoute,
          temporaryRoute:
            adoption.temporaryRoute,
          targetRoute:
            adoption.targetRoute,
          generationId:
            adoption.generationId,
          draftMode:
            adoption.draftMode,
          createdAt:
            adoption.createdAt,
          preexistingConversationKeys: [
            ...adoption
              .preexistingConversationKeys
          ]
        }
      );

    schedulePendingDraftStorageExpiry(
      pendingDraftAdoptionRecord
    );

    return pendingDraftAdoptionRecord;
  }

  function updatePendingDraftMode(value) {
    const pending =
      pendingDraftAdoptionRecord;

    if (!pending) {
      return;
    }

    pendingDraftAdoptionRecord =
      persistPendingDraftAdoptionToSessionStorage(
        draftSessionStorage,
        {
          sourceRoute:
            parseChatRoute(
              `https://chatgpt.com${pending.sourcePath}`
            ),
          temporaryRoute:
            typeof pending.temporaryPath ===
              "string"
              ? parseChatRoute(
                  `https://chatgpt.com${pending.temporaryPath}`
                )
              : null,
          targetRoute:
            typeof pending
              .targetConversationId ===
              "string"
              ? parseChatRoute(
                  `https://chatgpt.com/c/${pending.targetConversationId}`
                )
              : null,
          generationId:
            pending.generationId,
          draftMode:
            normalizeMode(value),
          createdAt:
            pending.createdAt,
          preexistingConversationKeys:
            pending
              .preexistingConversationKeys
        }
      );

    schedulePendingDraftStorageExpiry(
      pendingDraftAdoptionRecord
    );
  }

  function collectKnownConversationRoutes(
    activeOnly = false
  ) {
    const routes = new Map();

    for (const anchor of document.querySelectorAll(
      "a[href]"
    )) {
      if (!(anchor instanceof HTMLAnchorElement)) {
        continue;
      }

      if (
        activeOnly &&
        !anchor.hasAttribute(
          "data-active"
        ) &&
        !["page", "true"].includes(
          anchor.getAttribute(
            "aria-current"
          )
        )
      ) {
        continue;
      }

      const route = parseChatRoute(
        anchor.href
      );

      if (
        route.kind === "conversation" &&
        typeof route.storageKey ===
          "string"
      ) {
        routes.set(
          route.storageKey,
          route
        );
      }
    }

    return routes;
  }

  function collectKnownConversationStorageKeys() {
    return new Set(
      collectKnownConversationRoutes().keys()
    );
  }

  function persistDraftPreference(value) {
    draftPreference =
      persistDraftModeToSessionStorage(
        draftSessionStorage,
        value
      );

    return draftPreference;
  }

  function resetDraftPreference() {
    draftPreference =
      clearDraftModeFromSessionStorage(
        draftSessionStorage
      );
  }

  function resetDraftBinding() {
    draftBinding = null;
  }

  function beginDraftSendTracking({
    draftMode,
    replayStarted,
    requiresStatusConfirmation
  }) {
    if (
      activeRoute.kind !== "draft" ||
      conversationRouteForPageRoute(
        activeRoute
      )
    ) {
      return null;
    }

    const now = Date.now();

    if (
      draftAdoption &&
      routeBelongsToDraftAdoption(
        activeRoute
      ) &&
      !draftAdoption.adopted &&
      !draftAdoption.navigationDisqualified &&
      now - draftAdoption.createdAt <
        1000
    ) {
      draftAdoption.draftMode =
        normalizeMode(draftMode);
      draftAdoption.replayStarted =
        draftAdoption.replayStarted ||
        replayStarted === true;
      draftAdoption
        .requiresStatusConfirmation =
        draftAdoption
          .requiresStatusConfirmation ||
        requiresStatusConfirmation === true;

      if (
        requiresStatusConfirmation ===
          true &&
        draftAdoption.expiryTimer !==
          null
      ) {
        window.clearTimeout(
          draftAdoption.expiryTimer
        );
        draftAdoption.expiryTimer = null;
      }

      return draftAdoption;
    }

    clearDraftAdoption();

    draftAdoption = {
      sourceRoute: activeRoute,
      targetRoute: null,
      temporaryRoute:
        isTemporaryChatRoute(
          activeRoute
        )
          ? activeRoute
          : null,
      draftMode:
        normalizeMode(draftMode),
      generationId: null,
      replayStarted:
        replayStarted === true,
      sendSucceeded: false,
      requiresStatusConfirmation:
        requiresStatusConfirmation === true,
      binding: false,
      adopted: false,
      createdAt: now,
      expiryTimer: null,
      preexistingConversationKeys:
        collectKnownConversationStorageKeys(),
      navigationDisqualified: false
    };

    if (
      requiresStatusConfirmation !==
        true
    ) {
      const adoption = draftAdoption;

      adoption.expiryTimer =
        window.setTimeout(() => {
          if (
            draftAdoption === adoption
          ) {
            clearDraftAdoption();
          }
        }, 15000);
    }

    return draftAdoption;
  }

  function discoverDraftAdoptionTarget() {
    const adoption = draftAdoption;

    if (
      !adoption ||
      adoption.targetRoute ||
      adoption.binding ||
      adoption.adopted ||
      adoption.navigationDisqualified ||
      !routeBelongsToDraftAdoption(
        activeRoute,
        adoption
      )
    ) {
      return;
    }

    const createdRoutes = [
      ...collectKnownConversationRoutes(
        true
      )
        .entries()
    ].filter(
      ([storageKey]) =>
        !adoption
          .preexistingConversationKeys
          .has(storageKey)
    );

    if (createdRoutes.length === 0) {
      return;
    }

    if (createdRoutes.length !== 1) {
      adoption.navigationDisqualified =
        true;
      return;
    }

    const [, targetRoute] =
      createdRoutes[0];

    adoption.targetRoute =
      targetRoute;
    adoption.temporaryRoute =
      isTemporaryChatRoute(activeRoute)
        ? activeRoute
        : adoption.temporaryRoute;

    if (
      adoption
        .requiresStatusConfirmation !==
      true
    ) {
      adoption.sendSucceeded = true;
    }

    persistPendingDraftAdoption(
      adoption
    );
    void authorizeDraftCanonicalPromotion(
      adoption
    );
    void maybeAdoptDraftMode();
  }

  async function authorizeDraftCanonicalPromotion(
    adoption
  ) {
    if (
      !adoption ||
      draftAdoption !== adoption ||
      adoption.navigationDisqualified ||
      typeof adoption.generationId !==
        "string" ||
      adoption.generationId.length === 0 ||
      adoption.targetRoute?.kind !==
        "conversation"
    ) {
      return false;
    }

    try {
      const response = await runtimeSend({
        type:
          "authorizeCanonicalPromotion",
        generationId:
          adoption.generationId,
        targetPath:
          adoption.targetRoute.pathname
      });

      return response?.ok === true;
    } catch {
      return false;
    }
  }

  function trackPassingDraftSend() {
    return beginDraftSendTracking({
      /*
       * A pass-through send is Standard at capture time. If the user selects
       * Extended before ChatGPT assigns the new canonical route, the current
       * draft adoption record is updated by selectPreference().
       */
      draftMode: STANDARD,
      replayStarted: true,
      requiresStatusConfirmation: false
    });
  }

  function markDraftAdoptionNavigation(
    event
  ) {
    if (!(event.target instanceof Element)) {
      return;
    }

    const anchor =
      event.target.closest("a[href]");

    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }

    const route = parseChatRoute(
      anchor.href
    );

    if (route.kind === "conversation") {
      if (draftAdoption) {
        draftAdoption.navigationDisqualified =
          true;
      }
      clearPendingDraftAdoption();
    }
  }

  function completeAdoptedDraftBinding(
    adoption
  ) {
    if (
      draftAdoption !== adoption ||
      !adoption.adopted ||
      !adoption.targetRoute
    ) {
      return false;
    }

    const boundMode =
      normalizeMode(
        adoption.boundMode ??
        adoption.draftMode
      );
    const activeConversationRoute =
      conversationRouteForPageRoute(
        activeRoute
      );

    if (
      isTemporaryChatRoute(activeRoute) &&
      routeBelongsToDraftAdoption(
        activeRoute,
        adoption
      )
    ) {
      draftBinding =
        adoption.persistedBinding ??
        persistDraftBindingToSessionStorage(
          draftSessionStorage,
          activeRoute,
          adoption.targetRoute
        );
      persistDraftPreference(boundMode);
    } else if (
      activeRoute.kind ===
        "conversation" &&
      activeConversationRoute
        ?.storageKey ===
        adoption.targetRoute.storageKey
    ) {
      resetDraftPreference();
    } else {
      return false;
    }

    clearDraftAdoption();
    preference = boundMode;
    modeRevision += 1;
    routeLoaded = true;
    renderUi();
    scheduleScan();
    return true;
  }

  async function maybeAdoptDraftMode() {
    const adoption = draftAdoption;

    if (
      !adoption ||
      adoption.binding ||
      !adoption.targetRoute ||
      !shouldBindDraftConversation({
        fromRoute: adoption.sourceRoute,
        toRoute: adoption.targetRoute,
        activeDraftSend:
          adoption.replayStarted,
        sendSucceeded:
          adoption.sendSucceeded,
        alreadyAdopted:
          adoption.adopted,
        targetWasPreexisting:
          adoption.preexistingConversationKeys.has(
            adoption.targetRoute.storageKey
          ),
        navigationDisqualified:
          adoption.navigationDisqualified
      })
    ) {
      return;
    }

    adoption.binding = true;
    adoption.temporaryRoute =
      isTemporaryChatRoute(activeRoute) &&
      routeBelongsToDraftAdoption(
        activeRoute,
        adoption
      )
        ? activeRoute
        : adoption.temporaryRoute;

    if (
      adoption.temporaryRoute &&
      adoption.targetRoute
    ) {
      /*
       * Publish the exact WEB-to-canonical binding before the queued mode
       * write. A Back traversal during that write can then reload the binding,
       * and any newer selection writes to the same canonical key instead of
       * becoming a disconnected draft preference.
       */
      adoption.persistedBinding =
        persistDraftBindingToSessionStorage(
          draftSessionStorage,
          adoption.temporaryRoute,
          adoption.targetRoute
        );

      if (
        isTemporaryChatRoute(
          activeRoute
        ) &&
        activeRoute.pathname ===
          adoption.temporaryRoute
            .pathname
      ) {
        draftBinding =
          adoption.persistedBinding;
      }
    }

    let boundMode;

    try {
      boundMode =
        await drainLatestModeWrite(
          () => adoption.draftMode,
          (mode) =>
            enqueueModeWrite(
              adoption.targetRoute
                .storageKey,
              mode
            )
        );
    } catch {
      adoption.binding = false;

      if (draftAdoption === adoption) {
        showToast(
          "The selected mode could not be bound persistently to the new chat."
        );
      }
      return;
    }

    adoption.binding = false;
    adoption.adopted = true;
    adoption.boundMode = boundMode;

    if (
      draftAdoption !== adoption ||
      adoption.navigationDisqualified
    ) {
      return;
    }

    if (
      !completeAdoptedDraftBinding(
        adoption
      ) &&
      adoption.expiryTimer === null
    ) {
      adoption.expiryTimer =
        window.setTimeout(() => {
          if (
            draftAdoption === adoption
          ) {
            clearDraftAdoption();
          }
        }, 30000);
    }
  }

  function markDraftSendSucceeded(
    generationId
  ) {
    if (
      !draftAdoption ||
      !draftAdoption.replayStarted ||
      typeof generationId !== "string" ||
      generationId.length === 0 ||
      draftAdoption.generationId !==
        generationId
    ) {
      return;
    }

    draftAdoption.sendSucceeded = true;
    persistPendingDraftAdoption(
      draftAdoption
    );
    void authorizeDraftCanonicalPromotion(
      draftAdoption
    );
    void maybeAdoptDraftMode();
  }

  async function refreshConversationMode(
    expectedRoute,
    expectedRouteEpoch
  ) {
    const expectedModeRevision =
      modeRevision;
    let nextPreference;

    try {
      nextPreference =
        await storageGetMode(
          expectedRoute.storageKey
        );
    } catch {
      if (
        expectedRouteEpoch ===
          routeEpoch &&
        expectedModeRevision ===
          modeRevision &&
        sameRouteLocation(
          activeRoute,
          expectedRoute
        )
      ) {
        routeLoaded = false;
      }

      return;
    }

    if (
      expectedRouteEpoch !== routeEpoch ||
      expectedModeRevision !==
        modeRevision ||
      !sameRouteLocation(
        activeRoute,
        expectedRoute
      ) ||
      !sameRouteLocation(
        parseChatRoute(
          window.location.href
        ),
        expectedRoute
      )
    ) {
      return;
    }

    preference = nextPreference;
    modeRevision += 1;
    routeLoaded = true;
    renderUi();
    scheduleScan();
  }

  async function performRouteModeLoad(
    nextRoute,
    force
  ) {
    const loadSerial =
      ++routeLoadSerial;
    const previousRoute = activeRoute;

    if (
      isTemporaryChatRoute(nextRoute) &&
      !conversationRouteForBinding(
        draftBinding,
        nextRoute
      )
    ) {
      draftBinding =
        readDraftBindingFromSessionStorage(
          draftSessionStorage,
          nextRoute
        );
    }

    const routeChanged =
      !sameRouteLocation(
        previousRoute,
        nextRoute
      );
    const previousConversationRoute =
      conversationRouteForPageRoute(
        previousRoute
      );
    const preservesDraftOperation =
      routeChanged &&
      draftAdoption &&
      routeBelongsToDraftAdoption(
        previousRoute
      ) &&
      isProvisionalDraftTransition(
        previousRoute,
        nextRoute
      );
    const preservesBoundPromotion =
      routeChanged &&
      isTemporaryChatRoute(
        previousRoute
      ) &&
      previousConversationRoute &&
      nextRoute.kind ===
        "conversation" &&
      previousConversationRoute
        .storageKey ===
        nextRoute.storageKey;

    if (
      !force &&
      !routeChanged &&
      routeLoaded
    ) {
      return true;
    }

    if (preservesBoundPromotion) {
      activeRoute = nextRoute;
      resetDraftPreference();
      routeLoaded = true;
      renderUi();
      scheduleScan();

      return (
        loadSerial === routeLoadSerial &&
        sameRouteLocation(
          activeRoute,
          nextRoute
        ) &&
        sameRouteLocation(
          parseChatRoute(
            window.location.href
          ),
          nextRoute
        )
      );
    }

    if (preservesDraftOperation) {
      activeRoute = nextRoute;
      if (
        isTemporaryChatRoute(nextRoute)
      ) {
        draftAdoption.temporaryRoute =
          nextRoute;
        persistPendingDraftAdoption(
          draftAdoption
        );
      }
      preference =
        normalizeMode(draftPreference);
      routeLoaded = true;
      const bindingCompleted =
        draftAdoption?.adopted === true &&
        completeAdoptedDraftBinding(
          draftAdoption
        );

      if (bindingCompleted) {
        return (
          loadSerial ===
            routeLoadSerial &&
          sameRouteLocation(
            activeRoute,
            nextRoute
          ) &&
          sameRouteLocation(
            parseChatRoute(
              window.location.href
            ),
            nextRoute
          )
        );
      }

      renderUi();
      scheduleScan();
      discoverDraftAdoptionTarget();

      return (
        loadSerial === routeLoadSerial &&
        sameRouteLocation(
          activeRoute,
          nextRoute
        ) &&
        sameRouteLocation(
          parseChatRoute(
            window.location.href
          ),
          nextRoute
        )
      );
    }

    if (routeChanged) {
      routeEpoch += 1;
      modeRevision += 1;

      const draftSendCreatedRoute =
        draftAdoption &&
        routeBelongsToDraftAdoption(
          previousRoute
        ) &&
        draftAdoption.replayStarted ===
          true &&
        nextRoute.kind ===
          "conversation" &&
        !draftAdoption
          .preexistingConversationKeys
          .has(nextRoute.storageKey) &&
        draftAdoption
          .navigationDisqualified !==
          true;

      if (
        draftSendCreatedRoute &&
        draftAdoption
          .requiresStatusConfirmation !==
          true
      ) {
        draftAdoption.sendSucceeded =
          true;
      }

      const adoptionTransition =
        draftAdoption &&
        isDraftAdoptionTarget({
          fromRoute:
            draftAdoption.sourceRoute,
          toRoute: nextRoute,
          draftMode:
            draftAdoption.draftMode,
          activeDraftSend:
            draftAdoption.replayStarted,
          alreadyAdopted:
            draftAdoption.adopted,
          targetWasPreexisting:
            draftAdoption
              .preexistingConversationKeys
              .has(nextRoute.storageKey),
          navigationDisqualified:
            draftAdoption
              .navigationDisqualified
        }) &&
        routeBelongsToDraftAdoption(
          previousRoute
        );

      activeRoute = nextRoute;

      if (adoptionTransition) {
        draftAdoption.targetRoute =
          nextRoute;
        draftAdoption.temporaryRoute =
          isTemporaryChatRoute(
            previousRoute
          )
            ? previousRoute
            : draftAdoption
                .temporaryRoute;
        preference = EXTENDED;
        routeLoaded = true;

        persistPendingDraftAdoption(
          draftAdoption
        );
        void authorizeDraftCanonicalPromotion(
          draftAdoption
        );
        renderUi();
        scheduleScan();
        await maybeAdoptDraftMode();

        return (
          loadSerial === routeLoadSerial &&
          sameRouteLocation(
            activeRoute,
            nextRoute
          ) &&
          sameRouteLocation(
            parseChatRoute(
              window.location.href
            ),
            nextRoute
          )
        );
      }

      if (currentGenerationId) {
        rememberRetiredGeneration(
          currentGenerationId
        );
      }

      if (submissionBusy) {
        navigationInvalidatedOperation =
          true;
      }

      currentGenerationId = null;

      if (draftSendCreatedRoute) {
        resetDraftPreference();
      }

      clearDraftAdoption();

      if (
        nextRoute.kind === "draft" &&
        !conversationRouteForBinding(
          draftBinding,
          nextRoute
        ) &&
        (
          previousConversationRoute ||
          (
            previousRoute.kind ===
              "draft" &&
            previousRoute.pathname !==
              nextRoute.pathname
          )
        )
      ) {
        resetDraftPreference();
        resetDraftBinding();
      } else if (
        !isTemporaryChatRoute(nextRoute)
        &&
        nextRoute.kind !==
          "conversation"
      ) {
        resetDraftBinding();
      }

      preference =
        nextRoute.kind === "draft"
          ? draftPreference
          : STANDARD;
      routeLoaded = false;
      removeInjectedUi(false);
    } else {
      activeRoute = nextRoute;
      routeLoaded = false;
      removeInjectedUi(false);
    }

    let loadedPreference;
    const boundConversationRoute =
      conversationRouteForPageRoute(
        nextRoute
      );

    try {
      if (boundConversationRoute) {
        loadedPreference =
          await storageGetMode(
            boundConversationRoute
              .storageKey
          );
      } else {
        loadedPreference =
          normalizeMode(draftPreference);
      }
    } catch {
      if (
        loadSerial === routeLoadSerial &&
        sameRouteLocation(
          activeRoute,
          nextRoute
        ) &&
        sameRouteLocation(
          parseChatRoute(
            window.location.href
          ),
          nextRoute
        )
      ) {
        routeLoaded = false;
      }

      return false;
    }

    if (
      loadSerial !== routeLoadSerial ||
      !sameRouteLocation(
        activeRoute,
        nextRoute
      ) ||
      !sameRouteLocation(
        parseChatRoute(
          window.location.href
        ),
        nextRoute
      )
    ) {
      return false;
    }

    preference = loadedPreference;
    modeRevision += 1;
    routeLoaded = true;
    setNeutralModeView();
    scheduleScan();

    if (preference === EXTENDED) {
      await restoreBackgroundState(
        routeEpoch
      );
    }

    return true;
  }

  function loadRouteMode(
    nextRoute =
      parseChatRoute(
        window.location.href
      ),
    force = false
  ) {
    if (
      !force &&
      routeLoadPromise &&
      routeLoadTarget &&
      sameRouteLocation(
        routeLoadTarget,
        nextRoute
      )
    ) {
      return routeLoadPromise;
    }

    const promise =
      performRouteModeLoad(
        nextRoute,
        force
      );

    routeLoadTarget = nextRoute;
    routeLoadPromise = promise;

    void promise.finally(() => {
      if (routeLoadPromise === promise) {
        routeLoadPromise = null;
        routeLoadTarget = null;
      }
    });

    return promise;
  }

  function synchronizeRoute() {
    return loadRouteMode(
      parseChatRoute(
        window.location.href
      )
    );
  }

  async function selectPreference(
    value,
    restoreFocus
  ) {
    if (
      submissionBusy ||
      ![STANDARD, EXTENDED].includes(value)
    ) {
      return;
    }

    const intentSerial =
      ++selectionSerial;
    modeRevision += 1;

    const routeReady =
      await synchronizeRoute();

    if (
      intentSerial !== selectionSerial
    ) {
      return;
    }

    if (!routeReady || !routeLoaded) {
      showToast(
        "The current chat mode could not be loaded. The selection was not changed."
      );
      return;
    }

    const selectionRoute = activeRoute;
    const selectionConversationRoute =
      conversationRouteForPageRoute(
        selectionRoute
      );
    let selectionAdoption = null;

    if (selectionRoute.kind === "draft") {
      persistDraftPreference(value);
      updatePendingDraftMode(value);

      if (
        draftAdoption &&
        routeBelongsToDraftAdoption(
          selectionRoute
        ) &&
        !draftAdoption
          .navigationDisqualified
      ) {
        /*
         * Publish the target-scoped latest intent before awaiting any storage
         * callback. A detached adoption drain can then reconcile a pending
         * older write even if SPA navigation clears the global adoption.
         */
        selectionAdoption =
          draftAdoption;
        selectionAdoption.draftMode =
          value;
        persistPendingDraftAdoption(
          selectionAdoption
        );
        void maybeAdoptDraftMode();
      }
    }

    if (
      selectionConversationRoute &&
      !selectionAdoption
    ) {
      try {
        await enqueueModeWrite(
          selectionConversationRoute
            .storageKey,
          value
        );
      } catch {
        if (
          intentSerial ===
            selectionSerial
        ) {
          showToast(
            "The chat mode could not be saved. Its previous mode remains active."
          );
        }
        return;
      }
    }

    if (
      intentSerial !== selectionSerial ||
      !sameRouteLocation(
        activeRoute,
        selectionRoute
      ) ||
      !sameRouteLocation(
        parseChatRoute(
          window.location.href
        ),
        selectionRoute
      )
    ) {
      return;
    }

    preference = value;
    modeRevision += 1;
    currentGenerationId = null;
    setNeutralModeView();

    queueMicrotask(() => {
      if (restoreFocus && popover) {
        focusRadio(value);
      }
    });
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;

    window.setTimeout(() => {
      scanScheduled = false;
      scanModelAndUi();
    }, 40);
  }

  function scanModelAndUi() {
    const currentRoute =
      parseChatRoute(
        window.location.href
      );

    if (
      !routeLoaded ||
      !sameRouteLocation(
        currentRoute,
        activeRoute
      )
    ) {
      void loadRouteMode(currentRoute);
      return;
    }

    removeDuplicateRoots();

    const inspection = inspectCurrentModel();

    modelState = inspection.state;
    modelControl = inspection.control;

    if (
      modelState !== "pro" ||
      !modelControl
    ) {
      removeInjectedUi(false);
      return;
    }

    const mount = findRootMount(
      modelControl
    );

    if (!mount) {
      removeInjectedUi(false);
      return;
    }

    if (
      !root ||
      !root.isConnected ||
      !rootShadow ||
      root.shadowRoot !== rootShadow ||
      !trigger?.isConnected ||
      rootMountParent !== mount.parent ||
      rootMountReference !==
        mount.reference ||
      root.parentElement !== mount.parent ||
      root.previousElementSibling !==
        mount.reference
    ) {
      createInjectedUi(modelControl);
      return;
    }

    if (
      popover &&
      (
        !popoverHost?.isConnected ||
        !popoverShadow ||
        popoverHost.shadowRoot !==
          popoverShadow ||
        !popover.isConnected
      )
    ) {
      closePopover(false);
    }

    applyNativeTokens(root, modelControl);

    if (popover && popoverHost) {
      applyNativeTokens(
        popoverHost,
        modelControl
      );
      positionPopover();
    }

    renderUi();
  }

  function getEditableForTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    if (target.matches(EDITABLE_SELECTOR)) {
      return target;
    }

    return target.closest(
      EDITABLE_SELECTOR
    );
  }

  function buttonBelongsToComposer(
    button,
    editable
  ) {
    const form =
      button instanceof HTMLButtonElement
        ? button.form
        : button.closest("form");

    if (form && form.contains(editable)) {
      return true;
    }

    const buttonRect =
      button.getBoundingClientRect();
    const editableRect =
      editable.getBoundingClientRect();

    return (
      Math.abs(
        buttonRect.bottom -
        editableRect.bottom
      ) < 180 &&
      Math.abs(
        buttonRect.left -
        editableRect.right
      ) < 520
    );
  }

  function isSendButton(button, requireSendSemantics = false) {
    if (
      !(button instanceof Element) ||
      !button.isConnected ||
      !isVisible(button) ||
      button.closest(
        `[${ROOT_ATTRIBUTE}]`
      )
    ) {
      return false;
    }

    if (
      button.getAttribute("aria-disabled") === "true" ||
      button.matches(":disabled") ||
      button instanceof HTMLButtonElement &&
      button.disabled
    ) {
      return false;
    }

    const editable = findComposerEditable();

    if (
      !editable ||
      !buttonBelongsToComposer(
        button,
        editable
      )
    ) {
      return false;
    }

    const semantics = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.getAttribute("data-testid"),
      button.getAttribute("name"),
      getVisibleControlText(button)
    ]
      .map(normalizeText)
      .join(" ");

    if (/\b(stop|pause|cancel|abort)\b/i.test(semantics)) {
      return false;
    }

    if (/\b(send|submit)\b/i.test(semantics)) {
      return true;
    }

    return (
      !requireSendSemantics &&
      button instanceof HTMLButtonElement &&
      button.type === "submit"
    );
  }

  function findSendButton(requireSendSemantics = false) {
    const editable = findComposerEditable();

    if (!editable) {
      return null;
    }

    for (const scope of getCandidateScopes(editable)) {
      for (const candidate of scope.querySelectorAll(
        BUTTON_SELECTOR
      )) {
        if (isSendButton(candidate, requireSendSemantics)) {
          return candidate;
        }
      }
    }

    return null;
  }

  function getComposerForm() {
    return (
      findComposerEditable()?.closest("form") ??
      null
    );
  }

  function stopSubmissionEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function decideSubmissionPolicy() {
    const inspection = inspectCurrentModel();

    modelState = inspection.state;
    modelControl = inspection.control;

    return decideSubmissionForMode(
      preference,
      inspection.state
    ).policy;
  }

  function showUnknownModelBlock(
    event = null
  ) {
    if (event) {
      stopSubmissionEvent(event);
    }

    const message =
      "Extended is selected, but the extension cannot confirm the exact visible Pro model. Submission was blocked.";

    setViewState({
      kind: "error",
      label: "Extended blocked",
      message
    });

    showToast(message, false);
  }

  function createReplayDescriptor(
    kind,
    button = null,
    form = null,
    submitter = null
  ) {
    const editable = findComposerEditable();
    const inspection = inspectCurrentModel();

    // This snapshot is held only for this captured action, never persisted or
    // sent to the worker. An asynchronous arm must not send a later draft.
    return Object.freeze({
      kind,
      button,
      form,
      submitter,
      intent: Object.freeze({
        editable,
        draft: readReplayDraft(editable),
        route: parseChatRoute(window.location.href),
        composerIdentity: replayComposerIdentity(editable),
        modelLabel: inspection.state === "pro"
          ? getVisibleControlText(inspection.control)
          : null
      })
    });
  }

  function readReplayDraft(editable) {
    if (!(editable instanceof Element)) return null;
    return editable.matches("textarea")
      ? editable.value
      : typeof editable.innerText === "string"
        ? editable.innerText
        : editable.textContent;
  }

  function replayComposerIdentity(editable) {
    if (!(editable instanceof Element)) return null;
    if (editable.id === "prompt-textarea") return "prompt-textarea";
    if (editable.getAttribute("data-testid") === "prompt-textarea") return "prompt-textarea-testid";
    if (editable.hasAttribute("data-composer-markdown") && editable.closest("[data-composer-input]")) {
      return "composer-markdown";
    }
    return null;
  }

  function inspectReplayReadiness(
    descriptor,
    requirePro,
    operation = null,
    replayDeadlineAt = null
  ) {
    if (requirePro && replayDeadlineAt !== null && (
      !Number.isSafeInteger(replayDeadlineAt) || Date.now() >= replayDeadlineAt
    )) return { ok: false, reason: "authorization_expired" };

    if (operation && !operationRouteIsCurrent(operation.epoch, operation.route)) {
      return { ok: false, reason: "route_changed" };
    }
    if (operation && preference !== operation.mode) {
      return { ok: false, reason: "mode_changed" };
    }
    if (operation && !replayOperationIsCurrent(operation)) {
      return { ok: false, reason: "operation_finished" };
    }
    if (!operation && descriptor.intent && !sameRouteLocation(
      parseChatRoute(window.location.href), descriptor.intent.route
    )) return { ok: false, reason: "route_changed" };

    const intent = descriptor.intent;
    if (!intent || intent.draft === null || !intent.editable) {
      return { ok: false, reason: "composer_changed" };
    }
    const editable = findComposerEditable();
    if (!editable) return { ok: false, reason: "composer_unavailable", transient: true };
    if (editable !== intent.editable && (
      (intent.editable.isConnected && isVisible(intent.editable)) ||
      !intent.composerIdentity || replayComposerIdentity(editable) !== intent.composerIdentity
    )) return { ok: false, reason: "composer_changed" };
    if (readReplayDraft(editable) !== intent.draft) {
      return { ok: false, reason: "draft_changed" };
    }

    if (requirePro) {
      const inspection = inspectCurrentModel();
      if (inspection.state === "other") return { ok: false, reason: "model_changed" };
      if (inspection.state !== "pro") return { ok: false, reason: "model_unavailable", transient: true };
      if (!intent.modelLabel || getVisibleControlText(inspection.control) !== intent.modelLabel) {
        return { ok: false, reason: "model_changed" };
      }
    }

    const button = findSendButton(true);
    if (!button || !isSendButton(button, true)) {
      return { ok: false, reason: "send_unavailable", transient: true };
    }
    return { ok: true, button, editable };
  }

  function replayOperationIsCurrent(operation) {
    return submissionBusy && submissionSerial === operation.serial &&
      currentGenerationId === operation.generationId;
  }

  async function waitForReplayReadiness(
    descriptor,
    operation,
    budget,
    replayDeadlineAt = null
  ) {
    // Share actual UI-wait time across both acknowledgment boundaries. Worker
    // messaging latency has its own absolute deadline and does not spend this
    // readiness budget. A throttled wake-up cannot grant a late native action.
    const deadlineAt = Date.now() + budget.remainingMs;
    let lastReason = "ui_readiness_timeout";
    try {
      while (true) {
        if (Date.now() >= deadlineAt) return { ok: false, reason: lastReason };
        const readiness = inspectReplayReadiness(descriptor, true, operation, replayDeadlineAt);
        if (readiness.ok || !readiness.transient) return readiness;
        lastReason = readiness.reason;
        await new Promise(resolve => window.setTimeout(resolve, Math.min(25, deadlineAt - Date.now())));
      }
    } finally {
      budget.remainingMs = Math.max(0, deadlineAt - Date.now());
    }
  }

  function replayBlockedMessage(reason) {
    const reasons = {
      authorization_expired: "The Extended send authorization expired before the UI action could run.",
      authorization_invalid: "The request monitor did not return a valid send deadline. Reload the extension and refresh this chat after preserving your draft.",
      ui_readiness_timeout: "ChatGPT's send controls did not settle within the UI readiness window.",
      route_changed: "The chat changed while Extended was being armed.",
      mode_changed: "The selected effort changed while Extended was being armed.",
      operation_finished: "The one-shot operation ended before the UI action could run.",
      composer_changed: "The message input changed while Extended was being armed.",
      composer_unavailable: "ChatGPT's message input did not become ready after arming.",
      draft_changed: "The draft changed while Extended was being armed.",
      model_changed: "The visible Pro model changed while Extended was being armed.",
      model_unavailable: "The visible Pro model could not be confirmed after arming.",
      send_unavailable: "ChatGPT's Send button did not become ready after arming."
    };
    return `${reasons[reason] ?? "ChatGPT's send controls changed after arming."} The action was not replayed.`;
  }

  async function cancelBlockedReplay(operation, reason) {
    const generationId = operation.generationId;
    try {
      await runtimeSend({ type: "cancelArm", generationId });
    } catch {
      // Background cleanup or timeout remains conservative.
    }
    // A canceled generation's late acknowledgment must not clear or overwrite
    // a newer arm, including while the newer arm is still awaiting its ID.
    if (submissionSerial !== operation.serial || currentGenerationId !== generationId) return;
    submissionBusy = false;
    clearDraftAdoption(generationId);
    const message = replayBlockedMessage(reason);
    setViewState({ kind: "error", label: "Extended blocked", message });
    showToast(message, false);
  }

  function replayNormalUiAction(
    descriptor,
    requirePro = true,
    replayDeadlineAt = null,
    operation = null,
    onBlocked = null
  ) {
    const withinDeadline = () => !requirePro || (
      Number.isSafeInteger(replayDeadlineAt) && Date.now() < replayDeadlineAt
    );

    if (!withinDeadline()) {
      onBlocked?.(Number.isSafeInteger(replayDeadlineAt) ? "authorization_expired" : "authorization_invalid");
      return false;
    }

    const readiness = inspectReplayReadiness(descriptor, requirePro, operation, replayDeadlineAt);
    if (!readiness.ok) {
      onBlocked?.(readiness.reason);
      return false;
    }

    replayDepth += 1;

    try {
      if (!withinDeadline()) {
        onBlocked?.("authorization_expired");
        return false;
      }
      // Never replay the captured node blindly: React can reuse Send as Stop.
      // A form call without a valid Send control also cannot prove submission.
      readiness.button.click();
      return true;
    } finally {
      replayDepth -= 1;
    }
  }

  function operationRouteIsCurrent(
    operationEpoch,
    operationRoute
  ) {
    return (
      routeEpoch === operationEpoch &&
      routeMatchesOperation(
        activeRoute,
        operationRoute
      ) &&
      routeMatchesOperation(
        parseChatRoute(
          window.location.href
        ),
        operationRoute
      )
    );
  }

  async function invalidateArmedOperation(
    operation
  ) {
    const generationId = operation.generationId;
    const invalidationIsCurrent = () => submissionSerial === operation.serial && (
      currentGenerationId === generationId || currentGenerationId === null
    );
    if (!invalidationIsCurrent()) return;

    const currentRoute =
      parseChatRoute(
        window.location.href
      );

    if (
      !sameRouteLocation(
        activeRoute,
        currentRoute
      )
    ) {
      await loadRouteMode(currentRoute);
    }

    if (!invalidationIsCurrent()) return;

    rememberRetiredGeneration(
      generationId
    );
    currentGenerationId = null;
    clearDraftAdoption(generationId);

    try {
      await runtimeSend({
        type: "cancelArm",
        generationId
      });
    } catch {
      // The tab remains blocked until conservative status cleanup arrives.
    }

    if (!invalidationIsCurrent()) return;

    await loadRouteMode(
      parseChatRoute(
        window.location.href
      ),
      true
    );
  }

  async function gateAndReplay(descriptor) {
    if (submissionBusy) {
      return;
    }

    const operationEpoch = routeEpoch;
    const operationRoute = activeRoute;
    const operationSerial = ++submissionSerial;

    if (
      operationRoute.kind === "draft" &&
      !conversationRouteForPageRoute(
        operationRoute
      ) &&
      preference === EXTENDED
    ) {
      beginDraftSendTracking({
        draftMode: EXTENDED,
        replayStarted: false,
        requiresStatusConfirmation: true
      });
    }

    submissionBusy = true;

    setViewState({
      kind: "arming",
      label: "Arming",
      message:
        "Attaching Chrome's fresh one-shot debugger gate for this Extended-mode submission."
    });

    let armResponse;

    try {
      armResponse = await runtimeSend({
        type: "armExtended"
      });
    } catch {
      armResponse = {
        ok: false,
        message:
          "The extension service worker could not arm the one-shot gate."
      };
    }

    if (submissionSerial !== operationSerial) return;

    if (!armResponse?.ok) {
      submissionBusy = false;
      navigationInvalidatedOperation =
        false;
      clearDraftAdoption();

      if (
        !operationRouteIsCurrent(
          operationEpoch,
          operationRoute
        )
      ) {
        await loadRouteMode(
          parseChatRoute(
            window.location.href
          ),
          true
        );
        return;
      }

      const message =
        armResponse?.message ??
        "Extended could not be armed.";

      setViewState({
        kind: "error",
        label: "Extended blocked",
        message
      });

      showToast(message, false);
      return;
    }

    if (!submissionBusy) return;

    currentGenerationId =
      armResponse.generationId;

    const operation = Object.freeze({
      epoch: operationEpoch,
      route: operationRoute,
      mode: EXTENDED,
      generationId: armResponse.generationId,
      serial: operationSerial
    });
    if (!replayOperationIsCurrent(operation)) return;

    if (draftAdoption) {
      draftAdoption.generationId =
        currentGenerationId;
    }

    if (
      !operationRouteIsCurrent(
        operationEpoch,
        operationRoute
      )
    ) {
      await invalidateArmedOperation(
        operation
      );
      return;
    }

    let confirmation;

    try {
      confirmation = await runtimeSend({
        type: "confirmArmed",
        generationId: operation.generationId
      });
    } catch {
      confirmation = {
        ok: false,
        message:
          "The one-shot gate could not be confirmed immediately before replay."
      };
    }

    if (!replayOperationIsCurrent(operation)) return;

    if (
      !operationRouteIsCurrent(
        operationEpoch,
        operationRoute
      )
    ) {
      await invalidateArmedOperation(
        operation
      );
      return;
    }

    if (!confirmation?.ok) {
      try {
        await runtimeSend({
          type: "cancelArm",
          generationId: operation.generationId
        });
      } catch {
        // Background cleanup or timeout remains conservative.
      }

      if (submissionSerial !== operation.serial || currentGenerationId !== operation.generationId) return;
      submissionBusy = false;
      clearDraftAdoption(
        currentGenerationId
      );

      const message =
        confirmation?.message ??
        "The one-shot arm was no longer current.";

      setViewState({
        kind: "error",
        label: "Extended blocked",
        message
      });

      showToast(message, false);
      return;
    }

    const readinessBudget = { remainingMs: 1500 };
    const readiness = await waitForReplayReadiness(descriptor, operation, readinessBudget);
    if (!readiness.ok) {
      if (readiness.reason === "route_changed") {
        await invalidateArmedOperation(operation);
      } else {
        await cancelBlockedReplay(operation, readiness.reason);
      }
      return;
    }

    let replayStart;

    try {
      replayStart = await runtimeSend({
        type: "markReplayStarting",
        generationId: operation.generationId
      });
    } catch {
      replayStart = {
        ok: false,
        message:
          "The one-shot replay could not be marked current immediately before the UI action."
      };
    }

    if (!replayOperationIsCurrent(operation)) return;

    if (
      !operationRouteIsCurrent(
        operationEpoch,
        operationRoute
      )
    ) {
      await invalidateArmedOperation(
        operation
      );
      return;
    }

    if (replayStart?.ok && !Number.isSafeInteger(replayStart.replayDeadlineAt)) {
      replayStart = { ok: false, message: replayBlockedMessage("authorization_invalid") };
    } else if (replayStart?.ok && Date.now() >= replayStart.replayDeadlineAt) {
      replayStart = {
        ok: false,
        message: "The Extended send authorization expired before the UI action could run. The action was not replayed."
      };
    }

    if (!replayStart?.ok) {
      try {
        await runtimeSend({
          type: "cancelArm",
          generationId: operation.generationId
        });
      } catch {
        // Background cleanup or timeout remains conservative.
      }

      if (submissionSerial !== operation.serial || currentGenerationId !== operation.generationId) return;
      submissionBusy = false;
      clearDraftAdoption(
        currentGenerationId
      );

      const message =
        replayStart?.message ??
        "The one-shot replay was no longer current.";

      setViewState({
        kind: "error",
        label: "Extended blocked",
        message
      });

      showToast(message, false);
      return;
    }

    const finalReadiness = await waitForReplayReadiness(
      descriptor,
      operation,
      readinessBudget,
      replayStart.replayDeadlineAt
    );
    if (!finalReadiness.ok) {
      if (finalReadiness.reason === "route_changed") {
        await invalidateArmedOperation(operation);
      } else {
        await cancelBlockedReplay(operation, finalReadiness.reason);
      }
      return;
    }

    if (
      draftAdoption &&
      routeBelongsToDraftAdoption(
        operationRoute
      )
    ) {
      draftAdoption.replayStarted =
        true;
      persistPendingDraftAdoption(
        draftAdoption
      );
    }

    let replayBlockReason = null;
    const replayed = replayNormalUiAction(
      descriptor,
      true,
      replayStart.replayDeadlineAt,
      operation,
      reason => { replayBlockReason = reason; }
    );

    if (replayed) {
      /*
       * The background service worker owns the bounded capture deadline. The busy
       * state is released by a sent, warning, uncertain, or failed status.
       */
      return;
    }

    await cancelBlockedReplay(operation, replayBlockReason);
  }

  async function resumeCapturedSubmission(
    descriptor,
    expectedRoute
  ) {
    const loaded =
      await loadRouteMode(
        expectedRoute
      );

    if (
      !loaded ||
      !routeLoaded ||
      !sameRouteLocation(
        activeRoute,
        expectedRoute
      ) ||
      !sameRouteLocation(
        parseChatRoute(
          window.location.href
        ),
        expectedRoute
      )
    ) {
      showToast(
        "The chat changed or its mode could not be loaded. Submission was blocked."
      );
      return;
    }

    if (submissionBusy) {
      showToast(
        "A prior Extended operation is still being resolved. Submission was blocked."
      );
      return;
    }

    const policy = decideSubmissionPolicy();

    if (policy === "block_unknown") {
      showUnknownModelBlock();
      return;
    }

    if (policy === "gate") {
      void gateAndReplay(descriptor);
      return;
    }

    const trackedDraftAdoption =
      trackPassingDraftSend();

    if (
      !replayNormalUiAction(
        descriptor,
        false
      )
    ) {
      if (
        draftAdoption ===
          trackedDraftAdoption
      ) {
        clearDraftAdoption();
      }

      showToast(
        "ChatGPT's normal submission action could not be replayed after loading this chat's mode."
      );
    }
  }

  function handleCapturedSend(
    event,
    descriptor
  ) {
    if (replayDepth > 0) {
      return;
    }

    if (submissionBusy) {
      stopSubmissionEvent(event);
      return;
    }

    const currentRoute =
      parseChatRoute(
        window.location.href
      );

    if (
      !routeLoaded ||
      !sameRouteLocation(
        activeRoute,
        currentRoute
      )
    ) {
      stopSubmissionEvent(event);

      void resumeCapturedSubmission(
        descriptor,
        currentRoute
      );
      return;
    }

    const policy = decideSubmissionPolicy();

    if (policy === "pass") {
      trackPassingDraftSend();
      return;
    }

    if (policy === "block_unknown") {
      showUnknownModelBlock(event);
      return;
    }

    stopSubmissionEvent(event);
    void gateAndReplay(descriptor);
  }

  function handleDocumentClick(event) {
    if (replayDepth > 0) {
      return;
    }

    const button =
      event.target instanceof Element
        ? event.target.closest(
            BUTTON_SELECTOR
          )
        : null;

    if (!button || !isSendButton(button)) {
      return;
    }

    handleCapturedSend(
      event,
      createReplayDescriptor(
        "click",
        button,
        button.closest("form"),
        button instanceof HTMLButtonElement
          ? button
          : null
      )
    );
  }

  function handleDocumentKeydown(event) {
    if (
      popover &&
      event.key === "Escape"
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closePopover(true);
      return;
    }

    if (popover) {
      cancelOpeningFocusHandoff();
    }

    if (
      replayDepth > 0 ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.isComposing
    ) {
      return;
    }

    const editable =
      getEditableForTarget(event.target);

    if (
      !editable ||
      editable !== findComposerEditable()
    ) {
      return;
    }

    handleCapturedSend(
      event,
      createReplayDescriptor(
        "keyboard",
        null,
        editable.closest("form"),
        null
      )
    );
  }

  function handleDocumentSubmit(event) {
    if (
      replayDepth > 0 ||
      !(event.target instanceof HTMLFormElement)
    ) {
      return;
    }

    const editable = findComposerEditable();

    if (
      !editable ||
      !event.target.contains(editable)
    ) {
      return;
    }

    handleCapturedSend(
      event,
      createReplayDescriptor(
        "submit",
        null,
        event.target,
        event.submitter instanceof
          HTMLButtonElement
          ? event.submitter
          : null
      )
    );
  }

  function applyStatusMessage(message) {
    if (
      !message ||
      message.source !== MESSAGE_SOURCE ||
      message.type !== "status"
    ) {
      return;
    }

    const generationId =
      typeof message.generationId ===
      "string"
        ? message.generationId
        : null;

    if (
      navigationInvalidatedOperation
    ) {
      rememberRetiredGeneration(
        generationId
      );

      if (
        isTerminalStatusPhase(
          message.phase
        )
      ) {
        submissionBusy = false;
        navigationInvalidatedOperation =
          false;

        if (routeLoaded) {
          setNeutralModeView();
          scheduleScan();
        }
      }

      return;
    }

    if (
      generationId &&
      retiredGenerationIds.has(
        generationId
      )
    ) {
      return;
    }

    if (
      currentGenerationId &&
      message.generationId &&
      currentGenerationId !==
        message.generationId
    ) {
      return;
    }

    if (message.generationId) {
      currentGenerationId =
        message.generationId;
    }

    if (message.phase === "arming") {
      submissionBusy = true;

      setViewState({
        kind: "arming",
        label: message.label ?? "Arming",
        message:
          message.message ??
          "Waiting for one fresh Pro conversation POST."
      });
      return;
    }

    if (message.phase === "sent") {
      markDraftSendSucceeded(
        generationId
      );
    }

    if (message.phase === "sent") {
      submissionBusy = false;

      setViewState({
        kind: "sent",
        label:
          message.label ??
          "Sent as Extended",
        message:
          message.message ??
          "The fresh paused request was continued as Extended."
      });
      return;
    }

    if (message.phase === "warning") {
      markDraftSendSucceeded(
        generationId
      );
    }

    if (message.phase === "warning") {
      submissionBusy = false;

      setViewState({
        kind: "warning",
        label:
          message.label ??
          "Sent as Extended; warning",
        message:
          message.message ??
          "The send completed with a debugger cleanup warning."
      });

      showToast(
        viewState.message,
        false
      );
      return;
    }

    if (message.phase === "failed") {
      const failedAdoptionRoute =
        draftAdoption?.targetRoute &&
        sameRouteLocation(
          activeRoute,
          draftAdoption.targetRoute
        )
          ? draftAdoption.targetRoute
          : null;
      const failedAdoptionEpoch =
        routeEpoch;

      clearDraftAdoption(
        generationId
      );

      submissionBusy = false;

      setViewState({
        kind: "error",
        label:
          message.label ??
          "Extended blocked",
        message:
          message.message ??
          "The Extended operation failed closed."
      });

      showToast(
        viewState.message,
        false
      );

      if (failedAdoptionRoute) {
        void refreshConversationMode(
          failedAdoptionRoute,
          failedAdoptionEpoch
        );
      }
    }
  }

  async function restorePendingDraftAdoption() {
    let pending =
      pendingDraftAdoptionRecord;

    if (!pending || draftAdoption) {
      return false;
    }

    let response = null;

    for (
      let attempt = 0;
      attempt < 30;
      attempt += 1
    ) {
      const currentPending =
        readPendingDraftAdoptionFromSessionStorage(
          draftSessionStorage,
          parseChatRoute(
            window.location.href
          )
        );

      if (
        !currentPending ||
        currentPending.generationId !==
          pending.generationId
      ) {
        return false;
      }

      pendingDraftAdoptionRecord =
        currentPending;
      pending = currentPending;

      try {
        response = await runtimeSend({
          type: "getState"
        });
      } catch {
        response = null;
      }

      if (
        shouldRestorePendingDraftAdoption(
          pending,
          response
        )
      ) {
        break;
      }

      if (
        response?.ok === true &&
        typeof response.generationId ===
          "string" &&
        response.generationId !==
          pending.generationId
      ) {
        clearPendingDraftAdoption();
        return false;
      }

      if (
        response?.generationId ===
          pending.generationId &&
        [
          "failed",
          "uncertain"
        ].includes(response.phase)
      ) {
        clearPendingDraftAdoption();
        return false;
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, 100);
      });
    }

    if (
      !shouldRestorePendingDraftAdoption(
        pending,
        response
      ) ||
      readPendingDraftAdoptionFromSessionStorage(
        draftSessionStorage,
        parseChatRoute(
          window.location.href
        )
      )?.generationId !==
        pending.generationId
    ) {
      clearPendingDraftAdoption();
      return false;
    }

    const sourceRoute =
      parseChatRoute(
        `https://chatgpt.com${pending.sourcePath}`
      );
    const temporaryRoute =
      typeof pending.temporaryPath ===
        "string"
        ? parseChatRoute(
            `https://chatgpt.com${pending.temporaryPath}`
          )
        : (
            isTemporaryChatRoute(
              activeRoute
            )
              ? activeRoute
              : null
          );
    const preexistingConversationKeys =
      new Set(
        pending
          .preexistingConversationKeys
      );
    let targetRoute =
      typeof pending.targetConversationId ===
        "string"
        ? parseChatRoute(
            `https://chatgpt.com/c/${pending.targetConversationId}`
          )
        : null;

    if (
      targetRoute?.kind !==
        "conversation"
    ) {
      targetRoute = null;
    }

    if (
      targetRoute &&
      preexistingConversationKeys.has(
        targetRoute.storageKey
      )
    ) {
      clearPendingDraftAdoption();
      return false;
    }

    const adoption = {
      sourceRoute,
      targetRoute,
      temporaryRoute,
      draftMode:
        normalizeMode(
          pending.draftMode
        ),
      generationId:
        pending.generationId,
      replayStarted: true,
      sendSucceeded: true,
      requiresStatusConfirmation: true,
      binding: false,
      adopted: false,
      createdAt:
        pending.createdAt,
      expiryTimer: null,
      preexistingConversationKeys,
      navigationDisqualified: false
    };

    draftAdoption = adoption;
    submissionBusy = false;

    if (activeRoute.kind === "draft") {
      persistDraftPreference(
        adoption.draftMode
      );
    }

    preference = adoption.draftMode;
    modeRevision += 1;
    routeLoaded = true;
    currentGenerationId =
      pending.generationId;
    renderUi();
    scheduleScan();

    adoption.expiryTimer =
      window.setTimeout(() => {
        if (draftAdoption === adoption) {
          clearDraftAdoption();
        }
      }, 30000);

    if (targetRoute) {
      void maybeAdoptDraftMode();
    } else {
      discoverDraftAdoptionTarget();
    }

    return true;
  }

  async function restoreBackgroundState(
    expectedRouteEpoch = routeEpoch
  ) {
    if (preference !== EXTENDED) {
      return;
    }

    const expectedRoute = activeRoute;
    const expectedModeRevision =
      modeRevision;

    let response;

    try {
      response = await runtimeSend({
        type: "getState"
      });
    } catch {
      return;
    }

    if (
      !response?.ok ||
      response.activeOperation !== true ||
      response.pagePath !==
        expectedRoute.pathname ||
      expectedRouteEpoch !== routeEpoch ||
      expectedModeRevision !==
        modeRevision ||
      preference !== EXTENDED ||
      !sameRouteLocation(
        activeRoute,
        expectedRoute
      ) ||
      !sameRouteLocation(
        parseChatRoute(
          window.location.href
        ),
        expectedRoute
      )
    ) {
      return;
    }

    currentGenerationId =
      response.generationId ?? null;

    applyStatusMessage({
      source: MESSAGE_SOURCE,
      type: "status",
      ...response
    });
  }

  function observeRouteChange() {
    const currentHref =
      window.location.href;

    if (currentHref === lastObservedHref) {
      return;
    }

    lastObservedHref = currentHref;
    void synchronizeRoute();
    scheduleScan();
  }

  function handleNavigationEntryChange(
    event
  ) {
    if (
      event?.navigationType ===
        "traverse"
    ) {
      if (draftAdoption) {
        draftAdoption
          .navigationDisqualified =
          true;
      }
      clearPendingDraftAdoption();
    }

    observeRouteChange();
  }

  function beginObservation() {
    if (observer) {
      return;
    }

    const target = document.documentElement;

    if (!target) {
      document.addEventListener(
        "DOMContentLoaded",
        beginObservation,
        { once: true }
      );
      return;
    }

    observer = new MutationObserver(() => {
      observeRouteChange();
      discoverDraftAdoptionTarget();
      scheduleScan();
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "aria-expanded",
        "aria-pressed",
        "aria-haspopup",
        "data-testid",
        "hidden"
      ]
    });

    scheduleScan();

    window.setInterval(() => {
      observeRouteChange();
      discoverDraftAdoptionTarget();
    }, 125);
  }

  document.addEventListener(
    "click",
    markDraftAdoptionNavigation,
    true
  );
  document.addEventListener(
    "click",
    handleDocumentClick,
    true
  );
  document.addEventListener(
    "keydown",
    handleDocumentKeydown,
    true
  );
  document.addEventListener(
    "submit",
    handleDocumentSubmit,
    true
  );

  chrome.runtime.onMessage.addListener(
    (message) => {
      applyStatusMessage(message);
    }
  );

  chrome.storage.onChanged.addListener(
    (changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      const currentRoute =
        parseChatRoute(
          window.location.href
        );

      if (
        !sameRouteLocation(
          activeRoute,
          currentRoute
        )
      ) {
        void loadRouteMode(currentRoute);
        return;
      }

      const storageRoute =
        conversationRouteForPageRoute(
          activeRoute
        );

      if (
        !storageRoute ||
        !storageChangeAffectsRoute(
          changes,
          storageRoute
        )
      ) {
        return;
      }

      if (!routeLoaded) {
        void loadRouteMode(
          activeRoute,
          true
        );
        return;
      }

      const nextPreference =
        normalizeMode(
          changes[
            storageRoute.storageKey
          ].newValue
        );

      if (nextPreference === preference) {
        return;
      }

      preference = nextPreference;
      modeRevision += 1;

      if (!submissionBusy) {
        setNeutralModeView();

        if (preference === EXTENDED) {
          void restoreBackgroundState(
            routeEpoch
          );
        }
      } else {
        renderUi();
      }

      scheduleScan();
    }
  );

  window.addEventListener(
    "popstate",
    () => {
      if (draftAdoption) {
        draftAdoption.navigationDisqualified =
          true;
      }
      clearPendingDraftAdoption();

      observeRouteChange();
    }
  );

  if (
    typeof window.navigation
      ?.addEventListener === "function"
  ) {
    window.navigation.addEventListener(
      "currententrychange",
      handleNavigationEntryChange
    );
  }

  void retireLegacyPreference().then(
    async () => {
      await loadRouteMode(
        parseChatRoute(
          window.location.href
        ),
        true
      );
      beginObservation();
      await restorePendingDraftAdoption();
    }
  );
})();
