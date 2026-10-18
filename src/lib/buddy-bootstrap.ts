import type { CommonProfileData } from '@napplet/sdk';
import { resolvedProfileLabel } from './buddy-label.js';

export const HIM_BUDDY_BOOTSTRAP_KEY_PREFIX = 'him:buddy-bootstrap:v1';
export const HIM_BUDDY_BOOTSTRAP_MAX_ENTRIES = 256;
export const HIM_BUDDY_BOOTSTRAP_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const HIM_BUDDY_BOOTSTRAP_ONLINE_MAX_AGE_SECONDS = 45;

export interface HimBuddyBootstrapEntry {
  pubkey: string;
  profile: CommonProfileData;
  online: boolean;
}

export interface HimBuddyBootstrapSnapshot {
  ownerPubkey: string;
  capturedAt: number;
  buddies: HimBuddyBootstrapEntry[];
}

const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

export function himBuddyBootstrapKey(ownerPubkey: string): string {
  return `${HIM_BUDDY_BOOTSTRAP_KEY_PREFIX}:${ownerPubkey.toLowerCase()}`;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= maxLength
    ? value
    : undefined;
}

function compactProfile(value: unknown): CommonProfileData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const profile: CommonProfileData = {
    name: boundedString(source.name, 128),
    displayName: boundedString(source.displayName, 128),
    display_name: boundedString(source.display_name, 128),
    nip05: boundedString(source.nip05, 256),
    picture: boundedString(source.picture, 2_048),
  };
  return resolvedProfileLabel(profile) ? profile : null;
}

export function parseHimBuddyBootstrap(
  raw: string | null,
  ownerPubkey: string,
  now = Math.floor(Date.now() / 1_000),
): HimBuddyBootstrapSnapshot | null {
  if (!raw || !PUBKEY_PATTERN.test(ownerPubkey)) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = value as Record<string, unknown>;
    if (snapshot.ownerPubkey !== ownerPubkey) return null;
    if (!Number.isInteger(snapshot.capturedAt)) return null;
    const capturedAt = snapshot.capturedAt as number;
    if (capturedAt <= 0 || capturedAt > now + 60) return null;
    if (now - capturedAt > HIM_BUDDY_BOOTSTRAP_MAX_AGE_SECONDS) return null;
    if (!Array.isArray(snapshot.buddies)) return null;

    const seen = new Set<string>();
    const buddies: HimBuddyBootstrapEntry[] = [];
    for (const candidate of snapshot.buddies) {
      if (buddies.length >= HIM_BUDDY_BOOTSTRAP_MAX_ENTRIES) break;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const entry = candidate as Record<string, unknown>;
      const pubkey = typeof entry.pubkey === 'string' ? entry.pubkey.toLowerCase() : '';
      const profile = compactProfile(entry.profile);
      if (!PUBKEY_PATTERN.test(pubkey) || seen.has(pubkey) || !profile) continue;
      seen.add(pubkey);
      buddies.push({
        pubkey,
        profile,
        online: entry.online === true
          && now - capturedAt <= HIM_BUDDY_BOOTSTRAP_ONLINE_MAX_AGE_SECONDS,
      });
    }
    return { ownerPubkey, capturedAt, buddies };
  } catch {
    return null;
  }
}

export function serializeHimBuddyBootstrap(snapshot: HimBuddyBootstrapSnapshot): string {
  const buddies = snapshot.buddies
    .slice(0, HIM_BUDDY_BOOTSTRAP_MAX_ENTRIES)
    .flatMap((entry) => {
      const profile = compactProfile(entry.profile);
      if (!PUBKEY_PATTERN.test(entry.pubkey) || !profile) return [];
      return [{ pubkey: entry.pubkey, profile, online: entry.online }];
    });
  return JSON.stringify({
    ownerPubkey: snapshot.ownerPubkey,
    capturedAt: snapshot.capturedAt,
    buddies,
  });
}
