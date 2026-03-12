-- ============================================================
-- Cancel Order Stored Procedure
-- ============================================================
-- This migration creates:
--   1. cancel_order()  - Dedicated stored procedure for atomically
--      cancelling an order. Called via supabase.rpc('cancel_order', ...)
--      from the cancel-order Edge Function.
--
-- The procedure performs ALL operations in a single transaction:
--   a. Locks the order row FOR UPDATE to prevent concurrent modification.
--   b. Validates order status is cancellable ('active' or 'completed',
--      NOT 'finalized' or 'cancelled').
--   c. Updates order: status = 'cancelled', ended_at = now().
--   d. Resets the source table to 'empty' if no other active/completed
--      orders exist on that table.
--   e. Restores inventory by fetching order_items + recipes, aggregating
--      ingredient quantities, locking inventory rows FOR UPDATE, and
--      incrementing qty_on_hand.
--   f. Creates a single audit_log entry with action 'cancel_order'.
--
-- This is intentionally separate from restore_inventory() because:
--   - cancel_order combines order status change + table reset + inventory
--     restoration in one atomic transaction
--   - Uses a single audit_log entry with action 'cancel_order' (not
--     'restore_cancelled_order')
--   - Includes order status validation and table reset logic
--
-- Dependencies: 001_initial_schema.sql (tables, enums, triggers)
--               007_inventory_deduction.sql (pattern reference)
--               008_restore_inventory.sql (pattern reference)
-- Requirements: 5.2 AC-10 (cancel order with inventory restoration)
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION cancel_order(
    p_order_id UUID,
    p_user_id UUID,
    p_outlet_id UUID,
    p_reason TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_table_id UUID;
    v_table_reset BOOLEAN := FALSE;
    v_other_active_count INTEGER;
    v_row RECORD;
    v_restorations JSONB := '[]'::JSONB;
    v_new_qty DECIMAL(12,3);
    v_has_ingredients BOOLEAN := FALSE;
    v_item_count INTEGER;
BEGIN
    -- a. Lock the order row FOR UPDATE to prevent concurrent cancellation
    --    or status changes while we process.
    SELECT * INTO v_order
    FROM orders
    WHERE id = p_order_id
    FOR UPDATE;

    -- Validate order exists and belongs to the specified outlet
    IF v_order IS NULL OR v_order.outlet_id != p_outlet_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- b. Validate order status is cancellable.
    --    Only 'active' and 'completed' orders can be cancelled.
    --    'finalized' and 'cancelled' orders cannot be cancelled.
    IF v_order.status NOT IN ('active', 'completed') THEN
        RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE';
    END IF;

    -- Store the table_id for later table reset logic
    v_table_id := v_order.table_id;

    -- Get the total number of order items for the audit log
    SELECT COUNT(*) INTO v_item_count
    FROM order_items
    WHERE order_id = p_order_id;

    -- c. Cancel the order: set status to 'cancelled' and ended_at to now().
    --    The trg_orders_updated_at trigger will auto-set updated_at.
    UPDATE orders
    SET status = 'cancelled',
        ended_at = now()
    WHERE id = p_order_id;

    -- d. Reset table to 'empty' only if no other active or completed orders
    --    exist on this table. This prevents resetting a table that is still
    --    in use by another order (e.g., after a table merge/transfer).
    SELECT COUNT(*) INTO v_other_active_count
    FROM orders
    WHERE table_id = v_table_id
      AND id != p_order_id
      AND status IN ('active', 'completed');

    IF v_other_active_count = 0 THEN
        UPDATE tables
        SET status = 'empty'
        WHERE id = v_table_id;

        v_table_reset := TRUE;
    END IF;

    -- e. Restore inventory: fetch order_items + recipes, aggregate ingredient
    --    quantities, lock inventory rows FOR UPDATE, increment qty_on_hand.
    --    This follows the same pattern as restore_inventory() but is inline
    --    to keep everything in one transaction with one audit log entry.
    FOR v_row IN
        SELECT
            r.ingredient_id,
            i.name AS ingredient_name,
            inv.id AS inventory_id,
            inv.qty_on_hand,
            inv.threshold,
            SUM(r.qty * oi.qty) AS total_restore
        FROM order_items oi
        JOIN recipes r ON r.menu_item_id = oi.menu_item_id
        JOIN ingredients i ON i.id = r.ingredient_id
        JOIN inventory inv ON inv.ingredient_id = r.ingredient_id
                          AND inv.outlet_id = p_outlet_id
        WHERE oi.order_id = p_order_id
        GROUP BY r.ingredient_id, i.name, inv.id, inv.qty_on_hand, inv.threshold
        FOR UPDATE OF inv
    LOOP
        v_has_ingredients := TRUE;

        -- Restore: increase qty_on_hand by the amount originally deducted
        v_new_qty := v_row.qty_on_hand + v_row.total_restore;

        UPDATE inventory
        SET qty_on_hand = v_new_qty
        WHERE id = v_row.inventory_id;

        v_restorations := v_restorations || jsonb_build_array(
            jsonb_build_object(
                'ingredient_id', v_row.ingredient_id,
                'ingredient_name', v_row.ingredient_name,
                'restored_qty', v_row.total_restore,
                'new_qty_on_hand', v_new_qty
            )
        );
    END LOOP;

    -- f. Create a single audit_log entry with action 'cancel_order'.
    --    This captures the full context: order_id, reason, item count,
    --    table reset status, and inventory restorations.
    INSERT INTO audit_logs (outlet_id, entity, entity_id, action, user_id, details)
    VALUES (
        p_outlet_id,
        'order',
        p_order_id,
        'cancel_order',
        p_user_id,
        jsonb_build_object(
            'order_id', p_order_id,
            'reason', COALESCE(p_reason, ''),
            'item_count', v_item_count,
            'table_id', v_table_id,
            'table_reset', v_table_reset,
            'restorations', v_restorations
        )
    );

    -- g. Return result with cancellation details
    RETURN jsonb_build_object(
        'order_id', p_order_id,
        'table_id', v_table_id,
        'table_reset', v_table_reset,
        'restorations', v_restorations,
        'item_count', v_item_count
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION cancel_order(UUID, UUID, UUID, TEXT) IS
  'Atomic order cancellation with inventory restoration. '
  'Validates order is cancellable (active/completed), sets status to cancelled, '
  'resets table to empty if no other active orders, restores inventory via '
  'recipe-based calculation with FOR UPDATE locking, and creates a single '
  'audit_log entry with action cancel_order. Called via rpc from the '
  'cancel-order Edge Function. Requirements: 5.2 AC-10.';

COMMIT;
