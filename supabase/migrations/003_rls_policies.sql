-- ============================================================
-- RLS Policies for All 13 Tables
-- ============================================================
-- Enables Row Level Security on every table and creates
-- fine-grained policies based on the user's outlet_id and role.
--
-- All policies enforce multi-tenant data isolation by filtering
-- on outlet_id = public.user_outlet_id(). Role checks use
-- public.user_role() which queries the users table directly
-- (not JWT claims) so changes take effect immediately.
--
-- Dependencies:
--   - 001_initial_schema.sql  (table definitions)
--   - 002_rls_helpers.sql     (public.user_outlet_id, public.user_role)
--
-- Design reference: Section 3.2 (RLS Policies), Summary Matrix 3.2.15
-- Requirements reference: 5.8 AC-3/4/5/7, 6.3.3
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ENABLE RLS ON ALL 13 TABLES
-- ============================================================

ALTER TABLE outlets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables       ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredients  ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory    ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills        ENABLE ROW LEVEL SECURITY;
ALTER TABLE printers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs   ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. RLS POLICIES: outlets
-- All authenticated users can see their own outlet.
-- Only owners can update outlet info.
-- ============================================================

CREATE POLICY outlets_select ON outlets
    FOR SELECT
    USING (id = public.user_outlet_id());

CREATE POLICY outlets_update ON outlets
    FOR UPDATE
    USING (id = public.user_outlet_id() AND public.user_role() = 'owner')
    WITH CHECK (id = public.user_outlet_id() AND public.user_role() = 'owner');

-- ============================================================
-- 3. RLS POLICIES: users
-- All users can see users in their outlet.
-- Only owners can create, update, or delete users.
-- ============================================================

CREATE POLICY users_select ON users
    FOR SELECT
    USING (outlet_id = public.user_outlet_id());

CREATE POLICY users_insert ON users
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() = 'owner'
    );

CREATE POLICY users_update ON users
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() = 'owner'
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() = 'owner'
    );

CREATE POLICY users_delete ON users
    FOR DELETE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() = 'owner'
    );

-- ============================================================
-- 4. RLS POLICIES: tables
-- Viewable by: Owner, Manager, Staff, Cashier
-- INSERT/DELETE: Manager only
-- UPDATE: Manager, Staff, Cashier (layout protection via trigger)
--
-- SECURITY NOTE: The protect_table_layout trigger (001_initial_schema.sql)
-- enforces that Staff/Cashier can ONLY update the 'status' column.
-- All layout property changes (name, capacity, shape, x, y, rotation,
-- table_code) are blocked at the database level for non-Manager roles.
-- ============================================================

CREATE POLICY tables_select ON tables
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'staff', 'cashier')
    );

CREATE POLICY tables_insert ON tables
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() = 'manager'
    );

CREATE POLICY tables_update ON tables
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    );

CREATE POLICY tables_delete ON tables
    FOR DELETE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() = 'manager'
    );

-- ============================================================
-- 5. RLS POLICIES: categories
-- Viewable by: Owner, Manager, Staff, Cashier (needed for order creation)
-- Editable by: Manager only
-- ============================================================

CREATE POLICY categories_select ON categories
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'staff', 'cashier')
    );

CREATE POLICY categories_insert ON categories
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() = 'manager'
    );

CREATE POLICY categories_update ON categories
    FOR UPDATE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager')
    WITH CHECK (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager');

CREATE POLICY categories_delete ON categories
    FOR DELETE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager');

-- ============================================================
-- 6. RLS POLICIES: menu_items
-- Viewable by: Owner, Manager, Staff, Cashier
-- Editable by: Manager only
-- ============================================================

CREATE POLICY menu_items_select ON menu_items
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'staff', 'cashier')
    );

CREATE POLICY menu_items_insert ON menu_items
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() = 'manager'
    );

CREATE POLICY menu_items_update ON menu_items
    FOR UPDATE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager')
    WITH CHECK (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager');

CREATE POLICY menu_items_delete ON menu_items
    FOR DELETE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager');

-- ============================================================
-- 7. RLS POLICIES: ingredients
-- Viewable by: Manager, Warehouse
-- Editable by: Manager only
-- ============================================================

CREATE POLICY ingredients_select ON ingredients
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse')
    );

CREATE POLICY ingredients_insert ON ingredients
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() = 'manager'
    );

CREATE POLICY ingredients_update ON ingredients
    FOR UPDATE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager')
    WITH CHECK (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager');

CREATE POLICY ingredients_delete ON ingredients
    FOR DELETE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager');

-- ============================================================
-- 8. RLS POLICIES: recipes
-- Viewable by: Manager, Warehouse, Staff, Cashier (via JOIN through menu_items)
-- Editable by: Manager only
--
-- Recipes do not have a direct outlet_id column. Outlet ownership
-- is verified via an EXISTS subquery through the menu_items table.
-- ============================================================

CREATE POLICY recipes_select ON recipes
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() IN ('manager', 'warehouse', 'staff', 'cashier')
    );

CREATE POLICY recipes_insert ON recipes
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() = 'manager'
    );

CREATE POLICY recipes_update ON recipes
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() = 'manager'
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() = 'manager'
    );

CREATE POLICY recipes_delete ON recipes
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.id = recipes.menu_item_id
            AND mi.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() = 'manager'
    );

-- ============================================================
-- 9. RLS POLICIES: inventory
-- Viewable by: Manager, Warehouse
-- Editable by: Manager, Warehouse
-- No DELETE policy: deactivate the ingredient instead
-- ============================================================

CREATE POLICY inventory_select ON inventory
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse')
    );

CREATE POLICY inventory_insert ON inventory
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse')
    );

CREATE POLICY inventory_update ON inventory
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'warehouse')
    );

-- No DELETE policy for inventory rows (deactivate ingredient instead)

-- ============================================================
-- 10. RLS POLICIES: orders
-- Viewable by: Owner (reports), Manager, Staff, Cashier
-- Creatable/Updatable by: Manager, Staff, Cashier
-- No DELETE policy: orders use soft delete (status = 'cancelled')
-- ============================================================

CREATE POLICY orders_select ON orders
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'staff', 'cashier')
    );

CREATE POLICY orders_insert ON orders
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    );

CREATE POLICY orders_update ON orders
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    );

-- Orders are soft-deleted (status = 'cancelled'), no hard delete policy needed

-- ============================================================
-- 11. RLS POLICIES: order_items
-- Accessed through parent order context.
-- SELECT/INSERT: Owner, Manager, Staff, Cashier
-- UPDATE/DELETE: Manager, Staff, Cashier (only for active orders)
--
-- order_items does not have a direct outlet_id column. Outlet
-- ownership is verified via EXISTS subquery through orders table.
-- UPDATE and DELETE additionally require the parent order to be
-- in 'active' status, enforcing the edit lock at the DB level.
-- ============================================================

CREATE POLICY order_items_select ON order_items
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() IN ('owner', 'manager', 'staff', 'cashier')
    );

CREATE POLICY order_items_insert ON order_items
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
        )
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    );

CREATE POLICY order_items_update ON order_items
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
            AND o.status = 'active'
        )
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
            AND o.status = 'active'
        )
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    );

CREATE POLICY order_items_delete ON order_items
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
            AND o.status = 'active'
        )
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    );

-- ============================================================
-- 12. RLS POLICIES: bills
-- Viewable by: Owner (reports), Manager, Cashier
-- Creatable/Updatable by: Manager, Cashier (via finalize Edge Function)
-- No DELETE policy: bills are never deleted
--
-- SECURITY NOTE: The protect_finalized_bill trigger (001_initial_schema.sql)
-- prevents modification of total, tax, order_id, and finalized_at after
-- finalization. Only status, printed_at, and payment_method may be changed.
-- ============================================================

CREATE POLICY bills_select ON bills
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'cashier')
    );

CREATE POLICY bills_insert ON bills
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier')
    );

CREATE POLICY bills_update ON bills
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier')
    );

-- No DELETE policy: bills are never deleted

-- ============================================================
-- 13. RLS POLICIES: printers
-- Viewable/Editable by: Manager, Cashier
-- DELETE: Manager only
-- ============================================================

CREATE POLICY printers_select ON printers
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier')
    );

CREATE POLICY printers_insert ON printers
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('manager', 'cashier')
    );

CREATE POLICY printers_update ON printers
    FOR UPDATE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'cashier'))
    WITH CHECK (outlet_id = public.user_outlet_id() AND public.user_role() IN ('manager', 'cashier'));

CREATE POLICY printers_delete ON printers
    FOR DELETE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() = 'manager');

-- ============================================================
-- 14. RLS POLICIES: audit_logs
-- Viewable by: Owner, Manager (read-only for accountability)
-- Insertable by: authenticated users (with user_id = auth.uid())
-- No UPDATE or DELETE policies: audit logs are immutable
--
-- INSERT is primarily performed by Edge Functions using the
-- service_role key (which bypasses RLS). The INSERT policy below
-- allows direct client inserts when needed, constraining user_id
-- to the authenticated user to prevent impersonation.
-- ============================================================

CREATE POLICY audit_logs_select ON audit_logs
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager')
    );

CREATE POLICY audit_logs_insert ON audit_logs
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND user_id = auth.uid()
    );

-- No UPDATE or DELETE policies: audit logs are immutable

COMMIT;
