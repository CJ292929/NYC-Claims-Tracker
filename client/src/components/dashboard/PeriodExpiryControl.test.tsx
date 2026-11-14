// @vitest-environment jsdom
/**
 * P4-P31: Mark Expired / reviewed Restore on one authorization period card.
 * The server procedure is mocked; the period-scoped write and its audit are
 * proven against real Postgres in server/expiredAuthorization.pg.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => {
  const invalidations: Array<[string, unknown]> = [];
  const inv = (name: string) => (arg?: unknown) => { invalidations.push([name, arg]); };
  return {
    invalidations,
    utils: {
      visits: { authAlerts: { invalidate: inv("authAlerts") }, listByPatient: { invalidate: inv("listByPatient") }, completedPatientIds: { invalidate: inv("completedPatientIds") } },
      patients: { list: { invalidate: inv("patients.list") } },
      claims: { periodsForPatient: { invalidate: inv("periodsForPatient") } },
    },
    expire: { opts: null as any, inputs: [] as any[] },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => h.utils,
    visits: {
      setPeriodExpired: {
        useMutation: (opts: any) => {
          h.expire.opts = opts;
          return { mutate: (input: any) => h.expire.inputs.push(input), isPending: false };
        },
      },
    },
  },
}));

import { PeriodExpiryControl } from "./AuthorizationActions";

const PATIENT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  h.invalidations.length = 0;
  h.expire.inputs.length = 0;
});
afterEach(cleanup);

describe("PeriodExpiryControl", () => {
  it("asks for confirmation, explains counts are kept, then expires only that period", () => {
    render(<PeriodExpiryControl patientId={PATIENT} patientName="Synthetic Patient" period={2} expired={false} authorized={16} completed={13} hasLaterPeriod={false} />);
    fireEvent.click(screen.getByRole("button", { name: /mark expired/i }));
    expect(h.expire.inputs).toHaveLength(0);

    expect(screen.getByText(/Mark Authorization Period 2 Expired\?/)).toBeTruthy();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Only Period 2");
    expect(dialog.textContent).toMatch(/Authorized stays 16 and completed stays 13/);
    expect(dialog.textContent).toMatch(/3 unused session\(s\) stay visible as history/);

    const confirm = screen.getAllByRole("button", { name: /mark expired/i }).at(-1)!;
    fireEvent.click(confirm);
    fireEvent.click(confirm); // double click: single-flight guard
    expect(h.expire.inputs).toEqual([{ patientId: PATIENT, authPeriod: 2, expired: true }]);

    act(() => {
      h.expire.opts.onSettled();
      h.expire.opts.onSuccess({ success: true, changed: 16 }, h.expire.inputs[0]);
    });
    expect(h.invalidations).toContainEqual(["authAlerts", undefined]);
    expect(h.invalidations).toContainEqual(["listByPatient", { patientId: PATIENT }]);
  });

  it("Restore shows the effect, requires a reason, and sends it", () => {
    render(<PeriodExpiryControl patientId={PATIENT} patientName="Synthetic Patient" period={2} expired authorized={16} completed={13} hasLaterPeriod={false} />);
    expect(screen.queryByRole("button", { name: /clear expired/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /restore period/i }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Session statuses, dates, counts, claims and amounts were never changed/);
    expect(dialog.textContent).toMatch(/3 session\(s\) become available again/);

    const confirm = screen.getAllByRole("button", { name: /restore period/i }).at(-1)! as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(h.expire.inputs).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/reason for restoring/i), { target: { value: "  Marked by mistake  " } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(h.expire.inputs).toEqual([{ patientId: PATIENT, authPeriod: 2, expired: false, reason: "Marked by mistake" }]);
  });

  it("Restore is unavailable once a later period exists", () => {
    render(<PeriodExpiryControl patientId={PATIENT} patientName="Synthetic Patient" period={1} expired authorized={16} completed={13} hasLaterPeriod />);
    fireEvent.click(screen.getByRole("button", { name: /restore period/i }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/can.t be restored because a newer/);
    expect(screen.queryByLabelText(/reason for restoring/i)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /restore period/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(h.expire.inputs).toHaveLength(0);
  });

  it("cancel writes nothing", () => {
    render(<PeriodExpiryControl patientId={PATIENT} patientName="Synthetic Patient" period={1} expired={false} authorized={4} completed={4} hasLaterPeriod={false} />);
    fireEvent.click(screen.getByRole("button", { name: /mark expired/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(h.expire.inputs).toHaveLength(0);
  });
});
