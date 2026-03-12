-- ============================================================
-- Inventory Restoration Stored Procedure
-- ============================================================
-- This migration creates:
--   1. restore_inventory()  - Dedicated stored procedure for atomic
--      inventory restoration when an order is cancelled. Called via
--      supabase.rpc('restore_inventory', ...) from the
--      restore-inventory Edge Function.
--
-- The procedure:
--   a. Validates the order exists and belongs to the given outlet.
--   b. Fetches order_items joined with recipes and inventory,
--      aggregating total ingredient quantities to restore.
--   c. Locks inventory rows with FOR UPDATE to prevent concurrent
--      modification.
--   d. Increments qty_on_hand by the restoration amount for each
--      ingredient (no sufficiency check needed for restoration).
--   e. Creates an audit_log entry with action 'restore_cancelled_order'.
--   f. Returns a JSONB result with restorations[].
--
-- This is intentionally separate from deduct_inventory() because:
--   - The audit action must be 'restore_cancelled_order' (not generic 'restore')
--   - No need for the deduct branch or insufficient-stock checking
--   - Cleaner separation of concerns for the cancel-order flow
--
-- Dependencies: 001_initial_schema.sql (tables, enums, triggers)
--               007_inventory_deduction.sql (pattern reference)
-- Requirements: 5.2 AC-10 (restore inventory on cancel)
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION restore_inventory(
    p_order_id UUID,
    p_user_id UUID,
    p_outlet_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_row RECORD;
    v_restorations JSONB := '[]'::JSONB;
    v_new_qty DECIMAL(12,3);
    v_has_ingredients BOOLEAN := FALSE;
BEGIN
    -- a. Validate order exists and belongs to the outlet.
    --    Lock the order row to prevent concurrent restoration attempts.
    SELECT * INTO v_order
    FROM orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF v_order IS NULL OR v_order.outlet_id != p_outlet_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- b. Fetch aggregated ingredient requirements with inventory locking.
    --    Multiple order_items may reference the same ingredient via different
    --    menu items, so we aggregate with SUM. FOR UPDATE OF inv locks
    --    inventory rows to prevent concurrent modification.
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

        -- c. Restore: increase qty_on_hand
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

    -- d. If no recipe ingredients found, return early with empty array
    IF NOT v_has_ingredients THEN
        RETURN jsonb_build_object('restorations', v_restorations);
    END IF;

    -- e. Create audit log entry with action 'restore_cancelled_order'.
    --    This captures the full order-level context of what was restored.
    --    Note: trg_audit_inventory_change also fires per-row on inventory UPDATE.
    INSERT INTO audit_logs (outlet_id, entity, entity_id, action, user_id, details)
    VALUES (
        p_outlet_id,
        'inventory',
        p_order_id,
        'restore_cancelled_order',
        p_user_id,
        jsonb_build_object(
            'order_id', p_order_id,
            'restorations', v_restorations
        )
    );

    -- f. Return result with restoration details
    RETURN jsonb_build_object('restorations', v_restorations);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION restore_inventory(UUID, UUID, UUID) IS
  'Atomic inventory restoration with FOR UPDATE row-level locking. '
  'Aggregates ingredient requirements from order_items + recipes, '
  'restores inventory quantities, and creates audit log with action '
  'restore_cancelled_order. Called via rpc from the restore-inventory '
  'Edge Function. Requirements: 5.2 AC-10.';

COMMIT;
