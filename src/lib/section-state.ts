export const HIM_SECTION_STATE_KEY = 'him:section-state:v1';

export type HimSection = 'online' | 'offline' | 'followers' | 'pending';

export interface HimSectionState {
  online: boolean;
  offline: boolean;
  followers: boolean;
  pending: boolean;
}

export const DEFAULT_HIM_SECTION_STATE: HimSectionState = {
  online: true,
  offline: true,
  followers: false,
  pending: false,
};

export function parseHimSectionState(raw: string | null): HimSectionState {
  if (!raw) return { ...DEFAULT_HIM_SECTION_STATE };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ...DEFAULT_HIM_SECTION_STATE };
    }
    const stored = value as Partial<Record<HimSection, unknown>>;
    return {
      online: typeof stored.online === 'boolean' ? stored.online : DEFAULT_HIM_SECTION_STATE.online,
      offline: typeof stored.offline === 'boolean' ? stored.offline : DEFAULT_HIM_SECTION_STATE.offline,
      followers: typeof stored.followers === 'boolean' ? stored.followers : DEFAULT_HIM_SECTION_STATE.followers,
      pending: typeof stored.pending === 'boolean' ? stored.pending : DEFAULT_HIM_SECTION_STATE.pending,
    };
  } catch {
    return { ...DEFAULT_HIM_SECTION_STATE };
  }
}

export function serializeHimSectionState(state: HimSectionState): string {
  return JSON.stringify(state);
}
