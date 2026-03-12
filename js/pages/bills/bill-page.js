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

import { finalizeBill, getBillByOrderId, updateBillStatus } from '../../services/bill-service.js';
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
     * Grand total = subtotal + tax.
     * @returns {number} Grand total in VND
     */
    get grandTotal() {
      return this.subtotal + this.tax;
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
     * Status badge configuration based on bill state.
     * @returns {{ text: string, class: string }}
     */
    get statusBadge() {
      if (!this.bill) {
        return { text: 'Chua xuat hoa don', class: 'badge--muted' };
      }
      const map = {
        finalized: { text: 'Da xuat hoa don', class: 'badge--info' },
        printed: { text: 'Da in', class: 'badge--success' },
        pending_print: { text: 'Cho in lai', class: 'badge--warning' },
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
        Alpine.store('ui').showToast('Thieu thong tin don hang', 'error');
        navigate('/tables');
        return;
      }

      await this.loadOrderData();

      // Subscribe to bill changes for cross-device sync (Requirement 9 AC-4)
      this.subscribeToBillChanges();
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
      } catch (err) {
        console.error('[billPage] loadOrderData failed:', err);
        Alpine.store('ui').showToast(err.message || 'Khong the tai du lieu hoa don.', 'error');
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

        // Update local order status to reflect finalization
        if (this.order) {
          this.order.status = 'finalized';
        }

        // Update table status in tableMap store
        if (this.table) {
          this.table.status = 'awaiting_payment';
        }

        Alpine.store('ui').showToast('Hoa don da duoc xuat thanh cong', 'success');

        // Auto-trigger print if Bluetooth is supported and a printer is configured
        // (Requirement 9 AC-1: auto-print after finalize when printer connected)
        if (this.canPrint) {
          await this.printBill();
        }
      } catch (err) {
        console.error('[billPage] finalizeBill failed:', err);
        Alpine.store('ui').showToast(err.message || 'Khong the xuat hoa don.', 'error');
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
          throw new Error('Khong tim thay thong tin cua hang');
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

          // Update table status to 'paid' (Requirement 9 AC-5)
          if (this.order?.table_id) {
            await supabase
              .from('tables')
              .update({ status: 'paid' })
              .eq('id', this.order.table_id);

            // Update local table state in the tableMap store
            if (this.table) {
              this.table.status = 'paid';
            }
          }

          Alpine.store('printer').isConnected = true;
          Alpine.store('ui').showToast('In hoa don thanh cong!', 'success');
        } else {
          // Update bill status to 'pending_print' (Requirement 9 AC-3)
          const updatedBill = await updateBillStatus(this.bill.id, 'pending_print', userId);
          this.bill = updatedBill;

          Alpine.store('ui').showToast('In that bai. Vui long thu lai.', 'error');
        }
      } catch (err) {
        console.error('[billPage] printBill failed:', err);

        // If user cancelled the Bluetooth picker, do not show error
        if (err.name === 'NotFoundError') {
          return;
        }

        Alpine.store('ui').showToast('Loi in hoa don: ' + err.message, 'error');
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
        cash: 'Tien mat',
        card: 'The',
        transfer: 'Chuyen khoan',
      };
      return map[method] || method;
    },
  };
}

// Register as global function so x-data="billPage()" works
// when the template is dynamically loaded by the router
window.billPage = billPage;
