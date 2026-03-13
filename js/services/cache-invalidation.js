// Cache Invalidation - Realtime-driven cache invalidation with group support
//
// Bridges the Realtime subscription layer with the cache manager so that
// database changes received over WebSocket automatically evict stale cache
// entries. Supports invalidation groups (e.g., invalidating 'categories'
// also clears 'menu_items') and handles reconnect-after-disconnect by
// clearing the entire cache to avoid serving stale data from missed events.
//
// Design reference: cache-invalidation.js in design.md

import { INVALIDATION_GROUPS } from './cached-query.js';
import { onReconnect } from './realtime-service.js';

// ---------------------------------------------------------------------------
// Higher-Order Callback Wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a realtime subscription callback so that the relevant cache entries
 * are invalidated before the original callback executes.
 *
 * Usage:
 * ```js
 * subscribeToOrders(outletId, withCacheInvalidation('orders', handleOrder, cacheManager));
 * ```
 *
 * @param {string} tableName - The database table that triggered the event
 * @param {Function} originalCallback - The original realtime event handler
 * @param {import('./cache-manager.js').CacheManager} cacheManager - Cache instance to invalidate
 * @returns {Function} Decorated callback that invalidates cache then delegates
 */
export function withCacheInvalidation(tableName, originalCallback, cacheManager) {
  return (payload) => {
    invalidateWithGroup(tableName, cacheManager);
    originalCallback(payload);
  };
}

// ---------------------------------------------------------------------------
// Group-Aware Invalidation
// ---------------------------------------------------------------------------

/**
 * Invalidate all cache entries for a table and any related tables defined
 * in INVALIDATION_GROUPS.
 *
 * Each entry in INVALIDATION_GROUPS is an array of table names that should
 * be invalidated together. For example, `['categories', 'menu_items']` means
 * that a change to either table invalidates both.
 *
 * @param {string} tableName - The table whose cache entries should be invalidated
 * @param {import('./cache-manager.js').CacheManager} cacheManager - Cache instance
 */
export function invalidateWithGroup(tableName, cacheManager) {
  // Invalidate the target table itself
  const removed = cacheManager.invalidateByPrefix(tableName + ':');

  if (cacheManager.debug) {
    console.debug(
      `[CacheInvalidation] Invalidated "${tableName}" (${removed} entries removed)`,
    );
  }

  // Find and invalidate all group members that share a group with this table
  for (const group of Object.values(INVALIDATION_GROUPS)) {
    if (group.includes(tableName)) {
      for (const member of group) {
        if (member !== tableName) {
          const memberRemoved = cacheManager.invalidateByPrefix(member + ':');

          if (cacheManager.debug) {
            console.debug(
              `[CacheInvalidation] Group invalidated "${member}" via "${tableName}" (${memberRemoved} entries removed)`,
            );
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the cache invalidation system by registering a reconnect handler
 * that clears the entire cache when the WebSocket reconnects.
 *
 * This is necessary because any realtime events missed during a disconnection
 * period could leave the cache in an inconsistent state. A full clear ensures
 * the next read fetches fresh data from the server.
 *
 * @param {import('./cache-manager.js').CacheManager} cacheManager - Cache instance to clear on reconnect
 * @param {string} outletId - The outlet UUID (used for logging context)
 */
export function initCacheInvalidation(cacheManager, outletId) {
  onReconnect(() => {
    cacheManager.clear();
    console.info('[CacheInvalidation] Connection restored — cache cleared');
  });

  console.info(`[CacheInvalidation] Initialized for outlet: ${outletId}`);
}
