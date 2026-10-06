import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const currentSource = await readFile(new URL("../../content/content-script.js", import.meta.url), "utf8");

function implementation(source, name, nextName) {
  const start = source.indexOf(`  function ${name}(`);
  const asyncStart = source.indexOf(`  async function ${name}(`);
  const from = start < 0 ? asyncStart : start;
  const until = source.indexOf(`  ${nextName}`, from);
  assert.ok(from >= 0 && until > from, name);
  return source.slice(from, until);
}

// Only the DOM and extension runtime are stubbed. The submission descriptor,
// Send classification, readiness, cancellation, replay and gate are production
// functions. Fake time makes render races and deadlines deterministic.
export function fixture({ now = 1_000, deadline = 61_000, source = currentSource } = {}) {
  const calls = { clicks: [], submits: 0, messages: [], errors: [], invalidations: [], routeLoads: [], clearedAdoptions: [] };
  const state = {
    now, deadline, model: "pro", modelLabel: "GPT-6 Pro", waits: 0, timerStep: null, timers: [], hooks: new Map(),
    route: { kind: "conversation", pathname: "/c/current" },
    editable: null, buttons: []
  };
  class Element {
    isConnected = true;
    visible = true;
    attributes = new Map();
    textContent = "";
    renderedText = null;
    get innerText() { return this.renderedText ?? this.textContent; }
    id = "";
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    hasAttribute(name) { return this.attributes.has(name); }
    matches(selector) { return selector === ":disabled" ? this.disabled === true : selector === "textarea" ? this.textarea === true : false; }
    closest(selector) { return selector === "form" || selector === "[data-composer-input]" ? form : null; }
    getBoundingClientRect() { return { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 }; }
  }
  class HTMLButtonElement extends Element {
    disabled = false;
    type = "button";
    form = null;
    click() { calls.clicks.push(this); }
  }
  class HTMLFormElement extends Element {
    contains(editable) { return editable === state.editable; }
    requestSubmit() { calls.submits += 1; }
  }
  const form = new HTMLFormElement();
  const makeEditable = (draft = "captured prompt") => {
    const editable = new Element();
    editable.id = "prompt-textarea";
    editable.textContent = draft;
    return editable;
  };
  const makeButton = (label = "Send prompt") => {
    const button = new HTMLButtonElement();
    button.form = form;
    button.setAttribute("aria-label", label);
    return button;
  };
  state.editable = makeEditable();
  const button = makeButton();
  const modelControl = new Element();
  state.buttons = [button];
  const sandbox = {
    Element, HTMLElement: Element, HTMLButtonElement, HTMLFormElement,
    Date: { now: () => state.now }, replayDepth: 0,
    ROOT_ATTRIBUTE: "data-pro-effort-selector-root", BUTTON_SELECTOR: "button,[role=button]",
    EXTENDED: "extended", preference: "extended",
    window: {
      location: { href: "https://chatgpt.com/c/current" },
      setTimeout(resolve, milliseconds) {
        Promise.resolve().then(() => {
          state.now += state.timerStep ?? milliseconds;
          state.waits += 1;
          for (const timer of state.timers) {
            if (!timer.ran && state.now >= timer.at) { timer.ran = true; timer.run(); }
          }
          resolve();
        });
      }
    },
    normalizeText: value => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "",
    isVisible: element => element.visible && element.isConnected,
    inspectCurrentModel: () => {
      modelControl.textContent = state.modelLabel;
      return { state: state.model, control: state.model === "pro" ? modelControl : null };
    },
    findComposerEditable: () => state.editable?.visible && state.editable?.isConnected ? state.editable : null,
    getCandidateScopes: () => [{ querySelectorAll: () => state.buttons }],
    getComposerForm: () => form,
    parseChatRoute: () => ({ ...state.route }),
    sameRouteLocation: (left, right) => left?.kind === right?.kind && left?.pathname === right?.pathname,
    routeMatchesOperation: (left, right) => left?.kind === right?.kind && left?.pathname === right?.pathname,
    submissionBusy: false, submissionSerial: 0, routeEpoch: 1, activeRoute: { ...state.route },
    currentGenerationId: null, draftAdoption: null, navigationInvalidatedOperation: false,
    setViewState: value => { if (value.kind === "error") calls.errors.push(value); },
    showToast() {},
    clearDraftAdoption(generationId) { calls.clearedAdoptions.push(generationId); },
    rememberRetiredGeneration(generationId) { calls.invalidations.push(generationId); },
    async loadRouteMode(route, force = false) {
      calls.routeLoads.push({ force });
      sandbox.activeRoute = { ...route };
      await state.hooks.get(force ? "forceLoadRouteMode" : "loadRouteMode")?.();
      return true;
    },
    async runtimeSend(message) {
      calls.messages.push(message.type);
      await state.hooks.get(message.type)?.(message);
      return { ok: true, generationId: "local-generation", replayDeadlineAt: state.deadline };
    }
  };
  vm.createContext(sandbox);
  for (const [name, nextName] of [
    ["getVisibleControlText", "function isExactVisibleProLabel"],
    ["buttonBelongsToComposer", "function getComposerForm"],
    ["createReplayDescriptor", "function operationRouteIsCurrent"],
    ["operationRouteIsCurrent", "async function invalidateArmedOperation"],
    ["invalidateArmedOperation", "async function gateAndReplay"],
    ["gateAndReplay", "async function resumeCapturedSubmission"]
  ]) vm.runInContext(implementation(source, name, nextName), sandbox);

  const descriptor = () => sandbox.createReplayDescriptor("click", button, form, button);
  const after = (milliseconds, run) => state.timers.push({ at: state.now + milliseconds, run, ran: false });
  const setRoute = pathname => {
    state.route = { kind: "conversation", pathname };
    sandbox.activeRoute = { ...state.route };
    sandbox.routeEpoch += 1;
    sandbox.window.location.href = `https://chatgpt.com${pathname}`;
  };
  return { sandbox, state, calls, button, form, descriptor, after, setRoute, makeButton, makeEditable };
}
