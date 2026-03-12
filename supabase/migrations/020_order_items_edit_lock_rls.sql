-- ============================================================
-- Edit Lock: Prevent order_items modifications on non-active orders
-- ============================================================
-- This migration strengthens the edit lock on order_items by
-- replacing the INSERT policy to require the parent order
-- status = 'active'. The existing UPDATE and DELETE policies
-- (003_rls_policies.sql) already enforce this constraint.
--
-- After this migration, all write operations (INSERT, UPDATE,
-- DELETE) on order_items are only allowed when the parent order
-- status is 'active'. This ensures that once an order is
-- completed, finalized, or cancelled, its items cannot be
-- modified.
--
-- Existing policies (003_rls_policies.sql):
--   - order_items_select: SELECT with outlet check (no status check — correct)
--   - order_items_insert: INSERT with outlet + role check (NO active check — fixed here)
--   - order_items_update: UPDATE with outlet + role + active check (already correct)
--   - order_items_delete: DELETE with outlet + role + active check (already correct)
--
-- Dependencies:
--   - 001_initial_schema.sql (tables, enums)
--   - 003_rls_policies.sql   (existing RLS policies)
--
-- Requirements: Req 3 AC-1 (edit lock on finalized/completed orders)
-- ============================================================

BEGIN;

-- Drop the existing INSERT policy that lacks the active order check
DROP POLICY IF EXISTS order_items_insert ON order_items;

-- Recreate INSERT policy with the active order status requirement.
-- This ensures items can only be added to orders that are still active.
CREATE POLICY order_items_insert ON order_items
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
            AND o.outlet_id = public.user_outlet_id()
            AND o.status = 'active'
        )
        AND public.user_role() IN ('manager', 'staff', 'cashier')
    );

COMMIT;
