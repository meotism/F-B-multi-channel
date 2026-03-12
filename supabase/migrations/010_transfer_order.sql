-- ============================================================
-- Transfer Order Stored Procedure
-- ============================================================
-- This migration creates:
--   1. transfer_order()  - Stored procedure for atomically
--      transferring an order from one table to another.
--      Called via supabase.rpc('transfer_order', ...) from the
--      transfer-order Edge Function.
--
-- The procedure performs ALL operations in a single transaction:
--   a. Locks the order row FOR UPDATE, validates it exists,
--      belongs to the outlet, and is in 'active' status.
--   b. Locks both source and target table rows FOR UPDATE,
--      ordered by ID to prevent deadlocks in concurrent transfers.
--   c. Validates the target table belongs to the same outlet
--      and has status 'empty'.
--   d. Moves the order to the target table (UPDATE orders.table_id).
--   e. Resets the source table to 'empty' if no other active orders
--      remain on it.
--   f. Sets the target table status to 'serving'.
--   g. Creates an audit_log entry with action 'transfer' and
--      from_table_id/to_table_id details.
--
-- Dependencies: 001_initial_schema.sql (tables, enums, triggers)
-- Requirements: 5.2 AC-7 (transfer order between tables)
-- ============================================================

BEGIN;

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
BEGIN
    -- a. Lock the order row FOR UPDATE to prevent concurrent modification.
    --    Validate order exists, belongs to the specified outlet, and is active.
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

    -- Store the source table ID from the order
    v_source_table_id := v_order.table_id;

    -- b. Lock both source and target tables FOR UPDATE, ordered by ID
    --    to prevent deadlocks when concurrent transfers involve the same
    --    tables in different order. We select them individually after
    --    locking in sorted order.
    PERFORM id FROM tables
    WHERE id IN (v_source_table_id, p_target_table_id)
    ORDER BY id
    FOR UPDATE;

    -- Fetch source table details (already locked above)
    SELECT * INTO v_source_table
    FROM tables
    WHERE id = v_source_table_id;

    -- Fetch target table details (already locked above)
    SELECT * INTO v_target_table
    FROM tables
    WHERE id = p_target_table_id;

    -- c. Validate target table exists and belongs to the same outlet
    IF v_target_table IS NULL OR v_target_table.outlet_id != p_outlet_id THEN
        RAISE EXCEPTION 'TABLE_NOT_FOUND';
    END IF;

    -- Validate target table is empty (available for transfer)
    IF v_target_table.status != 'empty' THEN
        RAISE EXCEPTION 'TABLE_NOT_EMPTY';
    END IF;

    -- d. Move the order to the target table
    UPDATE orders
    SET table_id = p_target_table_id
    WHERE id = p_order_id;

    -- e. Reset source table to 'empty' if no other active orders remain.
    --    This prevents resetting a table that still has other active orders
    --    (e.g., if multiple orders were on the same table via merge).
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

    -- f. Set target table status to 'serving'
    UPDATE tables
    SET status = 'serving'
    WHERE id = p_target_table_id;

    -- g. Create audit log entry with transfer details
    INSERT INTO audit_logs (outlet_id, entity, entity_id, action, user_id, details)
    VALUES (
        p_outlet_id,
        'order',
        p_order_id,
        'transfer',
        p_user_id,
        jsonb_build_object(
            'from_table_id', v_source_table_id,
            'to_table_id', p_target_table_id
        )
    );

    -- h. Return transfer result with details for the Edge Function response
    RETURN jsonb_build_object(
        'order_id', p_order_id,
        'from_table_id', v_source_table_id,
        'to_table_id', p_target_table_id,
        'from_table_status', CASE WHEN v_source_table_reset THEN 'empty' ELSE 'serving' END,
        'to_table_status', 'serving'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION transfer_order(UUID, UUID, UUID, UUID) IS
  'Atomic order transfer between tables. Locks order and both tables '
  '(sorted by ID to prevent deadlocks), validates order is active and '
  'target table is empty, moves order to target table, resets source '
  'table if no other active orders, sets target to serving, and creates '
  'audit_log entry with action transfer. Called via rpc from the '
  'transfer-order Edge Function. Requirements: 5.2 AC-7.';

COMMIT;
