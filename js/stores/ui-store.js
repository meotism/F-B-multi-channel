// UI Store - Alpine.store('ui'): toasts, modal, loading, sidebar state
//
// Manages global UI state including toast notifications, modal dialogs,
// loading indicators, and sidebar visibility.

export function uiStore() {
  return {
    // Toast notifications
    toasts: [],         // [{ id, message, type: 'success'|'error'|'warning'|'info', duration }]

    // Modal state
    activeModal: null,  // string identifier or null
    modalData: null,    // data passed to the active modal

    // Loading state
    globalLoading: false,
    loadingMessage: '',

    // Confirmation dialog state
    confirmAction: null, // { title, message, confirmLabel, danger, onConfirm } or null

    // Connectivity
    isOffline: !navigator.onLine,

    // SW update banner
    showUpdateBanner: false,

    // Sidebar (desktop/tablet)
    sidebarOpen: true,

    // Current hash for reactive nav highlighting
    currentHash: window.location.hash || '#/',

    /**
     * Show a toast notification.
     * @param {string} message - The message to display
     * @param {'success'|'error'|'warning'|'info'} type - Toast type
     * @param {number} duration - Auto-dismiss duration in ms
     */
    showToast(message, type = 'info', duration = 4000) {
      const id = Date.now();
      this.toasts.push({ id, message, type, duration });
      setTimeout(() => this.dismissToast(id), duration);
    },

    /**
     * Dismiss a toast notification by its ID.
     * @param {number} id - Toast ID to dismiss
     */
    dismissToast(id) {
      this.toasts = this.toasts.filter(t => t.id !== id);
    },

    /**
     * Open a modal dialog.
     * @param {string} modalName - Identifier for the modal to open
     * @param {*} data - Optional data to pass to the modal
     */
    openModal(modalName, data = null) {
      this.activeModal = modalName;
      this.modalData = data;
    },

    /** Close the currently active modal. */
    closeModal() {
      this.activeModal = null;
      this.modalData = null;
    },

    /**
     * Show the global loading indicator.
     * @param {string} message - Loading message to display
     */
    startLoading(message = 'Dang tai...') {
      this.globalLoading = true;
      this.loadingMessage = message;
    },

    /** Hide the global loading indicator. */
    stopLoading() {
      this.globalLoading = false;
      this.loadingMessage = '';
    },

    /**
     * Open a centralized confirmation dialog.
     * @param {Object} options
     * @param {string} options.title - Dialog title
     * @param {string} options.message - Dialog message
     * @param {string} [options.confirmLabel='Xác nhận'] - Confirm button text
     * @param {boolean} [options.danger=false] - Use danger styling
     * @param {Function} options.onConfirm - Callback on confirm
     */
    openConfirmDialog({ title, message, confirmLabel = 'Xác nhận', danger = false, onConfirm }) {
      this.confirmAction = { title, message, confirmLabel, danger, onConfirm };
    },

    /** Close the confirmation dialog without executing. */
    closeConfirmDialog() {
      this.confirmAction = null;
    },

    /** Execute the confirmation callback and close. */
    async executeConfirm() {
      if (this.confirmAction?.onConfirm) {
        await this.confirmAction.onConfirm();
      }
      this.confirmAction = null;
    },

    /** Reload the page to apply a SW update. */
    applyUpdate() {
      window.location.reload();
    },
  };
}
