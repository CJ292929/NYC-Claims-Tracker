// @vitest-environment jsdom
/**
 * Auth Status dropdown with Expired. Expired is the period-level mark, so
 * choosing it only asks for the period's Mark Expired dialog, a row never
 * gets auth_status 'expired', and picking a row status in an expired period
 * never restores it. The Radix Select is replaced by a plain list of buttons
 * (jsdom can't drive its pointer-captured popover); the logic under test is
 * the component's own.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createContext, useContext, type ReactNode } from "react";

vi.mock("@/components/ui/select", () => {
  const Ctx = createContext<{ value: string; onValueChange: (v: string) => void } | null>(null);
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
      <Ctx.Provider value={{ value, onValueChange }}><div data-testid="select" data-value={value}>{children}</div></Ctx.Provider>
    ),
    SelectTrigger: ({ children, ...rest }: { children: ReactNode; "aria-label"?: string }) => (
      <div data-testid="trigger" aria-label={rest["aria-label"]}>{children}</div>
    ),
    SelectValue: () => {
      const ctx = useContext(Ctx);
      return <span>value:{ctx?.value}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const ctx = useContext(Ctx);
      return <button type="button" data-option={value} onClick={() => ctx?.onValueChange(value)}>{children}</button>;
    },
  };
});

import { resolveAuthStatusSelection, VisitAuthStatusSelect, type RowAuthStatus } from "./VisitAuthStatusSelect";

afterEach(cleanup);

const option = (v: string) => document.querySelector(`[data-option="${v}"]`) as HTMLButtonElement;

function renderSelect(rowStatus: RowAuthStatus, periodExpired: boolean) {
  const onSetRowStatus = vi.fn();
  const onRequestPeriodExpiry = vi.fn();
  render(
    <VisitAuthStatusSelect
      rowStatus={rowStatus}
      period={2}
      periodExpired={periodExpired}
      onSetRowStatus={onSetRowStatus}
      onRequestPeriodExpiry={onRequestPeriodExpiry}
    />,
  );
  return { onSetRowStatus, onRequestPeriodExpiry };
}

describe("resolveAuthStatusSelection", () => {
  it("Expired opens the period dialog when open, and is a no-op when already expired", () => {
    expect(resolveAuthStatusSelection({ option: "expired", rowStatus: "approved", periodExpired: false })).toEqual({ kind: "openPeriodExpiry" });
    expect(resolveAuthStatusSelection({ option: "expired", rowStatus: "approved", periodExpired: true })).toEqual({ kind: "noop" });
  });
  it("row statuses write directly only in an open period", () => {
    expect(resolveAuthStatusSelection({ option: "denied", rowStatus: "approved", periodExpired: false })).toEqual({ kind: "setRowStatus", status: "denied" });
    expect(resolveAuthStatusSelection({ option: "approved", rowStatus: "approved", periodExpired: false })).toEqual({ kind: "noop" });
    for (const s of ["none", "pending", "approved", "denied"] as const) {
      expect(resolveAuthStatusSelection({ option: s, rowStatus: "approved", periodExpired: true })).toEqual({ kind: "confirmExpiredRowChange", status: s });
    }
  });
  it("never yields a row write of 'expired' or an unknown value", () => {
    for (const periodExpired of [false, true]) {
      for (const opt of ["expired", "Expired", "bogus", ""]) {
        const r = resolveAuthStatusSelection({ option: opt, rowStatus: "pending", periodExpired });
        expect(r.kind === "setRowStatus" && (r.status as string) === "expired").toBe(false);
        if (opt !== "expired") expect(r).toEqual({ kind: "noop" });
      }
    }
  });
});

describe("VisitAuthStatusSelect", () => {
  it("offers Expired beside Pending, Approved and Denied", () => {
    renderSelect("approved", false);
    expect(["none", "pending", "approved", "denied", "expired"].every(v => option(v))).toBe(true);
    expect(option("expired").textContent).toBe("Expired");
  });

  it("open period: Expired only requests the period's Mark Expired dialog, no row write", () => {
    const { onSetRowStatus, onRequestPeriodExpiry } = renderSelect("approved", false);
    fireEvent.click(option("expired"));
    expect(onRequestPeriodExpiry).toHaveBeenCalledTimes(1);
    expect(onSetRowStatus).not.toHaveBeenCalled();
    // The controlled value is still the row status (Cancel there changes nothing).
    expect(screen.getByTestId("select").getAttribute("data-value")).toBe("approved");
  });

  it("open period: a row status writes that status", () => {
    const { onSetRowStatus, onRequestPeriodExpiry } = renderSelect("approved", false);
    fireEvent.click(option("denied"));
    expect(onSetRowStatus).toHaveBeenCalledWith("denied");
    expect(onRequestPeriodExpiry).not.toHaveBeenCalled();
  });

  it("expired period: shows Expired and keeps the underlying session status visible", () => {
    renderSelect("approved", true);
    expect(screen.getByTestId("select").getAttribute("data-value")).toBe("expired");
    const trigger = screen.getByTestId("trigger");
    expect(trigger.textContent).toContain("Expired");
    expect(trigger.textContent).toContain("Session: Approved");
    expect(trigger.getAttribute("aria-label")).toMatch(/Expired \(period 2\); session status Approved/);
  });

  it("expired period: picking Approved never restores silently — Cancel does nothing", () => {
    const { onSetRowStatus, onRequestPeriodExpiry } = renderSelect("pending", true);
    fireEvent.click(option("approved"));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Authorization Period 2 stays Expired/);
    expect(dialog.textContent).toMatch(/does not restore/);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onSetRowStatus).not.toHaveBeenCalled();
    expect(onRequestPeriodExpiry).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("expired period: Review Restore Period opens the existing reviewed Restore dialog", () => {
    const { onSetRowStatus, onRequestPeriodExpiry } = renderSelect("pending", true);
    fireEvent.click(option("approved"));
    fireEvent.click(screen.getByRole("button", { name: /review restore period/i }));
    expect(onRequestPeriodExpiry).toHaveBeenCalledTimes(1);
    expect(onSetRowStatus).not.toHaveBeenCalled();
  });

  it("expired period: an explicit session-only change writes the row status; the period is not restored", () => {
    const { onSetRowStatus, onRequestPeriodExpiry } = renderSelect("pending", true);
    fireEvent.click(option("approved"));
    fireEvent.click(screen.getByRole("button", { name: /change session status only/i }));
    expect(onSetRowStatus).toHaveBeenCalledWith("approved");
    expect(onRequestPeriodExpiry).not.toHaveBeenCalled();
  });

  it("expired period: picking Expired again does nothing", () => {
    const { onSetRowStatus, onRequestPeriodExpiry } = renderSelect("approved", true);
    fireEvent.click(option("expired"));
    expect(onSetRowStatus).not.toHaveBeenCalled();
    expect(onRequestPeriodExpiry).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
