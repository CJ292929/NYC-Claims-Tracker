// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DashboardShell } from "./DashboardShell";

afterEach(cleanup);

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

describe("DashboardShell desktop sidebar toggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to open, hides the sidebar on toggle, and restores it on a second click", () => {
    const { container } = render(
      <DashboardShell onNavigate={() => {}} onSignOut={() => {}} topbarTitle="Dashboard">
        <div>content</div>
      </DashboardShell>
    );

    const aside = container.querySelector("aside");
    if (!aside) throw new Error("desktop <aside> sidebar not found");
    const toggle = screen.getByRole("button", { name: /hide sidebar/i });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(aside.getAttribute("aria-hidden")).toBe("false");

    fireEvent.click(toggle);

    const reopenToggle = screen.getByRole("button", { name: /show sidebar/i });
    expect(reopenToggle.getAttribute("aria-expanded")).toBe("false");
    expect(aside.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(reopenToggle);

    expect(screen.getByRole("button", { name: /hide sidebar/i }).getAttribute("aria-expanded")).toBe("true");
    expect(aside.getAttribute("aria-hidden")).toBe("false");
  });

  it("persists the desktop preference across remounts", () => {
    const first = render(
      <DashboardShell onNavigate={() => {}} onSignOut={() => {}} topbarTitle="Dashboard">
        <div>content</div>
      </DashboardShell>
    );
    fireEvent.click(screen.getByRole("button", { name: /hide sidebar/i }));
    first.unmount();

    render(
      <DashboardShell onNavigate={() => {}} onSignOut={() => {}} topbarTitle="Dashboard">
        <div>content</div>
      </DashboardShell>
    );

    expect(screen.getByRole("button", { name: /show sidebar/i })).toBeTruthy();
  });
});
