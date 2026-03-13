-- ============================================================
-- Enhanced Report Functions
-- ============================================================
-- Creates three new reporting functions:
--   1. get_revenue_by_payment_method() — revenue grouped by cash/card/transfer
--   2. get_revenue_by_category()       — revenue grouped by menu category
--   3. get_peak_hours()                — order count & revenue by hour × day_of_week
--
-- All functions:
--   - Filter by bill.status IN ('finalized', 'printed')
--   - Use the outlet's configured timezone for date grouping
--   - Exclude cancelled orders entirely
--
-- Dependencies:
--   - 001_initial_schema.sql (tables, enums)
--   - 019_create_report_functions.sql (existing report functions)
--
-- Requirements: 3.3, 4.5
-- ============================================================

BEGIN;

-- ============================================================
-- 1. get_revenue_by_payment_method
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
      AND b.status IN ('finalized', 'printed')
    GROUP BY b.payment_method
    ORDER BY total DESC;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_revenue_by_payment_method(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
    'Revenue breakdown by payment method (cash, card, transfer). '
    'Only includes finalized/printed bills within the date range. '
    'Requirements: 3.3, 4.5.';

-- ============================================================
-- 2. get_revenue_by_category
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
      AND b.status IN ('finalized', 'printed')
    GROUP BY c.id, c.name
    ORDER BY total DESC;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_revenue_by_category(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
    'Revenue breakdown by menu category. '
    'Items without a category grouped as "Không phân loại". '
    'Only includes finalized/printed bills. Requirements: 3.3, 4.5.';

-- ============================================================
-- 3. get_peak_hours
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
    -- Fetch the outlet's timezone for correct local-time grouping
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
      AND b.status IN ('finalized', 'printed')
    GROUP BY
        EXTRACT(HOUR FROM b.finalized_at AT TIME ZONE v_tz),
        EXTRACT(ISODOW FROM b.finalized_at AT TIME ZONE v_tz)
    ORDER BY day_of_week, hour_of_day;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_peak_hours(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
    'Returns order count and revenue by hour_of_day (0-23) and day_of_week (1=Mon, 7=Sun). '
    'Uses outlet timezone (ISODOW for ISO day numbering). '
    'Designed for rendering a 7×24 heatmap. Requirements: 3.3, 4.5.';

COMMIT;
