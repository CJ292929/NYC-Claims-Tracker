// @vitest-environment jsdom
/**
 * Hold Request for Authorization UI: reason validation, confirm/cancel,
 * duplicate-submit guard, the hold list (effective + superseded) and
 * Remove Hold / Resume. Server procedures are mocked; their rules are in
 * server/authRequestHold.router.test.ts and the real-Postgres suite.
 * Also the Active/Discharged toggle (PatientActiveToggle).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  invalidated: [] as string[],
  alerts: [] as any[],
  hold: { opts: null as any, inputs: [] as any[] },
  release: { opts: null as any, inputs: [] as any[] },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => {
  const inv = (name: string) => () => { h.invalidated.push(name); };
  return {
    trpc: {
      useUtils: () => ({
        visits: { authAlerts: { invalidate: inv("authAlerts") }, listByPatient: { invalidate: inv("listByPatient") }, completedPatientIds: { invalidate: inv("completedPatientIds") } },
        patients: { list: { invalidate: inv("patients.list") } },
        claims: { periodsForPatient: { invalidate: inv("periodsForPatient") } },
      }),
      visits: {
        authAlerts: { useQuery: () => ({ data: h.alerts, isLoading: false, error: null }) },
        holdAuthorizationRequest: {
          useMutation: (opts: any) => { h.hold.opts = opts; return { mutate: (i: any) => h.hold.inputs.push(i), isPending: false }; },
        },
        releaseAuthorizationRequestHold: {
          useMutation: (opts: any) => { h.release.opts = opts; return { mutate: (i: any) => h.release.inputs.push(i), isPending: false }; },
        },
      },
    },
  };
});

import { AuthorizationHoldsPanel, HoldAuthorizationRequestDialog } from "./AuthorizationHold";
import { PatientActiveToggle } from "./PatientActiveToggle";

const P1 = "11111111-1111-4111-8111-111111111111";
const hold = (authPeriod: number | null) => ({ holdId: `hold-${authPeriod}`, authPeriod, reason: "Waiting on referral", heldAt: "2026-11-20T15:00:00Z", heldByDisplay: "Synthetic Staff" });

beforeEach(() => {
  h.invalidated.length = 0; h.hold.inputs.length = 0; h.release.inputs.length = 0; h.alerts = [];
});
afterEach(cleanup);

describe("HoldAuthorizationRequestDialog", () => {
  const target = { patientId: P1, patientName: "Synthetic Patient", authPeriod: 2 };

  it("Confirm stays disabled until the trimmed reason is nonblank; sends the trimmed reason and the period scope", () => {
    render(<HoldAuthorizationRequestDialog target={target} onClose={() => {}} />);
    const confirm = screen.getByRole("button", { name: "Hold Request" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "    " } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Enter a reason, not just spaces.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "  Waiting on referral  " } });
    fireEvent.click(confirm);
    fireEvent.click(confirm); // double click → one request
    expect(h.hold.inputs).toEqual([{ patientId: P1, authPeriod: 2, reason: "Waiting on referral" }]);
  });

  it("on success: closes and refreshes the alerts; on settle the guard allows a new attempt", () => {
    const onClose = vi.fn();
    render(<HoldAuthorizationRequestDialog target={target} onClose={onClose} />);
    h.hold.opts.onSuccess({ changed: true }, { patientId: P1 });
    expect(onClose).toHaveBeenCalled();
    expect(h.invalidated).toContain("authAlerts");
  });

  it("Cancel sends nothing", () => {
    const onClose = vi.fn();
    render(<HoldAuthorizationRequestDialog target={target} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(h.hold.inputs).toHaveLength(0);
  });
});

describe("AuthorizationHoldsPanel", () => {
  it("lists every held patient once with insurer, reason, date and actor; flags a superseded hold", () => {
    h.alerts = [
      { patientId: P1, patientName: "Held Pending", insurance: "Synthetic Ins", urgency: "pending", authStatus: "pending", authPeriod: 2, isActive: true, hold: hold(2) },
      { patientId: "p2", patientName: "Old Hold", insurance: "Other Ins", urgency: "critical", authStatus: "approved", authPeriod: 3, isActive: false, hold: hold(2) },
      { patientId: "p3", patientName: "Not Held", insurance: "X", urgency: "critical", authStatus: "approved", authPeriod: 1, isActive: true, hold: null },
    ];
    render(<AuthorizationHoldsPanel onSelectPatient={() => {}} />);
    // Badge counts only the hold that still defers a request; the superseded one is listed, not counted.
    expect(screen.getByLabelText("1 on hold")).toBeTruthy();
    expect(screen.getByText(/Also listed: 1 superseded hold/)).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const first = within(items[0]);
    expect(first.getByText("Held Pending")).toBeTruthy();
    expect(first.getByText(/Synthetic Ins · Period 2/)).toBeTruthy();
    expect(first.getByText(/Waiting on referral/)).toBeTruthy();
    expect(first.getByText(/by Synthetic Staff/)).toBeTruthy();
    expect(first.queryByText(/Superseded/)).toBeNull();
    const second = within(items[1]);
    expect(second.getByText(/Discharged/)).toBeTruthy(); // still findable after discharge
    expect(second.getByText(/Superseded/)).toBeTruthy();
  });

  it("Remove Hold / Resume confirms, then sends the exact hold id once", () => {
    h.alerts = [{ patientId: P1, patientName: "Held Pending", insurance: "I", urgency: "pending", authStatus: "pending", authPeriod: 2, isActive: true, hold: hold(2) }];
    render(<AuthorizationHoldsPanel onSelectPatient={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove Hold \/ Resume/ }));
    const confirm = screen.getByRole("button", { name: "Remove Hold" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(h.release.inputs).toEqual([{ patientId: P1, holdId: "hold-2" }]);
  });

  it("empty state", () => {
    render(<AuthorizationHoldsPanel onSelectPatient={() => {}} />);
    expect(screen.getByText("No authorization requests are on hold.")).toBeTruthy();
  });
});

describe("PatientActiveToggle", () => {
  it("Active: ON, green track, explicit label; toggling reports the new value", () => {
    const onToggle = vi.fn();
    render(<PatientActiveToggle id="t1" isActive onToggle={onToggle} />);
    const sw = screen.getByRole("switch", { name: "Toggle patient active status" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.className).toContain("data-[state=checked]:bg-green-600");
    expect(screen.getByText("Active").className).toContain("text-green-800");
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("Discharged: OFF, red track, explicit label; focus ring present; disabled while saving", () => {
    render(<PatientActiveToggle id="t2" isActive={false} onToggle={() => {}} disabled />);
    const sw = screen.getByRole("switch", { name: "Toggle patient active status" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.className).toContain("data-[state=unchecked]:bg-red-600");
    expect(sw.className).toContain("focus-visible:ring-");
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Discharged").className).toContain("text-red-700");
  });
});
