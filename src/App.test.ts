// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { himBuddyBootstrapKey, serializeHimBuddyBootstrap } from './lib/buddy-bootstrap.js';

const fixture = vi.hoisted(() => ({
  ownerPubkey: 'a'.repeat(64),
  buddyPubkey: 'b'.repeat(64),
  buddyPicture: 'https://example.com/buddy.png',
}));

const resourceImageBatch = vi.hoisted(() => vi.fn(
  (node: HTMLImageElement, source: string | null | undefined) => {
    if (source) node.dataset.resourceSource = source;
    return {
      update(nextSource: string | null | undefined): void {
        if (nextSource) node.dataset.resourceSource = nextSource;
        else delete node.dataset.resourceSource;
      },
      destroy(): void {
        delete node.dataset.resourceSource;
      },
    };
  },
));

const closeSubscription = vi.hoisted(() => vi.fn());
const publishedPresence = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const loadFollows = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, pubkeys: [fixture.buddyPubkey] }));
const relayQuery = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const storageValues = vi.hoisted(() => new Map<string, string>());

vi.mock('@hyprgate/utils', () => ({
  AIM_RUNNING_MAN_FILL_PATH: '',
  AIM_RUNNING_MAN_OUTLINE_PATH: '',
  AIM_RUNNING_MAN_VIEW_BOX: '0 0 1 1',
  resourceImageBatch,
}));

vi.mock('@napplet/sdk', () => ({
  common: {
    encodeNip19: vi.fn(),
    follow: vi.fn(),
    follows: loadFollows,
    getProfile: vi.fn().mockResolvedValue({
      ok: true,
      pubkey: fixture.buddyPubkey,
      profile: { display_name: 'Batched Buddy', picture: fixture.buddyPicture },
    }),
  },
  dm: {
    status: vi.fn().mockResolvedValue({ available: true, ownerPubkey: fixture.ownerPubkey }),
  },
  identity: { getPublicKey: vi.fn().mockResolvedValue(fixture.ownerPubkey) },
  intent: { invoke: vi.fn() },
  relay: {
    publish: publishedPresence,
    query: relayQuery,
    subscribe: vi.fn((filter, onEvent, onEose) => {
      if (!filter.kinds?.includes(3)) return { close: closeSubscription };
      onEvent({
        event: {
          id: 'c'.repeat(64),
          kind: 3,
          pubkey: fixture.buddyPubkey,
          created_at: 1,
          tags: [['p', fixture.ownerPubkey]],
          content: '',
          sig: 'd'.repeat(128),
        },
      });
      onEose();
      return { close: closeSubscription };
    }),
  },
  storage: {
    getItem: vi.fn(async (key: string) => storageValues.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storageValues.set(key, value); }),
  },
}));

describe('HIM buddy list', () => {
  afterEach(() => {
    vi.clearAllMocks();
    storageValues.clear();
    document.body.innerHTML = '';
  });

  it('routes resolved buddy avatars through the bytesMany batching action', async () => {
    const component = mount(App, { target: document.body });

    await vi.waitFor(() => {
      expect(resourceImageBatch).toHaveBeenCalledWith(
        expect.any(HTMLImageElement),
        fixture.buddyPicture,
      );
    });
    expect(document.querySelector('img')?.getAttribute('data-resource-source')).toBe(fixture.buddyPicture);
    await vi.waitFor(() => {
      const cached = storageValues.get(himBuddyBootstrapKey(fixture.ownerPubkey));
      expect(cached).toContain(fixture.buddyPubkey);
      expect(cached).toContain('Batched Buddy');
    });

    unmount(component);
  });

  it('starts offline and publishes status changes without owning persistence', async () => {
    const component = mount(App, { target: document.body });

    await vi.waitFor(() => expect(document.querySelector('.aim-titlebar small')?.textContent).toBe('Offline'));

    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="him-presence-menu-trigger"]')!;
    expect(trigger.querySelector('.aim-logo-outline')).not.toBeNull();
    expect(trigger.querySelector('.aim-logo-fill')).not.toBeNull();
    trigger.click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="him-presence-context-menu"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="him-remember-online"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid="him-status-online"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.aim-titlebar small')?.textContent).toBe('Online'));
    expect(publishedPresence).toHaveBeenCalledWith(expect.objectContaining({ content: 'online' }));

    unmount(component);
  });

  it('reverts a failed status change and lets the transient publish error be dismissed', async () => {
    publishedPresence.mockRejectedValueOnce(new Error('relay.publish timed out'));
    const component = mount(App, { target: document.body });

    await vi.waitFor(() => expect(document.querySelector('.aim-titlebar small')?.textContent).toBe('Offline'));
    document.querySelector<HTMLButtonElement>('[data-testid="him-presence-menu-trigger"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="him-status-online"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-testid="him-status-online"]')!.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="him-presence-error"]')?.textContent)
        .toContain('Online status update timed out');
      expect(document.querySelector('.aim-titlebar small')?.textContent).toBe('Offline');
    });
    expect(document.querySelector('[data-testid="him-error"]')).toBeNull();

    document.querySelector<HTMLButtonElement>('[data-testid="him-dismiss-presence-error"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="him-presence-error"]')).toBeNull());

    unmount(component);
  });

  it('paints a cached resolved buddy while live follows are still pending', async () => {
    storageValues.set(himBuddyBootstrapKey(fixture.ownerPubkey), serializeHimBuddyBootstrap({
      ownerPubkey: fixture.ownerPubkey,
      capturedAt: Math.floor(Date.now() / 1_000),
      buddies: [{
        pubkey: fixture.buddyPubkey,
        online: true,
        profile: { display_name: 'Warm Buddy', picture: fixture.buddyPicture },
      }],
    }));
    loadFollows.mockImplementationOnce(() => new Promise(() => {}));
    relayQuery.mockImplementationOnce(() => new Promise(() => {}));
    const component = mount(App, { target: document.body });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="him-buddy"] b')?.textContent).toBe('Warm Buddy');
      expect(document.querySelector('[data-testid="him-buddy"]')?.getAttribute('data-online')).toBe('true');
    });
    expect(loadFollows).toHaveBeenCalledOnce();

    unmount(component);
  });

  it('shows honest progress instead of empty-list claims while buddy discovery is pending', async () => {
    loadFollows.mockImplementationOnce(() => new Promise(() => {}));
    const component = mount(App, { target: document.body });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="him-loading"]')?.textContent)
        .toContain('Loading buddy list…');
    });
    expect(document.querySelector('[data-testid="him-section-online"] .empty')?.textContent)
      .toBe('Checking online friends…');
    expect(document.querySelector('[data-testid="him-section-offline"] .empty')?.textContent)
      .toBe('Checking offline friends…');
    expect(document.body.textContent).not.toContain('No friends online');
    expect(document.body.textContent).not.toContain('No offline friends');

    unmount(component);
  });

  it('streams buddies without waiting for own presence resolution', async () => {
    relayQuery.mockImplementation((filter: { kinds?: number[]; authors?: string[] }) => (
      filter.kinds?.includes(30315) && filter.authors?.includes(fixture.ownerPubkey)
        ? new Promise(() => {})
        : Promise.resolve([])
    ));
    const component = mount(App, { target: document.body });

    await vi.waitFor(() => expect(loadFollows).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="him-buddy"] b')?.textContent).toBe('Batched Buddy'));
    expect(relayQuery.mock.calls.some(([filter]) => (
      filter.kinds?.includes(30315) && filter.authors?.includes(fixture.ownerPubkey)
    ))).toBe(false);

    unmount(component);
  });
});
