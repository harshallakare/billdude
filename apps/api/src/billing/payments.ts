/**
 * apps/api/src/billing/payments.ts
 *
 * Usage: turns a gateway payment into wallet credit, exactly once.
 *
 *   const result = await settlePayment(db, gateway, payment);   // from checkout verify or webhook
 *   // { credited: true } the first time, { credited: false } on every repeat
 *
 * Checks the gateway payment against our own order record (order id,
 * amount, currency), captures it if it is only authorized, then marks the
 * order paid and credits the wallet in a single database transaction.
 */
import { and, eq } from "drizzle-orm";
import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { payments } from "../db/schema.js";
import type { GatewayPayment, PaymentGateway } from "./gateway.js";
import { postTransaction } from "./ledger.js";
import { formatAmount, fromMinorUnits } from "./money.js";

export class PaymentMismatchError extends Error {}

export async function settlePayment(
  db: Db,
  gateway: PaymentGateway,
  incoming: GatewayPayment,
): Promise<{ credited: boolean; userId?: string }> {
  const [order] = await db.select().from(payments).where(eq(payments.orderId, incoming.orderId));
  if (!order) throw new PaymentMismatchError(`Unknown order ${incoming.orderId}`);
  if (order.status === "paid") return { credited: false, userId: order.userId };
  if (incoming.amount !== order.amountMinor || incoming.currency !== order.currency) {
    throw new PaymentMismatchError(`Payment ${incoming.id} does not match order ${order.orderId}`);
  }

  let payment = incoming;
  if (payment.status === "authorized") payment = await gateway.capture(payment.id, order.amountMinor, order.currency);
  if (payment.status === "failed") {
    await db.update(payments).set({ status: "failed", paymentId: payment.id }).where(eq(payments.id, order.id));
    return { credited: false, userId: order.userId };
  }
  if (payment.status !== "captured") return { credited: false, userId: order.userId };

  const credited = await db.transaction(async (tx) => {
    const [marked] = await tx
      .update(payments)
      .set({ status: "paid", paymentId: payment.id, paidAt: new Date() })
      .where(and(eq(payments.id, order.id), eq(payments.status, "created")))
      .returning({ id: payments.id });
    if (!marked) return false;
    const amountMicros = fromMinorUnits(order.amountMinor);
    await postTransaction(tx, {
      userId: order.userId,
      type: "topup",
      amountMicros,
      description: `Wallet top-up ${formatAmount(amountMicros)} ${order.currency} (${gateway.name} ${payment.id})`,
      reference: payment.id,
    });
    return true;
  });

  if (credited) {
    await audit(db, {
      actorId: order.userId,
      action: "wallet.topup",
      targetType: "payment",
      targetId: order.id,
      data: { paymentId: payment.id, amountMinor: order.amountMinor },
    });
  }
  return { credited, userId: order.userId };
}
