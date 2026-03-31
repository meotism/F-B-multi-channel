-- ============================================================
-- Link orders to reservations
-- Migration 038
--
-- Adds reservation_id FK on orders table so prepaid reservations
-- can auto-create an order and maintain the link.
-- ============================================================

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_reservation_id ON orders(reservation_id)
  WHERE reservation_id IS NOT NULL;

COMMIT;
