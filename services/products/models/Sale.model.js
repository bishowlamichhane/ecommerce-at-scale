import { query } from "../db/db.js";

// Table definition: ../db/schema.sql

// The product of the most recently started sale, or undefined.
export const currentSaleProductId = async () => {
  const { rows } = await query("SELECT product_id FROM sales ORDER BY id DESC LIMIT 1");
  return rows[0]?.product_id;
};
