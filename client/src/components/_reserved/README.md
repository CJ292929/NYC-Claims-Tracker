# Reserved Components

These components were built during earlier iterations but are not currently
wired into the app. They are preserved here (rather than deleted) because
they may be adopted during future dashboard redesign work.

Do not import these components into active code without a specific plan.
If a component from this folder is being promoted back into active use,
move it out of `_reserved/` back to `src/components/` as part of the
change that uses it.

Components in this folder:
- **AIChatBox**: Chat widget UI. Only ever imported by `ComponentShowcase.tsx`
  (itself an unrouted showcase page, not part of the live app); that import
  was repointed to `_reserved/AIChatBox` so the showcase page still compiles.
- **ManusDialog**: Generic login-modal scaffold, unused anywhere.
- **Map**: Google Maps wrapper/integration guide, unused anywhere.

## Not moved, despite appearing dead-code-adjacent in the audit

- **Logo.tsx** stays in `src/components/` — it's actively imported and
  rendered by `Login.tsx` (`<Logo variant="icon" .../>`). The audit noted
  that `Dashboard.tsx` renders the PNG asset directly instead of this
  component, which is true, but didn't check `Login.tsx`, which does use it.
- **DashboardLayoutSkeleton.tsx** stays in `src/components/` — it's a direct
  dependency of `DashboardLayout.tsx` (`import { DashboardLayoutSkeleton }
  from './DashboardLayoutSkeleton'`). `DashboardLayout.tsx` is intentionally
  staying in place this session since it graduates to the primary layout in
  Session 2, so moving its own dependency out from under it would just break
  it now and require undoing next session.

Last updated: 2026-07-13
Related audit: DASHBOARD_AUDIT_2026-07-13.md
