/**
 * apps/api/src/db/schema.ts
 *
 * Usage: the Postgres schema as Drizzle table definitions. This file is the
 * source of truth for the database; after changing it run `pnpm db:generate`
 * to create a migration, then `pnpm db:migrate`.
 *
 *   import { users, servers } from "./db/schema.js";
 *   await db.select().from(servers).where(eq(servers.ownerId, userId));
 */
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["admin", "customer"]);
export const userStatus = pgEnum("user_status", ["active", "suspended"]);

/**
 * Portal-side lifecycle of a VM. Transitional states (…ing) mean a job is in
 * flight and new actions are refused until it settles.
 */
export const serverStatus = pgEnum("server_status", [
  "pending",
  "building",
  "active",
  "stopping",
  "stopped",
  "starting",
  "rebooting",
  "error",
  "deleting",
  "deleted",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("customer"),
  status: userStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const servers = pgTable(
  "servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** Nova server id; null until the create call has succeeded. */
    vhiServerId: text("vhi_server_id").unique(),
    flavorId: text("flavor_id").notNull(),
    imageId: text("image_id").notNull(),
    networkId: text("network_id").notNull(),
    bootVolumeGb: integer("boot_volume_gb").notNull(),
    status: serverStatus("status").notNull().default("pending"),
    /** Last error or provider fault shown to the customer. */
    statusMessage: text("status_message"),
    ipv4: text("ipv4"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("servers_owner_idx").on(t.ownerId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null for actions taken by the system (worker). */
    actorId: uuid("actor_id").references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_target_idx").on(t.targetType, t.targetId)],
);

export type User = typeof users.$inferSelect;
export type ServerRow = typeof servers.$inferSelect;
export type ServerStatusValue = (typeof serverStatus.enumValues)[number];
