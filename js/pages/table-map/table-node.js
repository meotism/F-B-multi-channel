// Table Node - Individual table sizing and rendering helpers
//
// Provides getTableWidth() and getTableHeight() functions that return
// the pixel dimensions of a table node based on its capacity and shape.
// These mirror the CSS rules in css/pages/table-map.css so that JS code
// (e.g., drag-and-drop boundary calculations) can determine table sizes
// without reading computed styles from the DOM.
//
// Design reference: design.md Section 4.2.4 (lines 6836-6839) for shapes,
//                   design.md Section 2.5 (lines 1463-1467) for capacity sizing.

/**
 * Base dimension lookup by capacity.
 * Keys are capacity values; values are { width, height } in pixels.
 * Default (2-seat) is used when capacity is not found.
 * @type {Object<number, {width: number, height: number}>}
 */
const CAPACITY_SIZES = {
  2: { width: 80,  height: 80  },
  4: { width: 100, height: 100 },
  6: { width: 120, height: 80  },
  8: { width: 140, height: 90  },
};

/** Default size used when capacity is not in the lookup table. */
const DEFAULT_SIZE = { width: 80, height: 80 };

/**
 * Get the pixel width of a table node based on its capacity and shape.
 *
 * - For `square` and `round` shapes, the width comes directly from the
 *   capacity-based size lookup (matches the CSS attribute selector rules).
 * - For `rectangle` shapes, width = 1.5 * height (aspect ratio override).
 *
 * @param {Object} table - Table object with `capacity` and `shape` properties
 * @param {number} table.capacity - Number of seats (2, 4, 6, 8)
 * @param {string} table.shape - Shape: 'square', 'round', or 'rectangle'
 * @returns {number} Width in pixels
 */
export function getTableWidth(table) {
  const size = CAPACITY_SIZES[table.capacity] || DEFAULT_SIZE;

  if (table.shape === 'rectangle') {
    // Rectangle: width = 1.5x height, using the capacity-based height
    return Math.round(size.height * 1.5);
  }

  // Square and round: use the capacity-based width directly.
  // The CSS defines specific width/height per capacity, and for
  // square/round the width comes from the data-capacity rule.
  return size.width;
}

/**
 * Get the pixel height of a table node based on its capacity and shape.
 *
 * Height is always determined by the capacity lookup table, regardless
 * of shape. Rectangle does not change the height -- only the width.
 *
 * @param {Object} table - Table object with `capacity` and `shape` properties
 * @param {number} table.capacity - Number of seats (2, 4, 6, 8)
 * @param {string} table.shape - Shape: 'square', 'round', or 'rectangle'
 * @returns {number} Height in pixels
 */
export function getTableHeight(table) {
  const size = CAPACITY_SIZES[table.capacity] || DEFAULT_SIZE;
  return size.height;
}

/**
 * Exported capacity sizes lookup for use in tests and other modules.
 * @type {Object<number, {width: number, height: number}>}
 */
export { CAPACITY_SIZES };
