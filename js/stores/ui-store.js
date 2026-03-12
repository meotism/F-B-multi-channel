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

    // Sidebar (desktop/tablet)
    sidebarOpen: true,

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
  };
}
