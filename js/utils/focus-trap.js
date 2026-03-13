// Focus Trap - trapFocus() utility for modal dialogs
// Traps keyboard focus within a modal element, cycling Tab/Shift+Tab
// through focusable children. Handles Escape to close the modal.
// Returns a cleanup function to remove event listeners.

// Selector for all natively focusable elements
const FOCUSABLE_SELECTOR = [
  'button',
  '[href]',
  'input',
  'select',
  'textarea',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Trap keyboard focus within a modal element.
 *
 * - Finds all focusable elements inside the modal
 * - Cycles Tab / Shift+Tab within the modal boundary
 * - Pressing Escape closes the modal via Alpine.store('ui').closeModal()
 * - Auto-focuses the first focusable element
 *
 * @param {HTMLElement} modalElement - The modal container element
 * @returns {Function} Cleanup function that removes the keydown listener
 */
export function trapFocus(modalElement) {
  /**
   * Keydown handler that manages Tab cycling and Escape closing.
   * @param {KeyboardEvent} e
   */
  function handleKeydown(e) {
    // Close modal on Escape
    if (e.key === 'Escape') {
      Alpine.store('ui').closeModal();
      return;
    }

    // Only handle Tab key
    if (e.key !== 'Tab') return;

    // Query focusable elements each time (modal content may change)
    const focusableEls = modalElement.querySelectorAll(FOCUSABLE_SELECTOR);
    if (focusableEls.length === 0) return;

    const firstEl = focusableEls[0];
    const lastEl = focusableEls[focusableEls.length - 1];

    if (e.shiftKey) {
      // Shift+Tab: if on first element, wrap to last
      if (document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      }
    } else {
      // Tab: if on last element, wrap to first
      if (document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  }

  // Attach listener
  modalElement.addEventListener('keydown', handleKeydown);

  // Auto-focus the first focusable element
  const firstFocusable = modalElement.querySelector(FOCUSABLE_SELECTOR);
  if (firstFocusable) {
    firstFocusable.focus();
  }

  // Return cleanup function
  return () => {
    modalElement.removeEventListener('keydown', handleKeydown);
  };
}
