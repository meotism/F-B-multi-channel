-- ============================================================
-- Add frozen_at parameter to finalize_bill()
-- ============================================================
-- Allows the client to pass a timestamp captured when the user
-- clicks "Xuat hoa don" so that the hourly charge calculation
-- uses that moment instead of NOW(). This prevents the charge
-- from incrementing during modal interaction and network delay.
--
-- Dependencies:
--   - 030_add_hourly_rate_billing.sql (current finalize_bill)
-- ============================================================

BEGIN;

-- Drop existing function signature (all overloads)
DROP FUNCTION IF EXISTS finalize_bill(UUID, payment_method, UUID, DECIMAL);

CREATE OR REPLACE FUNCTION finalize_bill(
    p_order_id UUID,
    p_payment_method payment_method,
    p_user_id UUID,
    p_discount_amount DECIMAL DEFAULT 0,
    p_frozen_at TIMESTAMPTZ DEFAULT NULL
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
    v_hourly_charge DECIMAL(12,0) := 0;
    v_duration_seconds INTEGER;
    v_charge_time TIMESTAMPTZ;
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

    -- 6. Get table info for audit log context and hourly rate
    SELECT * INTO v_table_record
    FROM tables
    WHERE id = v_order.table_id;

    -- 7. Calculate hourly charge if table has hourly_rate > 0
    --    Use frozen_at timestamp if provided (user clicked "Xuat hoa don"),
    --    otherwise use NOW() for backward compatibility.
    v_charge_time := COALESCE(p_frozen_at, NOW());
    v_duration_seconds := EXTRACT(EPOCH FROM (v_charge_time - v_order.started_at))::INTEGER;
    IF v_table_record.hourly_rate > 0 THEN
        v_hourly_charge := ROUND((v_duration_seconds / 3600.0) * v_table_record.hourly_rate);
    END IF;

    -- 8. Calculate final total (items - discount + hourly + tax)
    v_final_total := v_calculated_total - p_discount_amount + v_hourly_charge + v_tax;

    -- 9. Insert bill record with discount and hourly charge
    INSERT INTO bills (order_id, outlet_id, total, tax, discount_amount, hourly_charge, duration_seconds, payment_method, status, finalized_at)
    VALUES (p_order_id, v_order.outlet_id, v_final_total, v_tax, p_discount_amount, v_hourly_charge, v_duration_seconds, p_payment_method, 'finalized', NOW())
    RETURNING id INTO v_bill_id;

    -- 10. Update order status to 'finalized' and set ended_at
    UPDATE orders
    SET status = 'finalized', ended_at = NOW(), updated_at = NOW()
    WHERE id = p_order_id;

    -- 11. Reset table to 'empty' if no other active/completed orders remain
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

    -- 12. Insert audit log with items_snapshot and full context
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
            'hourly_charge', v_hourly_charge,
            'hourly_rate', v_table_record.hourly_rate,
            'duration_seconds', v_duration_seconds,
            'frozen_at', p_frozen_at,
            'total', v_final_total,
            'tax', v_tax,
            'payment_method', p_payment_method,
            'item_count', v_item_count,
            'items_snapshot', v_items_snapshot
        )
    );

    -- 13. Return the created bill summary
    RETURN jsonb_build_object(
        'id', v_bill_id,
        'order_id', p_order_id,
        'outlet_id', v_order.outlet_id,
        'subtotal', v_calculated_total,
        'discount_amount', p_discount_amount,
        'hourly_charge', v_hourly_charge,
        'duration_seconds', v_duration_seconds,
        'total', v_final_total,
        'tax', v_tax,
        'payment_method', p_payment_method,
        'status', 'finalized',
        'finalized_at', NOW()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION finalize_bill(UUID, payment_method, UUID, DECIMAL, TIMESTAMPTZ) IS
    'Atomic bill finalization with hourly rate billing support. '
    'Locks order, calculates item total + discount + hourly charge '
    '(from table.hourly_rate * duration), creates bill, finalizes order, '
    'resets table. Accepts optional frozen_at to freeze hourly charge at '
    'the moment user clicks export. Requirements: 4.1, 3.10, billiard billing.';

COMMIT;
