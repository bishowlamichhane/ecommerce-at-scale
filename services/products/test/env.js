// Imported first by every test file, so it runs before any module reads the
// environment: the tests get their own Postgres database and Redis database,
// and never touch the app's data.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://store:store@localhost:5433/product_service_test";
process.env.REDIS_DB = "14";
