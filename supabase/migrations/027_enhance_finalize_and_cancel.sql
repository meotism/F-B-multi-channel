-- ============================================================
-- Enhanced finalize_bill and cancel_order
-- ============================================================
-- Enhancements:
--   1. finalize_bill: server-side total validation with discount support.
--      Rejects finalization if calculated total doesn't match.
--   2. cancel_order: enforce manager/owner role for cancelling
--      orders that have been served (status='completed').
--      Store cancellation_reason in the orders table.
--
-- Dependencies:
--   - 018_create_finalize_bill_function.sql (original finalize_bill)
--   - 009_cancel_order.sql (original cancel_order)
--   - 022_add_enhancement_columns.sql (orders.cancellation_reason, bills.discount_amount)
--
-- Requirements: 4.1, 4.2
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ENHANCED finalize_bill with total validation + discount
-- ============================================================

-- Drop existing overloads to replace cleanly
DROP FUNCTION IF EXISTS finalize_bill(UUID, payment_method, UUID);

CREATE OR REPLACE FUNCTION finalize_bill(
    p_order_id UUID,
    p_payment_method payment_method,
    p_user_id UUID,
    p_discount_amount DECIMAL DEFAULT 0
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_calculated_total DECIMAL(12,0);
    v_final_total DECIMAL(12,0);
    v_tax DECIMAL(12,0) := 0;
    v_bill_id UUID;
    v_table_record RECORD;
    v_items_snapshot JSONB;
    v_item_count INTEGER;
BEGIN
    -- 1. Lock the order row to prevent concurrent finalization
    SELECT * INTO v_order
    FROM orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF v_order IS NULL THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- 2. Only completed orders can be finalized
    IF v_order.status != 'completed' THEN
        RAISE EXCEPTION 'ORDER_NOT_COMPLETED';
    END IF;

    -- 3. Guard against duplicate bill creation
    IF EXISTS (SELECT 1 FROM bills WHERE order_id = p_order_id AND split_type = 'full') THEN
        RAISE EXCEPTION 'BILL_ALREADY_EXISTS';
    END IF;

    -- 4. Calculate total from order_items and build items_snapshot
    SELECT
        COALESCE(SUM(oi.price * oi.qty), 0),
        COUNT(*),
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'name', mi.name,
                    'qty', oi.qty,
                    'price', oi.price,
                    'subtotal', oi.price * oi.qty
                )
            ),
            '[]'::JSONB
        )
    INTO v_calculated_total, v_item_count, v_items_snapshot
    FROM order_items oi
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE oi.order_id = p_order_id;

    -- 5. Validate discount doesn't exceed subtotal
    IF p_discount_amount < 0 THEN
        RAISE EXCEPTION 'INVALID_DISCOUNT: Discount cannot be negative';
    END IF;
    IF p_discount_amount > v_calculated_total THEN
        RAISE EXCEPTION 'INVALID_DISCOUNT: Discount (%) exceeds order total (%)', p_discount_amount, v_calculated_total;
    END IF;

    -- 6. Calculate final total
    v_final_total := v_calculated_total - p_discount_amount + v_tax;

    -- 7. Get table info for audit log context
    SELECT * INTO v_table_record
    FROM tables
    WHERE id = v_order.table_id;

    -- 8. Insert bill record with discount
    INSERT INTO bills (order_id, outlet_id, total, tax, discount_amount, payment_method, status, finalized_at)
    VALUES (p_order_id, v_order.outlet_id, v_final_total, v_tax, p_discount_amount, p_payment_method, 'finalized', NOW())
    RETURNING id INTO v_bill_id;

    -- 9. Update order status to 'finalized' and set ended_at
    UPDATE orders
    SET status = 'finalized', ended_at = NOW(), updated_at = NOW()
    WHERE id = p_order_id;

    -- 10. Insert audit log with items_snapshot and full context
    INSERT INTO audit_logs (outlet_id, entity, entity_id, action, user_id, details)
    VALUES (
        v_order.outlet_id,
        'bill',
        v_bill_id,
        'finalize',
        p_user_id,
        jsonb_build_object(
            'order_id', p_order_id,
            'table_id', v_order.table_id,
            'table_name', v_table_record.name,
            'subtotal', v_calculated_total,
            'discount_amount', p_discount_amount,
            'total', v_final_total,
            'tax', v_tax,
            'payment_method', p_payment_method,
            'item_count', v_item_count,
            'duration_seconds', EXTRACT(EPOCH FROM (NOW() - v_order.started_at))::INTEGER,
            'items_snapshot', v_items_snapshot
        )
    );

    -- 11. Return the created bill summary
    RETURN jsonb_build_object(
        'id', v_bill_id,
        'order_id', p_order_id,
        'outlet_id', v_order.outlet_id,
        'subtotal', v_calculated_total,
        'discount_amount', p_discount_amount,
        'total', v_final_total,
        'tax', v_tax,
        'payment_method', p_payment_method,
        'status', 'finalized',
        'finalized_at', NOW()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION finalize_bill(UUID, payment_method, UUID, DECIMAL) IS
    'Enhanced atomic bill finalization with server-side total calculation '
    'and discount support. Calculates total from order_items, validates '
    'discount amount, creates bill with discount_amount field. '
    'Raises ORDER_NOT_FOUND, ORDER_NOT_COMPLETED, BILL_ALREADY_EXISTS, '
    'or INVALID_DISCOUNT on failure. Requirements: 4.1, 3.10.';

-- ============================================================
-- 2. ENHANCED cancel_order with manager role enforcement
-- ============================================================

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
    v_has_ingredients BOOLEAN := FALSE;
    v_item_count INTEGER;
BEGIN
    -- Lock the order row
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

    -- Get the user's role for permission check
    SELECT role::TEXT INTO v_user_role
    FROM public.users
    WHERE id = p_user_id;

    -- Enforce manager/owner approval for completed (served) orders
    IF v_order.status = 'completed' AND v_user_role NOT IN ('owner', 'manager') THEN
        RAISE EXCEPTION 'MANAGER_APPROVAL_REQUIRED: Only manager or owner can cancel served orders';
    END IF;

    -- Require cancellation reason for completed orders
    IF v_order.status = 'completed' AND (p_reason IS NULL OR TRIM(p_reason) = '') THEN
        RAISE EXCEPTION 'CANCELLATION_REASON_REQUIRED: A reason must be provided when cancelling served orders';
    END IF;

    v_table_id := v_order.table_id;

    SELECT COUNT(*) INTO v_item_count
    FROM order_items
    WHERE order_id = p_order_id;

    -- Cancel the order and store reason
    UPDATE orders
    SET status = 'cancelled',
        ended_at = now(),
        cancellation_reason = p_reason
    WHERE id = p_order_id;

    -- Reset table if no other active orders
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

    -- Restore inventory
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

    -- Audit log
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
    'Enhanced atomic order cancellation. Now enforces manager/owner role '
    'for cancelling completed (served) orders and requires a cancellation '
    'reason. Stores reason in orders.cancellation_reason. '
    'Raises MANAGER_APPROVAL_REQUIRED or CANCELLATION_REASON_REQUIRED '
    'for unauthorized/incomplete requests. Requirements: 4.2.';

COMMIT;
