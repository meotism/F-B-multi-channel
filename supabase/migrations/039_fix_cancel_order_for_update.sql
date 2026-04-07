-- ============================================================
-- Fix: cancel_order() — FOR UPDATE not allowed with GROUP BY
-- ============================================================
-- PostgreSQL does not allow FOR UPDATE with GROUP BY in the same query.
-- The original cancel_order (027) used FOR UPDATE OF inv inside a
-- GROUP BY query for inventory restoration, causing:
--   "FOR UPDATE is not allowed with GROUP BY clause"
--
-- Fix: Lock inventory rows first (separate query), then aggregate
-- and restore in the main loop.
--
-- Dependencies:
--   - 027_enhance_finalize_and_cancel.sql (current cancel_order)
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS cancel_order(UUID, UUID, UUID, TEXT);

CREATE OR REPLACE FUNCTION cancel_order(
    p_order_id UUID,
    p_user_id UUID,
    p_outlet_id UUID,
    p_reason TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_user_role TEXT;
    v_table_id UUID;
    v_table_reset BOOLEAN := FALSE;
    v_other_active_count INTEGER;
    v_row RECORD;
    v_restorations JSONB := '[]'::JSONB;
    v_new_qty DECIMAL(12,3);
    v_item_count INTEGER;
BEGIN
    -- 1. Lock the order row
    SELECT * INTO v_order
    FROM orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF v_order IS NULL OR v_order.outlet_id != p_outlet_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status NOT IN ('active', 'completed') THEN
        RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE';
    END IF;

    -- 2. Get the user's role for permission check
    SELECT role::TEXT INTO v_user_role
    FROM public.users
    WHERE id = p_user_id;

    -- 3. Enforce manager/owner approval for completed (served) orders
    IF v_order.status = 'completed' AND v_user_role NOT IN ('owner', 'manager') THEN
        RAISE EXCEPTION 'MANAGER_APPROVAL_REQUIRED: Only manager or owner can cancel served orders';
    END IF;

    -- 4. Require cancellation reason for completed orders
    IF v_order.status = 'completed' AND (p_reason IS NULL OR TRIM(p_reason) = '') THEN
        RAISE EXCEPTION 'CANCELLATION_REASON_REQUIRED: A reason must be provided when cancelling served orders';
    END IF;

    v_table_id := v_order.table_id;

    SELECT COUNT(*) INTO v_item_count
    FROM order_items
    WHERE order_id = p_order_id;

    -- 5. Cancel the order and store reason
    UPDATE orders
    SET status = 'cancelled',
        ended_at = now(),
        cancellation_reason = p_reason
    WHERE id = p_order_id;

    -- 6. Reset table if no other active orders
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

    -- 7. Lock inventory rows first (separate from GROUP BY)
    PERFORM inv.id
    FROM order_items oi
    JOIN recipes r ON r.menu_item_id = oi.menu_item_id
    JOIN inventory inv ON inv.ingredient_id = r.ingredient_id
                      AND inv.outlet_id = p_outlet_id
    WHERE oi.order_id = p_order_id
    ORDER BY inv.id
    FOR UPDATE OF inv;

    -- 8. Restore inventory (now safe to GROUP BY without FOR UPDATE)
    FOR v_row IN
        SELECT
            r.ingredient_id,
            i.name AS ingredient_name,
            inv.id AS inventory_id,
            inv.qty_on_hand,
            SUM(r.qty * oi.qty) AS total_restore
        FROM order_items oi
        JOIN recipes r ON r.menu_item_id = oi.menu_item_id
        JOIN ingredients i ON i.id = r.ingredient_id
        JOIN inventory inv ON inv.ingredient_id = r.ingredient_id
                          AND inv.outlet_id = p_outlet_id
        WHERE oi.order_id = p_order_id
        GROUP BY r.ingredient_id, i.name, inv.id, inv.qty_on_hand
    LOOP
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

    -- 9. Audit log
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
            'cancelled_by_role', v_user_role,
            'order_was_served', v_order.status = 'completed',
            'item_count', v_item_count,
            'table_id', v_table_id,
            'table_reset', v_table_reset,
            'restorations', v_restorations
        )
    );

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
    'Fixes FOR UPDATE + GROUP BY conflict from migration 027. '
    'Locks inventory rows first, then aggregates and restores. '
    'Requirements: 4.2.';

COMMIT;
