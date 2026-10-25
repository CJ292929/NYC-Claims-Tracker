/**
 * client/src/lib/concurrencyGuards.ts
 *
 * P4-P16R: two concurrency hazards in the claim upload/save flow (since
 * P4-P24, client/src/components/claims/ClaimImportDialog.tsx) that a React
 * `disabled` prop alone cannot close, because state updates only take
 * effect after the next render commits, not synchronously inside the event
 * handler that triggered them:
 *
 * 1. Double-clicking a Save button (or any other re-entry while a save is
 *    already running) could send the same lines twice before the re-render
 *    disables the button. (The server is also idempotent per source line —
 *    this guard just avoids the wasted second request.)
 * 2. A slow extraction or preview request superseded by a newer one (a
 *    second file picked, an edit re-checked) could resolve AFTER the newer
 *    request and overwrite its result, or apply a stale result to a dialog
 *    the newer request has already moved past.
 *
 * Both are synchronous, in-memory guards (backed by a ref in the
 * component, not React state) checked in the same tick as the call that
 * needs to be rejected or distinguished.
 */

/** Guard #1: at most one "in flight" operation at a time. */
export interface SingleFlightGuard {
  /** Returns true and marks the guard busy if it was free; returns false
   *  (does nothing) if something is already in flight. */
  tryEnter(): boolean;
  /** Marks the guard free again. Safe to call even if not entered. */
  exit(): void;
  readonly isBusy: boolean;
}

export function createSingleFlightGuard(): SingleFlightGuard {
  let busy = false;
  return {
    tryEnter() {
      if (busy) return false;
      busy = true;
      return true;
    },
    exit() {
      busy = false;
    },
    get isBusy() {
      return busy;
    },
  };
}

/** Guard #2: only the most recently started request's result should ever be applied. */
export interface RequestGuard {
  /** Call at the start of a new request; returns its id and supersedes any earlier one. */
  start(): number;
  /** True if `id` is still the most recent request started (i.e. not stale). */
  isCurrent(id: number): boolean;
}

export function createRequestGuard(): RequestGuard {
  let current = 0;
  return {
    start() {
      current += 1;
      return current;
    },
    isCurrent(id: number) {
      return id === current;
    },
  };
}
