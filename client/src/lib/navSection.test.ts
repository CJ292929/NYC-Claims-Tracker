import { describe, it, expect } from 'vitest';
import { routeToNavSection } from './navSection';

describe('routeToNavSection', () => {
  it('maps each real route to its sidebar section', () => {
    expect(routeToNavSection('/dashboard')).toBe('dashboard');
    expect(routeToNavSection('/patients')).toBe('patients');
    expect(routeToNavSection('/authorizations')).toBe('authorizations');
    expect(routeToNavSection('/visits')).toBe('visits');
    expect(routeToNavSection('/claims')).toBe('claims');
  });

  it('falls back to dashboard for "/" and any unrecognized path', () => {
    expect(routeToNavSection('/')).toBe('dashboard');
    expect(routeToNavSection('/something-else')).toBe('dashboard');
  });
});
