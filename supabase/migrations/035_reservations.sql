-- ============================================================
-- Reservation / Đặt hẹn feature
-- Migration 035
-- Date: 2026-03-31
--
-- Creates:
--   1. reservation_status enum
--   2. settings JSONB column on outlets
--   3. reservations table with indexes, RLS, trigger
--   4. scheduled_tasks table for enqueue-at expiry pattern
--   5. RPC functions: process_due_tasks, enqueue_reservation_expiry, cancel_scheduled_task
--   6. Realtime publication for reservations
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ENUM: reservation_status
-- ============================================================

CREATE TYPE reservation_status AS ENUM (
    'pending',
    'active',
    'expired',
    'cancelled',
    'completed'
);

-- ============================================================
-- 2. Add settings JSONB to outlets (for reservation_timeout_minutes etc.)
-- ============================================================

ALTER TABLE outlets
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN outlets.settings IS 'Outlet-level settings JSON. Keys: reservation_timeout_minutes (default 10).';

-- ============================================================
-- 3. reservations table
-- ============================================================

CREATE TABLE reservations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id        UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    outlet_id       UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    customer_name   VARCHAR(255) NOT NULL,
    customer_phone  VARCHAR(20),
    party_size      INTEGER NOT NULL CHECK (party_size > 0),
    reserved_at     TIMESTAMPTZ NOT NULL,
    status          reservation_status NOT NULL DEFAULT 'pending',
    notes           TEXT,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE reservations IS 'Table reservations / đặt hẹn. Supports advance booking (days/months ahead). Status lifecycle: pending → active → completed, or pending → expired/cancelled.';

-- Indexes
CREATE INDEX idx_reservations_outlet_id     ON reservations(outlet_id);
CREATE INDEX idx_reservations_table_id      ON reservations(table_id);
CREATE INDEX idx_reservations_outlet_status ON reservations(outlet_id, status);
CREATE INDEX idx_reservations_reserved_at   ON reservations(reserved_at);

-- Prevent double-booking: one pending/active reservation per table at a time
CREATE UNIQUE INDEX idx_reservations_active_per_table
    ON reservations(table_id)
    WHERE status IN ('pending', 'active');

-- Reuse existing updated_at trigger function (defined in 001_initial_schema.sql)
CREATE TRIGGER trg_reservations_updated_at
    BEFORE UPDATE ON reservations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 3a. RLS for reservations
-- ============================================================

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

-- All operational roles can view reservations for their outlet
CREATE POLICY reservations_select ON reservations
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'staff', 'cashier')
    );

-- Owner, manager, staff, cashier can create reservations
CREATE POLICY reservations_insert ON reservations
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'staff', 'cashier')
    );

-- Owner, manager, cashier can update (confirm arrival, cancel)
CREATE POLICY reservations_update ON reservations
    FOR UPDATE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'cashier')
    )
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'cashier')
    );

-- Owner, manager can delete
CREATE POLICY reservations_delete ON reservations
    FOR DELETE
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager')
    );

-- ============================================================
-- 4. scheduled_tasks table (enqueue-at pattern)
-- ============================================================

CREATE TABLE scheduled_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id       UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    task_type       VARCHAR(50) NOT NULL,
    reference_id    UUID NOT NULL,
    schedule_for    TIMESTAMPTZ NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE scheduled_tasks IS 'Enqueue-at task queue. Tasks are picked up by Vercel Cron calling process_due_tasks() RPC. No RLS — accessed only via SECURITY DEFINER functions.';

-- Efficient lookup for due tasks
CREATE INDEX idx_scheduled_tasks_due
    ON scheduled_tasks(schedule_for)
    WHERE status = 'pending';

-- Lookup by reference (to cancel tasks when reservation is confirmed/cancelled)
CREATE INDEX idx_scheduled_tasks_reference
    ON scheduled_tasks(reference_id)
    WHERE status = 'pending';

-- ============================================================
-- 5. RPC Functions
-- ============================================================

-- 5a. process_due_tasks: called by Vercel Cron every minute
--     Picks up all pending tasks where schedule_for <= now(),
--     processes them (expire reservations), and marks completed.
--     Uses FOR UPDATE SKIP LOCKED for safe concurrent execution.

CREATE OR REPLACE FUNCTION process_due_tasks()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    task_row RECORD;
    processed_count INTEGER := 0;
BEGIN
    FOR task_row IN
        SELECT id, task_type, reference_id, outlet_id
        FROM scheduled_tasks
        WHERE status = 'pending'
          AND schedule_for <= now()
        ORDER BY schedule_for ASC
        FOR UPDATE SKIP LOCKED
    LOOP
        IF task_row.task_type = 'expire_reservation' THEN
            -- Only expire if reservation is still pending
            UPDATE reservations
            SET status = 'expired', updated_at = now()
            WHERE id = task_row.reference_id
              AND status = 'pending';
        END IF;

        -- Mark task as completed regardless (idempotent)
        UPDATE scheduled_tasks
        SET status = 'completed'
        WHERE id = task_row.id;

        processed_count := processed_count + 1;
    END LOOP;

    RETURN processed_count;
END;
$$;

COMMENT ON FUNCTION process_due_tasks() IS 'Process all due scheduled tasks. Called by Vercel Cron every minute. Uses SKIP LOCKED for concurrency safety.';

-- 5b. enqueue_reservation_expiry: called when creating a reservation

CREATE OR REPLACE FUNCTION enqueue_reservation_expiry(
    p_reservation_id UUID,
    p_outlet_id UUID,
    p_schedule_for TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    task_id UUID;
BEGIN
    INSERT INTO scheduled_tasks (outlet_id, task_type, reference_id, schedule_for)
    VALUES (p_outlet_id, 'expire_reservation', p_reservation_id, p_schedule_for)
    RETURNING id INTO task_id;

    RETURN task_id;
END;
$$;

COMMENT ON FUNCTION enqueue_reservation_expiry(UUID, UUID, TIMESTAMPTZ) IS 'Enqueue an expiry task for a reservation at a specific time.';

-- 5c. cancel_scheduled_task: called when confirming arrival or cancelling reservation

CREATE OR REPLACE FUNCTION cancel_scheduled_task(p_reference_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    cancelled_count INTEGER;
BEGIN
    UPDATE scheduled_tasks
    SET status = 'cancelled'
    WHERE reference_id = p_reference_id
      AND status = 'pending';

    GET DIAGNOSTICS cancelled_count = ROW_COUNT;
    RETURN cancelled_count;
END;
$$;

COMMENT ON FUNCTION cancel_scheduled_task(UUID) IS 'Cancel pending scheduled tasks for a given reference (reservation). Called on confirm arrival or cancel reservation.';

-- ============================================================
-- 6. Enable Realtime for reservations
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE reservations;

COMMIT;
