/**
 * jsdom does no layout, so every element measures 0×0 and a virtualised list
 * renders no rows. `stubViewport` gives elements a fixed size for the tests
 * that need rows. TanStack Virtual reads the scroll element's `clientWidth` /
 * `clientHeight` (`offsetWidth` / `offsetHeight` before virtual-core 3.18) and
 * measures rows with `offsetHeight`, so all four are stubbed.
 */

import { afterAll, beforeAll } from "vitest";

const PROPS = [
  "offsetWidth",
  "offsetHeight",
  "clientWidth",
  "clientHeight",
] as const;

export function stubViewport(width = 800, height = 600): void {
  const originals = PROPS.map((name) => {
    const proto = name.startsWith("offset")
      ? HTMLElement.prototype
      : Element.prototype;
    return { name, proto, desc: Object.getOwnPropertyDescriptor(proto, name) };
  });
  beforeAll(() => {
    for (const { name, proto } of originals) {
      const value = name.endsWith("Width") ? width : height;
      Object.defineProperty(proto, name, {
        configurable: true,
        get: () => value,
      });
    }
  });
  afterAll(() => {
    for (const { name, proto, desc } of originals) {
      if (desc) Object.defineProperty(proto, name, desc);
    }
  });
}
