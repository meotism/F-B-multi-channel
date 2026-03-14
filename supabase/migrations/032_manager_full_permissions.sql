-- ============================================================
-- Grant manager full permissions (same as owner)
-- ============================================================
-- Updates RLS policies that were owner-only to also allow
-- manager role. This gives manager identical access to owner
-- at the database level.
--
-- Affected tables: outlets (UPDATE), users (INSERT/UPDATE/DELETE)
--
-- Dependencies:
--   - 003_rls_policies.sql (original policies)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. outlets: allow manager to UPDATE (e.g., outlet settings)
-- ============================================================
DROP POLICY IF EXISTS outlets_update ON outlets;
CREATE POLICY outlets_update ON outlets
    FOR UPDATE
    USING (id = public.user_outlet_id() AND public.user_role() IN ('owner', 'manager'))
    WITH CHECK (id = public.user_outlet_id() AND public.user_role() IN ('owner', 'manager'));

-- ============================================================
-- 2. users: allow manager to INSERT (create users)
-- ============================================================
DROP POLICY IF EXISTS users_insert ON users;
CREATE POLICY users_insert ON users
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager')
    );

-- ============================================================
-- 3. users: allow manager to UPDATE (edit users)
-- ============================================================
DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_update ON users
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager')
    );

-- ============================================================
-- 4. users: allow manager to DELETE (remove users)
-- ============================================================
DROP POLICY IF EXISTS users_delete ON users;
CREATE POLICY users_delete ON users
    FOR DELETE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager')
    );

COMMIT;
