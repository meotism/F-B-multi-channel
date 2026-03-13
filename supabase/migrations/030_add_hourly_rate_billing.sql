-- ============================================================
-- Hourly Rate Billing for Billiard/Pool Tables
-- ============================================================
-- Adds hourly_rate to tables and hourly_charge/duration_seconds
-- to bills, enabling time-based billing alongside item-based
-- billing. Existing behavior is preserved (hourly_rate defaults
-- to 0 = no hourly billing).
--
-- Changes:
--   1. tables.hourly_rate          — VND per hour (0 = disabled)
--   2. bills.hourly_charge         — computed charge at finalize
--   3. bills.duration_seconds      — playing time snapshot
--   4. protect_finalized_bill()    — guard hourly_charge
--   5. protect_table_layout()      — guard hourly_rate
--   6. table_summary view          — expose hourly_rate
--   7. finalize_bill()             — compute hourly charge
--   8. get_revenue_by_source()     — report function
--
-- Dependencies:
--   - 028_finalize_bill_reset_table.sql (current finalize_bill)
--   - 024_create_table_summary_view.sql (table_summary view)
--   - 001_initial_schema.sql (protect triggers)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Add hourly_rate to tables
-- ============================================================

ALTER TABLE tables
    ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(12,0) NOT NULL DEFAULT 0;

ALTER TABLE tables
    DROP CONSTRAINT IF EXISTS chk_tables_hourly_rate;
ALTER TABLE tables
    ADD CONSTRAINT chk_tables_hourly_rate CHECK (hourly_rate >= 0);

COMMENT ON COLUMN tables.hourly_rate IS
    'Hourly rate in VND for time-based billing (billiard/pool tables). '
    '0 = no hourly billing (standard F&B table).';

-- ============================================================
-- 2. Add hourly_charge and duration_seconds to bills
-- ============================================================

ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS hourly_charge DECIMAL(12,0) NOT NULL DEFAULT 0;

ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS duration_seconds INTEGER DEFAULT NULL;

ALTER TABLE bills
    DROP CONSTRAINT IF EXISTS chk_bills_hourly_charge;
ALTER TABLE bills
    ADD CONSTRAINT chk_bills_hourly_charge CHECK (hourly_charge >= 0);

COMMENT ON COLUMN bills.hourly_charge IS
    'Time-based charge computed at finalization: (duration / 3600) * table.hourly_rate. '
    '0 for standard F&B bills.';

COMMENT ON COLUMN bills.duration_seconds IS
    'Playing time in seconds at finalization (NOW() - order.started_at). '
    'NULL for non-hourly-rate bills.';

-- ============================================================
-- 3. Update protect_finalized_bill() — guard hourly_charge
-- ============================================================

CREATE OR REPLACE FUNCTION protect_finalized_bill()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('finalized', 'printed', 'pending_print') THEN
        IF NEW.total IS DISTINCT FROM OLD.total THEN
            RAISE EXCEPTION 'Cannot modify total on a finalized bill (status: %)', OLD.status;
        END IF;
        IF NEW.tax IS DISTINCT FROM OLD.tax THEN
            RAISE EXCEPTION 'Cannot modify tax on a finalized bill (status: %)', OLD.status;
        END IF;
        IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
            RAISE EXCEPTION 'Cannot modify order_id on a finalized bill (status: %)', OLD.status;
        END IF;
        IF NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
            RAISE EXCEPTION 'Cannot modify finalized_at on a finalized bill (status: %)', OLD.status;
        END IF;
        IF NEW.hourly_charge IS DISTINCT FROM OLD.hourly_charge THEN
            RAISE EXCEPTION 'Cannot modify hourly_charge on a finalized bill (status: %)', OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 4. Update protect_table_layout() — guard hourly_rate
-- ============================================================

CREATE OR REPLACE FUNCTION protect_table_layout()
RETURNS TRIGGER AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role::text INTO v_role FROM public.users WHERE id = auth.uid();

    IF v_role IN ('staff', 'cashier') THEN
        IF NEW.name IS DISTINCT FROM OLD.name THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table name';
        END IF;
        IF NEW.capacity IS DISTINCT FROM OLD.capacity THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table capacity';
        END IF;
        IF NEW.shape IS DISTINCT FROM OLD.shape THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table shape';
        END IF;
        IF NEW.x IS DISTINCT FROM OLD.x THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table position';
        END IF;
        IF NEW.y IS DISTINCT FROM OLD.y THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table position';
        END IF;
        IF NEW.rotation IS DISTINCT FROM OLD.rotation THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table rotation';
        END IF;
        IF NEW.table_code IS DISTINCT FROM OLD.table_code THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table code';
        END IF;
        IF NEW.hourly_rate IS DISTINCT FROM OLD.hourly_rate THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table hourly rate';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 5. Update table_summary view — expose hourly_rate
-- ============================================================
-- DROP and recreate because CREATE OR REPLACE VIEW cannot add
-- columns in the middle of an existing view's column list.

DROP VIEW IF EXISTS table_summary;

CREATE VIEW table_summary AS
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
    t.hourly_rate,
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
    'Joins tables with active/completed order data (guest count, order total, hourly_rate). '
    'Used by table map to display inline info on table cards.';

-- ============================================================
-- 6. Update finalize_bill() — compute hourly charge
-- ============================================================

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
    v_hourly_charge DECIMAL(12,0) := 0;
    v_duration_seconds INTEGER;
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
    v_duration_seconds := EXTRACT(EPOCH FROM (NOW() - v_order.started_at))::INTEGER;
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

COMMENT ON FUNCTION finalize_bill(UUID, payment_method, UUID, DECIMAL) IS
    'Atomic bill finalization with hourly rate billing support. '
    'Locks order, calculates item total + discount + hourly charge '
    '(from table.hourly_rate * duration), creates bill, finalizes order, '
    'resets table. Requirements: 4.1, 3.10, billiard billing.';

-- ============================================================
-- 7. New report function: get_revenue_by_source
-- ============================================================

CREATE OR REPLACE FUNCTION get_revenue_by_source(
    p_outlet_id UUID,
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ
) RETURNS TABLE (
    items_revenue DECIMAL,
    hourly_revenue DECIMAL,
    total_revenue DECIMAL,
    hourly_bill_count BIGINT,
    total_bill_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(b.total - b.hourly_charge), 0) AS items_revenue,
        COALESCE(SUM(b.hourly_charge), 0) AS hourly_revenue,
        COALESCE(SUM(b.total), 0) AS total_revenue,
        COUNT(*) FILTER (WHERE b.hourly_charge > 0)::BIGINT AS hourly_bill_count,
        COUNT(*)::BIGINT AS total_bill_count
    FROM bills b
    WHERE b.outlet_id = p_outlet_id
      AND b.finalized_at >= p_from
      AND b.finalized_at < p_to
      AND b.status IN ('finalized', 'printed', 'pending_print');
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_revenue_by_source(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
    'Revenue split by source: items (food/drinks) vs hourly (billiard/pool). '
    'items_revenue = total - hourly_charge. Only includes finalized/printed/pending_print bills.';

COMMIT;
