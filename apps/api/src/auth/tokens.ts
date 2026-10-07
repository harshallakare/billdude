/**
 * apps/api/src/auth/tokens.ts
 *
 * Usage: single-use tokens for emailed links (password reset, email
 * verification). Only a SHA-256 hash is stored, so a database leak does not
 * leak usable links.
 *
 *   const token = await issueToken(db, userId, "password_reset", 3600_000);   // put in the link
 *   const userId = await consumeToken(db, token, "password_reset");          // null if invalid/used/expired
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authTokens } from "../db/schema.js";

type Purpose = (typeof authTokens.$inferInsert)["purpose"];

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function issueToken(db: Db, userId: string, purpose: Purpose, ttlMs: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(authTokens).values({ userId, purpose, tokenHash: hash(token), expiresAt: new Date(Date.now() + ttlMs) });
  return token;
}

/** Marks the token used and returns its user, atomically; null when unknown, used, expired or for another purpose. */
export async function consumeToken(db: Db, token: string, purpose: Purpose): Promise<string | null> {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, hash(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: authTokens.userId });
  return row?.userId ?? null;
}
