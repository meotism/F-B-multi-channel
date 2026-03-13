-- ============================================================
-- Fix: Include 'pending_print' bills in all report functions
-- ============================================================
-- Bills transition to 'pending_print' when auto-print fails after
-- finalization. These are valid finalized bills that should appear
-- in reports. Previously, all report functions only included
-- 'finalized' and 'printed' statuses, causing pending_print bills
-- to silently disappear from revenue reports.
--
-- Affected functions:
--   1. get_top_items           (019)
--   2. get_revenue_breakdown   (019)
--   3. get_revenue_by_payment_method (025)
--   4. get_revenue_by_category      (025)
--   5. get_peak_hours               (025)
--
-- Dependencies:
--   - 019_create_report_functions.sql
--   - 025_create_enhanced_report_functions.sql
-- ============================================================

BEGIN;

-- ============================================================
-- 1. get_top_items
-- ============================================================

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
      AND b.status IN ('finalized', 'printed', 'pending_print')
      AND (p_category_id IS NULL OR mi.category_id = p_category_id)
    GROUP BY mi.id, mi.name, c.name
    ORDER BY total_qty DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- 2. get_revenue_breakdown
-- ============================================================

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
    SELECT timezone INTO v_tz
    FROM outlets
    WHERE id = p_outlet_id;

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
          AND b.status IN ('finalized', 'printed', 'pending_print')
        GROUP BY EXTRACT(HOUR FROM b.finalized_at AT TIME ZONE v_tz)
        ORDER BY period;
    ELSE
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
          AND b.status IN ('finalized', 'printed', 'pending_print')
        GROUP BY TO_CHAR(b.finalized_at AT TIME ZONE v_tz, 'YYYY-MM-DD')
        ORDER BY period;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- 3. get_revenue_by_payment_method
-- ============================================================

CREATE OR REPLACE FUNCTION get_revenue_by_payment_method(
    p_outlet_id UUID,
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ
) RETURNS TABLE (
    pay_method TEXT,
    total DECIMAL,
    bill_count BIGINT,
    average_value DECIMAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.payment_method::TEXT AS pay_method,
        SUM(b.total) AS total,
        COUNT(*)::BIGINT AS bill_count,
        ROUND(AVG(b.total)) AS average_value
    FROM bills b
    WHERE b.outlet_id = p_outlet_id
      AND b.finalized_at >= p_from
      AND b.finalized_at < p_to
      AND b.status IN ('finalized', 'printed', 'pending_print')
    GROUP BY b.payment_method
    ORDER BY total DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- 4. get_revenue_by_category
-- ============================================================

CREATE OR REPLACE FUNCTION get_revenue_by_category(
    p_outlet_id UUID,
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ
) RETURNS TABLE (
    category_id UUID,
    category_name TEXT,
    total DECIMAL,
    item_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id AS category_id,
        COALESCE(c.name, 'Không phân loại')::TEXT AS category_name,
        SUM(oi.price * oi.qty) AS total,
        SUM(oi.qty)::BIGINT AS item_count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN bills b ON b.order_id = o.id
    JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN categories c ON c.id = mi.category_id
    WHERE b.outlet_id = p_outlet_id
      AND b.finalized_at >= p_from
      AND b.finalized_at < p_to
      AND b.status IN ('finalized', 'printed', 'pending_print')
    GROUP BY c.id, c.name
    ORDER BY total DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- 5. get_peak_hours
-- ============================================================

CREATE OR REPLACE FUNCTION get_peak_hours(
    p_outlet_id UUID,
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ
) RETURNS TABLE (
    hour_of_day INTEGER,
    day_of_week INTEGER,
    order_count BIGINT,
    revenue DECIMAL
) AS $$
DECLARE
    v_tz VARCHAR(50);
BEGIN
    SELECT timezone INTO v_tz
    FROM outlets
    WHERE id = p_outlet_id;

    IF v_tz IS NULL THEN
        v_tz := 'Asia/Ho_Chi_Minh';
    END IF;

    RETURN QUERY
    SELECT
        EXTRACT(HOUR FROM b.finalized_at AT TIME ZONE v_tz)::INTEGER AS hour_of_day,
        EXTRACT(ISODOW FROM b.finalized_at AT TIME ZONE v_tz)::INTEGER AS day_of_week,
        COUNT(*)::BIGINT AS order_count,
        SUM(b.total) AS revenue
    FROM bills b
    WHERE b.outlet_id = p_outlet_id
      AND b.finalized_at >= p_from
      AND b.finalized_at < p_to
      AND b.status IN ('finalized', 'printed', 'pending_print')
    GROUP BY
        EXTRACT(HOUR FROM b.finalized_at AT TIME ZONE v_tz),
        EXTRACT(ISODOW FROM b.finalized_at AT TIME ZONE v_tz)
    ORDER BY day_of_week, hour_of_day;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
