-- ============================================================
-- Business Logic Triggers
-- ============================================================
-- Creates three triggers for data integrity enforcement:
--   1. enforce_price_snapshot    — prevents modification of order_items.price
--   2. check_ingredient_availability — auto-toggles menu_items.is_available
--      when ingredient inventory reaches zero or is restored
--   3. invalidate_session_on_role_change — updates auth metadata when
--      a user's role is changed, forcing re-authentication
--
-- Dependencies:
--   - 001_initial_schema.sql (tables, enums)
--   - 022_add_enhancement_columns.sql (menu_items.is_available)
--
-- Requirements: 4.4, 4.6, 4.12
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TRIGGER: enforce_price_snapshot
-- Prevents modification of the price column on order_items.
-- Price is captured at order time and must remain immutable.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_price_snapshot()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.price IS DISTINCT FROM OLD.price THEN
        RAISE EXCEPTION 'ORDER_ITEM_PRICE_IMMUTABLE: Cannot modify price on an existing order item. Price is a snapshot captured at order time.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_items_price_immutable
    BEFORE UPDATE ON order_items
    FOR EACH ROW EXECUTE FUNCTION enforce_price_snapshot();

COMMENT ON FUNCTION enforce_price_snapshot() IS
    'Prevents modification of order_items.price after insertion. '
    'Enforces the price-snapshot-at-order-time business rule. '
    'Requirement 4.4.';

-- ============================================================
-- 2. TRIGGER: check_ingredient_availability
-- When inventory qty_on_hand changes, check if any menu items
-- using this ingredient should be marked unavailable (or restored).
--
-- Logic:
--   - When qty_on_hand drops to 0 or below: find all menu items
--     that use this ingredient (via recipes) and set is_available=false
--   - When qty_on_hand rises above 0: check if ALL ingredients
--     for each affected menu item are now available. Only set
--     is_available=true if every ingredient has qty_on_hand > 0.
-- ============================================================

CREATE OR REPLACE FUNCTION check_ingredient_availability()
RETURNS TRIGGER AS $$
DECLARE
    v_menu_item RECORD;
    v_all_available BOOLEAN;
BEGIN
    -- Only act when qty_on_hand actually changes
    IF NEW.qty_on_hand IS NOT DISTINCT FROM OLD.qty_on_hand THEN
        RETURN NEW;
    END IF;

    -- Case 1: Ingredient depleted → mark affected menu items unavailable
    IF NEW.qty_on_hand <= 0 AND OLD.qty_on_hand > 0 THEN
        UPDATE menu_items
        SET is_available = false
        WHERE id IN (
            SELECT DISTINCT r.menu_item_id
            FROM recipes r
            WHERE r.ingredient_id = NEW.ingredient_id
        )
        AND is_available = true;
    END IF;

    -- Case 2: Ingredient restored → check if menu items can be re-enabled
    IF NEW.qty_on_hand > 0 AND OLD.qty_on_hand <= 0 THEN
        FOR v_menu_item IN
            SELECT DISTINCT r.menu_item_id
            FROM recipes r
            WHERE r.ingredient_id = NEW.ingredient_id
        LOOP
            -- Check if ALL ingredients for this menu item are available
            SELECT NOT EXISTS (
                SELECT 1
                FROM recipes r
                JOIN inventory inv ON inv.ingredient_id = r.ingredient_id
                    AND inv.outlet_id = NEW.outlet_id
                WHERE r.menu_item_id = v_menu_item.menu_item_id
                  AND inv.qty_on_hand <= 0
            ) INTO v_all_available;

            IF v_all_available THEN
                UPDATE menu_items
                SET is_available = true
                WHERE id = v_menu_item.menu_item_id
                  AND is_available = false;
            END IF;
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_check_ingredient_availability
    AFTER UPDATE ON inventory
    FOR EACH ROW EXECUTE FUNCTION check_ingredient_availability();

COMMENT ON FUNCTION check_ingredient_availability() IS
    'Auto-toggles menu_items.is_available based on ingredient stock levels. '
    'Depletion (qty_on_hand drops to 0) marks affected items unavailable. '
    'Restoration (qty_on_hand rises above 0) re-enables items only if ALL '
    'their ingredients are available. SECURITY DEFINER needed to update '
    'menu_items across RLS boundary. Requirement 4.6.';

-- ============================================================
-- 3. TRIGGER: invalidate_session_on_role_change
-- When a user's role is changed, update auth.users metadata
-- to include the new role and a role_changed_at timestamp.
-- The client-side realtime subscription detects this and
-- forces the affected user to re-authenticate.
-- ============================================================

CREATE OR REPLACE FUNCTION invalidate_session_on_role_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        -- Update auth metadata so the client can detect the role change.
        -- The client's realtime subscription on the users table will
        -- detect the role change and force re-authentication.
        UPDATE auth.users
        SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::JSONB)
            || jsonb_build_object(
                'role', NEW.role::TEXT,
                'role_changed_at', EXTRACT(EPOCH FROM now())::TEXT
            )
        WHERE id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_invalidate_session_on_role_change
    AFTER UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION invalidate_session_on_role_change();

COMMENT ON FUNCTION invalidate_session_on_role_change() IS
    'Updates auth.users.raw_app_meta_data when a user role changes. '
    'Client detects via Realtime subscription and forces re-auth. '
    'SECURITY DEFINER needed to write to auth.users. Requirement 4.12.';

COMMIT;
