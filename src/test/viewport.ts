/**
 * jsdom does no layout, so every element measures 0×0 and a virtualised list
 * renders no rows. `stubViewport` gives elements a fixed `offsetWidth` /
 * `offsetHeight` (what TanStack Virtual reads) for the tests that need rows.
 */

import { afterAll, beforeAll } from "vitest";

export function stubViewport(width = 800, height = 600): void {
  const proto = HTMLElement.prototype;
  const original = {
    w: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
    h: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
  };
  beforeAll(() => {
    Object.defineProperty(proto, "offsetWidth", {
      configurable: true,
      get: () => width,
    });
    Object.defineProperty(proto, "offsetHeight", {
      configurable: true,
      get: () => height,
    });
  });
  afterAll(() => {
    if (original.w) Object.defineProperty(proto, "offsetWidth", original.w);
    if (original.h) Object.defineProperty(proto, "offsetHeight", original.h);
  });
}
