-- ============================================================
-- Fix reservation triggers: merge end_at computation + overlap check
-- into a single trigger to guarantee execution order and use
-- consistent formula throughout.
-- Migration 037
-- ============================================================

BEGIN;

-- Drop old separate triggers
DROP TRIGGER IF EXISTS trg_compute_reservation_end_at ON reservations;
DROP TRIGGER IF EXISTS trg_check_reservation_overlap ON reservations;
DROP FUNCTION IF EXISTS compute_reservation_end_at();
DROP FUNCTION IF EXISTS check_reservation_overlap();

-- Single merged trigger function: compute end_at THEN check overlap
CREATE OR REPLACE FUNCTION reservation_before_upsert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  overlap_count INTEGER;
BEGIN
  -- 1. Compute end_at (consistent formula: duration_hours * 1 hour interval)
  NEW.end_at := NEW.reserved_at + (NEW.duration_hours * interval '1 hour');

  -- 2. Check overlap only for pending/active reservations
  IF NEW.status IN ('pending', 'active') THEN
    SELECT COUNT(*) INTO overlap_count
    FROM reservations
    WHERE table_id = NEW.table_id
      AND id != NEW.id
      AND status IN ('pending', 'active')
      AND reserved_at < NEW.end_at
      AND end_at > NEW.reserved_at;

    IF overlap_count > 0 THEN
      RAISE EXCEPTION 'Bàn đã có đặt hẹn trong khoảng thời gian này. Vui lòng chọn thời gian khác.'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reservation_before_upsert
  BEFORE INSERT OR UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservation_before_upsert();

COMMENT ON FUNCTION reservation_before_upsert() IS 'Merged trigger: computes end_at from reserved_at + duration_hours, then checks for overlapping pending/active reservations on the same table.';

COMMIT;
