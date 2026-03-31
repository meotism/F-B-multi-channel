// Table Map Page - Map container, drag-drop, lock, edit mode
//
// Alpine.js component for the table map page. Manages the visual map of tables,
// edit mode with drag-and-drop (native pointer events), map lock state, undo stack,
// and serving-table timers. Delegates table data to the tableMap store.

import { navigate } from '../../utils/navigate.js';
import { supabase } from '../../services/supabase-client.js';
import { cachedSupabase } from '../../services/cached-query.js';
import { formatVND } from '../../utils/formatters.js';
import {
  subscribeToMapLock,
  acquireLock,
  releaseLock,
  unsubscribeMapLock,
} from '../../services/map-lock-service.js';
import { confirmArrival, completeReservation, cancelReservation } from '../../services/reservation-service.js';

/**
 * Pad a number to 2 digits with leading zero.
 * @param {number} n
 * @returns {string}
 */
function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Alpine component factory for the table map page.
 * Used as x-data="tableMapPage()" in pages/table-map.html.
 *
 * @returns {Object} Alpine component data object
 */
export function tableMapPage() {
  return {
    // --- State ---
    isEditMode: false,
    isDragging: false,
    selectedTable: null,
    undoStack: [],          // [{ tableId, prevX, prevY }]
    mapScale: 1,
    lockOwner: null,        // { user_id, user_name } or null
    heartbeatInterval: null,
    inactivityTimer: null,
    timerInterval: null,    // setInterval handle for serving-table timers
    timerTick: 0,           // Reactive counter to force Alpine re-renders
    isDetailsPanelCollapsed: false,  // Bottom sheet collapsed state (tablet/mobile)
    isSaving: false,        // Loading state for save map action
    _pinchCleanup: null,    // Cleanup function for pinch-zoom event listeners
    _mapLockChannel: null,  // Supabase Presence channel for map edit lock
    _beforeUnloadHandler: null, // beforeunload handler reference for cleanup

    // Context menu state (Task 8.1)
    contextMenu: { show: false, x: 0, y: 0, table: null },
    _longPressTimer: null,

    // Add Table Modal state
    showAddModal: false,
    addForm: { name: '', table_code: '', capacity: 4, shape: 'square', hourly_rate: 0 },
    addFormError: '',

    // Edit Table Modal state
    showEditModal: false,
    editForm: { name: '', table_code: '', capacity: 4, shape: 'square', hourly_rate: 0 },
    editFormError: '',

    // Inline rename state (double-click on table name)
    inlineRenameTableId: null,
    inlineRenameValue: '',

    // Delete Table Modal state
    showDeleteModal: false,

    // Reset Table state (S3-23)
    showResetPanel: false,
    resetTableTarget: null,
    isResetting: false,

    // Transfer Table state (Task 18.1)
    showTransferTableModal: false,
    isTransferringTable: false,
    transferSourceTable: null,
    transferTargetTableId: null,
    showTransferConfirm: false,

    // --- Computed ---

    /**
     * Whether the current user can enter edit mode.
     * Requires edit_table_map permission and no active lock by another user.
     */
    get canEdit() {
      return Alpine.store('auth').canEditMap() && !this.lockOwner;
    },

    /**
     * Reactive reference to the tables array from the store.
     */
    get tables() {
      return Alpine.store('tableMap').tables;
    },

    // --- Lifecycle ---

    /**
     * Initialize the table map page.
     * Loads tables from the store, starts the timer interval for serving tables,
     * and subscribes to the map lock Presence channel.
     */
    async init() {
      try {
        const store = Alpine.store('tableMap');
        await store.loadTables(
          Alpine.store('auth').user?.outlet_id
        );

        // Load active order start times for serving tables so that
        // the elapsed-time timer can display from the correct timestamp.
        // This reconstructs timers after page reload (req 5.3 EC-1).
        await store.loadActiveOrderTimers();

        // Load guest count and order total from table_summary view (Task 8.2)
        await this.loadTableSummary();

        // Load today's reservations for map overlay
        await store.loadReservations(Alpine.store('auth').user?.outlet_id);

        console.log('[TableMapPage] Tables loaded successfully');
      } catch (err) {
        console.error('[TableMapPage] Failed to load tables:', err);
        Alpine.store('ui').showToast(
          'Không thể tải sơ đồ bàn',
          'error',
        );
      }

      // Start timer interval for serving-table elapsed time display.
      // Increments timerTick every second to trigger Alpine reactivity
      // so that getElapsedTime() re-evaluates in the template.
      this.timerInterval = setInterval(() => {
        this.timerTick++;
      }, 1000);

      // Click-outside handler to close context menu (Task 8.1)
      this._closeContextMenuHandler = () => {
        if (this.contextMenu.show) {
          this.closeContextMenu();
        }
      };
      document.addEventListener('click', this._closeContextMenuHandler);

      // Initialize pinch-to-zoom on mobile (<768px)
      if (window.innerWidth < 768) {
        this.initPinchZoom();
      }

      // Subscribe to map lock Presence channel to monitor who is editing.
      // When another user holds the lock, lockOwner is set and the "Edit"
      // button is disabled with a lock indicator shown.
      const outletId = Alpine.store('auth').user?.outlet_id;
      if (outletId) {
        const currentUserId = Alpine.store('auth').user?.id;
        this._mapLockChannel = subscribeToMapLock(outletId, (lockInfo) => {
          if (lockInfo && lockInfo.user_id !== currentUserId) {
            // Another user holds the lock
            this.lockOwner = lockInfo;
          } else {
            this.lockOwner = null;
          }
        });

        // Subscribe to realtime order changes so that table status colors
        // update when orders are created/modified on other devices.
        // The order store's handleOrderChange() performs optimistic table
        // status updates (e.g., active -> serving, completed -> awaiting_payment).
        // Design reference: Section 4.3.7
        Alpine.store('orders').subscribeToChanges(outletId);

        // Subscribe to reservation realtime changes for map overlay
        Alpine.store('tableMap').subscribeToReservationChanges(outletId);
      }

      // Sync selectedTable to the store so that handleRemoteChange() can
      // guard against position jitter when the selected table receives a
      // remote UPDATE event during drag operations (design Section 4.2.8).
      this.$watch('selectedTable', (val) => {
        Alpine.store('tableMap').selectedTable = val ? val.id : null;
      });
    },

    /**
     * Cleanup on page unload or navigation away.
     * Clears intervals, exits edit mode if active, unsubscribes from
     * Realtime table changes and the map lock Presence channel.
     */
    destroy() {
      // Each cleanup step is individually guarded with try/catch so that a
      // failure in one step does not prevent the remaining resources from
      // being released (prevents memory leaks and dangling subscriptions).
      try {
        if (this.timerInterval) {
          clearInterval(this.timerInterval);
          this.timerInterval = null;
        }
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to clear timerInterval:', err);
      }

      try {
        if (this.isEditMode) {
          // exitEditMode() is async but we call it fire-and-forget during
          // destroy since beforeunload cannot await promises reliably.
          // releaseLock() inside exitEditMode() has its own try/catch.
          this.exitEditMode();
        }
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to exit edit mode:', err);
      }

      // Clean up the beforeunload handler in case exitEditMode() failed
      // or was not called (e.g. isEditMode was already false but handler
      // was still attached due to a prior error)
      try {
        if (this._beforeUnloadHandler) {
          window.removeEventListener('beforeunload', this._beforeUnloadHandler);
          this._beforeUnloadHandler = null;
        }
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to remove beforeunload handler:', err);
      }

      // Clean up pinch-to-zoom event listeners
      try {
        if (this._pinchCleanup) {
          this._pinchCleanup();
          this._pinchCleanup = null;
        }
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to clean up pinch-zoom:', err);
      }

      // Unsubscribe from the map lock Presence channel
      try {
        if (this._mapLockChannel) {
          unsubscribeMapLock(this._mapLockChannel);
          this._mapLockChannel = null;
        }
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to unsubscribe map lock:', err);
      }

      // Clean up Realtime subscription for table changes
      try {
        Alpine.store('tableMap').unsubscribeFromChanges();
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to unsubscribe table changes:', err);
      }

      // Clean up Realtime subscription for reservation changes
      try {
        Alpine.store('tableMap').unsubscribeFromReservationChanges();
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to unsubscribe reservation changes:', err);
      }

      // Clear any remaining intervals that might have been missed
      try {
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        if (this.inactivityTimer) {
          clearTimeout(this.inactivityTimer);
          this.inactivityTimer = null;
        }
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to clear remaining timers:', err);
      }

      // Clean up context menu click-outside handler (Task 8.1)
      try {
        if (this._closeContextMenuHandler) {
          document.removeEventListener('click', this._closeContextMenuHandler);
          this._closeContextMenuHandler = null;
        }
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to remove context menu handler:', err);
      }

      // Cancel any pending long-press timer
      try {
        this.cancelLongPress();
      } catch (err) {
        console.error('[TableMapPage] destroy: failed to cancel long press:', err);
      }
    },

    // --- Table Interaction ---

    /**
     * Handle click on a table node.
     * In edit mode: selects the table for editing.
     * In view mode: navigates based on table status:
     *   - empty          -> order creation page
     *   - serving        -> order detail page
     *   - awaiting_payment -> order detail page (locked)
     *   - paid           -> no navigation (S3-23 will add reset panel)
     *
     * Requirements: 5.2 AC-1, 5.2 AC-4
     *
     * @param {Object} table - The table object that was clicked
     */
    handleTableClick(table) {
      if (this.isDragging) return;

      if (this.isEditMode) {
        // Reset inactivity timer on table click in edit mode (user interaction)
        this.resetInactivityTimer();

        // Toggle selection in edit mode
        this.selectedTable =
          this.selectedTable?.id === table.id ? null : table;
        return;
      }

      // View mode: navigate based on table status
      this.navigateByStatus(table);
    },

    /**
     * Navigate to the appropriate page based on the table's current status.
     * The order page at /orders/:tableId auto-detects table status and switches
     * between create mode (empty) and detail mode (serving/awaiting_payment).
     *
     * For `paid` status, navigation is skipped -- S3-23 will implement the
     * reset table panel that appears when tapping a paid table.
     *
     * @param {Object} table - The table object with at least { id, status }
     */
    navigateByStatus(table) {
      // Check if table is blocked by a reservation
      const blockingRes = this.getBlockingReservation(table);
      if (blockingRes) {
        if (blockingRes.status === 'pending') {
          // Pending block: don't navigate, show info toast
          Alpine.store('ui').showToast(
            `Bàn đang chờ khách: ${blockingRes.customer_name} (${this.formatTimeRange(blockingRes)})`,
            'info',
          );
          return;
        }
        // Active block: allow navigation to order page (customer can order)
      }

      switch (table.status) {
        case 'empty':
        case 'serving':
        case 'awaiting_payment':
          navigate(`/orders/${table.id}`);
          break;

        case 'paid':
          this.resetTableTarget = table;
          this.showResetPanel = true;
          break;

        default:
          console.warn(
            `[TableMapPage] Unknown table status '${table.status}' for table ${table.id}`,
          );
          break;
      }
    },

    // --- Context Menu (Task 8.1) ---

    /**
     * Show the context menu for a table. Triggered by @contextmenu on desktop
     * and long-press (500ms) on mobile.
     *
     * In edit mode the context menu is suppressed so that drag-and-drop
     * and selection behavior is not interrupted.
     *
     * @param {MouseEvent|TouchEvent} event - The triggering event
     * @param {Object} table - The table object
     */
    showContextMenu(event, table) {
      if (this.isEditMode) return;

      event.preventDefault();
      event.stopPropagation();

      // Position: for touch events use the first touch point, otherwise mouse coords
      const x = event.clientX ?? event.touches?.[0]?.clientX ?? 0;
      const y = event.clientY ?? event.touches?.[0]?.clientY ?? 0;

      this.contextMenu = { show: true, x, y, table };
    },

    /**
     * Close the context menu.
     */
    closeContextMenu() {
      this.contextMenu = { show: false, x: 0, y: 0, table: null };
    },

    /**
     * Handle a context menu action.
     * Closes the menu and performs the action based on the provided key.
     *
     * @param {string} action - Action key: 'create-order', 'view-order',
     *   'transfer-table', 'merge-table', 'pay', 'cancel-payment', 'reset'
     * @param {Object} table - The table object the action applies to
     */
    handleContextAction(action, table) {
      this.closeContextMenu();

      switch (action) {
        case 'create-order':
        case 'view-order':
          navigate(`/orders/${table.id}`);
          break;

        case 'transfer-table':
          this.openTransferTableModal(table);
          break;

        case 'merge-table':
          // Navigate to order page which has full merge functionality
          navigate(`/orders/${table.id}`);
          break;

        case 'pay':
          navigate(`/orders/${table.id}`);
          break;

        case 'cancel-payment':
          // Navigate to order page which has cancel payment functionality
          navigate(`/orders/${table.id}`);
          break;

        case 'reset':
          this.resetTableTarget = table;
          this.showResetPanel = true;
          break;

        case 'reserve':
          navigate('/reservations');
          break;

        case 'confirm-reservation':
          this.handleConfirmReservationArrival(table);
          break;

        case 'complete-reservation':
          this.handleCompleteReservation(table);
          break;

        case 'cancel-reservation':
          this.handleCancelReservation(table);
          break;

        default:
          console.warn(`[TableMapPage] Unknown context action: ${action}`);
      }
    },

    /**
     * Start a long-press timer for mobile context menu.
     * Called on @touchstart on table nodes.
     *
     * @param {TouchEvent} event - The touchstart event
     * @param {Object} table - The table object
     */
    startLongPress(event, table) {
      if (this.isEditMode) return;

      this._longPressTimer = setTimeout(() => {
        this.showContextMenu(event, table);
        this._longPressTimer = null;
      }, 500);
    },

    /**
     * Cancel the long-press timer. Called on @touchend and @touchmove
     * to prevent the context menu from appearing if the user lifts
     * their finger or moves before the 500ms threshold.
     */
    cancelLongPress() {
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = null;
      }
    },

    // --- Reservation Helpers (for map overlay) ---

    /**
     * Get all pending/active reservations for a table today.
     * @param {Object} table - Table object
     * @returns {Array}
     */
    getReservations(table) {
      return Alpine.store('tableMap').getReservationsForTable(table.id);
    },

    /**
     * Get the reservation currently blocking a table (in its time slot right now).
     * @param {Object} table - Table object
     * @returns {object|undefined}
     */
    getBlockingReservation(table) {
      return Alpine.store('tableMap').getBlockingReservation(table.id);
    },

    /**
     * Check if a table is currently blocked by a reservation.
     * @param {Object} table - Table object
     * @param {number} [_tick] - Pass timerTick from template to force re-evaluation every second
     * @returns {boolean}
     */
    isTableBlocked(table, _tick) {
      return !!this.getBlockingReservation(table);
    },

    /**
     * Format a reservation's time range, e.g. "14:00-16:00".
     * @param {Object} res - Reservation object
     * @returns {string}
     */
    formatTimeRange(res) {
      if (!res?.reserved_at) return '';
      const fmt = (d) => d.toLocaleTimeString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit', minute: '2-digit',
      });
      const endTime = res.end_at ? new Date(res.end_at) : new Date(new Date(res.reserved_at).getTime() + (res.duration_hours || 1) * 3600000);
      return fmt(new Date(res.reserved_at)) + '-' + fmt(endTime);
    },

    /**
     * Format a reservation's reserved_at to HH:MM for the time badge.
     * @param {string} isoString - ISO datetime string
     * @returns {string}
     */
    formatReservationTime(isoString) {
      if (!isoString) return '';
      const d = new Date(isoString);
      return d.toLocaleTimeString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
      });
    },

    /**
     * Confirm arrival for a reservation from the context menu.
     * @param {Object} table - Table object
     */
    async handleConfirmReservationArrival(table) {
      const reservation = this.getBlockingReservation(table);
      if (!reservation || reservation.status !== 'pending') return;

      try {
        await confirmArrival(reservation.id);
        Alpine.store('ui').showToast('Đã xác nhận khách đến', 'success');
      } catch (err) {
        Alpine.store('ui').showToast(err.message, 'error');
      }
    },

    /**
     * Complete a reservation early (customer leaves before end time).
     * @param {Object} table - Table object
     */
    async handleCompleteReservation(table) {
      const reservation = this.getBlockingReservation(table);
      if (!reservation || reservation.status !== 'active') return;

      try {
        await completeReservation(reservation.id);
        Alpine.store('ui').showToast('Đã hoàn thành đặt hẹn', 'success');
      } catch (err) {
        Alpine.store('ui').showToast(err.message, 'error');
      }
    },

    /**
     * Cancel a blocking reservation from the context menu.
     * @param {Object} table - Table object
     */
    async handleCancelReservation(table) {
      const reservation = this.getBlockingReservation(table);
      if (!reservation) return;

      try {
        await cancelReservation(reservation.id);
        Alpine.store('ui').showToast('Đã hủy đặt hẹn', 'success');
      } catch (err) {
        Alpine.store('ui').showToast(err.message, 'error');
      }
    },

    // --- Table Summary Data (Task 8.2) ---

    /**
     * Load guest_count and order_total from the table_summary view
     * and merge onto the local tables array. Called after loadTables()
     * so the base table data is already present.
     */
    async loadTableSummary() {
      try {
        const outletId = Alpine.store('auth').user?.outlet_id;
        if (!outletId) return;

        const { data, error } = await supabase
          .from('table_summary')
          .select('table_id, guest_count, order_total, active_order_id, hourly_rate')
          .eq('outlet_id', outletId);

        if (error) throw error;

        // Build a map for quick lookup
        const summaryMap = {};
        (data || []).forEach(s => {
          summaryMap[s.table_id] = s;
        });

        // Merge onto existing table objects
        const store = Alpine.store('tableMap');
        store.tables.forEach(t => {
          const summary = summaryMap[t.id];
          t.guest_count = summary?.guest_count || 0;
          t.order_total = summary?.order_total || 0;
          t.active_order_id = summary?.active_order_id || null;
        });
      } catch (err) {
        console.error('[TableMapPage] loadTableSummary failed:', err);
        // Non-fatal: info overlay simply won't display
      }
    },

    /**
     * Format a VND amount for display in the template.
     * Wrapper around the shared formatVND utility.
     *
     * @param {number} amount - Amount in VND
     * @returns {string} Formatted string (e.g., "150.000")
     */
    formatVND(amount) {
      return formatVND(amount);
    },

    /**
     * Compute elapsed time string (HH:MM:SS) from a timestamp.
     * References this.timerTick to ensure Alpine reactivity on each tick.
     *
     * @param {string|null} startedAt - ISO timestamp of when serving started
     * @returns {string} Formatted elapsed time or empty string
     */
    getElapsedTime(startedAt) {
      // Reference timerTick to trigger re-render on each interval tick
      void this.timerTick;

      if (!startedAt) return '';

      const start = new Date(startedAt).getTime();
      const now = Date.now();
      const diffMs = Math.max(0, now - start);
      const totalSeconds = Math.floor(diffMs / 1000);

      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    },

    /**
     * Calculate the running hourly charge for a serving billiard table.
     * Uses timerTick for Alpine reactivity (re-computes every second).
     *
     * @param {Object} table - Table object with hourly_rate and activeOrderStartedAt
     * @returns {number} Current hourly charge in VND (rounded)
     */
    getRunningHourlyCharge(table) {
      // Reference timerTick to trigger re-render on each interval tick
      void this.timerTick;

      if (!table.hourly_rate || !table.activeOrderStartedAt) return 0;

      const elapsed = (Date.now() - new Date(table.activeOrderStartedAt).getTime()) / 1000;
      return Math.round((elapsed / 3600) * table.hourly_rate);
    },

    // --- Edit Mode ---

    /**
     * Enter edit mode. Acquires the map edit lock via Presence, then enables
     * drag-and-drop. Starts a heartbeat interval (30s) to keep the lock alive
     * and an inactivity timer (5 min) that auto-exits edit mode.
     *
     * If another user holds the lock, shows a warning toast and stays in view mode.
     *
     * Requirements: 5.1 AC-11 (single-editor lock), 5.1 EC-1 (auto-release)
     */
    async enterEditMode() {
      try {
        const auth = Alpine.store('auth');
        const userId = auth.user?.id;
        const userName = auth.user?.name || auth.user?.email || 'Unknown';

        // Attempt to acquire the map edit lock via Presence (non-blocking)
        if (this._mapLockChannel) {
          try {
            const acquired = await acquireLock(this._mapLockChannel, userId, userName);
            if (!acquired) {
              const ownerName = this.lockOwner?.user_name || 'Người dùng khác';
              Alpine.store('ui').showToast(
                `${ownerName} đang chỉnh sửa sơ đồ bàn`,
                'warning',
              );
              return;
            }
          } catch (lockErr) {
            // Lock service failed (Realtime not available) — proceed without lock
            console.warn('[TableMapPage] Map lock unavailable, proceeding without lock:', lockErr);
          }
        }

        this.isEditMode = true;
        this.undoStack = [];

        // Sync store-level editing flag so that handleRemoteChange() can guard
        // against position jitter during drag operations (design Section 4.2.8)
        Alpine.store('tableMap').isEditing = true;

        // Wait for Alpine to finish re-rendering the DOM before
        // initializing drag-and-drop pointer event listeners
        this.$nextTick(() => this.initDragAndDrop());

        // Register beforeunload handler to warn users when closing/reloading
        // the browser tab while there are unsaved layout changes.
        // Requirement: 5.1 EC-3 (unsaved changes guard)
        this._beforeUnloadHandler = (e) => {
          if (Alpine.store('tableMap').hasUnsavedChanges) {
            e.preventDefault();
            e.returnValue = '';
          }
        };
        window.addEventListener('beforeunload', this._beforeUnloadHandler);

        // Start heartbeat interval (30s) to refresh the lock's locked_at timestamp.
        // This keeps the lock fresh so other clients don't treat it as stale.
        this.heartbeatInterval = setInterval(() => {
          this.sendHeartbeat();
        }, 30000);

        // Start inactivity timer (5 min) to auto-exit edit mode if the user
        // stops interacting. This prevents indefinite lock holding.
        this.resetInactivityTimer();

        console.log('[TableMapPage] enterEditMode() -- edit mode active');
      } catch (err) {
        console.error('[TableMapPage] enterEditMode() failed:', err);
        Alpine.store('ui').showToast(
          'Không thể vào chế độ chỉnh sửa. Vui lòng thử lại.',
          'error',
        );
      }
    },

    /**
     * Handle the "Thoat chinh sua" button click.
     * If there are unsaved changes, shows a confirmation dialog before exiting.
     * If no unsaved changes, exits directly.
     *
     * Requirements: 5.1 EC-3 (unsaved changes guard)
     */
    handleExitEditMode() {
      const store = Alpine.store('tableMap');
      if (store.hasUnsavedChanges) {
        const confirmed = window.confirm(
          'Bạn có thay đổi chưa lưu. Bạn có muốn rời đi?',
        );
        if (!confirmed) return;
      }
      this.exitEditMode();
    },

    /**
     * Exit edit mode. Releases the map lock, disables drag-and-drop,
     * clears heartbeat and inactivity timers, and resets editing state.
     *
     * Requirements: 5.1 AC-12 (lock release on exit)
     */
    async exitEditMode() {
      try {
        // Release the map edit lock so other users can enter edit mode
        if (this._mapLockChannel) {
          await releaseLock(this._mapLockChannel);
        }
      } catch (err) {
        console.error('[TableMapPage] exitEditMode: failed to release lock:', err);
      }

      // Remove beforeunload handler since we are leaving edit mode
      if (this._beforeUnloadHandler) {
        window.removeEventListener('beforeunload', this._beforeUnloadHandler);
        this._beforeUnloadHandler = null;
      }

      try {
        this.destroyDragAndDrop();
      } catch (err) {
        console.error('[TableMapPage] exitEditMode: failed to destroy drag-and-drop:', err);
      }

      this.isEditMode = false;
      this.isDragging = false;
      this.selectedTable = null;
      this.undoStack = [];

      // Sync store-level editing flag to disable the jitter guard in
      // handleRemoteChange() now that we are back in view mode
      Alpine.store('tableMap').isEditing = false;

      // Reset unsaved changes flag on the store so the navigation guard
      // does not re-trigger after exiting edit mode
      Alpine.store('tableMap').hasUnsavedChanges = false;

      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      if (this.inactivityTimer) {
        clearTimeout(this.inactivityTimer);
        this.inactivityTimer = null;
      }

      console.log('[TableMapPage] exitEditMode() -- lock released');
    },

    /**
     * Send a heartbeat to refresh the lock's locked_at timestamp.
     * Called every 30 seconds while in edit mode to prevent the lock
     * from being considered stale by other clients.
     */
    async sendHeartbeat() {
      if (!this._mapLockChannel) return;
      const auth = Alpine.store('auth');
      try {
        await this._mapLockChannel.track({
          user_id: auth.user?.id,
          user_name: auth.user?.name || auth.user?.email || 'Unknown',
          locked_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error('[TableMapPage] Heartbeat failed:', err);
      }
    },

    /**
     * Reset the inactivity timer. Called when the user performs an action
     * in edit mode (e.g., drag start). If 5 minutes pass without activity,
     * edit mode is automatically exited to release the lock.
     *
     * Design reference: Section 4.2.5 line 6912-6921
     */
    resetInactivityTimer() {
      if (this.inactivityTimer) {
        clearTimeout(this.inactivityTimer);
      }
      this.inactivityTimer = setTimeout(() => {
        console.log('[TableMapPage] Inactivity timeout -- auto-exiting edit mode');
        this.exitEditMode();
      }, 5 * 60 * 1000); // 5 minutes
    },

    // --- Drag-and-Drop (native pointer events) ---

    /**
     * Initialize drag-and-drop using native pointer events on the map container.
     * Configures snap-to-grid (10px), restrict-to-parent, and percentage-based
     * positioning relative to .map-container dimensions.
     *
     * Called from enterEditMode(). Drag is only active on elements with
     * the `.table-node.is-editable` selector (added by Alpine when isEditMode=true).
     *
     * Requirements: 5.1 AC-3 (drag updates x,y), 5.1 EC-2 (snap to grid)
     */
    /**
     * Start dragging a table node. Called from @pointerdown on the template.
     * Uses setPointerCapture so pointermove/pointerup keep firing on the node
     * even when the pointer leaves it. Manipulates DOM style directly during
     * drag (bypassing Alpine :style) and syncs back to the store on drop.
     *
     * @param {PointerEvent} e - The pointerdown event
     * @param {Object} tableData - The Alpine table data object from x-for
     */
    startDrag(e, tableData) {
      // Only primary button (left click / single touch)
      if (e.button !== 0) return;

      const node = e.currentTarget;
      e.preventDefault();

      // Capture all future pointer events to this node, even if pointer
      // leaves the element bounds — this is the key to reliable drag.
      node.setPointerCapture(e.pointerId);

      this.isDragging = true;
      node.classList.add('is-dragging');

      // Save position for undo
      this.undoStack.push({
        tableId: tableData.id,
        prevX: tableData.x,
        prevY: tableData.y,
      });

      this.resetInactivityTimer();

      const container = document.getElementById('map-container');

      const onMove = (ev) => {
        // movementX/Y = delta since last pointermove, built into the API
        const containerRect = container.getBoundingClientRect();
        if (containerRect.width === 0 || containerRect.height === 0) return;

        // Direct DOM manipulation — bypasses Alpine :style during drag.
        // This avoids the reactive re-render cycle that was killing drag.
        const curLeft = parseFloat(node.style.left) || 0;
        const curTop = parseFloat(node.style.top) || 0;
        const dxPct = (ev.movementX / containerRect.width) * 100;
        const dyPct = (ev.movementY / containerRect.height) * 100;
        // Clamp so the entire node stays within the container (not just its anchor point)
        const maxXPct = 100 - (node.offsetWidth / containerRect.width) * 100;
        const maxYPct = 100 - (node.offsetHeight / containerRect.height) * 100;
        const newX = Math.max(0, Math.min(maxXPct, curLeft + dxPct));
        const newY = Math.max(0, Math.min(maxYPct, curTop + dyPct));
        node.style.left = newX + '%';
        node.style.top = newY + '%';
      };

      const onUp = () => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        node.removeEventListener('pointercancel', onUp);
        node.classList.remove('is-dragging');

        // Sync final position back to the store so Alpine data matches DOM
        const finalX = parseFloat(node.style.left) || 0;
        const finalY = parseFloat(node.style.top) || 0;
        const store = Alpine.store('tableMap');
        store.updateLocalPosition(tableData.id, finalX, finalY);
        store.hasUnsavedChanges = true;

        this.isDragging = false;
        this.resetInactivityTimer();

        console.log(
          `[TableMapPage] Table ${tableData.id} moved to (${finalX.toFixed(1)}%, ${finalY.toFixed(1)}%)`,
        );
      };

      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    },

    // initDragAndDrop / destroyDragAndDrop are no longer needed — drag is
    // handled per-element via @pointerdown="startDrag($event, table)" in the
    // template, so there's nothing to set up or tear down globally.
    initDragAndDrop() {},
    destroyDragAndDrop() {},

    /**
     * Save all table positions to the database via batch RPC.
     * Collects current positions from the store and calls
     * batch_update_table_positions to persist them atomically.
     * The button is disabled while the operation is in progress.
     *
     * On success: resets hasUnsavedChanges, clears undoStack, shows success toast.
     * On error: shows error toast with details.
     *
     * Requirements: 5.1 AC-4 (persist all table positions on save)
     */
    async saveMap() {
      if (this.isSaving) return;

      // Reset inactivity timer on save button click (user interaction)
      if (this.isEditMode) this.resetInactivityTimer();

      const store = Alpine.store('tableMap');
      const positions = store.tables.map(t => ({
        id: t.id,
        x: t.x,
        y: t.y,
        rotation: t.rotation || 0,
      }));

      this.isSaving = true;

      try {
        // The SQL function expects TEXT, cast to jsonb internally.
        // JSON.stringify ensures the array is sent as a JSON string
        // regardless of how supabase-js serializes the parameter.
        const { error } = await supabase.rpc('batch_update_table_positions', {
          positions: JSON.stringify(positions),
        });

        if (error) {
          throw error;
        }

        cachedSupabase.invalidate('tables');

        // Success: reset change tracking and undo history
        store.hasUnsavedChanges = false;
        this.undoStack = [];
        Alpine.store('ui').showToast('Đã lưu sơ đồ bàn', 'success');
        console.log('[TableMapPage] saveMap() completed successfully');
      } catch (err) {
        console.error('[TableMapPage] saveMap() failed:', err);
        Alpine.store('ui').showToast(
          `Không thể lưu sơ đồ bàn: ${err.message || 'Lỗi không xác định'}`,
          'error',
        );
      } finally {
        this.isSaving = false;
      }
    },

    /**
     * Undo the last drag action from the undo stack.
     * Pops the most recent entry { tableId, prevX, prevY } and restores
     * the table's position in the store directly (bypassing updateLocalPosition
     * to avoid re-pushing onto the undo stack).
     *
     * Alpine reactivity re-renders the table node's style.left / style.top
     * automatically via the x-bind:style in the template.
     *
     * Requirements: 5.1 AC-8
     */
    undo() {
      const lastAction = this.undoStack.pop();
      if (!lastAction) return;

      // Reset inactivity timer on undo button click (user interaction)
      if (this.isEditMode) this.resetInactivityTimer();

      // Restore position directly on the store's table object.
      // We intentionally bypass store.updateLocalPosition() because that
      // method pushes a new entry onto the store's undoStack, which we
      // do not want during an undo operation (single-level undo, no redo).
      const store = Alpine.store('tableMap');
      const table = store.getTableById(lastAction.tableId);
      if (table) {
        table.x = lastAction.prevX;
        table.y = lastAction.prevY;
      }

      console.log(
        `[TableMapPage] undo: table ${lastAction.tableId} restored to (${lastAction.prevX}%, ${lastAction.prevY}%)`,
      );
    },

    /**
     * Open the Add Table modal. Resets the form to default values and clears
     * any previous error state before showing the modal.
     */
    openAddModal() {
      // Reset inactivity timer on add button click (user interaction)
      if (this.isEditMode) this.resetInactivityTimer();

      this.addForm = { name: '', table_code: '', capacity: 4, shape: 'square', hourly_rate: 0 };
      this.addFormError = '';
      this.showAddModal = true;
    },

    /**
     * Close the Add Table modal without submitting.
     */
    closeAddModal() {
      this.showAddModal = false;
      this.addFormError = '';
    },

    /**
     * Validate and submit the Add Table form.
     * Validates required fields, then calls the store's addTable() method
     * with form values plus outlet_id and default position.
     *
     * On success: closes modal, shows success toast, selects the new table.
     * On error: shows error message in modal without closing.
     */
    async submitAddTable() {
      // Reset inactivity timer on form submission (user interaction)
      if (this.isEditMode) this.resetInactivityTimer();

      // --- Validation ---
      const { name, table_code, capacity, shape } = this.addForm;

      if (!name || !name.trim()) {
        this.addFormError = 'Vui lòng nhập tên bàn.';
        return;
      }
      if (!table_code || !table_code.trim()) {
        this.addFormError = 'Vui lòng nhập mã bàn.';
        return;
      }
      if (!capacity || capacity < 1) {
        this.addFormError = 'Số chỗ phải lớn hơn 0.';
        return;
      }

      this.addFormError = '';

      // Build table data payload with default center position
      const tableData = {
        outlet_id: Alpine.store('auth').user?.outlet_id,
        name: name.trim(),
        table_code: table_code.trim(),
        capacity: Number(capacity),
        shape,
        hourly_rate: Number(this.addForm.hourly_rate) || 0,
        x: 45,
        y: 40,
        status: 'empty',
      };

      const store = Alpine.store('tableMap');
      const newTable = await store.addTable(tableData);

      if (newTable) {
        // Success: close modal, show toast, select new table on map
        this.showAddModal = false;
        Alpine.store('ui').showToast('Thêm bàn mới thành công!', 'success');
        this.selectedTable = newTable;
      } else {
        // Error: keep modal open, show error from store or generic message
        this.addFormError = store.error || 'Không thể thêm bàn. Vui lòng thử lại.';
      }
    },

    // --- Edit Table Modal ---

    /**
     * Open the Edit Table modal. Populates the form with the currently
     * selected table's values so the user can modify them.
     * Only available in edit mode when a table is selected.
     */
    openEditModal() {
      if (!this.selectedTable) return;

      // Reset inactivity timer on edit button click (user interaction)
      if (this.isEditMode) this.resetInactivityTimer();

      this.editForm = {
        name: this.selectedTable.name || '',
        table_code: this.selectedTable.table_code || '',
        capacity: this.selectedTable.capacity || 4,
        shape: this.selectedTable.shape || 'square',
        hourly_rate: this.selectedTable.hourly_rate || 0,
      };
      this.editFormError = '';
      this.showEditModal = true;
    },

    /**
     * Close the Edit Table modal without saving changes.
     */
    closeEditModal() {
      this.showEditModal = false;
      this.editFormError = '';
    },

    /**
     * Validate and submit the Edit Table form.
     * Validates required fields, then calls the store's updateTable() method
     * with the changed fields plus updated_at timestamp.
     *
     * On success: closes modal, shows success toast, updates the selected
     * table reference so the details panel reflects the new values.
     * On error: shows error message in modal without closing.
     *
     * Requirements: 5.1 AC-2 (edit existing tables)
     */
    async submitEditTable() {
      // Reset inactivity timer on form submission (user interaction)
      if (this.isEditMode) this.resetInactivityTimer();

      // --- Validation ---
      const { name, table_code, capacity, shape } = this.editForm;

      if (!name || !name.trim()) {
        this.editFormError = 'Vui lòng nhập tên bàn.';
        return;
      }
      if (!table_code || !table_code.trim()) {
        this.editFormError = 'Vui lòng nhập mã bàn.';
        return;
      }
      if (!capacity || capacity < 1) {
        this.editFormError = 'Số chỗ phải lớn hơn 0.';
        return;
      }

      this.editFormError = '';

      // Build update payload with Supabase-compatible updated_at
      const updates = {
        name: name.trim(),
        table_code: table_code.trim(),
        capacity: Number(capacity),
        shape,
        hourly_rate: Number(this.editForm.hourly_rate) || 0,
        updated_at: new Date().toISOString(),
      };

      const store = Alpine.store('tableMap');
      const updatedTable = await store.updateTable(this.selectedTable.id, updates);

      if (updatedTable) {
        // Success: close modal, show toast, update selected table reference
        this.showEditModal = false;
        this.selectedTable = updatedTable;
        Alpine.store('ui').showToast('Cập nhật bàn thành công!', 'success');
      } else {
        // Error: keep modal open, show error from store or generic message
        this.editFormError = store.error || 'Không thể cập nhật bàn. Vui lòng thử lại.';
      }
    },

    // --- Inline Rename (double-click) ---

    /**
     * Start inline rename on a table node. Triggered by double-clicking the
     * table name text in edit mode. Shows an input field in place of the name.
     *
     * Design reference: Section 4.2.7 (line 6974-6978)
     *
     * @param {Object} table - The table object to rename
     */
    startInlineRename(table) {
      if (!this.isEditMode) return;

      // Reset inactivity timer on inline rename start (user interaction)
      this.resetInactivityTimer();

      this.inlineRenameTableId = table.id;
      this.inlineRenameValue = table.name;

      // Focus the input on the next tick after Alpine renders it
      this.$nextTick(() => {
        const tableNode = document.querySelector(
          `.table-node[data-table-id="${table.id}"] .table-node__rename-input`,
        );
        if (tableNode) {
          tableNode.focus();
          tableNode.select();
        }
      });
    },

    /**
     * Confirm inline rename: saves the new name via the store's updateTable()
     * method. Called on Enter key or input blur. If the name is unchanged or
     * empty, the rename is cancelled silently.
     */
    async confirmInlineRename() {
      const tableId = this.inlineRenameTableId;
      if (!tableId) return;

      // Reset inactivity timer on inline rename confirm (user interaction)
      if (this.isEditMode) this.resetInactivityTimer();

      const newName = this.inlineRenameValue.trim();
      const store = Alpine.store('tableMap');
      const table = store.getTableById(tableId);

      // Clear inline rename state first to prevent duplicate calls from blur
      this.inlineRenameTableId = null;

      // Skip save if name is empty or unchanged
      if (!newName || (table && newName === table.name)) {
        return;
      }

      const updatedTable = await store.updateTable(tableId, {
        name: newName,
        updated_at: new Date().toISOString(),
      });

      if (updatedTable) {
        // Update selected table reference if it matches
        if (this.selectedTable?.id === tableId) {
          this.selectedTable = updatedTable;
        }
        Alpine.store('ui').showToast('Đã đổi tên bàn thành công!', 'success');
      } else {
        Alpine.store('ui').showToast(
          store.error || 'Không thể đổi tên bàn. Vui lòng thử lại.',
          'error',
        );
      }
    },

    /**
     * Cancel inline rename without saving. Triggered by Escape key.
     */
    cancelInlineRename() {
      this.inlineRenameTableId = null;
      this.inlineRenameValue = '';
    },

    // --- Delete Table ---

    /**
     * Show the delete confirmation modal for the currently selected table.
     * Only available in edit mode when a table is selected.
     */
    confirmDeleteTable() {
      if (!this.selectedTable) return;

      // Reset inactivity timer on delete button click (user interaction)
      if (this.isEditMode) this.resetInactivityTimer();

      this.showDeleteModal = true;
    },

    /**
     * Close the delete confirmation modal without deleting.
     */
    closeDeleteModal() {
      this.showDeleteModal = false;
    },

    /**
     * Execute table deletion after user confirms.
     * Calls the store's deleteTable() which checks for active orders
     * before proceeding with the delete.
     *
     * On success: closes modal, shows success toast, clears selection.
     * On error (active orders or FK constraint): shows error toast.
     *
     * Requirements: 5.1 AC-6 (delete table), 5.1 AC-7 (active order guard)
     */
    async submitDeleteTable() {
      if (!this.selectedTable) return;

      // Reset inactivity timer on delete confirmation (user interaction)
      if (this.isEditMode) this.resetInactivityTimer();

      const tableId = this.selectedTable.id;
      const tableName = this.selectedTable.name;
      const store = Alpine.store('tableMap');

      const success = await store.deleteTable(tableId);

      if (success) {
        this.showDeleteModal = false;
        this.selectedTable = null;
        Alpine.store('ui').showToast(`Đã xóa bàn ${tableName}`, 'success');
      } else {
        this.showDeleteModal = false;
        // Display the specific error from the store (active orders or FK constraint)
        const errorMsg = store.error || 'Không thể xóa bàn. Vui lòng thử lại.';
        Alpine.store('ui').showToast(errorMsg, 'error');
      }
    },

    // --- Pinch-to-Zoom (mobile) ---

    /**
     * Initialize pinch-to-zoom gesture handling on the map container.
     * Listens for two-finger touch events and applies CSS transform: scale()
     * to the map container. Scale is clamped between 0.5 and 2.0.
     *
     * Called during init() when viewport width < 768px (mobile).
     * Stores a cleanup function in _pinchCleanup for teardown in destroy().
     */
    initPinchZoom() {
      const container = document.getElementById('map-container');
      if (!container) {
        console.warn('[TableMapPage] initPinchZoom: map-container not found');
        return;
      }

      const MIN_SCALE = 0.5;
      const MAX_SCALE = 2.0;

      let initialPinchDistance = 0;
      let scaleAtPinchStart = this.mapScale;

      /**
       * Calculate the Euclidean distance between two touch points.
       * @param {Touch} touch1
       * @param {Touch} touch2
       * @returns {number} Distance in pixels
       */
      const getTouchDistance = (touch1, touch2) => {
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
      };

      const onTouchStart = (e) => {
        if (e.touches.length === 2) {
          // Record the starting pinch distance and current scale
          initialPinchDistance = getTouchDistance(e.touches[0], e.touches[1]);
          scaleAtPinchStart = this.mapScale;
        }
      };

      const onTouchMove = (e) => {
        if (e.touches.length === 2) {
          e.preventDefault(); // Prevent default scroll/zoom during pinch gesture

          const currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
          if (initialPinchDistance === 0) return;

          // Scale proportionally to finger distance change
          const ratio = currentDistance / initialPinchDistance;
          const newScale = Math.min(
            MAX_SCALE,
            Math.max(MIN_SCALE, scaleAtPinchStart * ratio),
          );

          this.mapScale = newScale;
          container.style.transform = `scale(${this.mapScale})`;
          container.style.transformOrigin = 'center center';
        }
      };

      const onTouchEnd = (e) => {
        if (e.touches.length < 2) {
          // Pinch gesture ended; reset tracking distance
          initialPinchDistance = 0;
        }
      };

      // Attach listeners; touchmove needs passive: false to allow preventDefault
      container.addEventListener('touchstart', onTouchStart, { passive: true });
      container.addEventListener('touchmove', onTouchMove, { passive: false });
      container.addEventListener('touchend', onTouchEnd, { passive: true });

      // Store cleanup function for destroy()
      this._pinchCleanup = () => {
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchmove', onTouchMove);
        container.removeEventListener('touchend', onTouchEnd);
        // Reset transform to default
        container.style.transform = '';
        container.style.transformOrigin = '';
      };

      console.log('[TableMapPage] Pinch-to-zoom initialized');
    },

    // --- Reset Table (S3-23) ---
    // Design reference: Section 4.3.8
    // Requirements: 5.2 EC-4

    /**
     * Reset a paid table back to empty. Uses a status guard (WHERE status = 'paid')
     * to prevent race conditions where the table was already reset or reused.
     */
    async confirmResetTable() {
      if (this.isResetting || !this.resetTableTarget) return;
      this.isResetting = true;

      try {
        const tableId = this.resetTableTarget.id;

        // Atomic update with status guard
        const { data, error } = await supabase
          .from('tables')
          .update({ status: 'empty' })
          .eq('id', tableId)
          .eq('status', 'paid')
          .select('id')
          .single();

        if (error || !data) {
          throw new Error('Chỉ có thể dọn dẹp bàn ở trạng thái Đã thanh toán.');
        }

        // Update local store
        const store = Alpine.store('tableMap');
        const table = store.getTableById(tableId);
        if (table) {
          table.status = 'empty';
          table.activeOrderStartedAt = null;
        }

        Alpine.store('ui').showToast('Đã dọn dẹp bàn', 'success');
        this.showResetPanel = false;
        this.resetTableTarget = null;
      } catch (err) {
        console.error('[TableMapPage] confirmResetTable failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể dọn dẹp bàn.', 'error');
      } finally {
        this.isResetting = false;
      }
    },

    // --- Transfer Table via Mini Map (Task 18.1) ---

    /**
     * Open the transfer table modal with a mini grid of all tables.
     * Source table is highlighted distinctly; only empty tables are clickable.
     *
     * @param {Object} sourceTable - The serving table to transfer from
     */
    openTransferTableModal(sourceTable) {
      if (!sourceTable || sourceTable.status !== 'serving') {
        Alpine.store('ui').showToast('Chỉ có thể chuyển bàn đang phục vụ.', 'warning');
        return;
      }

      const allTables = Alpine.store('tableMap').tables || [];
      const hasEmptyTables = allTables.some(t => t.status === 'empty');

      if (!hasEmptyTables) {
        Alpine.store('ui').showToast('Không có bàn trống nào để chuyển.', 'warning');
        return;
      }

      this.transferSourceTable = sourceTable;
      this.transferTargetTableId = null;
      this.showTransferConfirm = false;
      this.showTransferTableModal = true;
    },

    /**
     * Select a target table for transfer. Only empty tables can be selected.
     * Shows a confirmation prompt.
     *
     * @param {Object} table - The target table
     */
    selectTransferTarget(table) {
      if (table.status !== 'empty') return;
      if (table.id === this.transferSourceTable?.id) return;

      this.transferTargetTableId = table.id;
      this.showTransferConfirm = true;
    },

    /**
     * Get the display name for a table by ID (for confirmation message).
     * @param {string} tableId
     * @returns {string}
     */
    getTableNameById(tableId) {
      const t = Alpine.store('tableMap').getTableById(tableId);
      return t?.name || '';
    },

    /**
     * Confirm and execute the transfer via the transfer_order RPC.
     * Finds the active order for the source table, then invokes the
     * transfer-order Edge Function with the order and target table.
     */
    async confirmTransferTable() {
      if (this.isTransferringTable || !this.transferSourceTable || !this.transferTargetTableId) return;
      this.isTransferringTable = true;

      try {
        // Find active order for source table
        const { data: order, error: orderErr } = await supabase
          .from('orders')
          .select('id, started_at')
          .eq('table_id', this.transferSourceTable.id)
          .eq('status', 'active')
          .limit(1)
          .single();

        if (orderErr || !order) {
          throw new Error('Không tìm thấy đơn hàng hoạt động cho bàn này.');
        }

        const { data, error } = await supabase.functions.invoke('transfer-order', {
          body: { order_id: order.id, target_table_id: this.transferTargetTableId },
        });

        if (error) {
          const msg = data?.message || error.message || 'Không thể chuyển bàn.';
          throw new Error(msg);
        }

        // Update local table map: source -> empty, target -> serving
        const tableMap = Alpine.store('tableMap');
        const sourceTable = tableMap.getTableById(this.transferSourceTable.id);
        if (sourceTable) {
          sourceTable.status = 'empty';
          sourceTable.activeOrderStartedAt = null;
        }

        const targetTable = tableMap.getTableById(this.transferTargetTableId);
        if (targetTable) {
          targetTable.status = 'serving';
          targetTable.activeOrderStartedAt = order.started_at;
        }

        Alpine.store('ui').showToast('Đã chuyển bàn thành công', 'success');
        this.showTransferTableModal = false;
        this.transferSourceTable = null;
        this.transferTargetTableId = null;
        this.showTransferConfirm = false;
      } catch (err) {
        console.error('[TableMapPage] confirmTransferTable failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể chuyển bàn.', 'error');
      } finally {
        this.isTransferringTable = false;
      }
    },
  };
}

// Register as global function so x-data="tableMapPage()" works
// when the template is dynamically loaded by the router
window.tableMapPage = tableMapPage;
