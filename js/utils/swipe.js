// Swipe - onSwipe() utility for touch gesture detection
// Listens for horizontal swipe gestures (left/right) on an element.
// Uses passive listeners for optimal scroll performance.
// Returns a cleanup function to remove event listeners.

/**
 * Detect horizontal swipe gestures on an element.
 *
 * @param {HTMLElement} element - The element to listen on
 * @param {object} options - Swipe configuration
 * @param {Function} [options.onLeft] - Callback for left swipe
 * @param {Function} [options.onRight] - Callback for right swipe
 * @param {number} [options.threshold=50] - Minimum horizontal distance in px to trigger a swipe
 * @returns {Function} Cleanup function that removes touch listeners
 */
export function onSwipe(element, { onLeft, onRight, threshold = 50 } = {}) {
  let startX = 0;

  function handleTouchStart(e) {
    startX = e.touches[0].clientX;
  }

  function handleTouchEnd(e) {
    const endX = e.changedTouches[0].clientX;
    const delta = endX - startX;

    if (Math.abs(delta) < threshold) return;

    if (delta < 0 && onLeft) {
      onLeft();
    } else if (delta > 0 && onRight) {
      onRight();
    }
  }

  // Use passive listeners for better scroll performance
  element.addEventListener('touchstart', handleTouchStart, { passive: true });
  element.addEventListener('touchend', handleTouchEnd, { passive: true });

  // Return cleanup function
  return () => {
    element.removeEventListener('touchstart', handleTouchStart);
    element.removeEventListener('touchend', handleTouchEnd);
  };
}
