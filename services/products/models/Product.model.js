import { query } from "../db/db.js";

// Table definition: ../db/schema.sql

const COLUMNS = `id, name, price, stock, category, gender, subcategory, color, usage,
  description, image, created_at AS "createdAt", updated_at AS "updatedAt"`;

// Mongo left unset fields out of a document; Postgres returns them as null.
// Dropping the nulls keeps the JSON the other services already rely on:
// orders checks `product.stock < quantity`, which is false for a missing
// stock but true for null (null counts as 0).
const toProduct = (row) =>
  row && Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

// NaN (no ?limit / ?skip in the URL) becomes NULL, and Postgres reads
// LIMIT NULL as "no limit" and OFFSET NULL as 0.
export const findProducts = async ({ skip, limit }) => {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM products ORDER BY id OFFSET $1 LIMIT $2`,
    [Number.isNaN(skip) ? null : skip, Number.isNaN(limit) ? null : limit]
  );
  return rows.map(toProduct);
};

export const createProduct = async (p) => {
  const { rows } = await query(
    `INSERT INTO products
       (name, price, stock, category, gender, subcategory, color, usage, description, image)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${COLUMNS}`,
    [p.name, p.price, p.stock, p.category, p.gender, p.subcategory, p.color, p.usage, p.description, p.image]
  );
  return toProduct(rows[0]);
};

export const findProductById = async (id) => {
  const { rows } = await query(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id]);
  return toProduct(rows[0]);
};

export const deleteProductById = async (id) => {
  const { rows } = await query("DELETE FROM products WHERE id = $1 RETURNING id", [id]);
  return rows[0];
};

// Only the image can change, exactly like before (orders' stock update is
// still ignored; project 1 fixes that). COALESCE keeps the old image when
// none is sent, the way Mongoose skipped `$set: { image: undefined }`.
export const updateProductImage = async (id, image) => {
  const { rows } = await query(
    `UPDATE products SET image = COALESCE($2, image), updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, image]
  );
  return toProduct(rows[0]);
};

export const deleteAllProducts = async () => {
  const { rowCount } = await query("DELETE FROM products");
  return rowCount;
};

// Each filter is a list of allowed values: `column = ANY($n)` is SQL's `$in`.
export const filterProducts = async ({ ids, category, gender, color, usage, subcategory, priceMin, priceMax }) => {
  const conditions = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace("?", `$${params.length}`));
  };

  if (ids.length > 0) add("id = ANY(?::int[])", ids);
  if (category.length > 0) add("category = ANY(?)", category);
  if (gender.length > 0) add("gender = ANY(?)", gender);
  if (color.length > 0) add("color = ANY(?)", color);
  if (usage.length > 0) add("usage = ANY(?)", usage);
  if (subcategory.length > 0) add("subcategory = ANY(?)", subcategory);
  if (priceMin) add("price >= ?", Number(priceMin));
  if (priceMax) add("price <= ?", Number(priceMax));

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM products ${where} ORDER BY id LIMIT 1000`,
    params
  );
  return rows.map(toProduct);
};
