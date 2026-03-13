// Announce - announce() utility for screen reader announcements
// Uses a live region (#status-announcer) to communicate dynamic changes
// to assistive technology. Clears and re-sets text via requestAnimationFrame
// to ensure screen readers re-read the message.

/**
 * Announce a message to screen readers via the #status-announcer live region.
 * Silently does nothing if the announcer element does not exist.
 *
 * @param {string} message - The message to announce
 */
export function announce(message) {
  const el = document.getElementById('status-announcer');
  if (!el) return;

  // Clear text first, then set via rAF so screen readers detect the change
  el.textContent = '';
  requestAnimationFrame(() => {
    el.textContent = message;
  });
}
