-- Runs on every boot, so every statement must be safe to repeat.

CREATE TABLE IF NOT EXISTS orders (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          text NOT NULL DEFAULT 'user123',
  billing_address  text NOT NULL,
  shipping_address text NOT NULL,
  total_price      numeric(10,2),
  status           text NOT NULL DEFAULT 'Pending'
                   CHECK (status IN ('Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  -- Lives in the products service's database, so there's no foreign key.
  product_id integer,
  name       text,
  price      numeric(10,2),
  quantity   integer
);

CREATE INDEX IF NOT EXISTS order_items_order_id_idx   ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON order_items (product_id);

-- Project 1, phase 3: the reservation behind each order. The sweeper uses it
-- to tell stock that an order owns from stock that nobody will ever buy.
-- Unique, so one reservation can never pay for two orders.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_id text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_reservation_id_key ON orders (reservation_id);
-- The sweeper's "Pending for too long" scan, and a shopper's order list.
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders (status, created_at);
CREATE INDEX IF NOT EXISTS orders_user_id_created_idx ON orders (user_id, created_at DESC);

-- What the confirmation job "emails": a simulated inbox, shown on the sale
-- page. One row per order and kind, so a job that runs twice still sends once.
CREATE TABLE IF NOT EXISTS notifications (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    text NOT NULL,
  order_id   integer NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('order-confirmed', 'order-cancelled')),
  subject    text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, kind)
);
CREATE INDEX IF NOT EXISTS notifications_user_id_created_idx ON notifications (user_id, created_at DESC);
