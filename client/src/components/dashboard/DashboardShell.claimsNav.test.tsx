// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DashboardShell } from "./DashboardShell";

afterEach(cleanup);

// P4-P23: the Claims nav item is Super Admin only, on BOTH the desktop
// sidebar and the mobile drawer (the earlier Staff Management parity bug
// showed the two can drift), and fails closed when the prop is omitted.
function renderShell(props: { canAccessClaims?: boolean; canManageStaff?: boolean }) {
  const { container } = render(
    <DashboardShell onNavigate={() => {}} onSignOut={() => {}} topbarTitle="Dashboard" {...props}>
      <div>content</div>
    </DashboardShell>
  );
  fireEvent.click(screen.getByRole("button", { name: /open navigation/i }));
  const desktopNav = container.querySelector("aside");
  if (!desktopNav) throw new Error("desktop <aside> sidebar not found");
  return { desktopNav, mobileNav: screen.getByRole("dialog") };
}

describe("DashboardShell Claims nav visibility", () => {
  it("shows Claims on desktop and mobile for the Super Admin", () => {
    const { desktopNav, mobileNav } = renderShell({ canAccessClaims: true, canManageStaff: true });
    expect(within(desktopNav).getByText("Claims")).toBeTruthy();
    expect(within(mobileNav).getByText("Claims")).toBeTruthy();
  });

  it("hides Claims on desktop and mobile for a clinic admin, keeping Patients/Authorizations/Management", () => {
    const { desktopNav, mobileNav } = renderShell({ canAccessClaims: false, canManageStaff: true });
    for (const nav of [desktopNav, mobileNav]) {
      expect(within(nav).queryByText("Claims")).toBeNull();
      expect(within(nav).getByText("Patients")).toBeTruthy();
      expect(within(nav).getByText("Authorizations")).toBeTruthy();
      expect(within(nav).getByText("Visits")).toBeTruthy();
      expect(within(nav).getByText("Staff Management")).toBeTruthy();
    }
  });

  it("hides Claims for staff and when the capability prop is omitted", () => {
    for (const props of [{ canAccessClaims: false }, {}]) {
      const { desktopNav, mobileNav } = renderShell(props);
      expect(within(desktopNav).queryByText("Claims")).toBeNull();
      expect(within(mobileNav).queryByText("Claims")).toBeNull();
      cleanup();
    }
  });
});
