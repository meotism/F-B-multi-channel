-- ============================================================
-- Fix table_summary view: SECURITY INVOKER
-- ============================================================
-- Switches table_summary from default SECURITY DEFINER to
-- SECURITY INVOKER so that RLS policies of the querying user
-- are enforced on the underlying tables.
-- ============================================================

ALTER VIEW table_summary SET (security_invoker = on);
