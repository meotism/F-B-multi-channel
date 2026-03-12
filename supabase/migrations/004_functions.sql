-- ============================================================
-- Role Sync Trigger and Stored Procedures
-- ============================================================
-- This migration creates:
--   1. sync_role_to_auth_metadata()  - Trigger function to mirror
--      users.role into auth.users.raw_app_meta_data for JWT claims.
--   2. finalize_bill()               - Stored procedure for atomic
--      bill finalization (called via rpc from finalize-bill Edge Function).
--   3. batch_update_table_positions() - Stored procedure for saving
--      multiple table positions atomically (called via rpc from table map).
--
-- Dependencies: 001_initial_schema.sql (tables, enums, triggers)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ROLE SYNC TRIGGER
-- ============================================================
-- Mirrors role changes from public.users to auth.users.raw_app_meta_data
-- so that JWT claims reflect the current role without requiring a
-- manual token refresh. The primary source of truth remains the
-- public.users.role column, queried by auth.user_role().
--
-- SECURITY DEFINER: required to write to the auth.users table.

CREATE OR REPLACE FUNCTION sync_role_to_auth_metadata()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE auth.users
    SET raw_app_meta_data = raw_app_meta_data || jsonb_build_object('role', NEW.role::text)
    WHERE id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION sync_role_to_auth_metadata() IS
  'Trigger function: syncs users.role to auth.users.raw_app_meta_data for JWT claim mirroring. '
  'SECURITY DEFINER to access auth.users.';

CREATE TRIGGER trg_sync_user_role
    AFTER INSERT OR UPDATE OF role ON users
    FOR EACH ROW
    EXECUTE FUNCTION sync_role_to_auth_metadata();

-- ============================================================
-- 2. FINALIZE BILL STORED PROCEDURE
-- ============================================================
-- Atomic bill finalization called via supabase.rpc('finalize_bill', ...).
-- Performs all steps within a single transaction:
--   a. Lock and validate the order (FOR UPDATE).
--   b. Check order status is 'completed' (ready for billing).
--   c. Guard against duplicate bills.
--   d. Calculate total from order_items.
--   e. Create the bill record.
--   f. Transition order status to 'finalized'.
--   g. Update the associated table status to 'paid' then 'empty'.
--   h. Create an audit log entry for the finalization.
--
-- Requirements: 5.4 AC-1 (create bill), AC-2 (lock edits), AC-7 (audit log).

CREATE OR REPLACE FUNCTION finalize_bill(
    p_order_id UUID,
    p_payment_method payment_method,
    p_user_id UUID,
    p_outlet_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_total DECIMAL(12,0);
    v_bill RECORD;
BEGIN
    -- a. Lock the order row to prevent concurrent finalization
    SELECT * INTO v_order
    FROM orders
    WHERE id = p_order_id
    FOR UPDATE;

    -- Validate order exists and belongs to the correct outlet
    IF v_order IS NULL OR v_order.outlet_id != p_outlet_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- b. Only completed orders can be finalized
    IF v_order.status != 'completed' THEN
        RAISE EXCEPTION 'ORDER_NOT_COMPLETED: %', v_order.status;
    END IF;

    -- c. Guard against duplicate bill creation (bills.order_id is UNIQUE,
    --    but an explicit check gives a clearer error message)
    IF EXISTS (SELECT 1 FROM bills WHERE order_id = p_order_id) THEN
        RAISE EXCEPTION 'BILL_ALREADY_EXISTS';
    END IF;

    -- d. Calculate total from order_items (qty * price snapshot)
    SELECT COALESCE(SUM(qty * price), 0) INTO v_total
    FROM order_items
    WHERE order_id = p_order_id;

    -- e. Create the bill record
    INSERT INTO bills (order_id, outlet_id, total, tax, payment_method, status, finalized_at)
    VALUES (p_order_id, p_outlet_id, v_total, 0, p_payment_method, 'finalized', now())
    RETURNING * INTO v_bill;

    -- f. Transition order status to 'finalized'
    UPDATE orders
    SET status = 'finalized', ended_at = now()
    WHERE id = p_order_id;

    -- g. Update table status: mark as 'paid' then 'empty'
    --    The table transitions through 'paid' (for visual feedback via
    --    Realtime) and then immediately to 'empty' (ready for next guest).
    UPDATE tables SET status = 'paid' WHERE id = v_order.table_id;
    UPDATE tables SET status = 'empty' WHERE id = v_order.table_id;

    -- h. Create audit log entry for bill finalization
    INSERT INTO audit_logs (outlet_id, entity, entity_id, action, user_id, details)
    VALUES (
        p_outlet_id,
        'bill',
        v_bill.id,
        'finalize',
        p_user_id,
        jsonb_build_object(
            'order_id', p_order_id,
            'total', v_total,
            'payment_method', p_payment_method
        )
    );

    -- Return the created bill summary
    RETURN jsonb_build_object(
        'bill_id', v_bill.id,
        'total', v_total,
        'status', 'finalized'
    );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION finalize_bill(UUID, payment_method, UUID, UUID) IS
  'Atomic bill finalization: locks order, validates status, calculates total, '
  'creates bill, updates order/table status, and logs to audit_logs. '
  'Called via rpc from the finalize-bill Edge Function.';

-- ============================================================
-- 3. BATCH UPDATE TABLE POSITIONS
-- ============================================================
-- Atomically updates positions (x, y, rotation) for multiple tables.
-- Called via supabase.rpc('batch_update_table_positions', { positions: [...] })
-- from the table map "Save map" action.
--
-- Input: a JSON array of objects, each containing:
--   { "id": "<uuid>", "x": <number>, "y": <number>, "rotation": <number> }
--
-- All updates run within a single transaction so either all positions
-- are saved or none are (atomicity guarantee).
--
-- Requirements: 5.1 AC-4 (persist all table positions on save).

CREATE OR REPLACE FUNCTION batch_update_table_positions(
    positions JSONB
) RETURNS VOID AS $$
DECLARE
    item JSONB;
BEGIN
    FOR item IN SELECT * FROM jsonb_array_elements(positions)
    LOOP
        UPDATE tables
        SET
            x = (item ->> 'x')::DOUBLE PRECISION,
            y = (item ->> 'y')::DOUBLE PRECISION,
            rotation = (item ->> 'rotation')::DOUBLE PRECISION
        WHERE id = (item ->> 'id')::UUID;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION batch_update_table_positions(JSONB) IS
  'Atomically updates x, y, and rotation for multiple tables in a single transaction. '
  'Input: JSONB array of {id, x, y, rotation} objects. '
  'Called via rpc from the table map save action.';

COMMIT;
