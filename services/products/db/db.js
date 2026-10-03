import pg from "pg";
import { readFile } from "node:fs/promises";

// node-postgres returns NUMERIC as a string so no precision is lost.
// Prices fit comfortably in a JS number, so parse them once, here.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => parseFloat(value));

// Created in connectDB(), after .env has been loaded.
let pool;

export const query = (text, params) => pool.query(text, params);

const connectDB = async () => {
  try {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

    const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    await pool.query(schema);

    const { rows } = await pool.query("SELECT current_database() AS db");
    console.log(`✅ Postgres connected: ${rows[0].db}`);

    process.on("SIGINT", async () => {
      await pool.end();
      console.log("🔒 Postgres pool closed due to app termination");
      process.exit(0);
    });

  } catch (error) {
    console.error("❌ Postgres connection error:", error.message);
    process.exit(1);
  }
};

export default connectDB;
