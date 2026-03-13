-- ============================================================
-- Fix: finalize_bill must reset table to 'empty'
-- ============================================================
-- After bill finalization, the table should be freed for new guests.
-- Previously, finalize_bill only set order.status = 'finalized' but
-- did NOT update the table status, leaving it stuck at 'awaiting_payment'.
--
-- This migration patches finalize_bill to atomically reset the table
-- to 'empty' (only if no other active/completed orders remain on it).
--
-- Dependencies:
--   - 027_enhance_finalize_and_cancel.sql (current finalize_bill)
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS finalize_bill(UUID, payment_method, UUID, DECIMAL);

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
    v_other_active INTEGER;
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

    -- 10. Reset table to 'empty' if no other active/completed orders remain
    SELECT COUNT(*) INTO v_other_active
    FROM orders
    WHERE table_id = v_order.table_id
      AND id != p_order_id
      AND status IN ('active', 'completed');

    IF v_other_active = 0 THEN
        UPDATE tables
        SET status = 'empty'
        WHERE id = v_order.table_id;
    END IF;

    -- 11. Insert audit log with items_snapshot and full context
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

    -- 12. Return the created bill summary
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
    'Atomic bill finalization: locks order, calculates total with discount, '
    'creates bill, finalizes order, resets table to empty (if no other active '
    'orders remain). Requirements: 4.1, 3.10.';

COMMIT;
