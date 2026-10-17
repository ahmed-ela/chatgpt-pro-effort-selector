import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../content/content-script.js", import.meta.url), "utf8");
const constants = source.slice(source.indexOf("  const ROOT_ATTRIBUTE ="), source.indexOf("  function getDraftSessionStorage("));
const detection = source.slice(source.indexOf("  function normalizeText("), source.indexOf("  function findOpaqueBackground("));
assert.ok(constants && detection, "load the production model-detection functions");

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// Only browser layout and DOM access are stubbed. Editable selection, ancestor
// discovery, exact model labels and proximity scoring execute production code.
function fixture() {
  class Element {
    constructor(tag, bounds, attributes = {}, style = {}) {
      this.tag = tag;
      this.bounds = bounds;
      this.attributes = attributes;
      this.style = { display: "block", visibility: "visible", opacity: "1", overflowX: "visible", overflowY: "visible", ...style };
      this.children = [];
      this.parentElement = null;
      this.innerText = "";
    }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    getBoundingClientRect() { return this.bounds; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    matches(selector) {
      return selector.split(",").some(part => {
        const attributes = [...part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
        return attributes.length
          ? attributes.every(([, name, value]) => name in this.attributes && (value === undefined || this.attributes[name] === value))
          : this.tag === part;
      });
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
      ]);
    }
  }
  const body = new Element("body", rect(0, 0, 1600, 1000));
  const form = body.append(new Element("form", rect(100, 380, 900, 730)));
  // ChatGPT has display:contents wrappers with zero-size bounding rectangles.
  const wrapper = form.append(new Element("div", rect(0, 0, 0, 0), {}, { display: "contents" }));
  const outer = wrapper.append(new Element("div", rect(100, 400, 900, 709.8), {}, { overflowX: "auto", overflowY: "auto" }));
  const scroller = outer.append(new Element("div", rect(120, 415, 880, 436), {}, { overflowX: "auto", overflowY: "auto" }));
  const editable = scroller.append(new Element("div", rect(120, 415, 880, 436), { contenteditable: "true" }));
  const model = form.append(new Element("button", rect(120, 413, 200, 441), { "aria-label": "Model selector", "aria-haspopup": "menu" }));
  model.innerText = "6\nPro";
  const sandbox = { Element, document: { body, querySelectorAll: selector => body.querySelectorAll(selector) }, getComputedStyle: element => element.style };
  vm.createContext(sandbox);
  vm.runInContext(constants + detection, sandbox);
  function paste(scroll = 0) {
    scroller.bounds = rect(120, 435.5, 880, 685.5);
    editable.bounds = rect(120, 435.5 - scroll, 880, 2229.5 - scroll);
    model.bounds = rect(120, 682, 200, 710);
  }
  return { sandbox, Element, body, form, wrapper, outer, scroller, editable, model, paste };
}

test("keeps the same Pro control through a long paste, scrolling, and clearing", () => {
  const f = fixture();
  assert.equal(f.sandbox.findComposerModelControl(), f.model, "empty composer");
  for (const scroll of [0, 800, 1544]) {
    f.paste(scroll);
    assert.equal(f.sandbox.findComposerModelControl(), f.model, `1794px editor, scroll offset ${scroll}`);
    assert.equal(f.sandbox.inspectCurrentModel().state, "pro");
  }
  f.scroller.bounds = f.editable.bounds = rect(120, 415, 880, 436);
  f.model.bounds = rect(120, 413, 200, 441);
  assert.equal(f.sandbox.findComposerModelControl(), f.model, "cleared composer");
});

for (const overflow of ["auto", "scroll", "hidden", "clip"]) {
  test(`uses an ancestor with overflow ${overflow} even through non-clipping wrappers`, () => {
    const f = fixture();
    f.paste();
    f.scroller.style.overflowX = f.scroller.style.overflowY = "visible";
    f.outer.style.overflowX = f.outer.style.overflowY = overflow;
    assert.equal(f.sandbox.findComposerModelControl(), f.model);
  });
}

test("intersects nested clipping ancestors and rejects fully clipped editors", () => {
  const f = fixture();
  f.paste();
  f.scroller.bounds = rect(120, 435.5, 880, 1800);
  assert.equal(f.sandbox.findComposerModelControl(), f.model, "outer viewport still clips the tall inner scroller");
  f.editable.bounds = rect(120, 1900, 880, 2200);
  assert.equal(f.sandbox.findComposerModelControl(), null, "no visible editor remains");
});

test("retains vertical and horizontal proximity rejection for unrelated Pro controls", () => {
  const f = fixture();
  f.paste();
  const unrelated = f.body.append(new f.Element("button", rect(120, 190, 200, 218), { "aria-label": "Model selector", "aria-haspopup": "menu" }));
  unrelated.innerText = "Pro";
  assert.equal(f.sandbox.findComposerModelControl(), f.model);
  f.model.bounds = rect(120, 190, 200, 218);
  assert.equal(f.sandbox.findComposerModelControl(), null, "distant controls above the composer");
  f.model.bounds = rect(1700, 682, 1780, 710);
  assert.equal(f.sandbox.findComposerModelControl(), null, "distant control beside the composer");
});

test("does not clip the editor on an axis whose overflow remains visible", () => {
  const f = fixture();
  f.paste();
  f.outer.style.overflowX = f.scroller.style.overflowX = "clip";
  f.outer.style.overflowY = f.scroller.style.overflowY = "visible";
  assert.equal(f.sandbox.findComposerModelControl(), null, "horizontal clipping cannot erase the vertical distance");
});

test("keeps exact model-label gating after a long paste", () => {
  const f = fixture();
  f.paste();
  for (const label of ["Pro", "GPT-5.6 Pro", "6\nPro", "GPT-6 Pro"]) {
    f.model.innerText = label;
    assert.equal(f.sandbox.findComposerModelControl(), f.model, label);
  }
  for (const label of ["Thinking", "GPT-6", "GPT-6 Pro preview", "Explore Pro models"]) {
    f.model.innerText = label;
    assert.equal(f.sandbox.findComposerModelControl(), null, label);
    assert.equal(f.sandbox.inspectCurrentModel().state, "other", label);
  }
});
