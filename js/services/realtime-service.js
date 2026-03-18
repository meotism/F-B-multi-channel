// Realtime Service - Supabase Realtime subscriptions management
//
// Centralized module for managing all Supabase Realtime channel subscriptions.
// Tracks active channels, handles connection status, and provides automatic
// data reconciliation on reconnect.
//
// Design reference: Section 3.3 Realtime Subscription Design (channel naming,
// filter strategy, subscription lifecycle, reconnection strategy)
//
// Channel naming pattern: {table_name}:{outlet_id}
// Tables with realtime: tables, orders, order_items, bills, inventory

import { supabase } from './supabase-client.js';

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

/**
 * Map of active channels keyed by channel name (e.g., 'inventory:{outletId}').
 * @type {Map<string, import('@supabase/supabase-js').RealtimeChannel>}
 */
const activeChannels = new Map();

/**
 * List of callbacks to invoke when the WebSocket reconnects after a disconnection.
 * Typically used to fetch fresh data via REST to reconcile missed events.
 * @type {Array<Function>}
 */
const reconnectCallbacks = [];

/**
 * Interval ID for the heartbeat timer. Stored so it can be cleared on cleanup.
 * @type {number|null}
 */
let heartbeatIntervalId = null;

/** Heartbeat check interval in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Reactive connection status object. Components can read `connectionStatus.state`
 * to display a connection indicator in the UI.
 *
 * Possible values: 'connected', 'disconnected', 'connecting'
 */
export const connectionStatus = {
  state: 'disconnected',
};

/**
 * Track the previous connection state to detect reconnection transitions
 * (disconnected -> connected) and trigger reconciliation.
 * @type {string}
 */
let previousConnectionState = 'disconnected';

// ---------------------------------------------------------------------------
// Generic Subscription
// ---------------------------------------------------------------------------

/**
 * Create a Realtime subscription for postgres_changes on a specific table.
 * The channel is named `{tableName}:{outletId}` and filtered by outlet_id
 * (except for order_items which uses client-side filtering).
 *
 * If a channel with the same name already exists, it is removed first to
 * prevent duplicate subscriptions.
 *
 * @param {string} tableName - Database table name (e.g., 'inventory', 'orders')
 * @param {string} outletId - The outlet UUID to filter by
 * @param {string|string[]} eventTypes - Event type(s): 'INSERT', 'UPDATE', 'DELETE', or '*'
 * @param {Function} callback - Called with the Supabase realtime payload on each event
 * @returns {import('@supabase/supabase-js').RealtimeChannel} The subscribed channel
 */
export function subscribeToTable(tableName, outletId, eventTypes, callback) {
  const channelName = `${tableName}:${outletId}`;

  // Remove existing channel with the same name to avoid duplicates
  if (activeChannels.has(channelName)) {
    const existingChannel = activeChannels.get(channelName);
    supabase.removeChannel(existingChannel);
    activeChannels.delete(channelName);
  }

  // Build the postgres_changes config
  // order_items does not have a direct outlet_id column, so no server-side filter
  const pgConfig = {
    schema: 'public',
    table: tableName,
  };

  // Use server-side filter for tables that have outlet_id
  if (tableName !== 'order_items') {
    pgConfig.filter = `outlet_id=eq.${outletId}`;
  }

  const channel = supabase.channel(channelName);

  // Subscribe to each event type (or a single '*' / string)
  const events = Array.isArray(eventTypes) ? eventTypes : [eventTypes];

  for (const event of events) {
    channel.on(
      'postgres_changes',
      { ...pgConfig, event },
      (payload) => {
        callback(payload);
      },
    );
  }

  // Subscribe and track connection status via the channel status callback
  channel.subscribe((status) => {
    handleChannelStatus(status);
  });

  activeChannels.set(channelName, channel);

  return channel;
}

// ---------------------------------------------------------------------------
// Specific Subscriptions
// ---------------------------------------------------------------------------

/**
 * Subscribe to inventory UPDATE events for a specific outlet.
 * Used to display real-time stock level changes and low-stock alerts.
 *
 * @param {string} outletId - The outlet UUID
 * @param {Function} callback - Called with the realtime payload on inventory updates
 * @returns {import('@supabase/supabase-js').RealtimeChannel}
 */
export function subscribeToInventory(outletId, callback) {
  return subscribeToTable('inventory', outletId, 'UPDATE', callback);
}

/**
 * Subscribe to tables UPDATE events for a specific outlet.
 * Used for table map status changes and position updates.
 *
 * @param {string} outletId - The outlet UUID
 * @param {Function} callback - Called with the realtime payload on table updates
 * @returns {import('@supabase/supabase-js').RealtimeChannel}
 */
export function subscribeToTables(outletId, callback) {
  return subscribeToTable('tables', outletId, 'UPDATE', callback);
}

/**
 * Subscribe to orders INSERT and UPDATE events for a specific outlet.
 * Used for new orders and order status transitions.
 *
 * @param {string} outletId - The outlet UUID
 * @param {Function} callback - Called with the realtime payload on order changes
 * @returns {import('@supabase/supabase-js').RealtimeChannel}
 */
export function subscribeToOrders(outletId, callback) {
  return subscribeToTable('orders', outletId, ['INSERT', 'UPDATE'], callback);
}

/**
 * Subscribe to order_items INSERT, UPDATE, and DELETE events.
 * Note: order_items does not have a direct outlet_id column, so no server-side
 * filter is applied. Client-side filtering by order_id should be performed in
 * the callback if needed.
 *
 * @param {string} outletId - The outlet UUID (used for channel naming only)
 * @param {Function} callback - Called with the realtime payload on order item changes
 * @returns {import('@supabase/supabase-js').RealtimeChannel}
 */
export function subscribeToOrderItems(outletId, callback) {
  return subscribeToTable('order_items', outletId, ['INSERT', 'UPDATE', 'DELETE'], callback);
}

/**
 * Subscribe to bills INSERT and UPDATE events for a specific outlet.
 * Used for bill creation and print status changes.
 *
 * @param {string} outletId - The outlet UUID
 * @param {Function} callback - Called with the realtime payload on bill changes
 * @returns {import('@supabase/supabase-js').RealtimeChannel}
 */
export function subscribeToBills(outletId, callback) {
  return subscribeToTable('bills', outletId, ['INSERT', 'UPDATE'], callback);
}

/**
 * Subscribe to users UPDATE events for a specific outlet.
 * Used to detect role changes for the current user and force logout when
 * the role is modified by an admin.
 *
 * @param {string} outletId - The outlet UUID
 * @param {string} currentUserId - The authenticated user's UUID
 * @param {string} currentRole - The user's role at login time
 * @param {Function} onForceLogout - Called when the current user's role changes
 * @returns {import('@supabase/supabase-js').RealtimeChannel}
 */
export function subscribeToUsers(outletId, currentUserId, currentRole, onForceLogout) {
  return subscribeToTable('users', outletId, 'UPDATE', (payload) => {
    const updated = payload.new;
    if (updated && updated.id === currentUserId && updated.role !== currentRole) {
      console.warn('[RealtimeService] Current user role changed, forcing logout');
      onForceLogout();
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize all Realtime subscriptions for the current authenticated user's outlet.
 * Called after authentication is resolved in app.js.
 *
 * Sets up subscriptions for all realtime-enabled tables (inventory, tables, orders,
 * order_items, bills). Each subscription uses a no-op callback by default;
 * page components can re-subscribe with their own callbacks when they mount.
 *
 * @param {string} outletId - The outlet UUID
 */
export function initRealtimeSubscriptions(outletId) {
  if (!outletId) {
    console.warn('[RealtimeService] Cannot init subscriptions: no outletId provided');
    return;
  }

  connectionStatus.state = 'connecting';

  // Set up subscriptions with default no-op handlers.
  // Individual pages will call the specific subscribe functions with their
  // own callbacks to override these defaults when they mount.
  subscribeToInventory(outletId, () => {});
  subscribeToTables(outletId, () => {});
  subscribeToOrders(outletId, () => {});
  subscribeToOrderItems(outletId, () => {});
  subscribeToBills(outletId, () => {});

  // Start heartbeat to detect and recover from silent disconnections
  startHeartbeat();

  console.info('[RealtimeService] Subscriptions initialized for outlet:', outletId);
}

/**
 * Remove a specific subscription by table name. The channel name is reconstructed
 * by scanning active channels for the given table prefix.
 *
 * @param {string} tableName - The table name (e.g., 'inventory')
 */
export function unsubscribeFromTable(tableName) {
  for (const [channelName, channel] of activeChannels) {
    if (channelName.startsWith(tableName + ':')) {
      supabase.removeChannel(channel);
      activeChannels.delete(channelName);
      break;
    }
  }
}

/**
 * Remove all active Realtime subscriptions and stop the heartbeat.
 * Called on logout to clean up all channels.
 */
export function unsubscribeAll() {
  stopHeartbeat();

  for (const [channelName, channel] of activeChannels) {
    supabase.removeChannel(channel);
  }
  activeChannels.clear();
  connectionStatus.state = 'disconnected';
  previousConnectionState = 'disconnected';

  console.info('[RealtimeService] All subscriptions removed');
}

// ---------------------------------------------------------------------------
// Connection Status & Reconnection
// ---------------------------------------------------------------------------

/**
 * Register a callback to be invoked when the WebSocket reconnects after
 * a disconnection. Callbacks typically fetch fresh data via REST API to
 * reconcile any events that were missed during the disconnection period.
 *
 * @param {Function} callback - Reconnection handler (no arguments)
 */
export function onReconnect(callback) {
  if (typeof callback === 'function') {
    reconnectCallbacks.push(callback);
  }
}

/**
 * Clear all reconnect callbacks. Called before re-registering
 * to prevent callback accumulation across page navigations.
 */
export function clearReconnectCallbacks() {
  reconnectCallbacks.length = 0;
}

/**
 * Handle channel subscription status updates. Updates the global connectionStatus
 * and detects reconnection transitions to trigger data reconciliation.
 *
 * Supabase channel statuses:
 * - 'SUBSCRIBED' -> connected
 * - 'CLOSED', 'CHANNEL_ERROR' -> disconnected
 * - 'TIMED_OUT' -> disconnected
 *
 * @param {string} status - Channel subscription status from Supabase
 */
function handleChannelStatus(status) {
  if (status === 'SUBSCRIBED') {
    const wasDisconnected = previousConnectionState !== 'connected';
    connectionStatus.state = 'connected';

    // Detect reconnection: was disconnected/connecting, now connected
    if (wasDisconnected && previousConnectionState !== 'disconnected') {
      // This is a reconnection (not the initial connection)
      triggerReconnectCallbacks();
    }

    previousConnectionState = 'connected';
  } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
    // Mark as disconnected only if we were previously connected,
    // to distinguish from initial connection failures
    if (previousConnectionState === 'connected') {
      previousConnectionState = 'connecting'; // Mark as "was connected, now reconnecting"
    }
    connectionStatus.state = 'disconnected';
  }
}

/**
 * Invoke all registered reconnection callbacks. Each callback is wrapped in
 * a try/catch to prevent one failing callback from blocking others.
 */
function triggerReconnectCallbacks() {
  console.info('[RealtimeService] Reconnected -- triggering data reconciliation');

  for (const cb of reconnectCallbacks) {
    try {
      cb();
    } catch (err) {
      console.error('[RealtimeService] Reconnect callback error:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Start a periodic heartbeat that checks whether the Realtime connection is
 * still alive. If the connection is detected as disconnected, it updates
 * `connectionStatus` and attempts to re-subscribe all active channels.
 *
 * Called automatically by `initRealtimeSubscriptions`.
 */
export function startHeartbeat() {
  stopHeartbeat(); // Prevent duplicate intervals

  heartbeatIntervalId = setInterval(() => {
    // Check if any channel is still connected by inspecting the internal state
    let hasConnectedChannel = false;
    for (const [, channel] of activeChannels) {
      // Supabase Realtime channel exposes a `state` property
      if (channel.state === 'joined' || channel.state === 'joining') {
        hasConnectedChannel = true;
        break;
      }
    }

    if (activeChannels.size > 0 && !hasConnectedChannel) {
      // All channels are down — mark as disconnected and trigger reconnect
      if (connectionStatus.state !== 'disconnected') {
        console.warn('[RealtimeService] Heartbeat: connection lost, attempting reconnect');
        connectionStatus.state = 'disconnected';
      }

      // Re-subscribe each channel to trigger Supabase's internal reconnect
      for (const [, channel] of activeChannels) {
        try {
          channel.subscribe();
        } catch (err) {
          console.error('[RealtimeService] Heartbeat reconnect error:', err);
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the periodic heartbeat check.
 * Called automatically by `unsubscribeAll`.
 */
export function stopHeartbeat() {
  if (heartbeatIntervalId != null) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
}
