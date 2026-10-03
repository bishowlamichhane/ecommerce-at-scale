-- Runs on every boot, so every statement must be safe to repeat.

CREATE TABLE IF NOT EXISTS products (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text          NOT NULL,
  price       numeric(10,2) NOT NULL,
  -- Nullable like the old Mongo field (the seed data has no stock).
  -- The CHECK is a last line of defence against negative stock.
  stock       integer CHECK (stock >= 0),
  category    text,
  gender      text,
  subcategory text,
  color       text,
  usage       text,
  description text,
  image       text,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now()
);

-- Same indexes the Mongoose schema declared.
CREATE INDEX IF NOT EXISTS products_category_idx    ON products (category);
CREATE INDEX IF NOT EXISTS products_gender_idx      ON products (gender);
CREATE INDEX IF NOT EXISTS products_color_idx       ON products (color);
CREATE INDEX IF NOT EXISTS products_usage_idx       ON products (usage);
CREATE INDEX IF NOT EXISTS products_subcategory_idx ON products (subcategory);
CREATE INDEX IF NOT EXISTS products_price_idx       ON products (price);
CREATE INDEX IF NOT EXISTS products_category_gender_color_idx ON products (category, gender, color);
