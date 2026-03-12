// Map Lock Service - Realtime Presence for table map edit lock
//
// Uses Supabase Realtime Presence to implement single-editor locking for the
// table map. When a user enters edit mode, they track their presence on the
// channel. Other clients see the lock and display a read-only notification.
//
// Key behaviors:
// - On browser tab close / disconnect, Supabase Presence automatically removes
//   the user's presence state, effectively releasing the lock.
// - Other clients can check if `locked_at` is stale (>5 minutes old) and
//   treat the lock as expired.
// - acquireLock checks presence state before tracking to ensure only one
//   editor at a time.
//
// Design reference: Section 2.5 (map-lock-service.js), Section 3.3.6
// (single-editor mechanism), Section 4.2.5 (presence locking)
//
// Requirements reference: 5.1 AC-11, AC-12

import { supabase } from './supabase-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Presence key used for editor tracking on the channel. */
const PRESENCE_KEY = 'editor';

/** Threshold in milliseconds after which a lock is considered stale (5 min). */
const STALE_LOCK_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to the map edit lock Presence channel for a given outlet.
 *
 * Joins a Supabase Presence channel named `map-lock:{outletId}` and listens
 * for `presence sync` events. On each sync, the callback is invoked with the
 * current editor info or `null` if no one is editing.
 *
 * @param {string} outletId - The outlet UUID
 * @param {Function} onLockChange - Called with `{ user_id, user_name, locked_at }`
 *   when an editor is present, or `null` when no editor is present
 * @returns {import('@supabase/supabase-js').RealtimeChannel} The Presence channel
 */
export function subscribeToMapLock(outletId, onLockChange) {
  const channel = supabase.channel(`map-lock:${outletId}`, {
    config: { presence: { key: PRESENCE_KEY } },
  });

  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const editors = state[PRESENCE_KEY] || [];

      // There should be at most 1 active editor at any time
      if (editors.length > 0) {
        onLockChange({
          user_id: editors[0].user_id,
          user_name: editors[0].user_name,
          locked_at: editors[0].locked_at,
        });
      } else {
        onLockChange(null);
      }
    })
    .subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('[MapLockService] Presence subscription failed:', status, err);
      }
    });

  return channel;
}

/**
 * Attempt to acquire the map edit lock on the given Presence channel.
 *
 * Checks the current presence state for other editors. If another user is
 * already editing (and their lock is not stale), returns `false`. Otherwise,
 * tracks the current user's presence and returns `true`.
 *
 * A lock is considered stale if `locked_at` is older than 5 minutes. Stale
 * locks are ignored, allowing a new editor to take over.
 *
 * @param {import('@supabase/supabase-js').RealtimeChannel} channel - The Presence channel
 * @param {string} userId - The current user's ID
 * @param {string} userName - The current user's display name
 * @returns {Promise<boolean>} `true` if lock was acquired, `false` if blocked
 */
export async function acquireLock(channel, userId, userName) {
  try {
    const state = channel.presenceState();
    const editors = state[PRESENCE_KEY] || [];

    if (editors.length > 0 && editors[0].user_id !== userId) {
      // Another user holds the lock -- check if it is stale
      const lockedAt = new Date(editors[0].locked_at).getTime();
      const now = Date.now();

      if (now - lockedAt < STALE_LOCK_THRESHOLD_MS) {
        // Lock is still fresh; another user is actively editing
        return false;
      }
      // Lock is stale (>5 min old) -- allow override
    }

    await channel.track({
      user_id: userId,
      user_name: userName,
      locked_at: new Date().toISOString(),
    });

    return true;
  } catch (err) {
    console.error('[MapLockService] Failed to acquire lock:', err);
    return false;
  }
}

/**
 * Release the map edit lock by removing the current user's presence.
 *
 * Calls `channel.untrack()` to remove presence from the channel. Errors are
 * caught and logged rather than thrown, since lock release should not block
 * the user from continuing their workflow.
 *
 * @param {import('@supabase/supabase-js').RealtimeChannel} channel - The Presence channel
 */
export async function releaseLock(channel) {
  try {
    await channel.untrack();
  } catch (err) {
    console.error('[MapLockService] Failed to release lock:', err);
  }
}

/**
 * Unsubscribe from the map edit lock Presence channel.
 *
 * Removes the channel subscription entirely. Should be called when the
 * component unmounts or the user navigates away from the table map view.
 *
 * @param {import('@supabase/supabase-js').RealtimeChannel} channel - The Presence channel
 */
export function unsubscribeMapLock(channel) {
  try {
    supabase.removeChannel(channel);
  } catch (err) {
    console.error('[MapLockService] Failed to unsubscribe map lock channel:', err);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Check whether a lock timestamp is stale (older than 5 minutes).
 *
 * This can be used by UI components to determine if a displayed lock should
 * be treated as expired.
 *
 * @param {string} lockedAt - ISO 8601 timestamp of when the lock was acquired
 * @returns {boolean} `true` if the lock is stale
 */
export function isLockStale(lockedAt) {
  if (!lockedAt) return true;
  const lockedTime = new Date(lockedAt).getTime();
  return Date.now() - lockedTime >= STALE_LOCK_THRESHOLD_MS;
}
