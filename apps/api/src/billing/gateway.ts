/**
 * apps/api/src/billing/gateway.ts
 *
 * Usage: payment gateway abstraction used for wallet top-ups.
 *
 *   const gateway = createGateway(config);      // Razorpay when keys are set, else the fake gateway
 *   const { orderId } = await gateway.createOrder({ amountMinor: 50000, currency: "INR", receipt });
 *   gateway.verifyCheckoutSignature(orderId, paymentId, signature);   // after Razorpay Checkout
 *   const payment = await gateway.fetchPayment(paymentId);            // authoritative status
 *   gateway.verifyWebhookSignature(rawBody, header);                  // X-Razorpay-Signature
 *
 * The fake gateway exists so the whole top-up flow can be developed and
 * tested without Razorpay credentials. It is refused in production by
 * loadConfig(), and its checkout "signature" is the literal string FAKE_SIGNATURE.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";

export interface GatewayPayment {
  id: string;
  orderId: string;
  /** Minor units (paise). */
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
}

export interface PaymentGateway {
  readonly name: "razorpay" | "fake";
  /** Public key for the browser checkout (Razorpay key_id); null for the fake gateway. */
  readonly publicKey: string | null;
  createOrder(input: { amountMinor: number; currency: string; receipt: string; notes?: Record<string, string> }): Promise<{
    orderId: string;
  }>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  capture(paymentId: string, amountMinor: number, currency: string): Promise<GatewayPayment>;
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function createGateway(config: Config): PaymentGateway {
  if (config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET) {
    return new RazorpayGateway(config.RAZORPAY_KEY_ID, config.RAZORPAY_KEY_SECRET, config.RAZORPAY_WEBHOOK_SECRET);
  }
  return new FakeGateway();
}

function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ---------------------------------------------------------------- Razorpay */

interface RazorpayPaymentEntity {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: GatewayPayment["status"];
}

export class RazorpayGateway implements PaymentGateway {
  readonly name = "razorpay" as const;
  private readonly baseUrl = "https://api.razorpay.com/v1";

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get publicKey(): string {
    return this.keyId;
  }

  async createOrder(input: { amountMinor: number; currency: string; receipt: string; notes?: Record<string, string> }) {
    const order = await this.call<{ id: string }>("POST", "/orders", {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {},
    });
    return { orderId: order.id };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    return toPayment(await this.call<RazorpayPaymentEntity>("GET", `/payments/${encodeURIComponent(paymentId)}`));
  }

  async capture(paymentId: string, amountMinor: number, currency: string): Promise<GatewayPayment> {
    return toPayment(
      await this.call<RazorpayPaymentEntity>("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, {
        amount: amountMinor,
        currency,
      }),
    );
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqual(hmacHex(this.keySecret, `${orderId}|${paymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!this.webhookSecret) return false;
    return safeEqual(hmacHex(this.webhookSecret, rawBody), signature);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new GatewayError(`Razorpay ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
    if (!res.ok) throw new GatewayError(`Razorpay ${method} ${path}: ${data.error?.description ?? res.statusText}`, res.status);
    return data as T;
  }
}

function toPayment(p: RazorpayPaymentEntity): GatewayPayment {
  return { id: p.id, orderId: p.order_id, amount: p.amount, currency: p.currency, status: p.status };
}

/** Parses a Razorpay webhook payment entity (payment.captured / order.paid events). */
export function paymentFromWebhook(body: unknown): GatewayPayment | null {
  const entity = (body as { payload?: { payment?: { entity?: RazorpayPaymentEntity } } }).payload?.payment?.entity;
  return entity?.id && entity.order_id ? toPayment(entity) : null;
}

/* ---------------------------------------------------------------- Fake */

export const FAKE_SIGNATURE = "fake-signature";

/** In-memory stand-in for Razorpay: every checkout succeeds and is captured. */
export class FakeGateway implements PaymentGateway {
  readonly name = "fake" as const;
  readonly publicKey = null;
  private readonly orders = new Map<string, { amount: number; currency: string }>();

  async createOrder(input: { amountMinor: number; currency: string }) {
    const orderId = `order_fake_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    this.orders.set(orderId, { amount: input.amountMinor, currency: input.currency });
    return { orderId };
  }

  /** Fake payment ids are "pay_fake_<orderId>" so the order can be recovered. */
  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const orderId = paymentId.replace(/^pay_fake_/, "");
    const order = this.orders.get(orderId);
    if (!order) throw new GatewayError(`Unknown fake payment ${paymentId}`, 404);
    return { id: paymentId, orderId, amount: order.amount, currency: order.currency, status: "captured" };
  }

  async capture(paymentId: string): Promise<GatewayPayment> {
    return this.fetchPayment(paymentId);
  }

  verifyCheckoutSignature(_orderId: string, paymentId: string, signature: string): boolean {
    return paymentId.startsWith("pay_fake_") && signature === FAKE_SIGNATURE;
  }

  verifyWebhookSignature(): boolean {
    return false;
  }
}
