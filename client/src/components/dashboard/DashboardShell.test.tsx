// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DashboardShell } from "./DashboardShell";

// Regression test for a bug where the mobile Sheet's SidebarNav did not
// receive canManageStaff, so Staff Management stayed hidden on mobile even
// for admins who could see it on desktop.
function renderShell(canManageStaff: boolean) {
  const { container } = render(
    <DashboardShell
      onNavigate={() => {}}
      onSignOut={() => {}}
      canManageStaff={canManageStaff}
      topbarTitle="Dashboard"
    >
      <div>content</div>
    </DashboardShell>
  );

  fireEvent.click(screen.getByRole("button", { name: /open navigation/i }));

  const desktopNav = container.querySelector("aside");
  if (!desktopNav) throw new Error("desktop <aside> sidebar not found");
  const mobileNav = screen.getByRole("dialog");
  return { desktopNav, mobileNav };
}

describe("DashboardShell staff management nav parity", () => {
  it("shows Staff Management on both desktop and mobile sidebars for admins", () => {
    const { desktopNav, mobileNav } = renderShell(true);

    expect(within(desktopNav).getByText("Staff Management")).toBeTruthy();
    expect(within(mobileNav).getByText("Staff Management")).toBeTruthy();
  });

  it("hides Staff Management on both desktop and mobile sidebars for normal staff", () => {
    const { desktopNav, mobileNav } = renderShell(false);

    expect(within(desktopNav).queryByText("Staff Management")).toBeNull();
    expect(within(mobileNav).queryByText("Staff Management")).toBeNull();
  });
});
