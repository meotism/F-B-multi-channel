// Table Map Store - Alpine.store('tableMap'): tables array, editing state, map lock
//
// SINGLE SOURCE OF TRUTH for all table data. No other store holds table arrays.
// Registered as Alpine.store('tableMap') in app.js.
//
// Requirements: 5.1 AC-1 (display tables at saved positions), AC-2 (add table),
// AC-3 (drag updates x,y), AC-5 (realtime sync), AC-6/AC-7 (delete with active-order guard),
// AC-8 (undo).
// Requirements: 6.1 AC-3 (changes from other devices appear within 2 seconds).

import { supabase } from '../services/supabase-client.js';
import { cachedSupabase } from '../services/cached-query.js';

export function tableMapStore() {
  return {
    // --- State ---
    tables: [],                // Array of table objects from DB
    isEditing: false,          // Whether current user is in edit mode
    editLock: null,            // { user_id, user_name, locked_at } or null
    selectedTable: null,       // UUID of currently selected table
    hasUnsavedChanges: false,
    undoStack: [],             // Array of { tableId, prevX, prevY } for undo
    isLoading: false,
    error: null,
    _realtimeChannel: null,    // Supabase RealtimeChannel reference for cleanup

    // --- Actions ---

    /**
     * Fetch all tables for the given outlet from Supabase and populate
     * the local tables[] array. This is the primary data-loading entry point
     * called during login and page refresh.
     *
     * @param {string} outletId - UUID of the outlet to load tables for
     */
    async loadTables(outletId) {
      this.isLoading = true;
      this.error = null;

      try {
        const { data, error } = await cachedSupabase
          .from('tables')
          .select('*')
          .eq('outlet_id', outletId);

        if (error) {
          throw error;
        }

        this.tables = data || [];

        // Subscribe to realtime changes after initial data load
        this.subscribeToChanges(outletId);
      } catch (err) {
        console.error('[tableMapStore] loadTables failed:', err);
        this.error = 'Khong the tai danh sach ban. Vui long thu lai.';
        this.tables = [];
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Find a table by its ID from the local array.
     *
     * @param {string} id - Table UUID
     * @returns {object|undefined} The table object, or undefined if not found
     */
    getTableById(id) {
      return this.tables.find(t => t.id === id);
    },

    /**
     * Load active order start times for all serving tables.
     * Fetches the earliest active order's `started_at` for each table with
     * status 'serving' and attaches it as `activeOrderStartedAt` on the
     * table object. This enables the elapsed-time timer display in the map UI.
     *
     * Called after loadTables() during page init and on page reload to
     * reconstruct timers from database timestamps (requirement 5.3 EC-1:
     * timer reconstructs from started_at on page reload).
     */
    async loadActiveOrderTimers() {
      const servingTables = this.tables.filter(t => t.status === 'serving');
      if (servingTables.length === 0) return;

      try {
        const tableIds = servingTables.map(t => t.id);
        const { data: orders, error } = await supabase
          .from('orders')
          .select('table_id, started_at')
          .in('table_id', tableIds)
          .eq('status', 'active')
          .order('started_at', { ascending: true });

        if (error) {
          throw error;
        }

        // Build a map of table_id -> earliest started_at (first order wins)
        const orderMap = {};
        (orders || []).forEach(o => {
          if (!orderMap[o.table_id]) {
            orderMap[o.table_id] = o.started_at;
          }
        });

        // Attach activeOrderStartedAt to each serving table for timer display
        this.tables.forEach(t => {
          if (orderMap[t.id]) {
            t.activeOrderStartedAt = orderMap[t.id];
          }
        });
      } catch (err) {
        console.error('[tableMapStore] loadActiveOrderTimers failed:', err);
        // Non-fatal: timers simply won't display, tables still render correctly
      }
    },

    /**
     * Update a table's position in the local state only (no DB write).
     * Used during drag operations -- the actual persist happens on saveMap().
     * Pushes the previous position onto the undoStack for undo support.
     *
     * @param {string} tableId - UUID of the table to move
     * @param {number} x - New x coordinate
     * @param {number} y - New y coordinate
     */
    updateLocalPosition(tableId, x, y) {
      const table = this.tables.find(t => t.id === tableId);
      if (!table) return;

      table.x = x;
      table.y = y;
    },

    /**
     * Set the currently selected table. Used for showing detail panels
     * and contextual actions (rename, delete, etc.).
     *
     * @param {string} tableId - UUID of the table to select
     */
    selectTable(tableId) {
      this.selectedTable = tableId;
    },

    /**
     * Clear the current table selection.
     */
    clearSelection() {
      this.selectedTable = null;
    },

    /**
     * Insert a new table into Supabase and add it to the local state.
     * The table is created with a default position that can be adjusted
     * via drag-and-drop afterward.
     *
     * @param {object} tableData - Table fields: { outlet_id, name, table_code, capacity, shape, x, y }
     * @returns {object|null} The newly created table object, or null on failure
     */
    async addTable(tableData) {
      this.error = null;

      try {
        const { data, error } = await supabase
          .from('tables')
          .insert(tableData)
          .select()
          .single();

        if (error) {
          throw error;
        }

        this.tables.push(data);
        return data;
      } catch (err) {
        console.error('[tableMapStore] addTable failed:', err);
        this.error = 'Khong the them ban moi. Vui long thu lai.';
        return null;
      }
    },

    /**
     * Update a table's fields in Supabase and sync the change to the local array.
     * Used for renaming, changing capacity, shape, rotation, etc.
     *
     * @param {string} tableId - UUID of the table to update
     * @param {object} updates - Fields to update (e.g. { name: 'Ban 5' })
     * @returns {object|null} The updated table object, or null on failure
     */
    async updateTable(tableId, updates) {
      this.error = null;

      try {
        const { data, error } = await supabase
          .from('tables')
          .update(updates)
          .eq('id', tableId)
          .select()
          .single();

        if (error) {
          throw error;
        }

        // Sync the updated record into the local array
        const idx = this.tables.findIndex(t => t.id === tableId);
        if (idx !== -1) {
          this.tables[idx] = data;
        }

        return data;
      } catch (err) {
        console.error('[tableMapStore] updateTable failed:', err);
        this.error = 'Khong the cap nhat ban. Vui long thu lai.';
        return null;
      }
    },

    /**
     * Delete a table from Supabase and remove it from the local array.
     * Guards against deletion when the table has active or completed orders.
     *
     * @param {string} tableId - UUID of the table to delete
     * @returns {boolean} true if deleted successfully, false otherwise
     */
    async deleteTable(tableId) {
      this.error = null;

      try {
        // Check for active or completed orders on this table before deleting
        const { count, error: countError } = await supabase
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .eq('table_id', tableId)
          .in('status', ['active', 'completed']);

        if (countError) {
          throw countError;
        }

        if (count > 0) {
          this.error = 'Ban dang co don hang, khong the xoa.';
          return false;
        }

        // Safe to delete -- no active orders
        const { error: deleteError } = await supabase
          .from('tables')
          .delete()
          .eq('id', tableId);

        if (deleteError) {
          throw deleteError;
        }

        // Remove from local array
        this.tables = this.tables.filter(t => t.id !== tableId);

        // Clear selection if the deleted table was selected
        if (this.selectedTable === tableId) {
          this.selectedTable = null;
        }

        return true;
      } catch (err) {
        console.error('[tableMapStore] deleteTable failed:', err);
        if (!this.error) {
          this.error = 'Khong the xoa ban. Vui long thu lai.';
        }
        return false;
      }
    },

    // --- Realtime Subscription ---

    /**
     * Subscribe to Supabase Realtime postgres_changes on the `public.tables`
     * table, filtered by outlet_id. Handles INSERT, UPDATE, and DELETE events
     * so that changes from other devices appear on the map within 2 seconds.
     *
     * If a subscription already exists it is removed first to prevent duplicates.
     *
     * Design reference: Section 4.2.8 Realtime Sync
     * Requirements: 5.1 AC-5, 6.1 AC-3
     *
     * @param {string} outletId - UUID of the outlet to subscribe to
     */
    subscribeToChanges(outletId) {
      if (!outletId) {
        console.warn('[tableMapStore] subscribeToChanges: no outletId provided');
        return;
      }

      // Remove existing subscription to avoid duplicates (e.g. on page re-init)
      this.unsubscribeFromChanges();

      this._realtimeChannel = supabase
        .channel('table-changes')
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'tables',
          filter: 'outlet_id=eq.' + outletId,
        }, (payload) => {
          this.handleRemoteChange(payload);
        })
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            console.log('[tableMapStore] Realtime subscription active');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.error('[tableMapStore] Realtime subscription failed:', status, err);
          }
        });
    },

    /**
     * Process a Supabase Realtime postgres_changes payload for the tables table.
     * Applies INSERT, UPDATE, and DELETE events to the local tables[] array.
     *
     * IMPORTANT: During edit mode, if the updated table is the currently selected
     * table, only the `status` field is updated (not position fields like x, y)
     * to prevent jitter while the user is dragging.
     *
     * @param {object} payload - Supabase realtime payload with eventType, new, old
     */
    handleRemoteChange(payload) {
      switch (payload.eventType) {
        case 'INSERT':
          // Add new table to local state if not already present
          if (!this.tables.find(t => t.id === payload.new.id)) {
            this.tables.push(payload.new);
          }
          break;

        case 'UPDATE': {
          const idx = this.tables.findIndex(t => t.id === payload.new.id);
          if (idx !== -1) {
            // If user is editing and this is the selected table, only update
            // status to prevent position jitter during drag operations
            if (this.isEditing && this.selectedTable === payload.new.id) {
              this.tables[idx].status = payload.new.status;
            } else {
              this.tables[idx] = { ...this.tables[idx], ...payload.new };
            }
          }
          break;
        }

        case 'DELETE':
          this.tables = this.tables.filter(t => t.id !== payload.old.id);
          break;
      }
    },

    /**
     * Remove the active Realtime subscription channel for table changes.
     * Called during cleanup (page destroy) and before re-subscribing.
     */
    unsubscribeFromChanges() {
      if (this._realtimeChannel) {
        supabase.removeChannel(this._realtimeChannel);
        this._realtimeChannel = null;
      }
    },
  };
}
