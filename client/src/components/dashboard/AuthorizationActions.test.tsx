// @vitest-environment jsdom
/**
 * P4-P30: the authorization actions now shared by the Dashboard alert panel
 * and the patient details alert banner. The server procedures are mocked;
 * their period targeting and audit are covered by
 * server/markAsRequested.periodScope.test.ts and
 * server/authApproval.periodScope.test.ts.
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
    mark: { opts: null as any, inputs: [] as any[] },
    approve: { opts: null as any, inputs: [] as any[] },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => h.utils,
    insurance: { list: { useQuery: () => ({ data: [{ name: "Synthetic Health", isActive: true }] }) } },
    visits: {
      markAsRequested: {
        useMutation: (opts: any) => {
          h.mark.opts = opts;
          return { mutate: (input: any) => { h.mark.inputs.push(input); opts.onMutate?.(input); } };
        },
      },
      approveAuthorization: {
        useMutation: (opts: any) => {
          h.approve.opts = opts;
          return { mutate: (input: any) => h.approve.inputs.push(input), isPending: false };
        },
      },
    },
  },
}));

import { ApproveAuthorizationDialog, AuthorizationActionButtons, useMarkAuthorizationRequested } from "./AuthorizationActions";

const PATIENT = "11111111-1111-4111-8111-111111111111";

function Harness({ authPending, onApprove = () => {} }: { authPending: boolean; onApprove?: () => void }) {
  const { requestingId, markRequested } = useMarkAuthorizationRequested();
  return (
    <AuthorizationActionButtons
      authPending={authPending}
      requesting={requestingId === PATIENT}
      onMarkRequested={() => markRequested(PATIENT)}
      onApprove={onApprove}
    />
  );
}

beforeEach(() => {
  h.invalidations.length = 0;
  h.mark.inputs.length = 0;
  h.approve.inputs.length = 0;
});
afterEach(cleanup);

describe("AuthorizationActionButtons", () => {
  it("offers Mark Requested until a request is pending", () => {
    render(<Harness authPending={false} />);
    expect(screen.queryByRole("button", { name: /approved/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /re-request/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /mark requested/i }));
    expect(h.mark.inputs).toEqual([{ patientId: PATIENT }]);
  });

  it("offers Approved and Re-request once pending, and Re-request uses the same audited mutation", () => {
    const onApprove = vi.fn();
    render(<Harness authPending onApprove={onApprove} />);
    expect(screen.queryByRole("button", { name: /mark requested/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /re-request/i }));
    expect(h.mark.inputs).toEqual([{ patientId: PATIENT }]);
    fireEvent.click(screen.getByRole("button", { name: /approved/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("sends one request for a double click, and allows another once it settles", () => {
    render(<Harness authPending={false} />);
    const button = screen.getByRole("button", { name: /mark requested/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(h.mark.inputs).toHaveLength(1);
    act(() => h.mark.opts.onSettled(undefined, null, { patientId: PATIENT }));
    fireEvent.click(screen.getByRole("button", { name: /mark requested/i }));
    expect(h.mark.inputs).toHaveLength(2);
  });

  it("refreshes alerts, the patient's sessions and totals after a request", () => {
    render(<Harness authPending={false} />);
    h.mark.opts.onSuccess({ success: true }, { patientId: PATIENT });
    expect(h.invalidations).toEqual(expect.arrayContaining([
      ["authAlerts", undefined],
      ["listByPatient", { patientId: PATIENT }],
      ["completedPatientIds", undefined],
      ["patients.list", undefined],
    ]));
  });
});

describe("ApproveAuthorizationDialog", () => {
  it("requires a session count, sends the patient's approval, then refreshes and closes", () => {
    const onClose = vi.fn();
    render(<ApproveAuthorizationDialog target={{ id: PATIENT, name: "SYNTH, ALPHA", insurance: "Synthetic Health" }} onClose={onClose} />);
    const confirm = screen.getByRole("button", { name: /confirm & create records/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/sessions authorized/i), { target: { value: "12" } });
    fireEvent.click(confirm);
    expect(h.approve.inputs).toHaveLength(1);
    expect(h.approve.inputs[0]).toMatchObject({ patientId: PATIENT, sessionsAuthorized: 12, newInsurance: "Synthetic Health", authValidUntil: null });

    h.approve.opts.onSuccess({ success: true, newVisitCount: 12 }, { patientId: PATIENT });
    expect(onClose).toHaveBeenCalled();
    expect(h.invalidations).toEqual(expect.arrayContaining([["authAlerts", undefined], ["listByPatient", { patientId: PATIENT }]]));
  });

  it("creates one batch for a double click on Confirm, and allows a retry after a failure", () => {
    render(<ApproveAuthorizationDialog target={{ id: PATIENT, name: "SYNTH, ALPHA", insurance: "Synthetic Health" }} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/sessions authorized/i), { target: { value: "12" } });
    const confirm = screen.getByRole("button", { name: /confirm & create records/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(h.approve.inputs).toHaveLength(1);
    h.approve.opts.onError({ message: "network" });
    h.approve.opts.onSettled();
    fireEvent.click(confirm);
    expect(h.approve.inputs).toHaveLength(2);
  });

  it("is closed with no target", () => {
    render(<ApproveAuthorizationDialog target={null} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
