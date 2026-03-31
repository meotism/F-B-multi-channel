-- ============================================================
-- Reservation Duration + Prepaid + Overlap Prevention
-- Migration 036
-- Date: 2026-03-31
--
-- Adds:
--   1. duration_hours column (0.5 - 24)
--   2. prepaid boolean column
--   3. Computed end_at column
--   4. Drops old unique index (1 reservation per table)
--   5. Overlap prevention trigger (multiple reservations per table OK if no time overlap)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Add duration_hours and prepaid columns
-- ============================================================

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS duration_hours NUMERIC(4,1) NOT NULL DEFAULT 1
    CHECK (duration_hours >= 0.5 AND duration_hours <= 24);

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS prepaid BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 2. Add end_at column (maintained by trigger, not generated)
-- ============================================================

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;

-- Backfill existing rows
UPDATE reservations SET end_at = reserved_at + (duration_hours * interval '1 hour');

-- Make NOT NULL after backfill
ALTER TABLE reservations ALTER COLUMN end_at SET NOT NULL;

-- Trigger to auto-compute end_at on INSERT/UPDATE
CREATE OR REPLACE FUNCTION compute_reservation_end_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.end_at := NEW.reserved_at + (NEW.duration_hours * interval '1 hour');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_compute_reservation_end_at
  BEFORE INSERT OR UPDATE OF reserved_at, duration_hours ON reservations
  FOR EACH ROW EXECUTE FUNCTION compute_reservation_end_at();

-- Index for end_at queries (loading today's reservations by time range)
CREATE INDEX IF NOT EXISTS idx_reservations_end_at ON reservations(end_at);

-- ============================================================
-- 3. Drop old unique index (was: 1 pending/active per table)
-- ============================================================

DROP INDEX IF EXISTS idx_reservations_active_per_table;

-- ============================================================
-- 4. Overlap prevention trigger
-- ============================================================

CREATE OR REPLACE FUNCTION check_reservation_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  overlap_count INTEGER;
  new_end_at TIMESTAMPTZ;
BEGIN
  -- Compute end_at for the new/updated row
  new_end_at := NEW.reserved_at + make_interval(secs => (NEW.duration_hours * 3600)::int);

  -- Check for overlapping pending/active reservations on the same table
  SELECT COUNT(*) INTO overlap_count
  FROM reservations
  WHERE table_id = NEW.table_id
    AND id != NEW.id
    AND status IN ('pending', 'active')
    AND reserved_at < new_end_at
    AND (reserved_at + make_interval(secs => (duration_hours * 3600)::int)) > NEW.reserved_at;

  IF overlap_count > 0 THEN
    RAISE EXCEPTION 'Bàn đã có đặt hẹn trong khoảng thời gian này. Vui lòng chọn thời gian khác.'
      USING ERRCODE = '23505'; -- unique_violation code for consistent frontend handling
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_check_reservation_overlap
  BEFORE INSERT OR UPDATE ON reservations
  FOR EACH ROW
  WHEN (NEW.status IN ('pending', 'active'))
  EXECUTE FUNCTION check_reservation_overlap();

COMMENT ON FUNCTION check_reservation_overlap() IS 'Prevents overlapping time ranges for pending/active reservations on the same table.';

COMMIT;
