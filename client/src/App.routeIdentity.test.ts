import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This project's vitest config runs in a plain node environment with no
// React/JSX runtime wired in (tsconfig sets "jsx": "preserve", which is only
// resolved by @vitejs/plugin-react at real build/dev time — vitest.config.ts
// doesn't include that plugin). Actually *calling* Router() here to inspect
// its rendered output would throw "React is not defined". So this test
// verifies the route wiring at the source level instead, which is enough to
// catch the regression it guards against and doesn't require adding
// rendering infra that doesn't otherwise exist in this project.
//
// Importing Dashboard.tsx also has a real problem in this environment (an
// unrelated component has a module-scope JSX literal that crashes under the
// same missing-JSX-runtime constraint), so it's stubbed out here purely to
// keep the import of DASHBOARD_ROUTE_PATHS side-effect-free.
vi.mock('./pages/Dashboard', () => ({ default: () => null }));
vi.mock('./pages/Login', () => ({ default: () => null }));

const { DASHBOARD_ROUTE_PATHS } = await import('./App');

const appSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.tsx'),
  'utf-8'
);

/**
 * Regression test for the route-remount bug: navigating between
 * Dashboard-backed routes (e.g. /patients/records -> /visits) used to
 * unmount/remount the Dashboard subtree because each <Route> was given a
 * distinct inline arrow function as its `component` prop — distinct function
 * references are distinct component types to React/wouter, so every
 * cross-route navigation destroyed local Dashboard state (selectedPatientId,
 * etc.), producing "No patient selected" on /visits right after selecting a
 * patient elsewhere.
 */
describe('Dashboard-backed route wiring', () => {
  it('lists every route that must share one Dashboard instance', () => {
    expect(DASHBOARD_ROUTE_PATHS).toEqual([
      '/dashboard',
      '/patients',
      '/patients/records',
      '/patients/discharged',
      '/authorizations',
      '/authorizations/attention',
      '/authorizations/records',
      '/visits',
      '/claims',
    ]);
  });

  it('defines exactly one component expression that mounts the protected Dashboard', () => {
    const occurrences = appSource.match(/<ProtectedRoute component=\{Dashboard\}\s*\/>/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('routes every Dashboard path through that single shared reference, not a per-route closure', () => {
    const routerBody = appSource.slice(appSource.indexOf('export function Router'));

    expect(routerBody).toMatch(
      /DASHBOARD_ROUTE_PATHS\.map\(\s*\(path\)\s*=>\s*\(\s*<Route key=\{path\} path=\{path\} component=\{ProtectedDashboard\}\s*\/>\s*\)\s*\)/
    );

    for (const routePath of DASHBOARD_ROUTE_PATHS) {
      expect(routerBody).not.toContain(`path="${routePath}" component={() =>`);
    }
  });
});
