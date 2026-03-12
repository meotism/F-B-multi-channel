-- ============================================================
-- RLS Helper Functions
-- ============================================================
-- These functions are used by Row Level Security policies to
-- determine the current user's outlet_id and role without
-- circular dependency issues.
--
-- SECURITY DEFINER: bypasses RLS on the users table itself,
--   avoiding infinite recursion when RLS policies on users
--   call these helpers.
-- STABLE: allows PostgreSQL to cache the result within a
--   single transaction for better performance.
-- ============================================================

-- Get the current user's outlet_id
CREATE OR REPLACE FUNCTION public.user_outlet_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT outlet_id FROM public.users WHERE id = auth.uid()
$$;

-- Get the current user's role
CREATE OR REPLACE FUNCTION public.user_role()
RETURNS public.user_role
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT role FROM public.users WHERE id = auth.uid()
$$;

COMMENT ON FUNCTION public.user_outlet_id() IS
  'Returns the outlet_id of the currently authenticated user. SECURITY DEFINER to bypass RLS on users table.';

COMMENT ON FUNCTION public.user_role() IS
  'Returns the role of the currently authenticated user. SECURITY DEFINER to bypass RLS on users table.';
