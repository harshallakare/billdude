/**
 * apps/api/src/scripts/seed-admin.ts
 *
 * Usage: creates (or promotes) the first admin account.
 *   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='long-password' pnpm seed:admin
 */
import { eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { createDb } from "../db/client.js";
import { users } from "../db/schema.js";

const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD;
const databaseUrl = process.env.DATABASE_URL;
if (!email || !password || !databaseUrl) {
  throw new Error("Set DATABASE_URL, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD");
}
if (password.length < 10) throw new Error("SEED_ADMIN_PASSWORD must be at least 10 characters");

const { db, pool } = createDb(databaseUrl);
const [existing] = await db.select().from(users).where(eq(users.email, email));
if (existing) {
  await db.update(users).set({ role: "admin", status: "active" }).where(eq(users.id, existing.id));
  console.log(`Promoted ${email} to admin.`);
} else {
  await db.insert(users).values({ email, name: "Administrator", role: "admin", passwordHash: await hashPassword(password) });
  console.log(`Created admin ${email}.`);
}
await pool.end();
