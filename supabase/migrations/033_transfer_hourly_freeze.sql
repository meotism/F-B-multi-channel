-- ============================================================
-- Transfer Hourly Freeze: Cut bill at transfer, merge with new table
-- ============================================================
-- When transferring a table:
--   1. Calculate hourly charge from source table at transfer moment
--   2. Accumulate into orders.prior_hourly_charge
--   3. Reset started_at to NOW() so new table starts fresh timer
--   4. finalize_bill includes prior_hourly_charge in total
--
-- Supports multi-transfer: A→B→C accumulates correctly.
--
-- Dependencies:
--   - 010_transfer_order.sql (original transfer_order)
--   - 031_finalize_bill_frozen_at.sql (latest finalize_bill)
--   - 030_add_hourly_rate_billing.sql (hourly_rate on tables)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Add prior_hourly_charge to orders
-- ============================================================

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS prior_hourly_charge DECIMAL(12,0) NOT NULL DEFAULT 0;

COMMENT ON COLUMN orders.prior_hourly_charge IS
    'Accumulated hourly charges from previous tables after transfers. '
    'Each transfer adds the source table charge based on elapsed time and hourly_rate. '
    'Reset to 0 for new orders. Included in bill total at finalization.';

-- ============================================================
-- 2. Update transfer_order() to freeze hourly charge and reset timer
-- ============================================================

DROP FUNCTION IF EXISTS transfer_order(UUID, UUID, UUID, UUID);

CREATE OR REPLACE FUNCTION transfer_order(
    p_order_id UUID,
    p_target_table_id UUID,
    p_user_id UUID,
    p_outlet_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_source_table_id UUID;
    v_source_table RECORD;
    v_target_table RECORD;
    v_source_table_reset BOOLEAN := FALSE;
    v_frozen_charge DECIMAL(12,0) := 0;
    v_elapsed_seconds INTEGER;
BEGIN
    -- a. Lock the order row FOR UPDATE
    SELECT * INTO v_order
    FROM orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF v_order IS NULL OR v_order.outlet_id != p_outlet_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status != 'active' THEN
        RAISE EXCEPTION 'ORDER_NOT_ACTIVE';
    END IF;

    v_source_table_id := v_order.table_id;

    -- b. Lock both tables sorted by ID (deadlock prevention)
    PERFORM id FROM tables
    WHERE id IN (v_source_table_id, p_target_table_id)
    ORDER BY id
    FOR UPDATE;

    SELECT * INTO v_source_table FROM tables WHERE id = v_source_table_id;
    SELECT * INTO v_target_table FROM tables WHERE id = p_target_table_id;

    -- c. Validate target table
    IF v_target_table IS NULL OR v_target_table.outlet_id != p_outlet_id THEN
        RAISE EXCEPTION 'TABLE_NOT_FOUND';
    END IF;

    IF v_target_table.status != 'empty' THEN
        RAISE EXCEPTION 'TABLE_NOT_EMPTY';
    END IF;

    -- d. Calculate and freeze hourly charge from source table
    IF v_source_table.hourly_rate > 0 THEN
        v_elapsed_seconds := EXTRACT(EPOCH FROM (NOW() - v_order.started_at))::INTEGER;
        v_frozen_charge := ROUND((v_elapsed_seconds / 3600.0) * v_source_table.hourly_rate);
    END IF;

    -- e. Move order to target table, accumulate prior charge, reset timer
    UPDATE orders
    SET table_id = p_target_table_id,
        prior_hourly_charge = COALESCE(prior_hourly_charge, 0) + v_frozen_charge,
        started_at = NOW()
    WHERE id = p_order_id;

    -- f. Reset source table if no other active orders remain
    IF NOT EXISTS (
        SELECT 1 FROM orders
        WHERE table_id = v_source_table_id
          AND status = 'active'
          AND id != p_order_id
    ) THEN
        UPDATE tables
        SET status = 'empty'
        WHERE id = v_source_table_id;
        v_source_table_reset := TRUE;
    END IF;

    -- g. Set target table to serving
    UPDATE tables
    SET status = 'serving'
    WHERE id = p_target_table_id;

    -- h. Audit log with frozen charge details
    INSERT INTO audit_logs (outlet_id, entity, entity_id, action, user_id, details)
    VALUES (
        p_outlet_id,
        'order',
        p_order_id,
        'transfer',
        p_user_id,
        jsonb_build_object(
            'from_table_id', v_source_table_id,
            'to_table_id', p_target_table_id,
            'frozen_hourly_charge', v_frozen_charge,
            'elapsed_seconds', COALESCE(v_elapsed_seconds, 0),
            'source_hourly_rate', v_source_table.hourly_rate,
            'total_prior_hourly_charge', COALESCE(v_order.prior_hourly_charge, 0) + v_frozen_charge
        )
    );

    RETURN jsonb_build_object(
        'order_id', p_order_id,
        'from_table_id', v_source_table_id,
        'to_table_id', p_target_table_id,
        'from_table_status', CASE WHEN v_source_table_reset THEN 'empty' ELSE 'serving' END,
        'to_table_status', 'serving',
        'frozen_hourly_charge', v_frozen_charge
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION transfer_order(UUID, UUID, UUID, UUID) IS
    'Atomic order transfer with hourly charge freeze. Calculates and freezes '
    'the source table hourly charge at transfer time, accumulates into '
    'orders.prior_hourly_charge, and resets started_at for fresh timer on '
    'the target table. Supports multi-transfer accumulation (A→B→C).';

-- ============================================================
-- 3. Update finalize_bill() to include prior_hourly_charge
-- ============================================================

-- Drop all existing overloads
DO $$
BEGIN
    DROP FUNCTION IF EXISTS finalize_bill(UUID, payment_method, UUID, DECIMAL);
    DROP FUNCTION IF EXISTS finalize_bill(UUID, payment_method, UUID, DECIMAL, TIMESTAMPTZ);
    DROP FUNCTION IF EXISTS finalize_bill(UUID, payment_method, UUID, DECIMAL, DECIMAL, INTEGER);
EXCEPTION WHEN undefined_object THEN
    NULL;
END $$;

CREATE OR REPLACE FUNCTION finalize_bill(
    p_order_id UUID,
    p_payment_method payment_method,
    p_user_id UUID,
    p_discount_amount DECIMAL DEFAULT 0,
    p_hourly_charge DECIMAL DEFAULT NULL,
    p_duration_seconds INTEGER DEFAULT NULL
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
    v_prior_hourly DECIMAL(12,0) := 0;
BEGIN
    -- 1. Lock the order row
    SELECT * INTO v_order
    FROM orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF v_order IS NULL THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status != 'completed' THEN
        RAISE EXCEPTION 'ORDER_NOT_COMPLETED';
    END IF;

    IF EXISTS (SELECT 1 FROM bills WHERE order_id = p_order_id AND split_type = 'full') THEN
        RAISE EXCEPTION 'BILL_ALREADY_EXISTS';
    END IF;

    -- 2. Calculate total from order_items
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

    -- 3. Validate discount
    IF p_discount_amount < 0 THEN
        RAISE EXCEPTION 'INVALID_DISCOUNT: Discount cannot be negative';
    END IF;
    IF p_discount_amount > v_calculated_total THEN
        RAISE EXCEPTION 'INVALID_DISCOUNT: Discount (%) exceeds order total (%)', p_discount_amount, v_calculated_total;
    END IF;

    -- 4. Get table info
    SELECT * INTO v_table_record
    FROM tables
    WHERE id = v_order.table_id;

    -- 5. Calculate hourly charge (client-provided or server-calculated)
    IF p_hourly_charge IS NOT NULL THEN
        v_hourly_charge := p_hourly_charge;
        v_duration_seconds := COALESCE(p_duration_seconds, 0);
    ELSE
        v_duration_seconds := EXTRACT(EPOCH FROM (NOW() - v_order.started_at))::INTEGER;
        IF v_table_record.hourly_rate > 0 THEN
            v_hourly_charge := ROUND((v_duration_seconds / 3600.0) * v_table_record.hourly_rate);
        END IF;
    END IF;

    -- 6. Get prior hourly charges from table transfers
    v_prior_hourly := COALESCE(v_order.prior_hourly_charge, 0);

    -- 7. Calculate final total = items - discount + current hourly + prior hourly + tax
    v_final_total := v_calculated_total - p_discount_amount + v_hourly_charge + v_prior_hourly + v_tax;

    -- 8. Insert bill (hourly_charge includes prior for combined accounting)
    INSERT INTO bills (order_id, outlet_id, total, tax, discount_amount, hourly_charge, duration_seconds, payment_method, status, finalized_at)
    VALUES (p_order_id, v_order.outlet_id, v_final_total, v_tax, p_discount_amount, v_hourly_charge + v_prior_hourly, v_duration_seconds, p_payment_method, 'finalized', NOW())
    RETURNING id INTO v_bill_id;

    -- 9. Finalize order
    UPDATE orders
    SET status = 'finalized', ended_at = NOW(), updated_at = NOW()
    WHERE id = p_order_id;

    -- 10. Reset table if no other active orders
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

    -- 11. Audit log
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
            'prior_hourly_charge', v_prior_hourly,
            'hourly_rate', v_table_record.hourly_rate,
            'duration_seconds', v_duration_seconds,
            'total', v_final_total,
            'tax', v_tax,
            'payment_method', p_payment_method,
            'item_count', v_item_count,
            'items_snapshot', v_items_snapshot
        )
    );

    -- 12. Return bill summary
    RETURN jsonb_build_object(
        'id', v_bill_id,
        'order_id', p_order_id,
        'outlet_id', v_order.outlet_id,
        'subtotal', v_calculated_total,
        'discount_amount', p_discount_amount,
        'hourly_charge', v_hourly_charge,
        'prior_hourly_charge', v_prior_hourly,
        'duration_seconds', v_duration_seconds,
        'total', v_final_total,
        'tax', v_tax,
        'payment_method', p_payment_method,
        'status', 'finalized',
        'finalized_at', NOW()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION finalize_bill(UUID, payment_method, UUID, DECIMAL, DECIMAL, INTEGER) IS
    'Atomic bill finalization with hourly rate billing and transfer support. '
    'Includes prior_hourly_charge from table transfers in the total. '
    'Locks order, calculates item total + discount + hourly charge + prior hourly, '
    'creates bill, finalizes order, resets table. '
    'Requirements: 4.1, 3.10, billiard billing, transfer billing.';

COMMIT;
