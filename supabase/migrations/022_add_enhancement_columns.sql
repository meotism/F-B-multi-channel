-- ============================================================
-- Enhancement Columns on Existing Tables
-- ============================================================
-- Adds new columns to support:
--   - Order-level notes and guest tracking (orders)
--   - Order cancellation reason (orders)
--   - Discount references (orders, order_items)
--   - Split bill support (bills) — removes UNIQUE on order_id
--   - Discount amount tracking (bills)
--   - Menu item availability and sort order (menu_items)
--   - User soft-delete and login tracking (users)
--
-- Discount FK constraints are added in 023_create_new_tables.sql
-- after the discounts table is created.
--
-- Dependencies:
--   - 001_initial_schema.sql (table definitions)
--
-- Requirements: 3.1, 3.4, 3.5, 3.6, 3.7, 3.10, 4.2
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ORDERS: note, guest_count, cancellation_reason, discount_id
-- ============================================================

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS guest_count INTEGER DEFAULT 0 CHECK (guest_count >= 0),
    ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
    ADD COLUMN IF NOT EXISTS discount_id UUID;

COMMENT ON COLUMN orders.note IS 'General order-level note (e.g., "birthday table"). Requirement 3.1.';
COMMENT ON COLUMN orders.guest_count IS 'Number of guests at the table for this order. Requirement 3.6.';
COMMENT ON COLUMN orders.cancellation_reason IS 'Reason for cancellation, required when manager cancels served order. Requirement 4.2.';
COMMENT ON COLUMN orders.discount_id IS 'FK to discounts table (constraint added in 023). Requirement 3.10.';

-- ============================================================
-- 2. ORDER_ITEMS: discount_id
-- ============================================================

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS discount_id UUID;

COMMENT ON COLUMN order_items.discount_id IS 'FK to discounts table for item-level discounts (constraint added in 023). Requirement 3.10.';

-- ============================================================
-- 3. BILLS: discount_amount, split_type, parent_bill_id
--    Also removes UNIQUE constraint on order_id to allow split bills.
-- ============================================================

-- Remove the UNIQUE constraint on order_id to allow multiple bills per order (split bills).
-- The original constraint was: order_id UUID NOT NULL UNIQUE REFERENCES orders(id)
-- We keep the NOT NULL and FK, just drop UNIQUE.
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_order_id_key;

ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(12,0) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    ADD COLUMN IF NOT EXISTS split_type TEXT NOT NULL DEFAULT 'full' CHECK (split_type IN ('full', 'by_item', 'equal')),
    ADD COLUMN IF NOT EXISTS parent_bill_id UUID REFERENCES bills(id) ON DELETE SET NULL;

COMMENT ON COLUMN bills.discount_amount IS 'Total discount deducted from bill. Requirement 3.10.';
COMMENT ON COLUMN bills.split_type IS 'How the bill was generated: full (single bill), by_item (item-based split), equal (equal division). Requirement 3.4.';
COMMENT ON COLUMN bills.parent_bill_id IS 'Self-reference for split bills: points to the conceptual parent. NULL for non-split or parent bills. Requirement 3.4.';

-- Index for split bill lookups
CREATE INDEX IF NOT EXISTS idx_bills_parent_bill_id ON bills(parent_bill_id) WHERE parent_bill_id IS NOT NULL;

-- ============================================================
-- 4. MENU_ITEMS: is_available, sort_order
-- ============================================================

ALTER TABLE menu_items
    ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN menu_items.is_available IS 'Auto-managed by inventory trigger: false when any required ingredient is depleted. Distinct from is_active (manual toggle). Requirement 4.6.';
COMMENT ON COLUMN menu_items.sort_order IS 'Display order within category for drag-and-drop reordering. Requirement 3.5.';

-- Index for availability filtering
CREATE INDEX IF NOT EXISTS idx_menu_items_outlet_available ON menu_items(outlet_id, is_available);

-- ============================================================
-- 5. USERS: is_active, last_login_at
-- ============================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

COMMENT ON COLUMN users.is_active IS 'Soft-delete flag. Inactive users cannot log in. Requirement 3.7.';
COMMENT ON COLUMN users.last_login_at IS 'Timestamp of most recent successful login. Requirement 3.7.';

-- Index for active user filtering
CREATE INDEX IF NOT EXISTS idx_users_outlet_active ON users(outlet_id, is_active);

COMMIT;
