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
