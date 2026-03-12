-- ============================================================
-- Inventory Deduction / Restoration Stored Procedure
-- ============================================================
-- This migration creates:
--   1. deduct_inventory()  - Stored procedure for atomic inventory
--      deduction or restoration with FOR UPDATE row-level locking.
--      Called via supabase.rpc('deduct_inventory', ...) from the
--      deduct-inventory Edge Function.
--
-- The procedure:
--   a. Validates the order exists and belongs to the given outlet.
--   b. Fetches order_items joined with recipes and inventory,
--      aggregating total ingredient quantities needed.
--   c. Locks inventory rows with FOR UPDATE to prevent concurrent
--      negative inventory.
--   d. For 'deduct': checks sufficient stock, then decrements.
--   e. For 'restore': increments inventory (no sufficiency check).
--   f. Creates an audit_log entry with deduction/restoration details.
--   g. Returns a JSONB result with deductions[] and low_stock_alerts[].
--
-- Note: The trg_audit_inventory_change trigger (001_initial_schema.sql)
--   also fires on each inventory UPDATE, creating per-row audit entries.
--   The audit_log created here captures the order-level context.
--
-- Dependencies: 001_initial_schema.sql (tables, enums, triggers)
-- Requirements: 5.6 AC-3/8, 5.6 EC-1
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION deduct_inventory(
    p_order_id UUID,
    p_action TEXT,       -- 'deduct' or 'restore'
    p_user_id UUID,
    p_outlet_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_row RECORD;
    v_deductions JSONB := '[]'::JSONB;
    v_low_stock_alerts JSONB := '[]'::JSONB;
    v_insufficient JSONB := '[]'::JSONB;
    v_has_insufficient BOOLEAN := FALSE;
    v_new_qty DECIMAL(12,3);
    v_has_ingredients BOOLEAN := FALSE;
BEGIN
    -- a. Validate order exists and belongs to the outlet
    SELECT * INTO v_order
    FROM orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF v_order IS NULL OR v_order.outlet_id != p_outlet_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- b. Fetch aggregated ingredient requirements with inventory locking.
    --    Multiple order_items may use the same ingredient (via different menu items),
    --    so we aggregate with SUM. FOR UPDATE OF inv locks inventory rows to
    --    prevent concurrent negative inventory (5.6 EC-1).
    --
    --    We iterate once: first collect all data into the v_deductions array,
    --    checking for insufficient stock along the way. If any ingredient is
    --    insufficient, we raise an exception before performing any updates.
    --    Since FOR UPDATE holds locks for the entire transaction, we then
    --    perform actual UPDATEs using the collected data.

    -- Phase 1: Lock rows and check sufficiency (for deduct action)
    FOR v_row IN
        SELECT
            r.ingredient_id,
            i.name AS ingredient_name,
            inv.id AS inventory_id,
            inv.qty_on_hand,
            inv.threshold,
            SUM(r.qty * oi.qty) AS total_needed
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

        IF p_action = 'deduct' THEN
            -- Check if deduction would result in negative inventory
            IF v_row.qty_on_hand < v_row.total_needed THEN
                v_has_insufficient := TRUE;
                v_insufficient := v_insufficient || jsonb_build_array(
                    jsonb_build_object(
                        'ingredient_id', v_row.ingredient_id,
                        'ingredient_name', v_row.ingredient_name,
                        'required', v_row.total_needed,
                        'available', v_row.qty_on_hand
                    )
                );
            END IF;
        END IF;
    END LOOP;

    -- c. If any ingredient has insufficient stock, raise exception with details
    --    encoded in the message for the Edge Function to parse.
    IF v_has_insufficient THEN
        RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_insufficient::TEXT;
    END IF;

    -- d. If no recipe ingredients found, return early with empty arrays
    IF NOT v_has_ingredients THEN
        RETURN jsonb_build_object(
            'deductions', v_deductions,
            'low_stock_alerts', v_low_stock_alerts
        );
    END IF;

    -- Phase 2: Perform actual updates. Rows are already locked from Phase 1.
    FOR v_row IN
        SELECT
            r.ingredient_id,
            i.name AS ingredient_name,
            inv.id AS inventory_id,
            inv.qty_on_hand,
            inv.threshold,
            SUM(r.qty * oi.qty) AS total_needed
        FROM order_items oi
        JOIN recipes r ON r.menu_item_id = oi.menu_item_id
        JOIN ingredients i ON i.id = r.ingredient_id
        JOIN inventory inv ON inv.ingredient_id = r.ingredient_id
                          AND inv.outlet_id = p_outlet_id
        WHERE oi.order_id = p_order_id
        GROUP BY r.ingredient_id, i.name, inv.id, inv.qty_on_hand, inv.threshold
        FOR UPDATE OF inv
    LOOP
        IF p_action = 'deduct' THEN
            -- Deduct: decrease qty_on_hand
            v_new_qty := v_row.qty_on_hand - v_row.total_needed;

            UPDATE inventory
            SET qty_on_hand = v_new_qty
            WHERE id = v_row.inventory_id;

            v_deductions := v_deductions || jsonb_build_array(
                jsonb_build_object(
                    'ingredient_id', v_row.ingredient_id,
                    'ingredient_name', v_row.ingredient_name,
                    'deducted_qty', v_row.total_needed,
                    'remaining_qty', v_new_qty,
                    'below_threshold', (v_new_qty <= v_row.threshold)
                )
            );

            -- Collect low-stock alerts for ingredients that fell below threshold
            IF v_new_qty <= v_row.threshold THEN
                v_low_stock_alerts := v_low_stock_alerts || jsonb_build_array(
                    jsonb_build_object(
                        'ingredient_id', v_row.ingredient_id,
                        'ingredient_name', v_row.ingredient_name,
                        'qty_on_hand', v_new_qty,
                        'threshold', v_row.threshold
                    )
                );
            END IF;

        ELSIF p_action = 'restore' THEN
            -- Restore: increase qty_on_hand (for order cancellation)
            v_new_qty := v_row.qty_on_hand + v_row.total_needed;

            UPDATE inventory
            SET qty_on_hand = v_new_qty
            WHERE id = v_row.inventory_id;

            v_deductions := v_deductions || jsonb_build_array(
                jsonb_build_object(
                    'ingredient_id', v_row.ingredient_id,
                    'ingredient_name', v_row.ingredient_name,
                    'restored_qty', v_row.total_needed,
                    'remaining_qty', v_new_qty,
                    'below_threshold', (v_new_qty <= v_row.threshold)
                )
            );
        END IF;
    END LOOP;

    -- e. Create audit log entry with order-level context.
    --    Note: trg_audit_inventory_change also fires per-row, but this entry
    --    captures the full order context (which ingredients, total deductions).
    INSERT INTO audit_logs (outlet_id, entity, entity_id, action, user_id, details)
    VALUES (
        p_outlet_id,
        'inventory',
        p_order_id,
        p_action,
        p_user_id,
        jsonb_build_object(
            'order_id', p_order_id,
            'action', p_action,
            'items', v_deductions
        )
    );

    -- f. Return result with deductions and low-stock alerts
    RETURN jsonb_build_object(
        'deductions', v_deductions,
        'low_stock_alerts', v_low_stock_alerts
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION deduct_inventory(UUID, TEXT, UUID, UUID) IS
  'Atomic inventory deduction/restoration with FOR UPDATE row-level locking. '
  'Aggregates ingredient requirements from order_items + recipes, checks stock '
  'sufficiency for deductions, updates inventory, and creates audit log. '
  'Called via rpc from the deduct-inventory Edge Function. '
  'Requirements: 5.6 AC-3/8, 5.6 EC-1.';

COMMIT;
