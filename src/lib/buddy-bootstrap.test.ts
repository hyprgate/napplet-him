import { describe, expect, it } from 'vitest';
import {
  HIM_BUDDY_BOOTSTRAP_MAX_AGE_SECONDS,
  HIM_BUDDY_BOOTSTRAP_ONLINE_MAX_AGE_SECONDS,
  himBuddyBootstrapKey,
  parseHimBuddyBootstrap,
  serializeHimBuddyBootstrap,
} from './buddy-bootstrap.js';

const OWNER = 'a'.repeat(64);
const BUDDY = 'b'.repeat(64);
const NOW = 10_000_000;

describe('HIM buddy bootstrap cache', () => {
  it('round-trips bounded resolved profiles and recent online hints', () => {
    const raw = serializeHimBuddyBootstrap({
      ownerPubkey: OWNER,
      capturedAt: NOW,
      buddies: [{
        pubkey: BUDDY,
        online: true,
        profile: {
          display_name: 'Cached Buddy',
          picture: 'https://example.com/cached.png',
          about: 'not needed for bootstrap rendering',
        },
      }],
    });

    expect(himBuddyBootstrapKey(OWNER)).toBe(`him:buddy-bootstrap:v1:${OWNER}`);
    expect(parseHimBuddyBootstrap(raw, OWNER, NOW)).toEqual({
      ownerPubkey: OWNER,
      capturedAt: NOW,
      buddies: [{
        pubkey: BUDDY,
        online: true,
        profile: {
          name: undefined,
          displayName: undefined,
          display_name: 'Cached Buddy',
          nip05: undefined,
          picture: 'https://example.com/cached.png',
        },
      }],
    });
    expect(raw).not.toContain('not needed for bootstrap rendering');
  });

  it('expires online hints before resolved identity metadata', () => {
    const raw = serializeHimBuddyBootstrap({
      ownerPubkey: OWNER,
      capturedAt: NOW - HIM_BUDDY_BOOTSTRAP_ONLINE_MAX_AGE_SECONDS - 1,
      buddies: [{ pubkey: BUDDY, online: true, profile: { name: 'Still Cached' } }],
    });

    expect(parseHimBuddyBootstrap(raw, OWNER, NOW)?.buddies[0]).toMatchObject({
      pubkey: BUDDY,
      online: false,
      profile: { name: 'Still Cached' },
    });
  });

  it('rejects cross-owner and stale snapshots', () => {
    const raw = serializeHimBuddyBootstrap({
      ownerPubkey: OWNER,
      capturedAt: NOW - HIM_BUDDY_BOOTSTRAP_MAX_AGE_SECONDS - 1,
      buddies: [{ pubkey: BUDDY, online: false, profile: { name: 'Stale' } }],
    });

    expect(parseHimBuddyBootstrap(raw, 'c'.repeat(64), NOW)).toBeNull();
    expect(parseHimBuddyBootstrap(raw, OWNER, NOW)).toBeNull();
  });
});
