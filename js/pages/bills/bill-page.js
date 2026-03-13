// Bill Page - Bill review, finalize, print x-data component
//
// Alpine.js component for the bill/payment page. Loads the order data and
// any existing bill for an order, displays the order summary, allows
// selecting a payment method, finalizing the bill, and triggering printing.
//
// The component reads the `orderId` from route params, loads the order with
// items via `loadOrder()`, looks up table/staff info, and checks for an
// existing bill via `getBillByOrderId()`.
//
// Design reference: design.md Section 5 (Bill Page)
// Requirements: 1 (Bill Finalization), 4 (Bill Page UI), 9 (End-to-End Print Flow)

import { finalizeBill, getBillByOrderId, getBillsByOrderId, updateBillStatus } from '../../services/bill-service.js';
import { splitByItems, splitEqual } from '../../services/split-bill-service.js';
import { calculateDiscount } from '../../services/discount-service.js';
import { loadOrder } from '../../services/order-service.js';
import { formatVND, formatDate } from '../../utils/formatters.js';
import { navigate } from '../../utils/navigate.js';
import { buildBillEscPos } from '../../services/escpos-service.js';
import { BluetoothConnectionManager, printWithRetry, bluetoothService } from '../../services/bluetooth-service.js';
import { supabase } from '../../services/supabase-client.js';

/**
 * Alpine component factory for the bill page.
 * Used as x-data="billPage()" in pages/bill.html.
 *
 * @returns {Object} Alpine component data object
 */
export function billPage() {
  return {
    // --- Page state ---
    isLoading: true,       // Whether the page is loading data
    isFinalizing: false,   // Whether the finalize action is in progress
    isPrinting: false,     // Whether the print action is in progress
    orderId: null,         // UUID from route params
    order: null,           // Full order object from Supabase
    orderItems: [],        // Array of order_items with menu_items join
    bill: null,            // Existing bill record (null if not yet finalized)
    paymentMethod: 'cash', // Selected payment method: 'cash' | 'card' | 'transfer'
    table: null,           // Table object from tableMap store
    staffName: '',         // Name of the user who created the order

    // --- Bluetooth / Realtime state ---
    billChannel: null,           // Supabase Realtime channel for bill changes
    connectionManager: null,     // BluetoothConnectionManager instance for print session

    // --- Confirmation modal state ---
    showFinalizeConfirm: false, // Whether the finalize confirmation modal is visible

    // --- Discount state (Task 10.3) ---
    discount: null,           // Discount object if order has discount_id
    discountAmount: 0,        // Calculated discount amount in VND

    // --- Split bill state (Task 10.2) ---
    showSplitModal: false,    // Whether the split bill modal is visible
    splitMode: 'by_item',     // 'by_item' | 'equal'
    splitItemChecked: [],     // Array of booleans parallel to orderItems for checkbox state
    splitEqualCount: 2,       // Number of equal splits
    isSplitting: false,       // Whether split action is in progress
    splitBills: [],           // Generated bills after split

    // --- Keyboard shortcut handler ref (Task 10.1) ---
    _keyHandler: null,

    // --- Hourly charge timer state ---
    _hourlyTimer: null,
    _hourlyTick: 0,

    // --- Computed properties ---

    /**
     * Calculate subtotal from all order items (price * qty).
     * @returns {number} Subtotal in VND
     */
    get subtotal() {
      return this.orderItems.reduce((sum, item) => sum + (item.price * item.qty), 0);
    },

    /**
     * Tax amount. Currently 0 (no tax applied).
     * @returns {number} Tax amount in VND
     */
    get tax() {
      return 0;
    },

    /**
     * Hourly charge from finalized bill, or 0 if not applicable.
     * @returns {number} Hourly charge in VND
     */
    get hourlyCharge() {
      return this.bill?.hourly_charge || 0;
    },

    /**
     * Estimated hourly charge before finalization (live running cost).
     * Returns 0 if table has no hourly rate or bill is already finalized.
     * @returns {number} Estimated charge in VND
     */
    get estimatedHourlyCharge() {
      if (this.bill || !this.table?.hourly_rate || !this.order?.started_at) return 0;
      // Reference _hourlyTick for Alpine reactivity (ticks every second)
      void this._hourlyTick;
      const elapsed = (Date.now() - new Date(this.order.started_at).getTime()) / 1000;
      return Math.round((elapsed / 3600) * this.table.hourly_rate);
    },

    /**
     * Display hourly charge: finalized value or live estimate.
     * @returns {number} Hourly charge in VND
     */
    get displayHourlyCharge() {
      return this.bill ? this.hourlyCharge : this.estimatedHourlyCharge;
    },

    /**
     * Whether hourly charge should be displayed on the bill.
     * @returns {boolean}
     */
    get hasHourlyCharge() {
      return this.hourlyCharge > 0 || (this.table?.hourly_rate > 0 && !this.bill);
    },

    /**
     * Format duration_seconds from bill for display.
     * @returns {string} Formatted duration (e.g., "1h 30p") or empty string
     */
    get durationDisplay() {
      const secs = this.bill?.duration_seconds;
      if (!secs) return '';
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      return h > 0 ? `${h}h ${m}p` : `${m} phút`;
    },

    /**
     * Grand total = subtotal - discountAmount + hourlyCharge + tax.
     * Before finalization uses estimated hourly charge for preview.
     * @returns {number} Grand total in VND
     */
    get grandTotal() {
      return this.subtotal - this.discountAmount + this.displayHourlyCharge + this.tax;
    },

    /**
     * Whether the split bill button should be shown.
     * Only before finalization and when there are 2+ items.
     * @returns {boolean}
     */
    get canSplit() {
      return !this.bill && this.orderItems.length >= 2 && this.order?.status === 'completed';
    },

    /**
     * Whether the bill has been finalized (bill record exists).
     * @returns {boolean}
     */
    get isBillFinalized() {
      return !!this.bill;
    },

    /**
     * Whether the finalize button should be enabled.
     * Only completed orders without an existing bill can be finalized.
     * @returns {boolean}
     */
    get canFinalize() {
      return this.order?.status === 'completed' && !this.bill;
    },

    /**
     * Whether the print button should be shown.
     * Bill must exist, not yet printed, and Bluetooth must be supported.
     * @returns {boolean}
     */
    get canPrint() {
      return this.bill && this.bill.status !== 'printed' && Alpine.store('printer').isBluetoothSupported();
    },

    /**
     * Whether a Bluetooth printer is currently connected and ready to print.
     * Used to gate auto-print after finalization — avoids prompting the
     * Bluetooth picker when no printer has been paired.
     * @returns {boolean}
     */
    get hasPrinterConnected() {
      return this.connectionManager?.isConnected && !!this.connectionManager.writeChar;
    },

    /**
     * Status badge configuration based on bill state.
     * @returns {{ text: string, class: string }}
     */
    get statusBadge() {
      if (!this.bill) {
        return { text: 'Chưa xuất hóa đơn', class: 'badge--muted' };
      }
      const map = {
        finalized: { text: 'Đã xuất hóa đơn', class: 'badge--info' },
        printed: { text: 'Đã in', class: 'badge--success' },
        pending_print: { text: 'Chờ in lại', class: 'badge--warning' },
      };
      return map[this.bill.status] || { text: this.bill.status, class: 'badge--muted' };
    },

    /**
     * Total number of items in the order.
     * @returns {number}
     */
    get itemCount() {
      return this.orderItems.reduce((sum, item) => sum + item.qty, 0);
    },

    // --- Lifecycle ---

    /**
     * Initialize the component: read route params, load order data, check for
     * existing bill, and subscribe to Realtime bill changes for cross-device sync.
     * Called automatically by Alpine when the component mounts.
     */
    async init() {
      // Extract orderId from route params stored by the router
      const params = JSON.parse(
        document.getElementById('page-container').dataset.routeParams || '{}',
      );
      this.orderId = params.orderId;

      if (!this.orderId) {
        Alpine.store('ui').showToast('Thiếu thông tin đơn hàng', 'error');
        navigate('/tables');
        return;
      }

      await this.loadOrderData();

      // Start timer for live hourly charge estimate (billiard tables)
      if (this.table?.hourly_rate > 0 && !this.bill) {
        this._hourlyTimer = setInterval(() => {
          // Force Alpine reactivity by touching a reactive property
          this._hourlyTick = (this._hourlyTick || 0) + 1;
        }, 1000);
      }

      // Subscribe to bill changes for cross-device sync (Requirement 9 AC-4)
      this.subscribeToBillChanges();

      // Task 10.1: Register keyboard shortcuts
      this._keyHandler = (e) => {
        // Guard against modal open state
        if (this.showFinalizeConfirm || this.showSplitModal) return;

        if (e.ctrlKey && e.key === 'Enter') {
          e.preventDefault();
          if (this.canFinalize && !this.isFinalizing) {
            this.showFinalizeConfirm = true;
          }
        }
        if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) {
          e.preventDefault();
          if (this.canPrint && !this.isPrinting) {
            this.printBill();
          }
        }
      };
      document.addEventListener('keydown', this._keyHandler);
    },

    /**
     * Subscribe to Supabase Realtime changes on the bills table filtered
     * by order_id. Keeps the local bill state in sync across devices.
     */
    subscribeToBillChanges() {
      if (!this.orderId) return;

      this.billChannel = supabase
        .channel(`bill-${this.orderId}`)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'bills',
          filter: `order_id=eq.${this.orderId}`,
        }, (payload) => {
          if (payload.new) {
            this.bill = payload.new;
            // Sync payment method from the bill record
            if (payload.new.payment_method) {
              this.paymentMethod = payload.new.payment_method;
            }
          }
        })
        .subscribe();
    },

    /**
     * Clean up Realtime subscription and Bluetooth connection when the
     * component is destroyed (e.g., navigating away).
     */
    destroy() {
      if (this.billChannel) {
        supabase.removeChannel(this.billChannel);
        this.billChannel = null;
      }
      if (this.connectionManager) {
        this.connectionManager.disconnect();
        this.connectionManager = null;
      }
      // Task 10.1: Remove keyboard shortcut handler
      if (this._keyHandler) {
        document.removeEventListener('keydown', this._keyHandler);
        this._keyHandler = null;
      }
      // Clean up hourly charge timer
      if (this._hourlyTimer) {
        clearInterval(this._hourlyTimer);
        this._hourlyTimer = null;
      }
    },

    /**
     * Load order data, items, table info, staff name, and check for existing bill.
     */
    async loadOrderData() {
      this.isLoading = true;

      try {
        // 1. Load order with items
        const order = await loadOrder(this.orderId);
        this.order = order;
        this.orderItems = (order.order_items || []).map(item => ({
          ...item,
          menuItemName: item.menu_items?.name || '',
        }));

        // 2. Look up table info from the tableMap store
        if (order.table_id) {
          this.table = Alpine.store('tableMap').getTableById(order.table_id) || null;
        }

        // 3. Look up staff name from auth store or order user_id
        const authUser = Alpine.store('auth').user;
        if (authUser) {
          this.staffName = authUser.name || '';
        }

        // 4. Check for existing bill
        const existingBill = await getBillByOrderId(this.orderId);
        if (existingBill) {
          this.bill = existingBill;
          // If bill exists, set payment method from bill
          if (existingBill.payment_method) {
            this.paymentMethod = existingBill.payment_method;
          }
        }

        // 5. Task 10.3: Load discount details if order has discount_id
        if (order.discount_id) {
          try {
            const { data: discountData, error: discountErr } = await supabase
              .from('discounts')
              .select('*')
              .eq('id', order.discount_id)
              .maybeSingle();

            if (!discountErr && discountData) {
              this.discount = discountData;
              this.discountAmount = calculateDiscount(this.subtotal, discountData);
            }
          } catch (discErr) {
            console.warn('[billPage] Failed to load discount:', discErr);
          }
        }

        // 6. Task 10.2: Load split bills if any
        try {
          const allBills = await getBillsByOrderId(this.orderId);
          if (allBills && allBills.length > 1) {
            this.splitBills = allBills;
          }
        } catch (splitErr) {
          console.warn('[billPage] Failed to load split bills:', splitErr);
        }
      } catch (err) {
        console.error('[billPage] loadOrderData failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể tải dữ liệu hóa đơn.', 'error');
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * Navigate back to the order detail page for this order's table.
     */
    goBack() {
      if (this.order?.table_id) {
        navigate(`/orders/${this.order.table_id}`);
      } else {
        navigate('/tables');
      }
    },

    /**
     * Navigate to the table map.
     */
    goToTableMap() {
      navigate('/tables');
    },

    /**
     * Finalize the bill. Shows confirmation dialog first, then calls the
     * bill service to create the bill record.
     * On success: updates local state, shows success toast.
     * On error: shows Vietnamese error toast.
     */
    async finalizeBillAction() {
      if (this.isFinalizing) return;
      this.isFinalizing = true;
      this.showFinalizeConfirm = false;

      try {
        const billData = await finalizeBill(this.orderId, this.paymentMethod);
        this.bill = billData;

        // Stop hourly charge timer after finalization
        if (this._hourlyTimer) {
          clearInterval(this._hourlyTimer);
          this._hourlyTimer = null;
        }

        // Update local order status to reflect finalization
        if (this.order) {
          this.order.status = 'finalized';
        }

        // Reset table to 'empty' after finalization — table is now free for new guests
        if (this.order?.table_id) {
          const { error: tableErr } = await supabase
            .from('tables')
            .update({ status: 'empty' })
            .eq('id', this.order.table_id);

          if (tableErr) {
            console.error('[billPage] Failed to reset table status:', tableErr);
          }

          // Update the global tableMap store so the table map shows 'empty' immediately
          const tableMap = Alpine.store('tableMap');
          const tbl = tableMap.getTableById(this.order.table_id);
          if (tbl) {
            tbl.status = 'empty';
            tbl.activeOrderStartedAt = null;
          }
        }

        Alpine.store('ui').showToast('Hóa đơn đã được xuất thành công', 'success');

        // Auto-trigger print only if a Bluetooth printer is already connected.
        // If not connected, skip — user can print later via the print button.
        // (Requirement 9 AC-1: auto-print after finalize when printer connected)
        if (this.canPrint && this.hasPrinterConnected) {
          await this.printBill();
        }
      } catch (err) {
        console.error('[billPage] finalizeBill failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể xuất hóa đơn.', 'error');
      } finally {
        this.isFinalizing = false;
      }
    },

    /**
     * Print the bill via Bluetooth.
     *
     * Flow: get printer config -> get outlet info -> build ESC/POS bytes ->
     * establish Bluetooth connection if needed -> send via printWithRetry ->
     * update bill status based on result.
     *
     * Requirement 9 AC-1 through AC-5.
     */
    async printBill() {
      if (this.isPrinting || !this.bill) return;
      this.isPrinting = true;

      try {
        // 1. Get active printer config from store
        const printerConfig = Alpine.store('printer').getActivePrinterConfig();

        // 2. Get outlet info for receipt header
        const outlet = Alpine.store('outlet').currentOutlet;
        if (!outlet) {
          throw new Error('Không tìm thấy thông tin cửa hàng');
        }

        // 3. Build ESC/POS byte data
        //    buildBillEscPos expects items with { name, quantity, price, note }
        //    but our orderItems have { menuItemName, qty, price, note }
        const printItems = this.orderItems.map(item => ({
          name: item.menuItemName || item.menu_items?.name || '',
          quantity: item.qty,
          price: item.price,
          note: item.note || '',
        }));

        const escPosData = buildBillEscPos(
          this.bill,
          outlet,
          this.order,
          printItems,
          this.table || { name: 'Khong xac dinh' },
          this.staffName,
          printerConfig,
        );

        // 4. Get or establish Bluetooth connection
        const writeChar = await this.getOrConnectPrinter();

        // 5. Send via printWithRetry
        const result = await printWithRetry(writeChar, escPosData, printerConfig.chunkSize);

        // 6. Handle result
        const userId = Alpine.store('auth').user?.id;

        if (result.success) {
          // Update bill status to 'printed' (Requirement 9 AC-2)
          const updatedBill = await updateBillStatus(this.bill.id, 'printed', userId);
          this.bill = updatedBill;

          Alpine.store('printer').isConnected = true;
          Alpine.store('ui').showToast('In hóa đơn thành công!', 'success');
        } else {
          // Update bill status to 'pending_print' (Requirement 9 AC-3)
          const updatedBill = await updateBillStatus(this.bill.id, 'pending_print', userId);
          this.bill = updatedBill;

          Alpine.store('ui').showToast('In thất bại. Vui lòng thử lại.', 'error');
        }
      } catch (err) {
        console.error('[billPage] printBill failed:', err);

        // If user cancelled the Bluetooth picker, do not show error
        if (err.name === 'NotFoundError') {
          return;
        }

        // Update bill to pending_print so retry button appears
        try {
          const userId = Alpine.store('auth').user?.id;
          if (this.bill) {
            const updatedBill = await updateBillStatus(this.bill.id, 'pending_print', userId);
            this.bill = updatedBill;
          }
        } catch (statusErr) {
          console.error('[billPage] failed to update bill to pending_print:', statusErr);
        }

        Alpine.store('ui').showToast('Lỗi in hóa đơn: ' + err.message, 'error');
      } finally {
        this.isPrinting = false;
      }
    },

    /**
     * Get an existing Bluetooth writeChar or establish a new connection.
     * If the connection manager has an active connection, reuse it.
     * Otherwise, prompt the user to select a Bluetooth printer and connect.
     *
     * @returns {Promise<BluetoothRemoteGATTCharacteristic>} writable characteristic
     * @throws {Error} if connection fails or user cancels
     */
    async getOrConnectPrinter() {
      // Reuse existing connection if still active
      if (this.connectionManager?.isConnected && this.connectionManager.writeChar) {
        return this.connectionManager.writeChar;
      }

      // Create a new connection manager if needed
      if (!this.connectionManager) {
        this.connectionManager = new BluetoothConnectionManager();
      }

      // Prompt user to select a Bluetooth printer device
      const device = await bluetoothService.scanForPrinter();
      await this.connectionManager.connect(device);

      // Update printer store connection state
      Alpine.store('printer').isConnected = true;

      // Update last_seen for the active printer
      const activePrinterId = Alpine.store('printer').activePrinterId;
      if (activePrinterId) {
        Alpine.store('printer').touchLastSeen(activePrinterId);
      }

      return this.connectionManager.writeChar;
    },

    /**
     * Retry printing the bill. Same flow as printBill.
     * Used when bill status is 'pending_print' after a previous failure.
     */
    async retryPrint() {
      await this.printBill();
    },

    // --- Split Bill Methods (Task 10.2) ---

    /**
     * Open the split bill modal and initialize checkbox state.
     */
    openSplitModal() {
      this.splitItemChecked = this.orderItems.map(() => false);
      this.splitEqualCount = 2;
      this.splitMode = 'by_item';
      this.showSplitModal = true;
    },

    /**
     * Close the split bill modal.
     */
    closeSplitModal() {
      this.showSplitModal = false;
    },

    /**
     * Execute the split bill action based on the selected mode.
     */
    async submitSplit() {
      if (this.isSplitting) return;
      this.isSplitting = true;

      try {
        const userId = Alpine.store('auth').user?.id;
        const outletId = Alpine.store('auth').user?.outlet_id;

        if (!userId || !outletId) {
          throw new Error('Thiếu thông tin người dùng hoặc cửa hàng');
        }

        let bills;

        if (this.splitMode === 'by_item') {
          // Group 1: checked items, Group 2: unchecked items
          const group1Ids = [];
          const group2Ids = [];
          this.orderItems.forEach((item, idx) => {
            if (this.splitItemChecked[idx]) {
              group1Ids.push(item.id);
            } else {
              group2Ids.push(item.id);
            }
          });

          if (group1Ids.length === 0 || group2Ids.length === 0) {
            throw new Error('Mỗi nhóm phải có ít nhất 1 món');
          }

          bills = await splitByItems(this.orderId, [
            { orderItemIds: group1Ids, paymentMethod: this.paymentMethod },
            { orderItemIds: group2Ids, paymentMethod: this.paymentMethod },
          ], userId, outletId);
        } else {
          // Equal split
          if (this.splitEqualCount < 2) {
            throw new Error('Số lượng tách phải >= 2');
          }
          bills = await splitEqual(
            this.orderId,
            this.splitEqualCount,
            this.paymentMethod,
            userId,
            outletId,
          );
        }

        this.splitBills = bills;
        this.bill = bills[0]; // Set first bill as active
        if (this.order) {
          this.order.status = 'finalized';
        }

        Alpine.store('ui').showToast('Tách hóa đơn thành công', 'success');
        this.closeSplitModal();
      } catch (err) {
        console.error('[billPage] splitBill failed:', err);
        Alpine.store('ui').showToast(err.message || 'Không thể tách hóa đơn', 'error');
      } finally {
        this.isSplitting = false;
      }
    },

    /**
     * Format discount type to Vietnamese display text.
     * @param {string} type - 'percent' or 'fixed'
     * @returns {string}
     */
    formatDiscountType(type) {
      return type === 'percent' ? 'Phần trăm' : 'Cố định';
    },

    // --- Formatting helpers ---

    /**
     * Format a price value as VND string (e.g., "55.000").
     * @param {number} amount - The price amount
     * @returns {string} Formatted VND string
     */
    formatVND(amount) {
      return formatVND(amount);
    },

    /**
     * Format a timestamp as a localized date/time string.
     * @param {string} ts - ISO timestamp string
     * @returns {string} Formatted date/time string
     */
    formatDateTime(ts) {
      return formatDate(ts, 'long');
    },

    /**
     * Format a payment method code to Vietnamese display text.
     * @param {string} method - Payment method code: 'cash' | 'card' | 'transfer'
     * @returns {string} Vietnamese display text
     */
    formatPaymentMethod(method) {
      const map = {
        cash: 'Tiền mặt',
        card: 'Thẻ',
        transfer: 'Chuyển khoản',
      };
      return map[method] || method;
    },
  };
}

// Register as global function so x-data="billPage()" works
// when the template is dynamically loaded by the router
window.billPage = billPage;
