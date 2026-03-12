-- ============================================================
-- Report Database Functions
-- ============================================================
-- This migration creates two reporting functions:
--   1. get_top_items()         - Top-selling menu items by qty/revenue
--   2. get_revenue_breakdown() - Revenue grouped by hour or day
--
-- Both functions use the outlet's configured timezone for correct
-- date/time grouping and only include bills with status
-- 'finalized' or 'printed'.
--
-- Dependencies:
--   - 001_initial_schema.sql (tables, enums)
--   - 003_rls_policies.sql   (RLS enabled)
--
-- Requirements: 5.7 (Reporting), Req 10 AC-1 through AC-5
-- ============================================================

BEGIN;

-- ============================================================
-- 1. get_top_items
-- ============================================================
-- Returns the top-selling menu items within a date range,
-- optionally filtered by category.
--
-- Joins: order_items -> orders -> bills -> menu_items -> categories
-- Filters: outlet_id, finalized_at range, bill status, optional category
-- Groups by menu item, ordered by total quantity descending.

CREATE OR REPLACE FUNCTION get_top_items(
    p_outlet_id UUID,
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ,
    p_category_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 10
) RETURNS TABLE (
    menu_item_id UUID,
    item_name VARCHAR,
    category_name VARCHAR,
    total_qty BIGINT,
    total_revenue DECIMAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        mi.id AS menu_item_id,
        mi.name AS item_name,
        c.name AS category_name,
        SUM(oi.qty)::BIGINT AS total_qty,
        SUM(oi.price * oi.qty) AS total_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN bills b ON b.order_id = o.id
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN categories c ON c.id = mi.category_id
    WHERE b.outlet_id = p_outlet_id
      AND b.finalized_at >= p_from
      AND b.finalized_at < p_to
      AND b.status IN ('finalized', 'printed')
      AND (p_category_id IS NULL OR mi.category_id = p_category_id)
    GROUP BY mi.id, mi.name, c.name
    ORDER BY total_qty DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_top_items(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER) IS
  'Returns top-selling menu items by quantity within a date range. '
  'Joins order_items -> orders -> bills -> menu_items -> categories. '
  'Filters by outlet_id, finalized_at range, bill status (finalized/printed), '
  'and optional category_id. Ordered by total_qty DESC. '
  'Requirements: Req 10 AC-1/2.';

-- ============================================================
-- 2. get_revenue_breakdown
-- ============================================================
-- Returns revenue grouped by hour or day within a date range.
-- Uses the outlet's configured timezone for correct grouping
-- (e.g., bills finalized near midnight are assigned to the
-- correct local date).
--
-- p_group_by = 'hour': groups by EXTRACT(HOUR), returns 'HH:00'
-- p_group_by = 'day':  groups by TO_CHAR(..., 'YYYY-MM-DD')

CREATE OR REPLACE FUNCTION get_revenue_breakdown(
    p_outlet_id UUID,
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ,
    p_group_by TEXT DEFAULT 'hour'
) RETURNS TABLE (
    period TEXT,
    revenue DECIMAL,
    bill_count BIGINT,
    average_value DECIMAL
) AS $$
DECLARE
    v_tz VARCHAR(50);
BEGIN
    -- Fetch the outlet's timezone once for use in grouping
    SELECT timezone INTO v_tz
    FROM outlets
    WHERE id = p_outlet_id;

    -- Default to UTC if outlet not found or timezone not set
    IF v_tz IS NULL THEN
        v_tz := 'UTC';
    END IF;

    IF p_group_by = 'hour' THEN
        RETURN QUERY
        SELECT
            LPAD(EXTRACT(HOUR FROM b.finalized_at AT TIME ZONE v_tz)::TEXT, 2, '0') || ':00' AS period,
            SUM(b.total) AS revenue,
            COUNT(*)::BIGINT AS bill_count,
            ROUND(AVG(b.total)) AS average_value
        FROM bills b
        WHERE b.outlet_id = p_outlet_id
          AND b.finalized_at >= p_from
          AND b.finalized_at < p_to
          AND b.status IN ('finalized', 'printed')
        GROUP BY EXTRACT(HOUR FROM b.finalized_at AT TIME ZONE v_tz)
        ORDER BY period;
    ELSE
        -- Default to 'day' grouping for any non-'hour' value
        RETURN QUERY
        SELECT
            TO_CHAR(b.finalized_at AT TIME ZONE v_tz, 'YYYY-MM-DD') AS period,
            SUM(b.total) AS revenue,
            COUNT(*)::BIGINT AS bill_count,
            ROUND(AVG(b.total)) AS average_value
        FROM bills b
        WHERE b.outlet_id = p_outlet_id
          AND b.finalized_at >= p_from
          AND b.finalized_at < p_to
          AND b.status IN ('finalized', 'printed')
        GROUP BY TO_CHAR(b.finalized_at AT TIME ZONE v_tz, 'YYYY-MM-DD')
        ORDER BY period;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_revenue_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) IS
  'Returns revenue breakdown grouped by hour or day within a date range. '
  'Uses the outlet''s configured timezone for correct date/time grouping. '
  'Only includes bills with status finalized or printed. '
  'p_group_by = ''hour'' formats as ''HH:00''; p_group_by = ''day'' formats as ''YYYY-MM-DD''. '
  'Requirements: Req 10 AC-3/4/5.';

COMMIT;
