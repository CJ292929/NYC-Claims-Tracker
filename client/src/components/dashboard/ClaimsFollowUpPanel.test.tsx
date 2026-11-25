// @vitest-environment jsdom
/**
 * Claims Follow-Up panel: the Dashboard preview is clinic-wide (no insurance
 * scope unless one is passed), labels "Showing X of Y" and offers View All;
 * the full page lists every row. Regression for "Claims Follow-Up shows only
 * one record/insurer": the Dashboard passed the Patient Records insurance
 * filter (default "Aetna") into this panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ claims: [] as any[], inputs: [] as any[] }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      claims: {
        getFollowUpClaims: { cancel: vi.fn(), getData: vi.fn(), setData: vi.fn(), invalidate: vi.fn() },
        getStatusCounts: { invalidate: vi.fn() },
        getByPatientAndPeriod: { invalidate: vi.fn() },
      },
    }),
    claims: {
      getFollowUpClaims: {
        useQuery: (input: any) => {
          h.inputs.push(input);
          const rows = input?.insurance ? h.claims.filter(c => c.insurance === input.insurance) : h.claims;
          return { data: rows, isLoading: false, isError: false };
        },
      },
      markResolved: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

import { ClaimsFollowUpPanel } from "./ClaimsFollowUpPanel";

const claim = (i: number, insurance: string) => ({
  id: `c${i}`, patientId: `p${i}`, patientName: `Synthetic ${String(i).padStart(2, "0")}`, insurance,
  authPeriod: 1, dateOfService: "2026-10-01", cptCodes: "97110", chargeAmount: 100, insuranceReimbursement: null,
  claimStatus: "denied", claimSubmittedDate: "2026-10-02", claimNumber: null, urgency: "denied", followUpReason: "Claim denied",
});

beforeEach(() => {
  h.inputs.length = 0;
  h.claims = Array.from({ length: 12 }, (_, i) => claim(i + 1, ["Aetna", "Meritain", "BCBS"][i % 3]));
});
afterEach(cleanup);

describe("ClaimsFollowUpPanel", () => {
  it("Dashboard preview: all insurances, 'Showing 8 of 12', View All works", () => {
    const onViewAll = vi.fn();
    render(<ClaimsFollowUpPanel onSelectPatient={() => {}} previewLimit={8} onViewAll={onViewAll} />);
    expect(h.inputs[0]).toEqual({ insurance: undefined });
    expect(screen.getByTestId("follow-up-showing").textContent).toBe("Showing 8 of 12");
    expect(screen.getByText(/All insurances/)).toBeTruthy();
    // Mobile cards + desktop table both render in jsdom: 8 distinct patients each.
    expect(new Set(screen.getAllByText(/^Synthetic \d+$/).map(e => e.textContent!.match(/Synthetic \d+/)![0])).size).toBe(8);
    expect(screen.getAllByText("Meritain").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BCBS").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /View all claims follow-up/ }));
    expect(onViewAll).toHaveBeenCalledOnce();
  });

  it("full page: every row, no preview label", () => {
    render(<ClaimsFollowUpPanel onSelectPatient={() => {}} />);
    expect(screen.queryByTestId("follow-up-showing")).toBeNull();
    expect(new Set(screen.getAllByText(/^Synthetic \d+$/).map(e => e.textContent!.match(/Synthetic \d+/)![0])).size).toBe(12);
  });

  it("explicit insurance scope still filters (follow-up page selector)", () => {
    render(<ClaimsFollowUpPanel insurance="Meritain" onSelectPatient={() => {}} />);
    expect(h.inputs[0]).toEqual({ insurance: "Meritain" });
    expect(new Set(screen.getAllByText(/^Synthetic \d+$/).map(e => e.textContent!.match(/Synthetic \d+/)![0])).size).toBe(4);
  });
});
