-- 005_realtime_config.sql
-- Enable Supabase Realtime for high-frequency tables.
--
-- Subscribed tables and their events:
--   tables      -> UPDATE (status changes, map position drag-and-drop)
--   orders      -> INSERT, UPDATE (new orders, status transitions)
--   order_items -> INSERT, UPDATE, DELETE (live order detail edits)
--   bills       -> INSERT, UPDATE (bill creation, print status)
--   inventory   -> UPDATE (low-stock alerts, real-time stock levels)
--
-- Static/low-frequency tables are intentionally excluded:
--   outlets, users, categories, menu_items, ingredients, recipes, printers, audit_logs

ALTER PUBLICATION supabase_realtime ADD TABLE tables, orders, order_items, bills, inventory;
