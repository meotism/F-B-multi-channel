-- ============================================================
-- New Tables: discounts, stock_movements
-- ============================================================
-- Creates:
--   1. discount_type enum
--   2. discounts table — promotion/discount definitions
--   3. stock_movements table — inventory movement history
--   4. FK constraints on orders.discount_id and order_items.discount_id
--   5. RLS policies for both new tables
--
-- Dependencies:
--   - 001_initial_schema.sql (base tables)
--   - 022_add_enhancement_columns.sql (discount_id columns)
--
-- Requirements: 3.8, 3.10
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ENUM TYPE: discount_type
-- ============================================================

CREATE TYPE discount_type AS ENUM ('percent', 'fixed');

-- ============================================================
-- 2. TABLE: discounts
-- ============================================================

CREATE TABLE discounts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    type        discount_type NOT NULL,
    value       DECIMAL(12,2) NOT NULL CHECK (value > 0),
    scope       TEXT NOT NULL DEFAULT 'order' CHECK (scope IN ('order', 'item')),
    valid_from  TIMESTAMPTZ,
    valid_to    TIMESTAMPTZ,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_discount_validity CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to),
    CONSTRAINT chk_discount_percent CHECK (type != 'percent' OR (value > 0 AND value <= 100))
);

COMMENT ON TABLE discounts IS 'Promotion/discount definitions. type=percent caps at 100%. scope determines order-level or item-level application. Requirement 3.10.';

-- Indexes
CREATE INDEX idx_discounts_outlet_id ON discounts(outlet_id);
CREATE INDEX idx_discounts_outlet_active ON discounts(outlet_id, is_active);

-- Auto-update updated_at
CREATE TRIGGER trg_discounts_updated_at
    BEFORE UPDATE ON discounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 3. TABLE: stock_movements
-- ============================================================

CREATE TABLE stock_movements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id       UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    ingredient_id   UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    qty             DECIMAL(12,3) NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('in', 'out', 'adjustment')),
    note            TEXT,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE stock_movements IS 'Inventory movement history: stock-in (receiving), stock-out (order deduction), adjustments. Requirement 3.8.';

-- Indexes
CREATE INDEX idx_stock_movements_outlet_id ON stock_movements(outlet_id);
CREATE INDEX idx_stock_movements_ingredient_id ON stock_movements(ingredient_id);
CREATE INDEX idx_stock_movements_outlet_ingredient ON stock_movements(outlet_id, ingredient_id);
CREATE INDEX idx_stock_movements_created_at ON stock_movements(created_at);

-- ============================================================
-- 4. FK CONSTRAINTS for discount_id columns (deferred from 022)
-- ============================================================

ALTER TABLE orders
    ADD CONSTRAINT fk_orders_discount
    FOREIGN KEY (discount_id) REFERENCES discounts(id) ON DELETE SET NULL;

ALTER TABLE order_items
    ADD CONSTRAINT fk_order_items_discount
    FOREIGN KEY (discount_id) REFERENCES discounts(id) ON DELETE SET NULL;

-- ============================================================
-- 5. RLS POLICIES: discounts
-- Viewable by: Owner, Manager, Staff, Cashier (needed for order creation)
-- Editable by: Owner, Manager
-- ============================================================

ALTER TABLE discounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY discounts_select ON discounts
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'staff', 'cashier')
    );

CREATE POLICY discounts_insert ON discounts
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager')
    );

CREATE POLICY discounts_update ON discounts
    FOR UPDATE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('owner', 'manager'))
    WITH CHECK (outlet_id = public.user_outlet_id() AND public.user_role() IN ('owner', 'manager'));

CREATE POLICY discounts_delete ON discounts
    FOR DELETE
    USING (outlet_id = public.user_outlet_id() AND public.user_role() IN ('owner', 'manager'));

-- ============================================================
-- 6. RLS POLICIES: stock_movements
-- Viewable by: Owner, Manager, Warehouse
-- Insertable by: Owner, Manager, Warehouse
-- No UPDATE/DELETE: movement records are immutable
-- ============================================================

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY stock_movements_select ON stock_movements
    FOR SELECT
    USING (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'warehouse')
    );

CREATE POLICY stock_movements_insert ON stock_movements
    FOR INSERT
    WITH CHECK (
        outlet_id = public.user_outlet_id()
        AND public.user_role() IN ('owner', 'manager', 'warehouse')
    );

-- No UPDATE or DELETE policies: stock movements are immutable audit records

COMMIT;
