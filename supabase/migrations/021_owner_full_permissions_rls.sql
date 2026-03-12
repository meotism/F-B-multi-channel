-- ============================================================
-- Owner Full Permissions: Add 'owner' to operational RLS policies
-- ============================================================
-- Owner role should have all operational capabilities of manager
-- and cashier. This migration updates INSERT/UPDATE/DELETE policies
-- to include 'owner' wherever it was previously excluded.
--
-- Approach: DROP existing policy + CREATE new policy with 'owner' added.
--
-- Dependencies:
--   - 003_rls_policies.sql  (original policies)
--   - 020_order_items_edit_lock_rls.sql (updated order_items_insert)
-- ============================================================

BEGIN;

-- ============================================================
-- tables: INSERT, UPDATE, DELETE
-- Owner can manage table layout (create/delete tables, update status + layout)
-- The protect_table_layout trigger only restricts staff/cashier, not owner.
-- ============================================================

DROP POLICY IF EXISTS tables_insert ON tables;
CREATE POLICY tables_insert ON tables
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'owner')
    );

DROP POLICY IF EXISTS tables_update ON tables;
CREATE POLICY tables_update ON tables
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier', 'owner')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier', 'owner')
    );

DROP POLICY IF EXISTS tables_delete ON tables;
CREATE POLICY tables_delete ON tables
    FOR DELETE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'owner')
    );

-- ============================================================
-- categories: INSERT, UPDATE, DELETE
-- ============================================================

DROP POLICY IF EXISTS categories_insert ON categories;
CREATE POLICY categories_insert ON categories
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'owner')
    );

DROP POLICY IF EXISTS categories_update ON categories;
CREATE POLICY categories_update ON categories
    FOR UPDATE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'))
    WITH CHECK (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'));

DROP POLICY IF EXISTS categories_delete ON categories;
CREATE POLICY categories_delete ON categories
    FOR DELETE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'));

-- ============================================================
-- menu_items: INSERT, UPDATE, DELETE
-- ============================================================

DROP POLICY IF EXISTS menu_items_insert ON menu_items;
CREATE POLICY menu_items_insert ON menu_items
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'owner')
    );

DROP POLICY IF EXISTS menu_items_update ON menu_items;
CREATE POLICY menu_items_update ON menu_items
    FOR UPDATE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'))
    WITH CHECK (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'));

DROP POLICY IF EXISTS menu_items_delete ON menu_items;
CREATE POLICY menu_items_delete ON menu_items
    FOR DELETE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'));

-- ============================================================
-- ingredients: SELECT, INSERT, UPDATE, DELETE
-- ============================================================

DROP POLICY IF EXISTS ingredients_select ON ingredients;
CREATE POLICY ingredients_select ON ingredients
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse', 'owner')
    );

DROP POLICY IF EXISTS ingredients_insert ON ingredients;
CREATE POLICY ingredients_insert ON ingredients
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'owner')
    );

DROP POLICY IF EXISTS ingredients_update ON ingredients;
CREATE POLICY ingredients_update ON ingredients
    FOR UPDATE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'))
    WITH CHECK (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'));

DROP POLICY IF EXISTS ingredients_delete ON ingredients;
CREATE POLICY ingredients_delete ON ingredients
    FOR DELETE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'));

-- ============================================================
-- recipes: SELECT, INSERT, UPDATE, DELETE
-- ============================================================

DROP POLICY IF EXISTS recipes_select ON recipes;
CREATE POLICY recipes_select ON recipes
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() IN ('manager', 'warehouse', 'staff', 'cashier', 'owner')
    );

DROP POLICY IF EXISTS recipes_insert ON recipes;
CREATE POLICY recipes_insert ON recipes
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() IN ('manager', 'owner')
    );

DROP POLICY IF EXISTS recipes_update ON recipes;
CREATE POLICY recipes_update ON recipes
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() IN ('manager', 'owner')
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() IN ('manager', 'owner')
    );

DROP POLICY IF EXISTS recipes_delete ON recipes;
CREATE POLICY recipes_delete ON recipes
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() IN ('manager', 'owner')
    );

-- ============================================================
-- inventory: SELECT, INSERT, UPDATE
-- ============================================================

DROP POLICY IF EXISTS inventory_select ON inventory;
CREATE POLICY inventory_select ON inventory
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse', 'owner')
    );

DROP POLICY IF EXISTS inventory_insert ON inventory;
CREATE POLICY inventory_insert ON inventory
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse', 'owner')
    );

DROP POLICY IF EXISTS inventory_update ON inventory;
CREATE POLICY inventory_update ON inventory
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse', 'owner')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse', 'owner')
    );

-- ============================================================
-- orders: INSERT, UPDATE
-- ============================================================

DROP POLICY IF EXISTS orders_insert ON orders;
CREATE POLICY orders_insert ON orders
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier', 'owner')
    );

DROP POLICY IF EXISTS orders_update ON orders;
CREATE POLICY orders_update ON orders
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier', 'owner')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier', 'owner')
    );

-- ============================================================
-- order_items: INSERT, UPDATE, DELETE
-- Replaces both 003_rls_policies.sql and 020_order_items_edit_lock_rls.sql versions
-- ============================================================

DROP POLICY IF EXISTS order_items_insert ON order_items;
CREATE POLICY order_items_insert ON order_items
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
            AND o.status = 'active'
        )
        AND public.user_role() IN ('manager', 'staff', 'cashier', 'owner')
    );

DROP POLICY IF EXISTS order_items_update ON order_items;
CREATE POLICY order_items_update ON order_items
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
            AND o.status = 'active'
        )
        AND public.user_role() IN ('manager', 'staff', 'cashier', 'owner')
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
            AND o.status = 'active'
        )
        AND public.user_role() IN ('manager', 'staff', 'cashier', 'owner')
    );

DROP POLICY IF EXISTS order_items_delete ON order_items;
CREATE POLICY order_items_delete ON order_items
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
            AND o.status = 'active'
        )
        AND public.user_role() IN ('manager', 'staff', 'cashier', 'owner')
    );

-- ============================================================
-- bills: INSERT, UPDATE
-- ============================================================

DROP POLICY IF EXISTS bills_insert ON bills;
CREATE POLICY bills_insert ON bills
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier', 'owner')
    );

DROP POLICY IF EXISTS bills_update ON bills;
CREATE POLICY bills_update ON bills
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier', 'owner')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier', 'owner')
    );

-- ============================================================
-- printers: SELECT, INSERT, UPDATE, DELETE
-- ============================================================

DROP POLICY IF EXISTS printers_select ON printers;
CREATE POLICY printers_select ON printers
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier', 'owner')
    );

DROP POLICY IF EXISTS printers_insert ON printers;
CREATE POLICY printers_insert ON printers
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier', 'owner')
    );

DROP POLICY IF EXISTS printers_update ON printers;
CREATE POLICY printers_update ON printers
    FOR UPDATE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'cashier', 'owner'))
    WITH CHECK (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'cashier', 'owner'));

DROP POLICY IF EXISTS printers_delete ON printers;
CREATE POLICY printers_delete ON printers
    FOR DELETE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'owner'));

COMMIT;
