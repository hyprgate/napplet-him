import type { CommonProfileData } from '@napplet/sdk';

export function shortPubkey(pubkey: string): string {
  return pubkey.length > 18 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-6)}` : pubkey;
}

export function resolvedProfileLabel(profile: CommonProfileData | null): string | null {
  const labels = [profile?.displayName, profile?.display_name, profile?.name, profile?.nip05];
  for (const label of labels) {
    if (typeof label === 'string' && label.trim().length > 0) return label.trim();
  }
  return null;
}

export function profileLabel(profile: CommonProfileData | null, pubkey: string): string {
  return resolvedProfileLabel(profile) ?? shortPubkey(pubkey);
}
