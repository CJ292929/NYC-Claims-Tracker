// @vitest-environment jsdom
/**
 * P4-P32: Sessions Authorized after patient creation — the Edit Patient
 * section, the initial mode of the New Authorization dialog, and the
 * period Correct Count control. Server procedures are mocked; the database
 * rules are proven in server/periodSessionCorrection.pg.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Inside a <form>, Radix Checkbox renders a hidden native input sized with
// ResizeObserver, which jsdom lacks (every real browser has it).
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

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
    approve: { opts: null as any, inputs: [] as any[] },
    correct: { opts: null as any, inputs: [] as any[] },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => h.utils,
    insurance: { list: { useQuery: () => ({ data: [{ name: "Synthetic Health", isActive: true }] }) } },
    visits: {
      approveAuthorization: {
        useMutation: (opts: any) => { h.approve.opts = opts; return { mutate: (i: any) => h.approve.inputs.push(i), isPending: false }; },
      },
      correctPeriodSessions: {
        useMutation: (opts: any) => { h.correct.opts = opts; return { mutate: (i: any) => h.correct.inputs.push(i), isPending: false }; },
      },
      setPeriodExpired: { useMutation: () => ({ mutate: () => {}, isPending: false }) },
    },
  },
}));

import { ApproveAuthorizationDialog, CorrectPeriodCountControl, describePeriodCountCorrection } from "./AuthorizationActions";
import { AuthorizationSessionsSection } from "./AuthorizationSessionsSection";

const PATIENT = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  h.invalidations.length = 0;
  h.approve.inputs.length = 0;
  h.correct.inputs.length = 0;
});
afterEach(cleanup);

const rows = (period: number, authorized: number, n: number, used: number, expired = false) =>
  Array.from({ length: n }, (_, i) => ({
    authPeriod: period, sessionsAuthorized: authorized, dateOfService: i < used ? new Date("2026-11-01") : null,
    periodExpiredAt: expired ? "2026-11-15T00:00:00Z" : null,
  }));

describe("AuthorizationSessionsSection (Edit Patient)", () => {
  it("shows the count as not set for a patient awaiting approval and offers the initial authorization", () => {
    const onRecordInitial = vi.fn();
    render(<AuthorizationSessionsSection patientId={PATIENT} patientName="SYNTH, BETA" visits={[]} loading={false} onRecordInitial={onRecordInitial} />);
    expect(screen.getByText(/Not set\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /correct/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /record initial authorization/i }));
    expect(onRecordInitial).toHaveBeenCalledTimes(1);
  });

  it("does not offer the initial authorization while periods are loading", () => {
    render(<AuthorizationSessionsSection patientId={PATIENT} patientName="SYNTH, BETA" visits={[]} loading onRecordInitial={() => {}} />);
    expect(screen.queryByRole("button", { name: /record initial authorization/i })).toBeNull();
  });

  it("lists each period, newest first, with its counts and its own Correct Count", () => {
    render(<AuthorizationSessionsSection patientId={PATIENT} patientName="SYNTH, BETA"
      visits={[...rows(1, 4, 4, 4, true), ...rows(2, 16, 16, 3)]} loading={false} onRecordInitial={() => {}} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("Period 2");
    expect(items[0].textContent).toContain("16 authorized · 3 completed · 13 remaining");
    expect(items[1].textContent).toContain("Period 1");
    expect(items[1].textContent).toContain("Expired");
    expect(screen.getByRole("button", { name: /period 2/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /record initial authorization/i })).toBeNull();
  });
});

describe("ApproveAuthorizationDialog — initial mode", () => {
  const target = { id: PATIENT, name: "SYNTH, BETA", insurance: "Synthetic Health", initial: true };

  it("needs the count AND an explicit approval-received confirmation, then sends initial: true", () => {
    render(<ApproveAuthorizationDialog target={target} onClose={() => {}} />);
    expect(screen.getByText("Record Initial Authorization")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: /confirm/i }) as HTMLButtonElement;

    fireEvent.change(screen.getByLabelText(/sessions authorized/i), { target: { value: "16" } });
    expect(confirm.disabled).toBe(true); // a number alone does not imply approval
    fireEvent.click(confirm);
    expect(h.approve.inputs).toHaveLength(0);

    fireEvent.click(screen.getByRole("checkbox", { name: /approval received/i }));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    fireEvent.click(confirm); // double click
    expect(h.approve.inputs).toHaveLength(1);
    expect(h.approve.inputs[0]).toMatchObject({ patientId: PATIENT, sessionsAuthorized: 16, initial: true });
  });

  it("refreshes alerts, sessions and the patient list on success", () => {
    const onClose = vi.fn();
    render(<ApproveAuthorizationDialog target={target} onClose={onClose} />);
    h.approve.opts.onSuccess({ success: true, newVisitCount: 16, authPeriod: 1 }, { patientId: PATIENT, initial: true });
    expect(onClose).toHaveBeenCalled();
    expect(h.invalidations.map(([n]) => n)).toEqual(expect.arrayContaining(["authAlerts", "listByPatient", "completedPatientIds", "patients.list"]));
  });

  it("renewal mode is unchanged: no confirmation box and no initial flag", () => {
    render(<ApproveAuthorizationDialog target={{ ...target, initial: false }} onClose={() => {}} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.change(screen.getByLabelText(/sessions authorized/i), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(h.approve.inputs[0]).not.toHaveProperty("initial");
  });
});

describe("CorrectPeriodCountControl", () => {
  const props = { patientId: PATIENT, patientName: "SYNTH, BETA", period: 2, authorized: 16, completed: 3, sessionRows: 16, expired: false };

  it("shows which period and its current counts, and sends the correction with the expected current count", () => {
    render(<CorrectPeriodCountControl {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /correct session count for authorization period 2/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Period 2");
    expect(dialog.textContent).toMatch(/Current16Completed3Remaining13/);

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "20" } });
    expect(dialog.textContent).toContain("4 empty session row(s) will be added");
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Payer letter" } });
    const save = screen.getByRole("button", { name: /save correction/i });
    fireEvent.click(save);
    fireEvent.click(save); // double click
    expect(h.correct.inputs).toEqual([{ patientId: PATIENT, authPeriod: 2, sessionsAuthorized: 20, expectedCurrent: 16, reason: "Payer letter" }]);

    h.correct.opts.onSuccess({ success: true, changed: true, sessionsAuthorized: 20, added: 4, removed: 0 }, h.correct.inputs[0]);
    expect(h.invalidations.map(([n]) => n)).toEqual(expect.arrayContaining(["authAlerts", "listByPatient", "patients.list"]));
  });

  it("blocks a value below completed sessions before sending", () => {
    render(<CorrectPeriodCountControl {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /correct session count/i }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
    expect(screen.getByRole("dialog").textContent).toContain("lower than the 3 completed");
    expect((screen.getByRole("button", { name: /save correction/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.correct.inputs).toHaveLength(0);
  });

  it("shows a server refusal inline and keeps the dialog open", () => {
    render(<CorrectPeriodCountControl {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /correct session count/i }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: /save correction/i }));
    act(() => {
      h.correct.opts.onError({ message: "Lowering the count would remove session(s) 15, 16 ... Nothing was changed." }, h.correct.inputs[0]);
      h.correct.opts.onSettled();
    });
    expect(screen.getByRole("alert").textContent).toContain("session(s) 15, 16");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("an Expired period explains Restore-first and offers no save", () => {
    render(<CorrectPeriodCountControl {...props} expired />);
    fireEvent.click(screen.getByRole("button", { name: /correct session count/i }));
    expect(screen.getByRole("alert").textContent).toContain("marked Expired");
    expect(screen.queryByRole("button", { name: /save correction/i })).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });
});

describe("describePeriodCountCorrection", () => {
  it("mirrors the database row rules", () => {
    expect(describePeriodCountCorrection({ authorized: 16, completed: 3, sessionRows: 16, next: 10 })).toEqual({ ok: true, added: 0, removed: 6 });
    expect(describePeriodCountCorrection({ authorized: 20, completed: 0, sessionRows: 1, next: 30 })).toEqual({ ok: true, added: 0, removed: 0 });
    expect(describePeriodCountCorrection({ authorized: 16, completed: 3, sessionRows: 16, next: 16 }).ok).toBe(false);
    expect(describePeriodCountCorrection({ authorized: 16, completed: 3, sessionRows: 16, next: 1.5 }).ok).toBe(false);
  });
});
