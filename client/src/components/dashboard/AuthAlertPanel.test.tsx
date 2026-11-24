// @vitest-environment jsdom
/**
 * Authorization Alerts panel: discharged patients are never listed or
 * counted, and the insurance filter (aliases, historical insurers, empty
 * state, filtered vs. all-insurances counts). tRPC is mocked; the server
 * side is covered by server/authRequestHoldFlow.postgrest.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ alerts: [] as any[], catalog: [] as any[] }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => {
  const noop = () => {};
  const mutation = { useMutation: () => ({ mutate: noop, isPending: false }) };
  return {
    trpc: {
      useUtils: () => ({
        visits: { authAlerts: { invalidate: noop }, listByPatient: { invalidate: noop }, completedPatientIds: { invalidate: noop } },
        patients: { list: { invalidate: noop } },
        claims: { periodsForPatient: { invalidate: noop } },
      }),
      insurance: { list: { useQuery: () => ({ data: h.catalog }) } },
      visits: {
        authAlerts: { useQuery: () => ({ data: h.alerts, isLoading: false, error: null }) },
        markAsRequested: mutation, approveAuthorization: mutation, holdAuthorizationRequest: mutation,
      },
    },
  };
});

import { AuthAlertPanel } from "./AuthAlertPanel";

const alert = (name: string, insurance: string | null, over: Record<string, unknown> = {}) => ({
  patientId: name, patientName: name, insurance, sessionsAuthorized: 4, sessionsRemaining: 1,
  authStatus: "approved", dateAshSubmitted: null, urgency: "critical", authValidUntil: null, authExpiryWarning: false,
  authPeriod: 1, latestAuthPeriod: 1, periodExpired: false, unusedExpiredSessions: 0, isActive: true, hold: null, ...over,
});

beforeEach(() => {
  h.catalog = [
    { id: "1", name: "United Healthcare Medicare Advantage", aliases: ["United Healthcare Medicare"], isActive: true },
    { id: "2", name: "Aetna", aliases: [], isActive: true },
  ];
  h.alerts = [
    alert("Renamed New", "United Healthcare Medicare Advantage"),
    alert("Renamed Old", "United Healthcare Medicare"),
    alert("Aetna Active", "Aetna"),
    alert("Aetna Discharged", "Aetna", { isActive: false }),
    alert("Deleted Insurer", "Old Regional Plan"),
  ];
});
afterEach(cleanup);

describe("AuthAlertPanel", () => {
  it("never lists or counts a discharged patient", () => {
    render(<AuthAlertPanel onSelectPatient={() => {}} />);
    expect(screen.queryByText("Aetna Discharged")).toBeNull();
    expect(screen.getByText("Aetna Active")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy(); // badge: 4 actionable
    expect(screen.queryByRole("combobox")).toBeNull(); // no selector unless the page opts in
  });

  it("all-discharged queue shows the on-track empty state", () => {
    h.alerts = h.alerts.map(a => ({ ...a, isActive: false }));
    render(<AuthAlertPanel onSelectPatient={() => {}} />);
    expect(screen.getByText(/All patients are on track/)).toBeTruthy();
  });

  it("filters by insurer including its alias, and labels filtered vs. all-insurances counts", () => {
    render(<AuthAlertPanel onSelectPatient={() => {}} insurance="United Healthcare Medicare Advantage" onInsuranceChange={() => {}} />);
    expect(screen.getByText("Renamed New")).toBeTruthy();
    expect(screen.getByText("Renamed Old")).toBeTruthy();
    expect(screen.queryByText("Aetna Active")).toBeNull();
    expect(screen.getByText("Showing 2 of 4 alerts (filtered: United Healthcare Medicare Advantage)")).toBeTruthy();
  });

  it("an old (alias) name from the URL resolves to the current insurer", () => {
    render(<AuthAlertPanel onSelectPatient={() => {}} insurance="United Healthcare Medicare" onInsuranceChange={() => {}} />);
    expect(screen.getByRole("combobox").textContent).toContain("United Healthcare Medicare Advantage");
    expect(screen.getByText("Renamed Old")).toBeTruthy();
  });

  it("a historical insurer (not in the catalog) keeps its patients", () => {
    render(<AuthAlertPanel onSelectPatient={() => {}} insurance="Old Regional Plan" onInsuranceChange={() => {}} />);
    expect(screen.getByText("Deleted Insurer")).toBeTruthy();
    expect(screen.getByText(/Showing 1 of 4 alerts/)).toBeTruthy();
  });

  it("zero results: clear empty state with a way back to all insurances", () => {
    const onChange = vi.fn();
    render(<AuthAlertPanel onSelectPatient={() => {}} insurance="Gone Insurer" onInsuranceChange={onChange} />);
    expect(screen.getByText("No authorization alerts for Gone Insurer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all insurances (4)" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("unfiltered with the selector shows the all-insurances total", () => {
    render(<AuthAlertPanel onSelectPatient={() => {}} insurance="" onInsuranceChange={() => {}} />);
    expect(screen.getByText("4 alerts, all insurances")).toBeTruthy();
    expect(screen.getByRole("combobox").textContent).toContain("All Insurances");
  });
});
