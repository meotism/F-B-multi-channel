-- ============================================================
-- Table Summary View
-- ============================================================
-- Creates a view joining tables with their active order data
-- (guest count, order total) for table map display.
--
-- Dependencies:
--   - 001_initial_schema.sql (tables, orders, order_items)
--   - 022_add_enhancement_columns.sql (orders.guest_count)
--
-- Requirements: 3.6
-- ============================================================

BEGIN;

CREATE OR REPLACE VIEW table_summary AS
SELECT
    t.id AS table_id,
    t.outlet_id,
    t.name,
    t.table_code,
    t.capacity,
    t.shape,
    t.status,
    t.x,
    t.y,
    t.rotation,
    o.id AS active_order_id,
    COALESCE(o.guest_count, 0) AS guest_count,
    COALESCE(item_totals.order_total, 0) AS order_total
FROM tables t
LEFT JOIN orders o
    ON o.table_id = t.id
    AND o.status IN ('active', 'completed')
LEFT JOIN (
    SELECT
        oi.order_id,
        SUM(oi.price * oi.qty) AS order_total
    FROM order_items oi
    GROUP BY oi.order_id
) item_totals ON item_totals.order_id = o.id;

COMMENT ON VIEW table_summary IS
    'Joins tables with active/completed order data (guest count, order total). '
    'Used by table map to display inline info on table cards. '
    'Requirement 3.6.';

COMMIT;
