/**
 * apps/web/src/lib/checkout.ts
 *
 * Usage: runs a wallet top-up end to end in the browser.
 *
 *   const result = await payTopup(order);   // order from api.createTopup(amount)
 *
 * With the Razorpay gateway it loads Razorpay Checkout, waits for the
 * customer to pay and then asks the API to verify the signed result. With the
 * development "fake" gateway it skips the popup and confirms immediately.
 */
import { api, type TopupOrder } from "./api";

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open(): void; on(event: string, cb: (e: unknown) => void): void };
  }
}

const SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
let scriptPromise: Promise<void> | null = null;

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Could not load Razorpay Checkout. Check your connection and try again."));
    };
    document.body.appendChild(script);
  });
  return scriptPromise;
}

export class CheckoutCancelled extends Error {}

export async function payTopup(order: TopupOrder) {
  if (order.gateway === "fake") {
    return api.verifyTopup(order.orderId, `pay_fake_${order.orderId}`, "fake-signature");
  }

  await loadRazorpay();
  const response = await new Promise<RazorpayResponse>((resolve, reject) => {
    const checkout = new window.Razorpay!({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amountMinor,
      currency: order.currency,
      name: order.companyName,
      description: "Wallet top-up",
      prefill: order.prefill,
      theme: { color: "#4f46e5" },
      handler: resolve,
      modal: { ondismiss: () => reject(new CheckoutCancelled("Payment was cancelled")) },
    });
    checkout.on("payment.failed", () => reject(new Error("The payment failed. No money was taken; please try again.")));
    checkout.open();
  });
  return api.verifyTopup(response.razorpay_order_id, response.razorpay_payment_id, response.razorpay_signature);
}
