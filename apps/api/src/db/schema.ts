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
import type { ProjectQuotas } from "@billdude/vhi-connector";
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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
  /** The customer's own VHI project; created lazily by the worker. */
  vhiProjectId: text("vhi_project_id"),
  /** Admin override of the default quotas; null = use defaults from config. */
  quotas: jsonb("quotas").$type<ProjectQuotas>(),
  /** Prepaid wallet balance in micro-units of the billing currency (1 INR = 1_000_000). */
  balanceMicros: bigint("balance_micros", { mode: "number" }).notNull().default(0),
  /** Set when the balance first went negative; cleared when it is topped up again. */
  overdueSince: timestamp("overdue_since", { withTimezone: true }),
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
    /** VHI project the VM lives in; set when provisioning starts. */
    vhiProjectId: text("vhi_project_id"),
    /** Nova server id; null until the create call has succeeded. */
    vhiServerId: text("vhi_server_id").unique(),
    flavorId: text("flavor_id").notNull(),
    /** Flavor size copied at create time so billing still works if the flavor is later removed. */
    flavorVcpus: integer("flavor_vcpus").notNull().default(0),
    flavorRamMb: integer("flavor_ram_mb").notNull().default(0),
    imageId: text("image_id").notNull(),
    networkId: text("network_id").notNull(),
    bootVolumeGb: integer("boot_volume_gb").notNull(),
    /** Public keys copied from the customer's SSH keys at create time (injected via cloud-init). */
    sshPublicKeys: jsonb("ssh_public_keys").$type<string[]>().notNull().default([]),
    status: serverStatus("status").notNull().default("pending"),
    /** Last error or provider fault shown to the customer. */
    statusMessage: text("status_message"),
    ipv4: text("ipv4"),
    /** When the VM first became active; billing starts here. */
    billingStartedAt: timestamp("billing_started_at", { withTimezone: true }),
    /** Usage has been charged up to this instant. */
    billedUntil: timestamp("billed_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("servers_owner_idx").on(t.ownerId)],
);

export const sshKeys = pgTable(
  "ssh_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("ssh_keys_owner_fingerprint_unique").on(t.ownerId, t.fingerprint)],
);

export const walletTxType = pgEnum("wallet_tx_type", ["topup", "usage", "credit", "adjustment", "refund"]);
export const paymentStatus = pgEnum("payment_status", ["created", "paid", "failed"]);

/** Admin price overrides per flavor; flavors without a row use the vCPU/RAM formula. */
export const flavorPrices = pgTable("flavor_prices", {
  flavorId: text("flavor_id").primaryKey(),
  hourlyMicros: bigint("hourly_micros", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Append-only wallet ledger. amount > 0 credits the wallet, < 0 debits it. */
export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    type: walletTxType("type").notNull(),
    amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
    balanceAfterMicros: bigint("balance_after_micros", { mode: "number" }).notNull(),
    description: text("description").notNull(),
    /** Idempotency key, e.g. a payment id; unique per type. */
    reference: text("reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("wallet_tx_user_idx").on(t.userId, t.createdAt), unique("wallet_tx_type_reference_unique").on(t.type, t.reference)],
);

/** Per-server usage charged in one metering run. */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id),
    walletTransactionId: uuid("wallet_transaction_id").references(() => walletTransactions.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    flavorId: text("flavor_id").notNull(),
    diskGb: integer("disk_gb").notNull(),
    computeMicros: bigint("compute_micros", { mode: "number" }).notNull(),
    storageMicros: bigint("storage_micros", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_records_user_period_idx").on(t.userId, t.periodStart)],
);

/** Wallet top-ups through the payment gateway. */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    gateway: text("gateway").notNull(),
    /** Gateway order id (Razorpay order_…). */
    orderId: text("order_id").notNull().unique(),
    /** Gateway payment id once paid (Razorpay pay_…). */
    paymentId: text("payment_id"),
    /** Amount in the currency's minor unit (paise), as the gateway expects. */
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: paymentStatus("status").notNull().default("created"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => [index("payments_user_idx").on(t.userId, t.createdAt)],
);

export const ticketStatus = pgEnum("ticket_status", ["open", "answered", "closed"]);

/** Customer support tickets. "open" = waiting on staff, "answered" = waiting on the customer. */
export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    subject: text("subject").notNull(),
    status: ticketStatus("status").notNull().default("open"),
    /** Optional server the ticket is about. */
    serverId: uuid("server_id").references(() => servers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("tickets_user_idx").on(t.userId, t.updatedAt), index("tickets_status_idx").on(t.status, t.updatedAt)],
);

export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    /** true when written by staff (admin), shown as "Support" to the customer. */
    fromStaff: boolean("from_staff").notNull().default(false),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ticket_messages_ticket_idx").on(t.ticketId, t.createdAt)],
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
export type SshKey = typeof sshKeys.$inferSelect;
export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type ServerRow = typeof servers.$inferSelect;
export type ServerStatusValue = (typeof serverStatus.enumValues)[number];
