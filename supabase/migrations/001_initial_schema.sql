-- ============================================================
-- F&B Multi-Platform Management Application
-- Full Database Schema Migration
-- Version: 1.0
-- Date: 2026-03-11
-- Target: Supabase (PostgreSQL 15+)
--
-- Creates all enum types, tables, indexes, trigger functions,
-- triggers, and table comments for the complete application
-- schema. Tables are ordered by FK dependency.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ENUM TYPES
-- ============================================================

CREATE TYPE user_role AS ENUM (
    'owner',
    'manager',
    'staff',
    'cashier',
    'warehouse'
);

CREATE TYPE table_status AS ENUM (
    'empty',
    'serving',
    'awaiting_payment',
    'paid'
);

CREATE TYPE table_shape AS ENUM (
    'square',
    'round',
    'rectangle'
);

CREATE TYPE order_status AS ENUM (
    'active',
    'completed',
    'finalized',
    'cancelled'
);

CREATE TYPE bill_status AS ENUM (
    'draft',
    'finalized',
    'printed',
    'pending_print'
);

CREATE TYPE payment_method AS ENUM (
    'cash',
    'card',
    'transfer'
);

-- ============================================================
-- 2. TRIGGER FUNCTION: auto-update updated_at on row modification
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. TABLES (in dependency order)
-- ============================================================

-- 3a. outlets (no FK dependencies)
CREATE TABLE outlets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255) NOT NULL,
    address     TEXT,
    timezone    VARCHAR(50) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE outlets IS 'Restaurant outlets/branches. Each outlet is an isolated data silo.';

-- 3b. users (depends on: outlets, auth.users)
CREATE TABLE users (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    email       VARCHAR(255) NOT NULL UNIQUE,
    role        user_role NOT NULL,
    outlet_id   UUID REFERENCES outlets(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE users IS 'Application users linked to Supabase Auth. Each user belongs to one outlet.';

-- 3c. tables (depends on: outlets)
CREATE TABLE tables (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    table_code  VARCHAR(20),
    capacity    INTEGER NOT NULL CHECK (capacity > 0),
    shape       table_shape NOT NULL DEFAULT 'square',
    status      table_status NOT NULL DEFAULT 'empty',
    x           DOUBLE PRECISION NOT NULL DEFAULT 0,
    y           DOUBLE PRECISION NOT NULL DEFAULT 0,
    rotation    DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tables IS 'Physical tables in the restaurant. Position (x,y,rotation) used for drag-and-drop map. Layout changes restricted to Manager role via protect_table_layout trigger.';

-- 3d. categories (depends on: outlets)
CREATE TABLE categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE categories IS 'Menu item categories per outlet. sort_order controls display ordering.';

-- 3e. menu_items (depends on: outlets, categories)
CREATE TABLE menu_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    price       DECIMAL(12,0) NOT NULL CHECK (price >= 0),
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE menu_items IS 'Menu items with VND pricing (no decimals). price captured at order time in order_items.';

-- 3f. ingredients (depends on: outlets)
CREATE TABLE ingredients (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    unit        VARCHAR(50) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ingredients IS 'Raw ingredients tracked for inventory management. unit = g, ml, pcs, etc.';

-- 3g. recipes (depends on: menu_items, ingredients)
CREATE TABLE recipes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    ingredient_id   UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    qty             DECIMAL(10,3) NOT NULL CHECK (qty > 0),
    CONSTRAINT uq_recipe_item_ingredient UNIQUE (menu_item_id, ingredient_id)
);

COMMENT ON TABLE recipes IS 'Recipe mapping: qty of each ingredient consumed per 1 unit of a menu item.';

-- 3h. inventory (depends on: outlets, ingredients)
CREATE TABLE inventory (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id       UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    ingredient_id   UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    qty_on_hand     DECIMAL(12,3) NOT NULL DEFAULT 0,
    threshold       DECIMAL(12,3) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventory_outlet_ingredient UNIQUE (outlet_id, ingredient_id)
);

COMMENT ON TABLE inventory IS 'Current stock levels. threshold triggers low-stock alerts. All qty_on_hand changes are automatically audit-logged via trg_audit_inventory_change.';

-- 3i. orders (depends on: tables, outlets, users)
CREATE TABLE orders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id    UUID NOT NULL REFERENCES tables(id) ON DELETE RESTRICT,
    outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status      order_status NOT NULL DEFAULT 'active',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE orders IS 'Orders linked to tables. outlet_id denormalized for RLS and reporting efficiency.';

-- 3j. order_items (depends on: orders, menu_items)
CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
    qty             INTEGER NOT NULL CHECK (qty > 0),
    price           DECIMAL(12,0) NOT NULL CHECK (price >= 0),
    note            TEXT CHECK (char_length(note) <= 1000),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE order_items IS 'Line items in an order. price is captured at order time (snapshot, not FK to current price).';

-- 3k. bills (depends on: orders, outlets)
CREATE TABLE bills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
    outlet_id       UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    total           DECIMAL(12,0) NOT NULL CHECK (total >= 0),
    tax             DECIMAL(12,0) NOT NULL DEFAULT 0 CHECK (tax >= 0),
    payment_method  payment_method NOT NULL DEFAULT 'cash',
    status          bill_status NOT NULL DEFAULT 'draft',
    finalized_at    TIMESTAMPTZ,
    printed_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE bills IS 'Bills are created at finalize time. UNIQUE on order_id enforces 1:1 with orders. The protect_finalized_bill trigger prevents modification of total, tax, order_id, and finalized_at after finalization.';

-- 3l. printers (depends on: outlets)
CREATE TABLE printers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    device_info JSONB,
    last_seen   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE printers IS 'Bluetooth thermal printers. device_info stores GATT service/characteristic UUIDs.';

-- 3m. audit_logs (depends on: outlets, users)
CREATE TABLE audit_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
    entity      VARCHAR(100) NOT NULL,
    entity_id   UUID,
    action      VARCHAR(100) NOT NULL,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
    details     JSONB
);

COMMENT ON TABLE audit_logs IS 'Immutable audit trail for bill finalization, inventory changes, user management. outlet_id enables direct RLS filtering without joining through user_id.';

-- ============================================================
-- 4. INDEXES
-- ============================================================

-- users
CREATE INDEX idx_users_outlet_id ON users(outlet_id);
CREATE INDEX idx_users_role ON users(role);

-- tables
CREATE INDEX idx_tables_outlet_id ON tables(outlet_id);
CREATE INDEX idx_tables_outlet_status ON tables(outlet_id, status);

-- categories
CREATE INDEX idx_categories_outlet_id ON categories(outlet_id);
CREATE INDEX idx_categories_outlet_active ON categories(outlet_id, is_active);

-- menu_items
CREATE INDEX idx_menu_items_outlet_id ON menu_items(outlet_id);
CREATE INDEX idx_menu_items_category_id ON menu_items(category_id);
CREATE INDEX idx_menu_items_outlet_active ON menu_items(outlet_id, is_active);

-- ingredients
CREATE INDEX idx_ingredients_outlet_id ON ingredients(outlet_id);

-- recipes
CREATE INDEX idx_recipes_menu_item_id ON recipes(menu_item_id);
CREATE INDEX idx_recipes_ingredient_id ON recipes(ingredient_id);

-- inventory
CREATE INDEX idx_inventory_outlet_id ON inventory(outlet_id);
CREATE INDEX idx_inventory_ingredient_id ON inventory(ingredient_id);
CREATE INDEX idx_inventory_outlet_ingredient ON inventory(outlet_id, ingredient_id);

-- orders
CREATE INDEX idx_orders_table_id ON orders(table_id);
CREATE INDEX idx_orders_outlet_id ON orders(outlet_id);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_table_status ON orders(table_id, status);
CREATE INDEX idx_orders_outlet_status ON orders(outlet_id, status);

-- order_items
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_menu_item_id ON order_items(menu_item_id);

-- bills
CREATE INDEX idx_bills_order_id ON bills(order_id);
CREATE INDEX idx_bills_outlet_id ON bills(outlet_id);
CREATE INDEX idx_bills_outlet_finalized ON bills(outlet_id, finalized_at);
CREATE INDEX idx_bills_outlet_status ON bills(outlet_id, status);

-- printers
CREATE INDEX idx_printers_outlet_id ON printers(outlet_id);

-- audit_logs
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_logs_outlet_id ON audit_logs(outlet_id);
CREATE INDEX idx_audit_logs_outlet_timestamp ON audit_logs(outlet_id, timestamp);

-- ============================================================
-- 5. UPDATED_AT TRIGGERS
-- ============================================================

CREATE TRIGGER trg_tables_updated_at
    BEFORE UPDATE ON tables
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_menu_items_updated_at
    BEFORE UPDATE ON menu_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_inventory_updated_at
    BEFORE UPDATE ON inventory
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_bills_updated_at
    BEFORE UPDATE ON bills
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 6. PROTECTION TRIGGERS (business rule enforcement)
-- ============================================================

-- Prevent modification of financial fields on finalized bills.
-- Only status, printed_at, and payment_method may be changed after finalization.
-- total, tax, order_id, and finalized_at are immutable once status != 'draft'.
CREATE OR REPLACE FUNCTION protect_finalized_bill()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('finalized', 'printed', 'pending_print') THEN
        IF NEW.total IS DISTINCT FROM OLD.total THEN
            RAISE EXCEPTION 'Cannot modify total on a finalized bill (status: %)', OLD.status;
        END IF;
        IF NEW.tax IS DISTINCT FROM OLD.tax THEN
            RAISE EXCEPTION 'Cannot modify tax on a finalized bill (status: %)', OLD.status;
        END IF;
        IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
            RAISE EXCEPTION 'Cannot modify order_id on a finalized bill (status: %)', OLD.status;
        END IF;
        IF NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
            RAISE EXCEPTION 'Cannot modify finalized_at on a finalized bill (status: %)', OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_finalized_bill
    BEFORE UPDATE ON bills
    FOR EACH ROW EXECUTE FUNCTION protect_finalized_bill();

-- Prevent Staff/Cashier from modifying table layout properties.
-- Staff and Cashier may only update the 'status' column on tables.
-- All layout changes (name, capacity, shape, x, y, rotation, table_code)
-- require Manager role.
-- SECURITY DEFINER is required to query the users table for role lookup.
CREATE OR REPLACE FUNCTION protect_table_layout()
RETURNS TRIGGER AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role::text INTO v_role FROM public.users WHERE id = auth.uid();

    IF v_role IN ('staff', 'cashier') THEN
        IF NEW.name IS DISTINCT FROM OLD.name THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table name';
        END IF;
        IF NEW.capacity IS DISTINCT FROM OLD.capacity THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table capacity';
        END IF;
        IF NEW.shape IS DISTINCT FROM OLD.shape THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table shape';
        END IF;
        IF NEW.x IS DISTINCT FROM OLD.x THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table position';
        END IF;
        IF NEW.y IS DISTINCT FROM OLD.y THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table position';
        END IF;
        IF NEW.rotation IS DISTINCT FROM OLD.rotation THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table rotation';
        END IF;
        IF NEW.table_code IS DISTINCT FROM OLD.table_code THEN
            RAISE EXCEPTION 'Staff/Cashier cannot modify table code';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_protect_table_layout
    BEFORE UPDATE ON tables
    FOR EACH ROW EXECUTE FUNCTION protect_table_layout();

-- Auto-create audit log when inventory qty_on_hand is updated.
-- This ensures NFR 6.3.4 compliance (audit logging for inventory changes)
-- even when updates bypass Edge Functions via direct PostgREST calls.
-- SECURITY DEFINER is required to insert into audit_logs and call auth.uid().
CREATE OR REPLACE FUNCTION audit_inventory_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.qty_on_hand IS DISTINCT FROM OLD.qty_on_hand THEN
        INSERT INTO audit_logs (outlet_id, entity, entity_id, action, user_id, details)
        VALUES (
            NEW.outlet_id,
            'inventory',
            NEW.id,
            'inventory_update',
            auth.uid(),
            jsonb_build_object(
                'ingredient_id', NEW.ingredient_id,
                'old_qty', OLD.qty_on_hand,
                'new_qty', NEW.qty_on_hand,
                'change', NEW.qty_on_hand - OLD.qty_on_hand
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_audit_inventory_change
    AFTER UPDATE ON inventory
    FOR EACH ROW EXECUTE FUNCTION audit_inventory_change();

COMMIT;
