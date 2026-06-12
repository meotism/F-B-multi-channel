-- ============================================================
-- Allow deleting users without losing order history
-- Migration 040
--
-- orders.user_id was NOT NULL + ON DELETE RESTRICT, which blocked
-- deleting any staff member who had ever created an order
-- (orders_user_id_fkey violation). Switch to ON DELETE SET NULL
-- so deleting a user preserves their orders (user_id becomes NULL)
-- instead of blocking the delete. Column must become nullable for
-- SET NULL to work.
-- ============================================================

BEGIN;

-- 1. Drop the existing RESTRICT foreign key
ALTER TABLE orders
  DROP CONSTRAINT orders_user_id_fkey;

-- 2. Allow NULL (required so SET NULL can write NULL on delete)
ALTER TABLE orders
  ALTER COLUMN user_id DROP NOT NULL;

-- 3. Re-add the FK with SET NULL behavior
ALTER TABLE orders
  ADD CONSTRAINT orders_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
