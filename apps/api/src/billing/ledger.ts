/**
 * apps/api/src/billing/ledger.ts
 *
 * Usage: the only code allowed to change a wallet balance. Every change is an
 * append-only wallet_transactions row written in the same database
 * transaction as the balance update, so the ledger always explains the balance.
 *
 *   await postTransaction(db, { userId, type: "topup", amountMicros: 500_000_000,
 *                               description: "Razorpay top-up", reference: "pay_123" });
 *
 * Passing a `reference` makes the call idempotent per (type, reference): a
 * second call with the same pair is ignored and returns { applied: false }.
 * It also keeps users.overdue_since in step with the sign of the balance.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users, walletTransactions, type WalletTransaction } from "../db/schema.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface PostInput {
  userId: string;
  type: WalletTransaction["type"];
  /** Positive credits the wallet, negative debits it. */
  amountMicros: number;
  description: string;
  reference?: string;
}

export async function postTransaction(
  db: Db | Tx,
  input: PostInput,
): Promise<{ applied: boolean; transaction?: WalletTransaction }> {
  try {
    return await db.transaction(async (tx) => {
      if (input.reference) {
        const [existing] = await tx
          .select({ id: walletTransactions.id })
          .from(walletTransactions)
          .where(and(eq(walletTransactions.type, input.type), eq(walletTransactions.reference, input.reference)));
        if (existing) return { applied: false };
      }
      const [user] = await tx
        .update(users)
        .set({
          balanceMicros: sql`${users.balanceMicros} + ${input.amountMicros}`,
          overdueSince: sql`case
            when ${users.balanceMicros} + ${input.amountMicros} >= 0 then null
            else coalesce(${users.overdueSince}, now()) end`,
        })
        .where(eq(users.id, input.userId))
        .returning({ balance: users.balanceMicros });
      if (!user) throw new Error(`User ${input.userId} not found`);

      const [transaction] = await tx
        .insert(walletTransactions)
        .values({ ...input, reference: input.reference ?? null, balanceAfterMicros: user.balance })
        .returning();
      return { applied: true, transaction };
    });
  } catch (error) {
    // A concurrent call with the same reference won the race.
    if (input.reference && (error as { code?: string }).code === "23505") return { applied: false };
    throw error;
  }
}
