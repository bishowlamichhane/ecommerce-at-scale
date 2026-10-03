-- Runs once, when the postgres-data volume is first created.
-- One database per service, so no service can join another service's tables.
CREATE DATABASE product_service;
CREATE DATABASE cart_service;
CREATE DATABASE orders_service;
