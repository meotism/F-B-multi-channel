-- ============================================================
-- Enhanced finalize_bill Stored Procedure
-- ============================================================
-- Replaces the original finalize_bill (004_functions.sql) with
-- an enhanced version that includes:
--   - items_snapshot in audit log (array of {name, qty, price, subtotal})
--   - table_id, table_name, duration_seconds in audit log details
--   - item_count in audit log details
--   - Proper error codes: ORDER_NOT_FOUND, ORDER_NOT_COMPLETED,
--     BILL_ALREADY_EXISTS
--
-- This function is called via supabase.rpc('finalize_bill', ...)
-- from the finalize-bill Edge Function.
--
-- Dependencies:
--   - 001_initial_schema.sql (tables, enums, triggers)
--   - 004_functions.sql (original finalize_bill, overloaded here)
--
-- Requirements: 5.4 AC-1 (create bill), AC-2 (lock edits),
--               AC-7 (audit log with items_snapshot)
-- ============================================================

BEGIN;

-- Drop the old 4-parameter overload so there is a single canonical
-- signature going forward.  The new function derives outlet_id from the
-- order row, so the caller no longer needs to supply it.
DROP FUNCTION IF EXISTS finalize_bill(UUID, payment_method, UUID, UUID);

CREATE OR REPLACE FUNCTION finalize_bill(
    p_order_id UUID,
    p_payment_method payment_method,
    p_user_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_total DECIMAL(12,0);
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

    -- Validate order exists
    IF v_order IS NULL THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- 2. Only completed orders can be finalized
    IF v_order.status != 'completed' THEN
        RAISE EXCEPTION 'ORDER_NOT_COMPLETED';
    END IF;

    -- 3. Guard against duplicate bill creation (bills.order_id is UNIQUE,
    --    but an explicit check gives a clearer error message)
    IF EXISTS (SELECT 1 FROM bills WHERE order_id = p_order_id) THEN
        RAISE EXCEPTION 'BILL_ALREADY_EXISTS';
    END IF;

    -- 4. Calculate total from order_items and build items_snapshot.
    --    order_items does not have a name column, so we JOIN menu_items
    --    to capture the item name at finalization time.
    --    The order_items column is "qty" (INTEGER), not "quantity".
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
    INTO v_total, v_item_count, v_items_snapshot
    FROM order_items oi
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE oi.order_id = p_order_id;

    -- 5. Get table info for audit log context
    SELECT * INTO v_table_record
    FROM tables
    WHERE id = v_order.table_id;

    -- 6. Insert bill record
    INSERT INTO bills (order_id, outlet_id, total, tax, payment_method, status, finalized_at)
    VALUES (p_order_id, v_order.outlet_id, v_total, v_tax, p_payment_method, 'finalized', NOW())
    RETURNING id INTO v_bill_id;

    -- 7. Update order status to 'finalized' and set ended_at
    UPDATE orders
    SET status = 'finalized', ended_at = NOW(), updated_at = NOW()
    WHERE id = p_order_id;

    -- 8. Insert audit log with items_snapshot and full context.
    --    duration_seconds is computed from the order's started_at to NOW().
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
            'total', v_total,
            'tax', v_tax,
            'payment_method', p_payment_method,
            'item_count', v_item_count,
            'duration_seconds', EXTRACT(EPOCH FROM (NOW() - v_order.started_at))::INTEGER,
            'items_snapshot', v_items_snapshot
        )
    );

    -- 9. Return the created bill summary
    RETURN jsonb_build_object(
        'id', v_bill_id,
        'order_id', p_order_id,
        'outlet_id', v_order.outlet_id,
        'total', v_total,
        'tax', v_tax,
        'payment_method', p_payment_method,
        'status', 'finalized',
        'finalized_at', NOW()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION finalize_bill(UUID, payment_method, UUID) IS
  'Enhanced atomic bill finalization: locks order FOR UPDATE, validates status, '
  'calculates total from order_items, builds items_snapshot with item names '
  '(via menu_items JOIN), creates bill, updates order status to finalized, '
  'and logs to audit_logs with full context (table info, duration, items_snapshot). '
  'Raises ORDER_NOT_FOUND, ORDER_NOT_COMPLETED, or BILL_ALREADY_EXISTS on failure. '
  'Called via rpc from the finalize-bill Edge Function. '
  'Requirements: 5.4 AC-1/2/7.';

COMMIT;
