// @vitest-environment jsdom
/**
 * Clear Date of Service confirmation for one session row. The server
 * procedure is mocked; its single-field audited write is covered by
 * server/clearDateOfService.router.test.ts and the real-Postgres suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
    clear: { opts: null as any, inputs: [] as any[], isPending: false },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => h.utils,
    visits: {
      clearDateOfService: {
        useMutation: (opts: any) => {
          h.clear.opts = opts;
          return { mutate: (input: any) => h.clear.inputs.push(input), isPending: h.clear.isPending };
        },
      },
    },
  },
}));

import { ClearDateOfServiceDialog } from "./ClearDateOfServiceDialog";

const PATIENT = "22222222-2222-4222-8222-222222222222";
const VISIT = "44444444-4444-4444-8444-444444444444";

function renderDialog(over: Partial<Parameters<typeof ClearDateOfServiceDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onCleared = vi.fn();
  render(
    <ClearDateOfServiceDialog
      open
      onOpenChange={onOpenChange}
      onCleared={onCleared}
      visitId={VISIT}
      patientId={PATIENT}
      period={1}
      sessionNumber={5}
      dateLabel="Nov 3, 2026"
      completed={5}
      periodExpired={false}
      {...over}
    />,
  );
  return { onOpenChange, onCleared };
}

beforeEach(() => {
  h.invalidations.length = 0;
  h.clear.inputs.length = 0;
  h.clear.isPending = false;
});
afterEach(cleanup);

describe("ClearDateOfServiceDialog", () => {
  it("names the period, session and date, then clears only that row on confirm", () => {
    const { onOpenChange, onCleared } = renderDialog();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Authorization Period 1 · Session #5 · Date of Service Nov 3, 2026/);
    expect(dialog.textContent).toMatch(/Only this session's Date of Service is cleared/);
    expect(dialog.textContent).toMatch(/not moved to another period/);
    expect(dialog.textContent).toMatch(/go from 5 to 4/);
    expect(dialog.textContent).toMatch(/One more session becomes available/);
    expect(h.clear.inputs).toHaveLength(0);

    const confirm = screen.getByRole("button", { name: /clear date of service/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm); // double click: single-flight guard
    expect(h.clear.inputs).toEqual([{ id: VISIT, patientId: PATIENT }]);

    act(() => {
      h.clear.opts.onSettled();
      h.clear.opts.onSuccess({ success: true }, h.clear.inputs[0]);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(h.invalidations).toContainEqual(["listByPatient", { patientId: PATIENT }]);
    expect(h.invalidations).toContainEqual(["authAlerts", undefined]);
    expect(h.invalidations).toContainEqual(["completedPatientIds", undefined]);
  });

  it("an expired period stays expired: no session is said to become available", () => {
    renderDialog({ period: 2, sessionNumber: 3, periodExpired: true });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Period 2 stays Expired, so no session becomes available/);
    expect(dialog.textContent).not.toMatch(/One more session becomes available/);
  });

  it("Cancel sends nothing", () => {
    const { onOpenChange, onCleared } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(h.clear.inputs).toHaveLength(0);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCleared).not.toHaveBeenCalled();
  });

  it("a failure is shown in the dialog, which stays open, and a retry sends again", () => {
    const { onOpenChange, onCleared } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /clear date of service/i }));
    act(() => {
      h.clear.opts.onError({ message: "Session not found. It may have been removed — reload and try again." });
      h.clear.opts.onSettled();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Session not found/);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onCleared).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(h.clear.inputs).toHaveLength(2);
  });

  it("while a request is in flight, confirm and cancel are disabled", () => {
    h.clear.isPending = true;
    renderDialog();
    expect((screen.getByRole("button", { name: /clear date of service/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
