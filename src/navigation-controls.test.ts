import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { NavigationControls, navigationAction } from "./navigation-controls.ts";

test("standard mouse buttons and modifiers select orbit, pan and dolly", () => {
  assert.equal(navigationAction(0, false), "orbit");
  assert.equal(navigationAction(0, true), "pan");
  assert.equal(navigationAction(1, false), "zoom");
  assert.equal(navigationAction(2, false), "pan");
  assert.equal(navigationAction(3, false), null);
});

class Canvas extends EventTarget {
  dataset: Record<string, string> = {};
  clientHeight = 600;
  captures = new Set<number>();
  focus() {}
  setPointerCapture(id: number) {
    this.captures.add(id);
  }
  hasPointerCapture(id: number) {
    return this.captures.has(id);
  }
  releasePointerCapture(id: number) {
    this.captures.delete(id);
  }
}
function send(target: EventTarget, type: string, props = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(
    event,
    {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 100,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      deltaY: 0,
      deltaMode: 0,
    },
    props,
  );
  target.dispatchEvent(event);
  return event;
}
function setup(t: TestContext) {
  const canvas = new Canvas(),
    window = new EventTarget(),
    document = Object.assign(new EventTarget(), { hidden: false });
  for (const [key, value] of Object.entries({ window, document })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const gestures: unknown[][] = [],
    manual: boolean[] = [];
  new NavigationControls(
    canvas as unknown as HTMLElement,
    {
      drag: (...v) => gestures.push(["orbit", ...v]),
      pan: (...v) => gestures.push(["pan", ...v]),
      zoom: (...v) => gestures.push(["zoom", ...v]),
    },
    (active) => manual.push(active),
  );
  t.after(() => send(window, "blur"));
  return { canvas, window, document, gestures, manual };
}

test("drag modifiers switch gestures without re-entering manual control; other pointers are ignored", (t) => {
  const { canvas, gestures, manual } = setup(t);
  send(canvas, "pointerdown");
  send(canvas, "pointermove", { clientX: 112, clientY: 105 });
  send(canvas, "pointermove", { clientX: 118, clientY: 107, shiftKey: true });
  send(canvas, "pointermove", { pointerId: 2, clientX: 900 });
  send(canvas, "pointerup", { pointerId: 2 });
  assert.deepEqual(manual, [true]);
  assert.deepEqual(gestures, [
    ["orbit", 12, 5],
    ["pan", 6, 2],
  ]);
  assert.equal(canvas.dataset.navigation, "pan");
  send(canvas, "pointerup");
  assert.deepEqual(manual, [true, false]);
  assert.equal(canvas.hasPointerCapture(1), false);
  assert.equal(canvas.dataset.navigation, undefined);
});

test("right drag pans, middle drag dollies, and cancellation releases tracking exactly once", (t) => {
  const { canvas, gestures, manual } = setup(t);
  assert.equal(send(canvas, "contextmenu").defaultPrevented, true);
  assert.equal(
    send(canvas, "pointerdown", { button: 2 }).defaultPrevented,
    true,
  );
  send(canvas, "pointermove", { clientX: 108, clientY: 97 });
  send(canvas, "pointercancel");
  send(canvas, "lostpointercapture");
  send(canvas, "pointerdown", { button: 1 });
  send(canvas, "pointermove", { clientY: 112 });
  send(canvas, "pointerup");
  assert.deepEqual(gestures, [
    ["pan", 8, -3],
    ["zoom", 60],
  ]);
  assert.deepEqual(manual, [true, false, true, false]);
});

test("wheel deltas normalize across browsers and never release a drag early", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { canvas, gestures, manual } = setup(t);
  send(canvas, "pointerdown");
  send(canvas, "wheel", { deltaY: 2, deltaMode: 1 });
  t.mock.timers.tick(201);
  assert.deepEqual(manual, [true]);
  send(canvas, "pointerup");
  assert.deepEqual(manual, [true, false]);
  send(canvas, "wheel", { deltaY: -3, ctrlKey: true });
  t.mock.timers.tick(100);
  send(canvas, "wheel", { deltaY: 1, deltaMode: 2 });
  t.mock.timers.tick(199);
  assert.deepEqual(manual, [true, false, true]);
  t.mock.timers.tick(1);
  assert.deepEqual(manual, [true, false, true, false]);
  assert.deepEqual(gestures, [
    ["zoom", 32],
    ["zoom", -24],
    ["zoom", 600],
  ]);
});

test("wheel bursts keep control through pointer release; blur or a hidden tab cancels all gestures", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { canvas, window, document, gestures, manual } = setup(t);
  send(canvas, "wheel", { deltaY: 100 });
  send(canvas, "pointerdown");
  send(canvas, "pointerup");
  assert.deepEqual(manual, [true]);
  send(window, "blur");
  assert.deepEqual(manual, [true, false]);
  t.mock.timers.tick(500);
  send(canvas, "pointerdown");
  document.hidden = true;
  send(document, "visibilitychange");
  send(canvas, "pointermove", { clientX: 200 });
  assert.deepEqual(manual, [true, false, true, false]);
  assert.deepEqual(gestures, [["zoom", 100]]);
});
