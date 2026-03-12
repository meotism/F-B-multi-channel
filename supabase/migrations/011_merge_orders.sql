-- ============================================================
-- Merge Orders Stored Procedure
-- ============================================================
-- This migration creates:
--   1. merge_orders()  - Stored procedure for atomically merging
--      order_items from one or more source orders into a target
--      order. Called via supabase.rpc('merge_orders', ...) from
--      the merge-orders Edge Function.
--
-- The procedure performs ALL operations in a single transaction:
--   a. Combines target + source IDs into one array.
--   b. Locks ALL involved orders FOR UPDATE, sorted by ID to
--      prevent deadlocks when concurrent merges target overlapping
--      sets of orders.
--   c. Validates all orders exist, all are 'active', and all
--      belong to the caller's outlet.
--   d. Moves order_items from source orders to the target order.
--   e. Cancels source orders (status = 'cancelled', ended_at = now()).
--   f. Collects source table IDs.
--   g. Resets source tables to 'empty' only if no other active
--      orders remain on them.
--   h. Counts total items now on the target order.
--   i. Creates an audit_log entry with action 'merge' and details
--      of source orders cancelled and tables reset.
--   j. Returns JSONB with merged order details.
--
-- Dependencies: 001_initial_schema.sql (tables, enums, triggers)
--               009_cancel_order.sql (pattern reference)
--               010_transfer_order.sql (pattern reference)
-- Requirements: 5.2 AC-8 (merge orders)
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION merge_orders(
    p_target_order_id UUID,
    p_source_order_ids UUID[],
    p_user_id UUID,
    p_outlet_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_all_order_ids UUID[];
    v_locked_orders RECORD;
    v_locked_count INTEGER;
    v_expected_count INTEGER;
    v_all_active BOOLEAN;
    v_all_same_outlet BOOLEAN;
    v_target_table_id UUID;
    v_source_table_ids UUID[];
    v_tables_reset UUID[] := '{}';
    v_total_items INTEGER;
BEGIN
    -- a. Combine target + source IDs into one array for locking
    v_all_order_ids := p_target_order_id || p_source_order_ids;
    v_expected_count := array_length(v_all_order_ids, 1);

    -- b. Lock ALL involved orders sorted by ID to prevent deadlocks.
    --    CRITICAL: Sorting by ID ensures consistent lock acquisition order
    --    when concurrent merge operations target overlapping sets of orders.
    SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE status = 'active') AS active_count,
        COUNT(DISTINCT outlet_id) AS outlet_count,
        bool_and(outlet_id = p_outlet_id) AS all_match_outlet
    INTO v_locked_orders
    FROM (
        SELECT id, status, outlet_id
        FROM orders
        WHERE id = ANY(v_all_order_ids)
        ORDER BY id
        FOR UPDATE
    ) locked;

    v_locked_count := v_locked_orders.total_count;

    -- c. Validate all orders exist
    IF v_locked_count != v_expected_count THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- Validate all orders belong to the caller's outlet
    IF NOT v_locked_orders.all_match_outlet THEN
        RAISE EXCEPTION 'OUTLET_MISMATCH';
    END IF;

    -- Validate all orders are in 'active' status
    IF v_locked_orders.active_count != v_expected_count THEN
        RAISE EXCEPTION 'ORDER_NOT_ACTIVE';
    END IF;

    -- Get the target order's table_id for the response
    SELECT table_id INTO v_target_table_id
    FROM orders
    WHERE id = p_target_order_id;

    -- d. Move all order_items from source orders to the target order
    UPDATE order_items
    SET order_id = p_target_order_id
    WHERE order_id = ANY(p_source_order_ids);

    -- e. Cancel source orders: set status to 'cancelled' and ended_at to now()
    UPDATE orders
    SET status = 'cancelled',
        ended_at = now()
    WHERE id = ANY(p_source_order_ids);

    -- f. Collect source table IDs (distinct, since multiple source orders
    --    could potentially be on the same table)
    SELECT array_agg(DISTINCT o.table_id) INTO v_source_table_ids
    FROM orders o
    WHERE o.id = ANY(p_source_order_ids);

    -- g. Reset source tables to 'empty' only if no other active orders
    --    remain on them. This prevents resetting a table that still has
    --    other active orders (e.g., the target order if it shares a table).
    WITH reset_tables AS (
        UPDATE tables t
        SET status = 'empty'
        WHERE t.id = ANY(v_source_table_ids)
        AND NOT EXISTS (
            SELECT 1 FROM orders o2
            WHERE o2.table_id = t.id
              AND o2.status = 'active'
              AND o2.id != ALL(p_source_order_ids)
        )
        RETURNING t.id
    )
    SELECT COALESCE(array_agg(id), '{}') INTO v_tables_reset
    FROM reset_tables;

    -- h. Count total items now on the target order
    SELECT COUNT(*) INTO v_total_items
    FROM order_items
    WHERE order_id = p_target_order_id;

    -- i. Create audit log entry with merge details
    INSERT INTO audit_logs (outlet_id, entity, entity_id, action, user_id, details)
    VALUES (
        p_outlet_id,
        'order',
        p_target_order_id,
        'merge',
        p_user_id,
        jsonb_build_object(
            'target_order_id', p_target_order_id,
            'source_order_ids', to_jsonb(p_source_order_ids),
            'source_orders_cancelled', to_jsonb(p_source_order_ids),
            'tables_reset', to_jsonb(v_tables_reset),
            'total_items', v_total_items
        )
    );

    -- j. Return result with merged order details for the Edge Function response
    RETURN jsonb_build_object(
        'table_id', v_target_table_id,
        'total_items', v_total_items,
        'source_orders_cancelled', to_jsonb(p_source_order_ids),
        'tables_reset', to_jsonb(v_tables_reset)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION merge_orders(UUID, UUID[], UUID, UUID) IS
  'Atomic order merge operation. Locks all involved orders sorted by ID '
  'to prevent deadlocks, validates all are active and belong to the same '
  'outlet, moves order_items from source orders to target, cancels source '
  'orders, resets source tables to empty if no other active orders remain, '
  'and creates audit_log entry with action merge. Called via rpc from the '
  'merge-orders Edge Function. Requirements: 5.2 AC-8.';

COMMIT;
