import { describe, expect, it } from 'vitest';
import { profileLabel, resolvedProfileLabel } from './buddy-label.js';

describe('profileLabel', () => {
  it('uses available profile metadata', () => {
    expect(profileLabel({ displayName: 'Alice Example' }, 'a'.repeat(64))).toBe('Alice Example');
  });

  it('falls back to a shortened pubkey without metadata', () => {
    expect(profileLabel(null, 'b'.repeat(64))).toBe('bbbbbbbbbb…bbbbbb');
  });

  it('does not resolve a list label without usable profile metadata', () => {
    expect(resolvedProfileLabel(null)).toBeNull();
    expect(resolvedProfileLabel({})).toBeNull();
    expect(resolvedProfileLabel({ displayName: '   ' })).toBeNull();
    expect(resolvedProfileLabel({ displayName: '   ', name: 'Alice' })).toBe('Alice');
  });

  it('resolves a list label from profile metadata', () => {
    expect(resolvedProfileLabel({ displayName: 'Alice Example' })).toBe('Alice Example');
  });
});
