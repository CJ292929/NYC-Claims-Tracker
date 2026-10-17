import { describe, it, expect } from 'vitest';
import { routeToNavSection, navSectionToRoute } from './navSection';

describe('routeToNavSection', () => {
  it('maps each real route to its sidebar section', () => {
    expect(routeToNavSection('/dashboard')).toBe('dashboard');
    expect(routeToNavSection('/patients')).toBe('patients-overview');
    expect(routeToNavSection('/patients/records')).toBe('patients-records');
    expect(routeToNavSection('/patients/discharged')).toBe('patients-discharged');
    expect(routeToNavSection('/authorizations')).toBe('authorizations-overview');
    expect(routeToNavSection('/authorizations/attention')).toBe('authorizations-attention');
    expect(routeToNavSection('/authorizations/records')).toBe('authorizations-records');
    expect(routeToNavSection('/visits')).toBe('visits');
    expect(routeToNavSection('/claims')).toBe('claims');
    expect(routeToNavSection('/staff')).toBe('staff');
    expect(routeToNavSection('/activity-log')).toBe('activity-log');
  });

  it('falls back to dashboard for "/" and any unrecognized path', () => {
    expect(routeToNavSection('/')).toBe('dashboard');
    expect(routeToNavSection('/something-else')).toBe('dashboard');
    expect(routeToNavSection('/patients/unknown')).toBe('dashboard');
  });
});

describe('navSectionToRoute', () => {
  it('is the inverse of routeToNavSection for every routable section', () => {
    expect(navSectionToRoute('dashboard')).toBe('/dashboard');
    expect(navSectionToRoute('patients-overview')).toBe('/patients');
    expect(navSectionToRoute('patients-records')).toBe('/patients/records');
    expect(navSectionToRoute('patients-discharged')).toBe('/patients/discharged');
    expect(navSectionToRoute('authorizations-overview')).toBe('/authorizations');
    expect(navSectionToRoute('authorizations-attention')).toBe('/authorizations/attention');
    expect(navSectionToRoute('authorizations-records')).toBe('/authorizations/records');
    expect(navSectionToRoute('visits')).toBe('/visits');
    expect(navSectionToRoute('claims')).toBe('/claims');
    expect(navSectionToRoute('staff')).toBe('/staff');
    expect(navSectionToRoute('activity-log')).toBe('/activity-log');
  });

  it('returns null for bulk-upload, which has no route of its own', () => {
    expect(navSectionToRoute('bulk-upload')).toBeNull();
  });
});
