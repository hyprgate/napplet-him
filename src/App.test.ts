// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { common, dm, intent } from '@napplet/sdk';
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
    encodeNip19: vi.fn().mockResolvedValue({ ok: false }),
    decodeNip19: vi.fn(),
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

  describe('people and actions', () => {
    const named = { ok: true, pubkey: fixture.buddyPubkey, profile: { display_name: 'Batched Buddy', picture: fixture.buddyPicture } };
    const pendingPubkey = 'e'.repeat(64);

    afterEach(() => {
      vi.mocked(common.getProfile).mockResolvedValue(named);
      vi.mocked(common.encodeNip19).mockResolvedValue({ ok: false });
      vi.mocked(dm.status).mockResolvedValue({ available: true, ownerPubkey: fixture.ownerPubkey, implementations: [], capabilities: [] });
      loadFollows.mockResolvedValue({ ok: true, pubkeys: [fixture.buddyPubkey] });
    });

    it('still lists a friend with no profile, under their npub', async () => {
      vi.mocked(common.getProfile).mockResolvedValue({ ok: true, pubkey: fixture.buddyPubkey, profile: null });
      vi.mocked(common.encodeNip19).mockResolvedValue({ ok: true, value: 'npub1buddybuddybuddybuddybuddybuddybuddy' });
      const component = mount(App, { target: document.body });
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="him-buddy"] b')?.textContent).toContain('npub1buddy');
      });
      unmount(component);
    });

    it('names pending people once friends have been handled, and opens their profile', async () => {
      loadFollows.mockResolvedValue({ ok: true, pubkeys: [fixture.buddyPubkey, pendingPubkey] });
      vi.mocked(common.getProfile).mockImplementation(async (target) => (
        target === pendingPubkey
          ? { ok: true, pubkey: pendingPubkey, profile: { name: 'Pending Person' } }
          : named
      ));
      vi.mocked(intent.invoke).mockResolvedValue({ ok: true } as never);
      const component = mount(App, { target: document.body });
      const row = await vi.waitFor(() => {
        const element = document.querySelector<HTMLElement>(`[data-testid="him-pending"][data-pubkey="${pendingPubkey}"]`);
        expect(element?.querySelector('b')?.textContent).toBe('Pending Person');
        return element!;
      }, { timeout: 3_000 });
      const lookups = vi.mocked(common.getProfile).mock.calls.map(([target]) => target);
      expect(lookups.indexOf(fixture.buddyPubkey)).toBeLessThan(lookups.indexOf(pendingPubkey));
      row.querySelector('button')!.click();
      expect(intent.invoke).toHaveBeenCalledWith('napplet:profile/open', { payload: { pubkey: pendingPubkey }, behavior: { focus: true, reuse: true } });
      unmount(component);
    });

    it('opens a profile from the avatar, and from the name of an offline friend', async () => {
      vi.mocked(intent.invoke).mockResolvedValue({ ok: true } as never);
      const component = mount(App, { target: document.body });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="him-buddy"] b')?.textContent).toBe('Batched Buddy'));
      const profileCall = ['napplet:profile/open', { payload: { pubkey: fixture.buddyPubkey }, behavior: { focus: true, reuse: true } }];
      document.querySelector<HTMLButtonElement>('[data-testid="him-buddy-avatar"]')!.click();
      expect(intent.invoke).toHaveBeenLastCalledWith(...profileCall);
      vi.mocked(intent.invoke).mockClear();
      document.querySelector<HTMLButtonElement>('[data-testid="him-buddy-identity"]')!.click();
      expect(intent.invoke).toHaveBeenLastCalledWith(...profileCall);
      unmount(component);
    });

    it('adds a buddy without a form, says what is wrong with bad input, and follows a good npub', async () => {
      const npub = 'npub1newbuddynewbuddynewbuddy';
      vi.mocked(common.decodeNip19).mockResolvedValue({ ok: true, nip19Type: 'npub', hex: 'f'.repeat(64) });
      vi.mocked(common.follow).mockResolvedValue({ ok: true });
      const component = mount(App, { target: document.body });
      await vi.waitFor(() => expect(document.querySelector('.aim-titlebar small')?.textContent).toBe('Offline'));
      // The allow-scripts sandbox never fires `submit`, so this can't rely on a form.
      expect(document.querySelector('form')).toBeNull();
      const input = document.querySelector<HTMLInputElement>('[data-testid="him-add-buddy-input"]')!;
      input.value = 'not a key';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(document.querySelector('[data-testid="him-add-error"]')?.textContent).toContain('npub or public key'));
      expect(common.follow).not.toHaveBeenCalled();

      input.value = npub;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-testid="him-add-buddy"]')?.disabled).toBe(false));
      document.querySelector<HTMLButtonElement>('[data-testid="him-add-buddy"]')!.click();
      await vi.waitFor(() => expect(common.follow).toHaveBeenCalledWith(npub));
      unmount(component);
    });

    it('explains what a read-only account can do and turns off what it cannot', async () => {
      vi.mocked(dm.status).mockResolvedValue({ available: false, ownerPubkey: fixture.ownerPubkey, implementations: [], capabilities: [] });
      const component = mount(App, { target: document.body });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="him-unavailable"]')?.textContent).toContain('signer'));
      expect(document.querySelector('.aim-titlebar small')?.textContent).toBe('Messenger unavailable');
      expect(document.querySelector<HTMLInputElement>('[data-testid="him-add-buddy-input"]')?.disabled).toBe(true);
      expect(document.querySelector('[data-testid="him-go-online"]')).toBeNull();
      unmount(component);
    });

    it('offers a direct way online when the account can chat', async () => {
      const component = mount(App, { target: document.body });
      const button = await vi.waitFor(() => {
        const element = document.querySelector<HTMLButtonElement>('[data-testid="him-go-online"]');
        expect(element).not.toBeNull();
        return element!;
      });
      button.click();
      await vi.waitFor(() => expect(document.querySelector('.aim-titlebar small')?.textContent).toBe('Online'));
      expect(publishedPresence).toHaveBeenCalled();
      expect(document.querySelector('[data-testid="him-go-online"]')).toBeNull();
      unmount(component);
    });
  });
});
