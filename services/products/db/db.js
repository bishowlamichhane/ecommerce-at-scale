import pg from "pg";
import { readFile } from "node:fs/promises";

// node-postgres returns NUMERIC as a string so no precision is lost.
// Prices fit comfortably in a JS number, so parse them once, here.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => parseFloat(value));

// Created in connectDB(), after .env has been loaded.
let pool;

export const query = (text, params) => pool.query(text, params);

// Runs `work(client)` inside BEGIN/COMMIT, and rolls back if it throws.
// Every query in `work` must use the client it's given, not query() above.
export const withTransaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const closeDB = () => pool?.end();

// handleSignals: close the pool and exit on Ctrl+C. The worker turns it off
// so it can first finish the jobs it's working on.
const connectDB = async ({ handleSignals = true } = {}) => {
  try {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

    const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    await pool.query(schema);

    const { rows } = await pool.query("SELECT current_database() AS db");
    console.log(`✅ Postgres connected: ${rows[0].db}`);

    if (handleSignals) process.on("SIGINT", async () => {
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
