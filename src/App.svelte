<script lang="ts">
  import { onMount } from 'svelte';
  import {
    common,
    dm,
    identity,
    intent,
    relay,
    storage,
    type CommonProfileData,
    type NostrEvent,
    type Subscription,
  } from '@napplet/sdk';
  import {
    AIM_RUNNING_MAN_FILL_PATH,
    AIM_RUNNING_MAN_OUTLINE_PATH,
    AIM_RUNNING_MAN_VIEW_BOX,
    resourceImageBatch,
  } from '@hyprgate/utils';
  import { profileLabel, resolvedProfileLabel, shortPubkey } from './lib/buddy-label.js';
  import {
    himBuddyBootstrapKey,
    parseHimBuddyBootstrap,
    serializeHimBuddyBootstrap,
  } from './lib/buddy-bootstrap.js';
  import { createEnrichmentQueue } from './lib/enrichment-queue.js';
  import {
    DEFAULT_HIM_SECTION_STATE,
    HIM_SECTION_STATE_KEY,
    parseHimSectionState,
    serializeHimSectionState,
    type HimSection,
    type HimSectionState,
  } from './lib/section-state.js';

  interface Buddy {
    pubkey: string;
    profile: CommonProfileData | null;
    profileResolved: boolean;
    relation: 'friend' | 'incoming' | 'outgoing';
    online: boolean;
  }

  interface BuddyContextMenu {
    pubkey: string;
    label: string;
    x: number;
    y: number;
  }

  interface PresenceContextMenu {
    x: number;
    y: number;
  }

  const PRESENCE_KIND = 30315;
  const PRESENCE_D_TAG = 'hyprgate-him';
  const PRESENCE_TTL_SECONDS = 45;
  const PRESENCE_ERROR_TTL_MS = 8_000;
  const BUDDY_BOOTSTRAP_READ_TIMEOUT_MS = 250;
  const BUDDY_BOOTSTRAP_WRITE_DELAY_MS = 250;
  const MUTUAL_FOLLOW_RELAYS = ['wss://purplepag.es', 'wss://relay.primal.net'] as const;

  let ownerPubkey = $state('');
  let buddies = $state<Buddy[]>([]);
  let loading = $state(true);
  let error = $state('');
  let presenceError = $state('');
  let messengerStatusResolved = $state(false);
  let messengerAvailable = $state(false);
  let online = $state(false);
  let addTarget = $state('');
  let adding = $state(false);
  let buddyContextMenu = $state<BuddyContextMenu | null>(null);
  let presenceContextMenu = $state<PresenceContextMenu | null>(null);
  let sectionState = $state<HimSectionState>({ ...DEFAULT_HIM_SECTION_STATE });
  let sectionStateHydrated = false;
  let sectionStateChangedBeforeHydration = false;
  let buddyLoadRevision = 0;
  let buddySubscriptions: Subscription[] = [];
  let buddyLoadTimer: ReturnType<typeof setTimeout> | null = null;
  let presenceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let presenceErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let buddyBootstrapPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPresenceCreatedAt = 0;
  let followedPubkeys: Set<string> | null = null;
  let confirmedFriendPubkeys = new Set<string>();
  let mutualDiscoveryComplete = false;
  const enrichmentQueue = createEnrichmentQueue({ delayMs: 100 });

  const statusLine = $derived(
    !messengerStatusResolved
      ? 'Connecting…'
      : !messengerAvailable
        ? 'Messenger unavailable'
        : online ? 'Online' : 'Offline',
  );

  const onlineFriends = $derived(buddies.filter((buddy) => (
    buddy.relation === 'friend' && buddy.online && resolvedBuddyLabel(buddy) !== null
  )));
  const offlineFriends = $derived(buddies.filter((buddy) => (
    buddy.relation === 'friend' && !buddy.online && resolvedBuddyLabel(buddy) !== null
  )));
  const resolvingOnlineFriends = $derived(buddies.some((buddy) => (
    buddy.relation === 'friend' && buddy.online && !buddy.profileResolved
  )));
  const resolvingOfflineFriends = $derived(buddies.some((buddy) => (
    buddy.relation === 'friend' && !buddy.online && !buddy.profileResolved
  )));
  const followers = $derived(buddies.filter((buddy) => buddy.relation === 'incoming'));
  const outgoing = $derived(buddies.filter((buddy) => buddy.relation === 'outgoing'));

  function buddyLabel(buddy: Buddy): string {
    return profileLabel(buddy.profile, buddy.pubkey);
  }

  function resolvedBuddyLabel(buddy: Buddy): string | null {
    return resolvedProfileLabel(buddy.profile);
  }

  async function loadSectionState(): Promise<void> {
    try {
      const stored = parseHimSectionState(await storage.getItem(HIM_SECTION_STATE_KEY));
      if (!sectionStateChangedBeforeHydration) sectionState = stored;
    } catch {
      // Host-backed preferences are best-effort; defaults remain usable.
    } finally {
      sectionStateHydrated = true;
      if (sectionStateChangedBeforeHydration) persistSectionState();
    }
  }

  function persistSectionState(): void {
    void storage.setItem(HIM_SECTION_STATE_KEY, serializeHimSectionState(sectionState)).catch(() => {});
  }

  function clearPresenceError(): void {
    presenceError = '';
    if (presenceErrorTimer) clearTimeout(presenceErrorTimer);
    presenceErrorTimer = null;
  }

  function showPresenceError(cause: unknown): void {
    clearPresenceError();
    const message = cause instanceof Error ? cause.message : 'Could not update online status';
    presenceError = message === 'relay.publish timed out'
      ? 'Online status update timed out. Try again.'
      : message;
    presenceErrorTimer = setTimeout(clearPresenceError, PRESENCE_ERROR_TTL_MS);
  }

  async function publishOwnPresence(isOnline: boolean): Promise<boolean> {
    if (!messengerAvailable) return false;
    const now = Math.floor(Date.now() / 1_000);
    const createdAt = Math.max(now, lastPresenceCreatedAt + 1);
    lastPresenceCreatedAt = createdAt;
    try {
      await relay.publish({
        kind: PRESENCE_KIND,
        content: isOnline ? 'online' : 'offline',
        created_at: createdAt,
        tags: [
          ['d', PRESENCE_D_TAG],
          ['expiration', String(isOnline ? createdAt + PRESENCE_TTL_SECONDS : createdAt)],
        ],
      });
      clearPresenceError();
      return true;
    } catch (cause) {
      showPresenceError(cause);
      return false;
    }
  }

  async function setOnline(nextOnline: boolean): Promise<void> {
    presenceContextMenu = null;
    if (nextOnline && !messengerAvailable) {
      showPresenceError(new Error('Messenger is unavailable for this identity'));
      return;
    }
    if (online === nextOnline) return;
    const previousOnline = online;
    online = nextOnline;
    clearPresenceError();
    if (!await publishOwnPresence(nextOnline)) online = previousOnline;
  }

  function setSectionOpen(section: HimSection, open: boolean): void {
    if (sectionState[section] === open) return;
    sectionState = { ...sectionState, [section]: open };
    if (!sectionStateHydrated) {
      sectionStateChangedBeforeHydration = true;
      return;
    }
    persistSectionState();
  }

  function latestByAuthor(events: NostrEvent[]): Map<string, NostrEvent> {
    const latest = new Map<string, NostrEvent>();
    for (const event of events) {
      const previous = latest.get(event.pubkey);
      if (!previous || event.created_at > previous.created_at) latest.set(event.pubkey, event);
    }
    return latest;
  }

  function eventHasTag(event: NostrEvent | undefined, name: string, value: string): boolean {
    return Boolean(event?.tags.some((tag) => tag[0] === name && tag[1] === value));
  }

  function closeBuddySubscriptions(): void {
    for (const subscription of buddySubscriptions) subscription.close();
    buddySubscriptions = [];
    if (buddyLoadTimer) clearTimeout(buddyLoadTimer);
    buddyLoadTimer = null;
    if (presenceRefreshTimer) clearTimeout(presenceRefreshTimer);
    presenceRefreshTimer = null;
    if (buddyBootstrapPersistTimer) clearTimeout(buddyBootstrapPersistTimer);
    buddyBootstrapPersistTimer = null;
    enrichmentQueue.clear();
  }

  async function restoreBuddyBootstrap(owner: string, revision: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const raw = await Promise.race([
        storage.getItem(himBuddyBootstrapKey(owner)),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), BUDDY_BOOTSTRAP_READ_TIMEOUT_MS);
        }),
      ]);
      if (revision !== buddyLoadRevision) return;
      const snapshot = parseHimBuddyBootstrap(raw, owner);
      if (!snapshot) return;
      for (const cached of snapshot.buddies) {
        if (followedPubkeys && !followedPubkeys.has(cached.pubkey)) continue;
        const relation = mutualDiscoveryComplete && !confirmedFriendPubkeys.has(cached.pubkey)
          ? 'outgoing'
          : 'friend';
        upsertBuddy(cached.pubkey, relation, {
          profile: cached.profile,
          profileResolved: true,
          online: cached.online,
        });
      }
      schedulePresenceRefresh(revision, 0);
    } catch {
      // This is an optimization only; live relay discovery remains authoritative.
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function persistBuddyBootstrap(owner: string, revision: number): void {
    if (revision !== buddyLoadRevision || owner !== ownerPubkey) return;
    const cacheable = buddies.flatMap((buddy) => {
      if (
        buddy.relation !== 'friend'
        || !confirmedFriendPubkeys.has(buddy.pubkey)
        || !buddy.profile
        || !resolvedBuddyLabel(buddy)
      ) return [];
      return [{ pubkey: buddy.pubkey, profile: buddy.profile, online: buddy.online }];
    });
    void storage.setItem(himBuddyBootstrapKey(owner), serializeHimBuddyBootstrap({
      ownerPubkey: owner,
      capturedAt: Math.floor(Date.now() / 1_000),
      buddies: cacheable,
    })).catch(() => {});
  }

  function scheduleBuddyBootstrapPersist(owner: string, revision: number): void {
    if (buddyBootstrapPersistTimer) clearTimeout(buddyBootstrapPersistTimer);
    buddyBootstrapPersistTimer = setTimeout(() => {
      buddyBootstrapPersistTimer = null;
      persistBuddyBootstrap(owner, revision);
    }, BUDDY_BOOTSTRAP_WRITE_DELAY_MS);
  }

  function reconcileConfirmedFriends(revision: number): void {
    if (revision !== buddyLoadRevision || !followedPubkeys) return;
    buddies = buddies.flatMap((buddy) => {
      if (buddy.relation !== 'friend' || confirmedFriendPubkeys.has(buddy.pubkey)) return [buddy];
      if (!followedPubkeys.has(buddy.pubkey)) return [];
      return [{ ...buddy, relation: 'outgoing' as const, online: false }];
    });
    scheduleBuddyBootstrapPersist(ownerPubkey, revision);
  }

  function upsertBuddy(pubkey: string, relation: Buddy['relation'], patch: Partial<Buddy> = {}): void {
    const previous = buddies.find((buddy) => buddy.pubkey === pubkey);
    const next: Buddy = {
      pubkey,
      profile: previous?.profile ?? null,
      profileResolved: previous?.profileResolved ?? false,
      online: previous?.online ?? false,
      relation,
      ...patch,
    };
    buddies = previous
      ? buddies.map((buddy) => buddy.pubkey === pubkey ? next : buddy)
      : [...buddies, next];
    buddies.sort((a, b) => buddyLabel(a).localeCompare(buddyLabel(b)));
  }

  function presenceIsFresh(event: NostrEvent | undefined): boolean {
    if (!event || event.content !== 'online') return false;
    const now = Math.floor(Date.now() / 1_000);
    const expiresAt = Number(event.tags.find((tag) => tag[0] === 'expiration')?.[1] ?? 0);
    return eventHasTag(event, 'd', PRESENCE_D_TAG) && event.created_at >= now - 45 && expiresAt > now;
  }

  function applyOwnPresence(event: NostrEvent): void {
    if (event.pubkey !== ownerPubkey || event.created_at < lastPresenceCreatedAt) return;
    lastPresenceCreatedAt = event.created_at;
    online = presenceIsFresh(event);
    clearPresenceError();
  }

  function followOwnPresence(revision: number): void {
    const filter = {
      kinds: [PRESENCE_KIND],
      authors: [ownerPubkey],
      '#d': [PRESENCE_D_TAG],
      limit: 1,
    };
    buddySubscriptions.push(relay.subscribe(filter, (result) => {
      if (revision === buddyLoadRevision) applyOwnPresence(result.event);
    }, () => {}));
  }

  async function hydrateBuddyProfile(pubkey: string, revision: number): Promise<void> {
    const result = await common.getProfile(pubkey).catch(() => null);
    if (revision !== buddyLoadRevision) return;
    const current = buddies.find((buddy) => buddy.pubkey === pubkey);
    if (current) {
      upsertBuddy(pubkey, current.relation, {
        profile: result?.profile ?? null,
        profileResolved: true,
      });
      if (confirmedFriendPubkeys.has(pubkey)) scheduleBuddyBootstrapPersist(ownerPubkey, revision);
    }
  }

  async function hydrateFriendPresence(revision: number): Promise<void> {
    const friendPubkeys = buddies
      .filter((buddy) => buddy.relation === 'friend')
      .map((buddy) => buddy.pubkey);
    if (friendPubkeys.length === 0) return;
    const results = await relay.query({
      kinds: [PRESENCE_KIND],
      authors: friendPubkeys,
      '#d': [PRESENCE_D_TAG],
      limit: friendPubkeys.length,
    }).catch(() => []);
    if (revision !== buddyLoadRevision) return;
    const latest = latestByAuthor(results.map((result) => result.event));
    buddies = buddies.map((buddy) => buddy.relation === 'friend'
      ? { ...buddy, online: presenceIsFresh(latest.get(buddy.pubkey)) }
      : buddy);
    scheduleBuddyBootstrapPersist(ownerPubkey, revision);
  }

  function schedulePresenceRefresh(revision: number, delay = 250): void {
    if (presenceRefreshTimer) clearTimeout(presenceRefreshTimer);
    presenceRefreshTimer = setTimeout(() => {
      presenceRefreshTimer = null;
      if (revision === buddyLoadRevision) void hydrateFriendPresence(revision);
    }, delay);
  }

  function loadFollowers(owner: string, followed: Set<string>, revision: number): void {
    void relay.query({ kinds: [3], '#p': [owner], limit: 500 }).then((results) => {
      if (revision !== buddyLoadRevision) return;
      const latest = latestByAuthor(results.map((result) => result.event));
      for (const [pubkey, event] of latest) {
        if (followed.has(pubkey) || !eventHasTag(event, 'p', owner)) continue;
        upsertBuddy(pubkey, 'incoming');
        enrichmentQueue.enqueue(() => hydrateBuddyProfile(pubkey, revision));
      }
    }).catch(() => {});
  }

  async function loadBuddies(): Promise<void> {
    const revision = ++buddyLoadRevision;
    closeBuddySubscriptions();
    loading = true;
    error = '';
    buddies = [];
    followedPubkeys = null;
    confirmedFriendPubkeys = new Set();
    mutualDiscoveryComplete = false;
    try {
      const dmStatus = await dm.status();
      if (revision !== buddyLoadRevision) return;
      ownerPubkey = dmStatus.ownerPubkey ?? await identity.getPublicKey();
      messengerAvailable = dmStatus.available;
      messengerStatusResolved = true;
      followOwnPresence(revision);
      const followsPromise = common.follows();
      void restoreBuddyBootstrap(ownerPubkey, revision);
      const followsResult = await followsPromise;
      if (revision !== buddyLoadRevision) return;
      if (!followsResult.ok) throw new Error(followsResult.error ?? 'Could not load follows');
      const followed = new Set(followsResult.pubkeys);
      followedPubkeys = followed;

      buddies = buddies.filter((buddy) => (
        buddy.relation !== 'friend' || followed.has(buddy.pubkey)
      ));

      for (const pubkey of followed) {
        const existing = buddies.find((buddy) => buddy.pubkey === pubkey);
        if (!existing) upsertBuddy(pubkey, 'outgoing');
      }
      loadFollowers(ownerPubkey, followed, revision);

      if (followed.size === 0) {
        mutualDiscoveryComplete = true;
        reconcileConfirmedFriends(revision);
        loading = false;
        return;
      }

      const resolvedAuthors = new Set<string>();
      let pendingRelays = MUTUAL_FOLLOW_RELAYS.length;
      const finishRelay = (): void => {
        if (revision !== buddyLoadRevision) return;
        pendingRelays = Math.max(0, pendingRelays - 1);
        if (pendingRelays === 0) {
          mutualDiscoveryComplete = true;
          loading = false;
          reconcileConfirmedFriends(revision);
        }
      };
      const filter = {
        kinds: [3],
        authors: [...followed],
        '#p': [ownerPubkey],
        limit: Math.max(1, followed.size),
      };

      for (const relayUrl of MUTUAL_FOLLOW_RELAYS) {
        try {
          buddySubscriptions.push(relay.subscribe(
            filter,
            (result) => {
              if (revision !== buddyLoadRevision) return;
              const event = result.event as NostrEvent;
              if (!followed.has(event.pubkey) || !eventHasTag(event, 'p', ownerPubkey)) return;
              // Promote each author immediately. Profile and presence hydration
              // remain independent so one slow lookup cannot hold back the list.
              upsertBuddy(event.pubkey, 'friend');
              confirmedFriendPubkeys.add(event.pubkey);
              scheduleBuddyBootstrapPersist(ownerPubkey, revision);
              if (resolvedAuthors.has(event.pubkey)) return;
              resolvedAuthors.add(event.pubkey);
              const current = buddies.find((buddy) => buddy.pubkey === event.pubkey);
              if (!current?.profileResolved) {
                enrichmentQueue.enqueue(() => hydrateBuddyProfile(event.pubkey, revision));
              }
              schedulePresenceRefresh(revision);
            },
            finishRelay,
            { relay: relayUrl },
          ));
        } catch {
          finishRelay();
        }
      }

      buddyLoadTimer = setTimeout(() => {
        if (revision === buddyLoadRevision) {
          mutualDiscoveryComplete = true;
          loading = false;
          reconcileConfirmedFriends(revision);
        }
      }, 8_000);
    } catch (cause) {
      if (revision !== buddyLoadRevision) return;
      error = cause instanceof Error ? cause.message : 'Buddy List could not connect';
      messengerAvailable = false;
      messengerStatusResolved = true;
      loading = false;
    }
  }

  async function normalizeNpub(value: string): Promise<string> {
    const target = value.trim();
    if (!target) throw new Error('Enter an npub or hex public key');
    if (target.startsWith('npub1')) return target;
    if (!/^[0-9a-f]{64}$/i.test(target)) throw new Error('Enter a valid npub or 64-character hex public key');
    const encoded = await common.encodeNip19({ type: 'npub', hex: target });
    if (!encoded.ok || !encoded.value) throw new Error(encoded.error ?? 'Could not encode public key');
    return encoded.value;
  }

  async function followTarget(target: string): Promise<void> {
    adding = true;
    error = '';
    try {
      const npub = await normalizeNpub(target);
      const result = await common.follow(npub);
      if (!result.ok) throw new Error(result.error ?? 'Follow was not published');
      addTarget = '';
      await loadBuddies();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not add this buddy';
    } finally {
      adding = false;
    }
  }

  async function openChat(pubkey: string): Promise<void> {
    const result = await intent.invoke('napplet:dm/open', {
      payload: { pubkey },
      behavior: { focus: true, reuse: true },
    });
    if (!result.ok) error = result.error ?? 'No direct messenger is installed';
  }

  async function openProfile(pubkey: string): Promise<void> {
    await intent.invoke('napplet:profile/open', { payload: { pubkey }, behavior: { focus: true, reuse: true } });
  }

  function placeBuddyContextMenu(buddy: Buddy, x: number, y: number): void {
    const margin = 4;
    const menuWidth = 150;
    const menuHeight = 34;
    buddyContextMenu = {
      pubkey: buddy.pubkey,
      label: buddyLabel(buddy),
      x: Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - menuHeight - margin)),
    };
  }

  function openBuddyContextMenu(event: MouseEvent, buddy: Buddy): void {
    event.preventDefault();
    event.stopPropagation();
    placeBuddyContextMenu(buddy, event.clientX, event.clientY);
  }

  function handleBuddyKeydown(event: KeyboardEvent, buddy: Buddy): void {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    placeBuddyContextMenu(buddy, rect.left + 18, rect.bottom);
  }

  async function openContextProfile(): Promise<void> {
    const selected = buddyContextMenu;
    buddyContextMenu = null;
    if (selected) await openProfile(selected.pubkey);
  }

  function placePresenceContextMenu(x: number, y: number): void {
    const margin = 4;
    const menuWidth = 238;
    const menuHeight = 102;
    presenceContextMenu = {
      x: Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - menuHeight - margin)),
    };
  }

  function openPresenceContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget as HTMLElement;
    const rect = button.getBoundingClientRect();
    const x = event.type === 'contextmenu' ? event.clientX : rect.left;
    const y = event.type === 'contextmenu' ? event.clientY : rect.bottom + 2;
    placePresenceContextMenu(x, y);
  }

  function handlePresenceLogoKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    placePresenceContextMenu(rect.left, rect.bottom + 2);
  }

  onMount(() => {
    void loadSectionState();
    void loadBuddies();
    const refreshTimer = setInterval(() => schedulePresenceRefresh(buddyLoadRevision, 0), 20_000);
    const closeContextMenu = (): void => {
      buddyContextMenu = null;
      presenceContextMenu = null;
    };
    const closeContextMenuOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeContextMenu();
    };
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('keydown', closeContextMenuOnEscape);
    window.addEventListener('blur', closeContextMenu);
    return () => {
      clearInterval(refreshTimer);
      document.removeEventListener('click', closeContextMenu);
      document.removeEventListener('keydown', closeContextMenuOnEscape);
      window.removeEventListener('blur', closeContextMenu);
      clearPresenceError();
      closeBuddySubscriptions();
    };
  });
</script>

<main class="buddy-window" data-testid="him-buddy-list">
  <header class="aim-titlebar">
    <button
      class="presence-menu-trigger"
      type="button"
      title="Set online status"
      aria-label="Set online status"
      aria-haspopup="menu"
      aria-expanded={presenceContextMenu !== null}
      onclick={openPresenceContextMenu}
      oncontextmenu={openPresenceContextMenu}
      onkeydown={handlePresenceLogoKeydown}
      data-testid="him-presence-menu-trigger"
    >
      <svg viewBox={AIM_RUNNING_MAN_VIEW_BOX} aria-hidden="true">
        <path class="aim-logo-outline" d={AIM_RUNNING_MAN_OUTLINE_PATH}></path>
        <path class="aim-logo-fill" d={AIM_RUNNING_MAN_FILL_PATH}></path>
      </svg>
    </button>
    <div><strong>Instant Messenger</strong><small>{statusLine}</small></div>
  </header>

  <section class="identity-strip">
    <span class:connected={statusLine === 'Online'}></span>
    <div><b>My Buddy List</b><small>{ownerPubkey ? shortPubkey(ownerPubkey) : 'No identity'}</small></div>
    <button type="button" onclick={() => { void loadBuddies(); }} disabled={loading} aria-label="Refresh buddy list">↻</button>
  </section>

  {#if error}<p class="notice" role="alert" data-testid="him-error">{error}</p>{/if}
  {#if presenceError}
    <div class="notice transient-notice" role="alert" data-testid="him-presence-error">
      <span>{presenceError}</span>
      <button
        type="button"
        aria-label="Dismiss online status error"
        onclick={clearPresenceError}
        data-testid="him-dismiss-presence-error"
      >×</button>
    </div>
  {/if}

  <section class="buddy-list" aria-label="Buddy List">
    {#if loading}
      <div class="buddy-loading" role="status" aria-live="polite" data-testid="him-loading">
        <span class="buddy-loading-spinner" aria-hidden="true"></span>
        <span>Loading buddy list…</span>
      </div>
    {/if}
    <details
      open={sectionState.online}
      ontoggle={(event) => setSectionOpen('online', event.currentTarget.open)}
      data-testid="him-section-online"
    >
      <summary>Online ({onlineFriends.length})</summary>
      {#each onlineFriends as buddy (buddy.pubkey)}
        {@render BuddyRow(buddy)}
      {:else}<p class="empty">{loading ? 'Checking online friends…' : resolvingOnlineFriends ? 'Resolving online friends…' : 'No friends online'}</p>{/each}
    </details>

    <details
      open={sectionState.offline}
      ontoggle={(event) => setSectionOpen('offline', event.currentTarget.open)}
      data-testid="him-section-offline"
    >
      <summary>Offline ({offlineFriends.length})</summary>
      {#each offlineFriends as buddy (buddy.pubkey)}
        {@render BuddyRow(buddy)}
      {:else}<p class="empty">{loading ? 'Checking offline friends…' : resolvingOfflineFriends ? 'Resolving offline friends…' : 'No offline friends'}</p>{/each}
    </details>

    {#if followers.length > 0}
      <details
        open={sectionState.followers}
        ontoggle={(event) => setSectionOpen('followers', event.currentTarget.open)}
        data-testid="him-section-followers"
      >
        <summary>Followers ({followers.length})</summary>
        {#each followers as buddy (buddy.pubkey)}
          <div class="buddy-row follower">
            <button class="buddy-identity" type="button" onclick={() => { void openProfile(buddy.pubkey); }}>
              <span class="avatar">
                {buddyLabel(buddy).slice(0, 1).toUpperCase()}
                {#if buddy.profile?.picture}<img use:resourceImageBatch={buddy.profile.picture} alt="" />{/if}
              </span>
              <span><b>{buddyLabel(buddy)}</b><small>{shortPubkey(buddy.pubkey)}</small></span>
            </button>
            <button
              class="follow-back"
              type="button"
              aria-label={`Follow back ${buddyLabel(buddy)}`}
              disabled={adding}
              onclick={() => { void followTarget(buddy.pubkey); }}
            >Follow Back</button>
          </div>
        {/each}
      </details>
    {/if}

    {#if outgoing.length > 0}
      <details
        open={sectionState.pending}
        ontoggle={(event) => setSectionOpen('pending', event.currentTarget.open)}
        data-testid="him-section-pending"
      >
        <summary>Pending ({outgoing.length})</summary>
        {#each outgoing as buddy (buddy.pubkey)}
          <div class="pending-row"><span>◌</span><span>{buddyLabel(buddy)}</span></div>
        {/each}
      </details>
    {/if}
  </section>

  <form onsubmit={(event) => { event.preventDefault(); void followTarget(addTarget); }}>
    <input bind:value={addTarget} placeholder="npub or hex public key" aria-label="Add a buddy" />
    <button type="submit" disabled={adding || !addTarget.trim()}>{adding ? 'Adding…' : 'Add Buddy'}</button>
  </form>

  <footer>Friends are people who follow each other.</footer>

  {#if buddyContextMenu}
    <div
      class="buddy-context-menu"
      role="menu"
      aria-label={`${buddyContextMenu.label} actions`}
      style={`left: ${buddyContextMenu.x}px; top: ${buddyContextMenu.y}px;`}
      data-testid="him-buddy-context-menu"
    >
      <button type="button" role="menuitem" onclick={() => { void openContextProfile(); }} data-testid="him-open-profile">View Profile</button>
    </div>
  {/if}

  {#if presenceContextMenu}
    <div
      class="buddy-context-menu presence-context-menu"
      role="menu"
      aria-label="Online status"
      style={`left: ${presenceContextMenu.x}px; top: ${presenceContextMenu.y}px;`}
      data-testid="him-presence-context-menu"
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!online}
        onclick={() => { void setOnline(false); }}
        data-testid="him-status-offline"
      ><span aria-hidden="true">{online ? '' : '✓'}</span> Offline</button>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={online}
        disabled={!messengerAvailable}
        onclick={() => { void setOnline(true); }}
        data-testid="him-status-online"
      ><span aria-hidden="true">{online ? '✓' : ''}</span> Online</button>
    </div>
  {/if}
</main>

{#snippet BuddyRow(buddy: Buddy)}
  <div class="buddy-row" class:offline={!buddy.online} data-testid="him-buddy" data-online={buddy.online} data-pubkey={buddy.pubkey}>
    <button
      class="buddy-identity"
      class:chat-target={buddy.online}
      type="button"
      aria-haspopup="menu"
      aria-label={buddy.online ? `Message ${buddyLabel(buddy)}` : `${buddyLabel(buddy)} is offline`}
      title={buddy.online ? `Message ${buddyLabel(buddy)}` : `${buddyLabel(buddy)} is offline — right-click for profile`}
      onclick={() => {
        buddyContextMenu = null;
        if (buddy.online) void openChat(buddy.pubkey);
      }}
      oncontextmenu={(event) => openBuddyContextMenu(event, buddy)}
      onkeydown={(event) => handleBuddyKeydown(event, buddy)}
      data-testid="him-buddy-identity"
    >
      <span class="presence" aria-label={buddy.online ? 'Online' : 'Offline'}></span>
      <span class="avatar">
        {buddyLabel(buddy).slice(0, 1).toUpperCase()}
        {#if buddy.profile?.picture}<img use:resourceImageBatch={buddy.profile.picture} alt="" />{/if}
      </span>
      <span><b>{buddyLabel(buddy)}</b><small>{shortPubkey(buddy.pubkey)}</small></span>
    </button>
  </div>
{/snippet}

<style>
  :global(body) { margin: 0; min-width: 250px; background: var(--hg-bg-base); color: var(--hg-text-primary); font: 12px/1.3 var(--hg-font-body); }
  button, input { font: inherit; }
  button { cursor: pointer; }
  button:disabled { cursor: default; opacity: .55; }
  .buddy-window {
    --aim-theme-background: var(--hg-theme-background, var(--hg-bg-base));
    --aim-theme-text: var(--hg-theme-text, var(--hg-text-primary));
    --aim-theme-primary: var(--hg-theme-primary, var(--hg-accent-primary));
    --aim-title-top: color-mix(in srgb, var(--aim-theme-primary) 46%, var(--aim-theme-background));
    --aim-title-bottom: color-mix(in srgb, var(--aim-theme-primary) 30%, var(--aim-theme-background));
    --aim-title-text: var(--aim-theme-text);
    --aim-title-shadow: color-mix(in srgb, var(--aim-theme-background) 72%, transparent);
    --aim-header-border: color-mix(in srgb, var(--aim-theme-primary) 56%, var(--aim-theme-background));
    --aim-section-top: color-mix(in srgb, var(--aim-theme-primary) 38%, var(--aim-theme-background));
    --aim-section-bottom: color-mix(in srgb, var(--aim-theme-primary) 22%, var(--aim-theme-background));
    --aim-control-top: color-mix(in srgb, var(--aim-theme-text) 18%, var(--aim-theme-background));
    --aim-control-bottom: color-mix(in srgb, var(--aim-theme-text) 10%, var(--aim-theme-background));
    box-sizing: border-box;
    min-height: 100vh;
    padding: 5px;
    background: var(--hg-bg-base);
  }
  .aim-titlebar { display: flex; align-items: center; gap: 7px; padding: 6px 8px; color: var(--aim-title-text); background: linear-gradient(var(--aim-title-top), var(--aim-title-bottom)); border: 1px solid var(--aim-header-border); border-radius: 5px 5px 0 0; text-shadow: 0 1px var(--aim-title-shadow); }
  .presence-menu-trigger { display: grid; place-items: center; width: 27px; height: 27px; flex: 0 0 27px; padding: 0; border: 0; border-radius: 2px; color: inherit; background: transparent; }
  .presence-menu-trigger:hover, .presence-menu-trigger:focus-visible, .presence-menu-trigger[aria-expanded="true"] { background: color-mix(in srgb, var(--hg-text-primary) 14%, transparent); outline: 1px solid color-mix(in srgb, var(--hg-text-primary) 45%, transparent); outline-offset: 0; }
  .presence-menu-trigger svg { width: 27px; height: 27px; }
  .aim-titlebar .aim-logo-outline { fill: var(--aim-theme-background); }
  .aim-titlebar .aim-logo-fill { fill: var(--aim-theme-primary); }
  .aim-titlebar div, .identity-strip div, .buddy-identity > span:last-child { display: grid; min-width: 0; }
  .aim-titlebar small { opacity: .85; font-size: 10px; }
  .identity-strip { display: grid; grid-template-columns: auto 1fr auto; gap: 7px; align-items: center; padding: 7px; border: 1px solid var(--hg-border-default); border-top: 0; background: var(--hg-bg-surface); }
  .identity-strip > span { width: 10px; height: 10px; border-radius: 50%; background: var(--hg-text-dim); border: 1px solid var(--hg-border-default); }
  .identity-strip > span.connected { background: var(--hg-accent-success); border-color: color-mix(in srgb, var(--hg-accent-success) 60%, var(--hg-border-default)); box-shadow: 0 0 4px color-mix(in srgb, var(--hg-accent-success) 72%, transparent); }
  .identity-strip small, .buddy-row small { color: var(--hg-text-muted); overflow: hidden; text-overflow: ellipsis; }
  .notice { margin: 5px 0; padding: 5px 7px; color: var(--hg-accent-danger); border: 1px solid currentColor; background: color-mix(in srgb, var(--hg-accent-danger) 10%, var(--hg-bg-surface)); }
  .transient-notice { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; }
  .transient-notice button { padding: 0 3px; border: 0; color: inherit; background: transparent; line-height: 1; }
  .buddy-list { margin-top: 5px; border: 1px solid var(--hg-border-default); background: var(--hg-bg-surface); min-height: 230px; }
  .buddy-loading { display: flex; align-items: center; gap: 7px; padding: 5px 8px; color: var(--hg-text-muted); border-bottom: 1px solid var(--hg-border-muted); background: var(--hg-bg-elevated); font-style: italic; }
  .buddy-loading-spinner { width: 8px; height: 8px; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--hg-accent-primary) 36%, var(--hg-border-default)); border-top-color: var(--hg-accent-primary); border-radius: 50%; animation: him-buddy-loading .8s linear infinite; }
  @keyframes him-buddy-loading { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .buddy-loading-spinner { animation: none; } }
  details + details { border-top: 1px solid var(--hg-border-muted); }
  summary { padding: 3px 6px; color: var(--aim-title-text); font-weight: 700; background: linear-gradient(var(--aim-section-top), var(--aim-section-bottom)); cursor: pointer; user-select: none; }
  .buddy-row { padding: 3px 5px; }
  .buddy-row:hover { background: color-mix(in srgb, var(--hg-accent-primary) 15%, var(--hg-bg-surface)); }
  .buddy-row.offline { opacity: .68; }
  .buddy-identity { display: grid; width: 100%; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 6px; padding: 0; border: 0; color: inherit; background: none; text-align: left; cursor: default; }
  .buddy-identity.chat-target { cursor: pointer; }
  .buddy-identity.chat-target:hover b, .buddy-identity.chat-target:focus-visible b { text-decoration: underline; }
  .follower { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; align-items: center; }
  .follower .buddy-identity { grid-template-columns: auto minmax(0, 1fr); }
  .presence { width: 8px; height: 8px; border-radius: 50%; background: var(--hg-accent-success); border: 1px solid color-mix(in srgb, var(--hg-accent-success) 58%, var(--hg-border-default)); }
  .offline .presence { background: var(--hg-text-dim); border-color: var(--hg-border-muted); }
  .avatar { position: relative; display: grid; place-items: center; width: 25px; height: 25px; border: 1px solid var(--hg-border-default); border-radius: 3px; overflow: hidden; color: var(--hg-text-primary); background: color-mix(in srgb, var(--hg-accent-primary) 26%, var(--hg-bg-elevated)); font-weight: 700; text-shadow: 0 1px color-mix(in srgb, var(--hg-bg-base) 70%, transparent); }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  form button, .follow-back, .identity-strip button { padding: 2px 7px; border: 1px solid var(--hg-border-default); border-radius: 3px; color: var(--hg-text-primary); background: linear-gradient(var(--aim-control-top), var(--aim-control-bottom)); }
  .follow-back { white-space: nowrap; }
  .buddy-context-menu { position: fixed; z-index: 100; min-width: 150px; box-sizing: border-box; padding: 3px; border: 1px solid var(--hg-border-accent); border-radius: 3px; background: var(--hg-bg-elevated); box-shadow: 2px 3px 8px color-mix(in srgb, var(--hg-bg-base) 72%, transparent); }
  .buddy-context-menu button { width: 100%; padding: 4px 8px; border: 0; color: var(--hg-text-primary); background: transparent; text-align: left; }
  .buddy-context-menu button:hover, .buddy-context-menu button:focus-visible { color: var(--aim-title-text); background: linear-gradient(var(--aim-section-top), var(--aim-section-bottom)); outline: none; }
  .presence-context-menu { min-width: 238px; }
  .presence-context-menu button { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 4px; align-items: center; }
  .presence-context-menu button span { display: inline-block; text-align: center; }
  .empty, .pending-row { margin: 0; padding: 5px 9px; color: var(--hg-text-muted); font-style: italic; }
  .pending-row { display: flex; gap: 6px; }
  form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; margin-top: 5px; }
  input { min-width: 0; padding: 4px 6px; border: 1px solid var(--hg-border-default); background: var(--hg-bg-surface); color: var(--hg-text-primary); }
  input::placeholder { color: var(--hg-text-dim); }
  footer { padding: 5px 2px 0; color: var(--hg-text-muted); font-size: 10px; text-align: center; }
</style>
