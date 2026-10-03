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
