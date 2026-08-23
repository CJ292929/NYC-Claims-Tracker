import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This project's vitest config runs in a plain node environment with no
// React/JSX runtime wired in (tsconfig sets "jsx": "preserve", which is only
// resolved by @vitejs/plugin-react at real build/dev time — vitest.config.ts
// doesn't include that plugin). Actually *calling* Router() here to inspect
// its rendered output would throw "React is not defined". So this test
// verifies the route wiring at the source level, plus exercises the actual
// matching RegExp (a real value, not source text) directly — that's enough
// to catch the regression it guards against without adding rendering infra
// that doesn't otherwise exist in this project (no jsdom/happy-dom/
// react-test-renderer/@testing-library/react are installed).
//
// Importing Dashboard.tsx also has a real problem in this environment (an
// unrelated component has a module-scope JSX literal that crashes under the
// same missing-JSX-runtime constraint), so it's stubbed out here purely to
// keep the import of DASHBOARD_ROUTE_PATHS side-effect-free.
vi.mock('./pages/Dashboard', () => ({ default: () => null }));
vi.mock('./pages/Login', () => ({ default: () => null }));

const { DASHBOARD_ROUTE_PATHS, DASHBOARD_ROUTE_PATTERN } = await import('./App');

const appSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.tsx'),
  'utf-8'
);

/**
 * Regression test for the route-remount bug (PR #50 v1, then still
 * reproducing in production afterward — see PR #50 v2).
 *
 * v1 diagnosis: every <Route> was given a distinct inline arrow function as
 * its `component` prop, so distinct function references looked like distinct
 * component types to React/wouter. Fixed by sharing one `ProtectedDashboard`
 * reference across all Dashboard-backed routes.
 *
 * That fix was necessary but not sufficient. wouter's <Switch> matches one
 * child <Route> per render and returns `cloneElement(matchedElement, {
 * match })` — cloneElement does not touch `key`, so whatever `key` the
 * matched element originally had is preserved on Switch's single rendered
 * output. The v1 router built the Dashboard-backed routes via
 * `DASHBOARD_ROUTE_PATHS.map((path) => <Route key={path} .../>)`, so the key
 * on that single output element changed on every cross-route navigation
 * (e.g. key="/patients/records" -> key="/visits") even though `component`
 * never changed. React's single-child reconciliation treats a changed `key`
 * as a different element and unmounts/remounts the old subtree before
 * mounting the new one — destroying all of Dashboard's local state
 * (selectedPatientId, selectedRecordsPatientId, filters, etc.) on every
 * cross-route navigation between Dashboard-backed paths.
 *
 * v2 fix: route all Dashboard-backed paths through one *static* <Route>
 * matched by a single RegExp (DASHBOARD_ROUTE_PATTERN), instead of one
 * <Route> per path from `.map()`. A static JSX child needs no `key`, so
 * there is nothing for React to see change between navigations — the same
 * keyless element (and therefore the same ProtectedDashboard/Dashboard
 * instance) is reused for every Dashboard-backed path.
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

  it('routes every Dashboard path through one static, keyless <Route>, not a per-path .map()', () => {
    const routerBody = appSource.slice(appSource.indexOf('export function Router'));

    // Exactly one JSX element mounts ProtectedDashboard...
    const occurrences = routerBody.match(/<Route[^>]*component=\{ProtectedDashboard\}[^>]*\/>/g) ?? [];
    expect(occurrences).toHaveLength(1);

    // ...and it must not be produced by mapping over DASHBOARD_ROUTE_PATHS
    // (which is exactly what reintroduces a per-path `key` and the remount
    // bug this test guards against).
    expect(routerBody).not.toContain('DASHBOARD_ROUTE_PATHS.map');

    // A `key` prop on the Dashboard route is the specific mechanism that
    // caused the remount (see comment above) — guard against it coming back
    // in any form, not just via .map().
    expect(occurrences[0]).not.toMatch(/\bkey=/);

    // It must match via DASHBOARD_ROUTE_PATTERN, the RegExp exercised for
    // real below, not a hardcoded/duplicated path list that could drift.
    expect(occurrences[0]).toContain('path={DASHBOARD_ROUTE_PATTERN}');
  });

  it('DASHBOARD_ROUTE_PATTERN matches every Dashboard-backed path exactly once', () => {
    for (const routePath of DASHBOARD_ROUTE_PATHS) {
      expect(DASHBOARD_ROUTE_PATTERN.test(routePath)).toBe(true);
    }
  });

  it('DASHBOARD_ROUTE_PATTERN does not match unrelated or merely-similar paths', () => {
    const nonMatches = [
      '/login',
      '/404',
      '/',
      '/patients/records/',
      '/patients/records/extra',
      '/patients/recordsx',
      '/visitsx',
      '/xvisits',
      '/authorizations/attention/extra',
      '/claim',
      '',
    ];
    for (const candidate of nonMatches) {
      expect(DASHBOARD_ROUTE_PATTERN.test(candidate)).toBe(false);
    }
  });

});
