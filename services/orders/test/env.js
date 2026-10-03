// Imported first by every test file, so it runs before any module reads the
// environment: the tests get their own Postgres database and never touch the
// app's data. They never reach Redis or the products service either: the
// job code gets fakes for those.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://store:store@localhost:5433/orders_service_test";
