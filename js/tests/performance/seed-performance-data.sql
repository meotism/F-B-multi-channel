-- ============================================================
-- Seed 10,000 bills for performance testing
-- ============================================================
-- Creates test data across all required tables (outlet, user,
-- tables, categories, menu items, orders, order items, bills)
-- to validate NFR 6.1.4: report queries < 3 seconds for
-- datasets under 10,000 bills.
--
-- Prerequisites:
--   - Supabase local instance running (supabase start)
--   - All migrations applied (001_initial_schema.sql, etc.)
--   - A valid auth.users entry (created below via raw insert)
--
-- Run:
--   psql <local-db-url> -f js/tests/performance/seed-performance-data.sql
--
-- After seeding, note the outlet_id printed at the end and
-- pass it as TEST_OUTLET_ID when running performance tests.
--
-- Requirements: 5.7.4, NFR 6.1.4
-- Design reference: Section 9.5 Report Query < 3s Validation
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_outlet_id UUID;
  v_auth_user_id UUID;
  v_user_id UUID;
  v_table_id UUID;
  v_category_ids UUID[];
  v_menu_item_ids UUID[];
  v_order_id UUID;
  v_bill_id UUID;
  v_i INTEGER;
  v_j INTEGER;
  v_num_items INTEGER;
  v_menu_item_idx INTEGER;
  v_item_price DECIMAL(12,0);
  v_item_qty INTEGER;
  v_order_total DECIMAL(12,0);
  v_order_tax DECIMAL(12,0);
  v_finalized_at TIMESTAMPTZ;
  v_payment_methods TEXT[] := ARRAY['cash', 'card', 'transfer'];
  v_bill_statuses TEXT[] := ARRAY['finalized', 'printed'];
  v_rand_payment TEXT;
  v_rand_status TEXT;
  v_prices DECIMAL(12,0)[] := ARRAY[25000, 35000, 45000, 55000, 65000,
                                     75000, 85000, 95000, 120000, 150000];
BEGIN
  -- ==========================================================
  -- 1. Create test outlet
  -- ==========================================================
  INSERT INTO outlets (name, address, timezone)
  VALUES ('Perf Test Outlet', '123 Performance St', 'Asia/Ho_Chi_Minh')
  RETURNING id INTO v_outlet_id;

  RAISE NOTICE 'Created outlet: %', v_outlet_id;

  -- ==========================================================
  -- 2. Create test auth user and application user
  -- ==========================================================
  -- Insert a minimal auth.users record for FK satisfaction.
  -- Local Supabase allows direct inserts to auth.users.
  v_auth_user_id := gen_random_uuid();

  INSERT INTO auth.users (
    id,
    instance_id,
    email,
    encrypted_password,
    email_confirmed_at,
    aud,
    role,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    recovery_token
  ) VALUES (
    v_auth_user_id,
    '00000000-0000-0000-0000-000000000000',
    'perftest@example.com',
    crypt('perftest123', gen_salt('bf')),
    now(),
    'authenticated',
    'authenticated',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Perf Tester"}'::jsonb,
    now(),
    now(),
    '',
    ''
  );

  INSERT INTO users (id, name, email, role, outlet_id)
  VALUES (v_auth_user_id, 'Perf Tester', 'perftest@example.com', 'manager', v_outlet_id)
  RETURNING id INTO v_user_id;

  RAISE NOTICE 'Created user: %', v_user_id;

  -- ==========================================================
  -- 3. Create test table
  -- ==========================================================
  INSERT INTO tables (outlet_id, name, table_code, capacity, shape, status, x, y)
  VALUES (v_outlet_id, 'Perf Table 1', 'PT-01', 4, 'square', 'empty', 100, 100)
  RETURNING id INTO v_table_id;

  -- ==========================================================
  -- 4. Create test categories
  -- ==========================================================
  v_category_ids := ARRAY[]::UUID[];

  INSERT INTO categories (outlet_id, name, sort_order) VALUES
    (v_outlet_id, 'Appetizers', 1) RETURNING id INTO v_category_ids[1];
  INSERT INTO categories (outlet_id, name, sort_order) VALUES
    (v_outlet_id, 'Main Course', 2) RETURNING id INTO v_category_ids[2];
  INSERT INTO categories (outlet_id, name, sort_order) VALUES
    (v_outlet_id, 'Drinks', 3) RETURNING id INTO v_category_ids[3];
  INSERT INTO categories (outlet_id, name, sort_order) VALUES
    (v_outlet_id, 'Desserts', 4) RETURNING id INTO v_category_ids[4];

  -- ==========================================================
  -- 5. Create 10 test menu items across categories
  -- ==========================================================
  v_menu_item_ids := ARRAY[]::UUID[];

  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Spring Rolls', 25000, v_category_ids[1]) RETURNING id INTO v_menu_item_ids[1];
  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Crispy Tofu', 35000, v_category_ids[1]) RETURNING id INTO v_menu_item_ids[2];
  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Pho Bo', 45000, v_category_ids[2]) RETURNING id INTO v_menu_item_ids[3];
  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Bun Cha', 55000, v_category_ids[2]) RETURNING id INTO v_menu_item_ids[4];
  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Com Rang', 65000, v_category_ids[2]) RETURNING id INTO v_menu_item_ids[5];
  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Ca Phe Sua Da', 75000, v_category_ids[3]) RETURNING id INTO v_menu_item_ids[6];
  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Tra Dao', 85000, v_category_ids[3]) RETURNING id INTO v_menu_item_ids[7];
  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Nuoc Mia', 95000, v_category_ids[3]) RETURNING id INTO v_menu_item_ids[8];
  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Che Bap', 120000, v_category_ids[4]) RETURNING id INTO v_menu_item_ids[9];
  INSERT INTO menu_items (outlet_id, name, price, category_id) VALUES
    (v_outlet_id, 'Banh Flan', 150000, v_category_ids[4]) RETURNING id INTO v_menu_item_ids[10];

  -- ==========================================================
  -- 6. Generate 10,000 orders with order items and bills
  -- ==========================================================
  -- Each iteration creates:
  --   - 1 order (status: finalized)
  --   - 2-5 random order items
  --   - 1 bill (status: finalized or printed)
  --   - finalized_at spread across the last 365 days

  FOR v_i IN 1..10000 LOOP
    -- Random finalized_at within the last 365 days
    v_finalized_at := now() - (random() * 365 * INTERVAL '1 day');

    -- Create order
    INSERT INTO orders (table_id, outlet_id, user_id, status, started_at, ended_at)
    VALUES (
      v_table_id,
      v_outlet_id,
      v_user_id,
      'finalized',
      v_finalized_at - INTERVAL '30 minutes',
      v_finalized_at
    )
    RETURNING id INTO v_order_id;

    -- Random number of items (2-5)
    v_num_items := 2 + floor(random() * 4)::INTEGER;
    v_order_total := 0;

    FOR v_j IN 1..v_num_items LOOP
      -- Pick a random menu item (index 1-10)
      v_menu_item_idx := 1 + floor(random() * 10)::INTEGER;
      IF v_menu_item_idx > 10 THEN v_menu_item_idx := 10; END IF;

      -- Random quantity (1-4)
      v_item_qty := 1 + floor(random() * 4)::INTEGER;
      v_item_price := v_prices[v_menu_item_idx];

      INSERT INTO order_items (order_id, menu_item_id, qty, price)
      VALUES (
        v_order_id,
        v_menu_item_ids[v_menu_item_idx],
        v_item_qty,
        v_item_price
      );

      v_order_total := v_order_total + (v_item_price * v_item_qty);
    END LOOP;

    -- Calculate 10% tax
    v_order_tax := round(v_order_total * 0.1);

    -- Random payment method
    v_rand_payment := v_payment_methods[1 + floor(random() * 3)::INTEGER];

    -- Random bill status (finalized or printed)
    v_rand_status := v_bill_statuses[1 + floor(random() * 2)::INTEGER];

    -- Create bill
    INSERT INTO bills (order_id, outlet_id, total, tax, payment_method, status, finalized_at)
    VALUES (
      v_order_id,
      v_outlet_id,
      v_order_total,
      v_order_tax,
      v_rand_payment::payment_method,
      v_rand_status::bill_status,
      v_finalized_at
    );

    -- Progress indicator every 1,000 rows
    IF v_i % 1000 = 0 THEN
      RAISE NOTICE 'Seeded % / 10,000 bills', v_i;
    END IF;
  END LOOP;

  -- ==========================================================
  -- 7. Print summary
  -- ==========================================================
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Performance seed complete.';
  RAISE NOTICE 'Outlet ID: %', v_outlet_id;
  RAISE NOTICE 'User ID:   %', v_user_id;
  RAISE NOTICE 'Table ID:  %', v_table_id;
  RAISE NOTICE 'Bills:     10,000';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Run tests with:';
  RAISE NOTICE '  TEST_OUTLET_ID=% node js/tests/performance/report-performance.test.js', v_outlet_id;
END $$;

COMMIT;
