-- scripts/create-test-db.sql
-- Usage: run automatically by the Postgres container on first start (docker-compose.yml);
-- creates the database the API integration tests use.
CREATE DATABASE billdude_test;
