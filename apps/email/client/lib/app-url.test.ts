import { describe, expect, it } from 'bun:test';
import { absoluteAppUrl } from './app-url';

describe('absoluteAppUrl', () => {
  it('falls back to a root-relative path when no origin is available', () => {
    // Self-hosted builds omit VITE_PUBLIC_APP_URL; in Node/bun tests window is
    // also absent. The old `${import.meta.env.VITE_PUBLIC_APP_URL}/login`
    // pattern stringified to "undefined/login" and broke logout redirects.
    expect(absoluteAppUrl('/login')).toBe('/login');
    expect(absoluteAppUrl('/login')).not.toContain('undefined');
  });
});
