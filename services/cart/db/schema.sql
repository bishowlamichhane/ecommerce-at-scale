-- Runs on every boot, so every statement must be safe to repeat.

CREATE TABLE IF NOT EXISTS carts (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  total_price numeric(10,2) NOT NULL DEFAULT 0,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cart_items (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cart_id     integer NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  -- Lives in the products service's database, so there's no foreign key.
  product_id  integer,
  name        text    NOT NULL,
  price       numeric(10,2),
  quantity    integer NOT NULL,
  description text,
  image       text
);

CREATE INDEX IF NOT EXISTS cart_items_cart_id_idx ON cart_items (cart_id);

-- Project 1: one cart per shopper, identified by the X-User-Id header.
-- Carts from the old shared-cart days become the 'guest' cart; if a race
-- ever left more than one of them, keep the oldest so the index can exist.
ALTER TABLE carts ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'guest';
DELETE FROM carts a USING carts b WHERE a.user_id = b.user_id AND a.id > b.id;
CREATE UNIQUE INDEX IF NOT EXISTS carts_user_id_key ON carts (user_id);
