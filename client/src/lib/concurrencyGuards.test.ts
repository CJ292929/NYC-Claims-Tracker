/**
 * client/src/lib/concurrencyGuards.test.ts
 *
 * P4-P16R: synthetic coverage for the two concurrency guards used by
 * handleSaveExtractedClaims and handleClaimFileUpload
 * (client/src/pages/Dashboard.tsx) -- a double-clicked Save button cannot
 * issue concurrent duplicate writes, and a delayed response from an older
 * upload cannot overwrite a newer one's result.
 */
import { describe, it, expect } from "vitest";
import { createSingleFlightGuard, createRequestGuard } from "./concurrencyGuards";

describe("createSingleFlightGuard", () => {
  it("lets the first caller in and blocks a second concurrent caller", () => {
    const guard = createSingleFlightGuard();
    expect(guard.tryEnter()).toBe(true);
    // Simulates a double-click: a second call arrives before the first
    // one calls exit(). It must be rejected, not run concurrently.
    expect(guard.tryEnter()).toBe(false);
    expect(guard.isBusy).toBe(true);
  });

  it("allows a new caller in again after exit()", () => {
    const guard = createSingleFlightGuard();
    guard.tryEnter();
    guard.exit();
    expect(guard.isBusy).toBe(false);
    expect(guard.tryEnter()).toBe(true);
  });

  it("exit() is safe to call even when nothing is in flight", () => {
    const guard = createSingleFlightGuard();
    expect(() => guard.exit()).not.toThrow();
    expect(guard.isBusy).toBe(false);
  });

  it("simulates the exact double-click scenario: second attempt issues zero writes", () => {
    const guard = createSingleFlightGuard();
    let writesIssued = 0;

    function clickSave() {
      if (!guard.tryEnter()) return; // second click: bail before writing anything
      writesIssued++;
    }

    clickSave(); // first click
    clickSave(); // second click, same tick, before exit()
    expect(writesIssued).toBe(1);

    guard.exit();
    clickSave(); // a THIRD, later click after the first save finished is legitimate
    expect(writesIssued).toBe(2);
  });
});

describe("createRequestGuard", () => {
  it("the first and only request started is current", () => {
    const guard = createRequestGuard();
    const id = guard.start();
    expect(guard.isCurrent(id)).toBe(true);
  });

  it("starting a second request makes the first one stale", () => {
    const guard = createRequestGuard();
    const first = guard.start();
    const second = guard.start();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("simulates a delayed older-upload response losing to a newer one", () => {
    const guard = createRequestGuard();
    const appliedResults: string[] = [];

    function simulateUpload(label: string, resolveOrder: string[]) {
      const id = guard.start();
      resolveOrder.push(label);
      return () => {
        // "response arrives" -- only applies if still current
        if (guard.isCurrent(id)) appliedResults.push(label);
      };
    }

    const order: string[] = [];
    const applyFirst = simulateUpload("first-upload (slow)", order);
    const applySecond = simulateUpload("second-upload (fast)", order);

    // Second (newer) request's response arrives first.
    applySecond();
    // First (older, slower) request's response arrives late -- must be dropped.
    applyFirst();

    expect(appliedResults).toEqual(["second-upload (fast)"]);
  });
});
