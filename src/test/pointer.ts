/**
 * jsdom has no `PointerEvent`; Testing Library then fires a plain `Event`
 * without `button` or coordinates. This stand-in is a `MouseEvent` with a
 * `pointerId`, enough for components that read `button`, `clientX/Y` and the id.
 * Call it from `beforeEach` (and `vi.unstubAllGlobals()` after).
 */

import { vi } from "vitest";

class PointerEventStub extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

export function stubPointerEvents() {
  vi.stubGlobal("PointerEvent", PointerEventStub);
}
