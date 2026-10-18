import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HIM_SECTION_STATE,
  parseHimSectionState,
  serializeHimSectionState,
} from './section-state.js';

describe('HIM section state', () => {
  it('opens presence lists and collapses follower and pending lists by default', () => {
    expect(parseHimSectionState(null)).toEqual({
      online: true,
      offline: true,
      followers: false,
      pending: false,
    });
  });

  it('restores every persisted collapsible independently', () => {
    const state = {
      online: false,
      offline: true,
      followers: true,
      pending: true,
    };

    expect(parseHimSectionState(serializeHimSectionState(state))).toEqual(state);
  });

  it('uses per-section defaults for invalid or older stored data', () => {
    expect(parseHimSectionState('{"online":false}')).toEqual({
      ...DEFAULT_HIM_SECTION_STATE,
      online: false,
    });
    expect(parseHimSectionState('not json')).toEqual(DEFAULT_HIM_SECTION_STATE);
  });
});
