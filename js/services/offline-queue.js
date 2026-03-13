// Offline Queue - Queues operations when offline, flushes when back online
//
// Stores pending operations in localStorage under 'fb_offline_queue'.
// Each operation is tagged with a timestamp and unique ID.
// When connectivity is restored, the queue is flushed in order.
// Failed operations are re-queued for the next flush attempt.

const STORAGE_KEY = 'fb_offline_queue';

/**
 * Read the current queue from localStorage.
 * @returns {Array<object>} The queued operations
 */
function readQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Write the queue to localStorage.
 * @param {Array<object>} queue - The operations to persist
 */
function writeQueue(queue) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

/**
 * Execute a single queued operation.
 * Dispatches by op.type to the appropriate service method.
 * Uses dynamic imports so service modules are only loaded when needed.
 *
 * @param {object} op - The operation to execute
 * @returns {Promise<void>}
 */
async function execute(op) {
  switch (op.type) {
    case 'create_order': {
      const { createOrder } = await import('./order-service.js');
      const options = {};
      if (op.guestCount != null) {
        options.guestCount = op.guestCount;
      }
      await createOrder(op.tableId, op.outletId, op.userId, op.cartItems, options);
      break;
    }
    case 'update_item_qty': {
      const { updateItemQty } = await import('./order-service.js');
      await updateItemQty(op.itemId, op.qty);
      break;
    }
    case 'add_item': {
      const { addItem } = await import('./order-service.js');
      await addItem(op.orderId, op.item);
      break;
    }
    default:
      console.warn(`[OfflineQueue] Unknown operation type: ${op.type}`);
  }
}

export const offlineQueue = {
  /**
   * Add an operation to the offline queue.
   * Tags the operation with a unique ID and timestamp.
   *
   * @param {object} operation - The operation descriptor (must include a `type` field)
   */
  enqueue(operation) {
    const queue = readQueue();
    queue.push({
      ...operation,
      timestamp: Date.now(),
      id: crypto.randomUUID(),
    });
    writeQueue(queue);
  },

  /**
   * Process all queued operations in order.
   * Successfully processed items are removed; failed items are re-queued.
   *
   * @returns {Promise<{processed: number, failed: number}>} Result counts
   */
  async flush() {
    const queue = readQueue();
    if (queue.length === 0) return { processed: 0, failed: 0 };

    let processed = 0;
    let failed = 0;
    const failedOps = [];

    for (const op of queue) {
      try {
        await execute(op);
        processed++;
      } catch (err) {
        console.error(`[OfflineQueue] Failed to execute op ${op.id}:`, err);
        failed++;
        failedOps.push(op);
      }
    }

    // Re-queue failed operations for the next attempt
    writeQueue(failedOps);

    return { processed, failed };
  },

  /**
   * Get the current queue contents.
   * @returns {Array<object>} The queued operations
   */
  getQueue() {
    return readQueue();
  },

  /**
   * Clear all operations from the queue.
   */
  clear() {
    writeQueue([]);
  },

  /**
   * Get the number of operations in the queue.
   * @returns {number} Queue length
   */
  getSize() {
    return readQueue().length;
  },
};

// Auto-flush when connectivity is restored
window.addEventListener('online', async () => {
  const size = offlineQueue.getSize();
  if (size === 0) return;

  try {
    const { processed, failed } = await offlineQueue.flush();
    Alpine.store('ui').showToast(
      `Da dong bo ${processed} thao tac.${failed ? ` ${failed} that bai, se thu lai.` : ''}`,
      failed ? 'warning' : 'success',
    );
  } catch (err) {
    console.error('[OfflineQueue] Flush on reconnect failed:', err);
    Alpine.store('ui').showToast(
      'Dong bo that bai. Se thu lai khi co mang.',
      'error',
    );
  }
});
