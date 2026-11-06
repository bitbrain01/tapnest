// netlify/functions/shop-webhook.js
//
// Stripe webhook — confirms payment, marks the order paid, and
// decrements stock for each resale product purchased. No smart-item
// allocation logic needed for resale-only products.
//
// Setup: npm install stripe @supabase/supabase-js
// Env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//           SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Stripe dashboard: Developers -> Webhooks -> Add endpoint
//   URL: https://<your-shop-netlify-site>.netlify.app/.netlify/functions/shop-webhook
//   Event: checkout.session.completed

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const sig = event.headers["stripe-signature"];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  if (stripeEvent.type !== "checkout.session.completed") {
    return { statusCode: 200, body: "Ignored" };
  }

  const session = stripeEvent.data.object;
  const orderId = session.metadata?.order_id;

  // Not a shop order (for example a subscription checkout started from the
  // app). Acknowledge it with 200 so Stripe does not keep retrying it and,
  // after days of failures, disable this endpoint.
  if (!orderId) {
    console.log(`Ignoring checkout session ${session.id}: no order_id, not a shop order`);
    return { statusCode: 200, body: "Ignored: not a shop order" };
  }

  // Claim the order. Only a 'pending' order can be marked paid, so if Stripe
  // delivers the same event twice (automatic retry, or a manual resend from the
  // Dashboard) the second delivery finds nothing to claim and changes nothing.
  // This is what stops stock being reduced twice for one payment.
  const { data: claimed, error: claimErr } = await supabase
    .from("orders")
    .update({
      status: "paid",
      customer_email: session.customer_details?.email ?? null,
      stripe_payment_intent_id: session.payment_intent,
      shipping_address: session.shipping_details ?? session.customer_details ?? null,
    })
    .eq("id", orderId)
    .eq("status", "pending")
    .select("id");

  if (claimErr) {
    // Nothing was changed, so it is safe for Stripe to retry.
    return { statusCode: 500, body: `Failed to update order: ${claimErr.message}` };
  }
  if (!claimed || claimed.length === 0) {
    console.log(`Order ${orderId} is not pending (already processed or cancelled), nothing to do`);
    return { statusCode: 200, body: "Already processed" };
  }

  const { data: orderItems, error: fetchErr } = await supabase
    .from("order_items")
    .select("product_id, quantity")
    .eq("order_id", orderId);

  if (fetchErr) {
    // Put the order back to pending so Stripe's retry can process it properly.
    await supabase.from("orders").update({ status: "pending" }).eq("id", orderId);
    return { statusCode: 500, body: `Failed to load order items: ${fetchErr.message}` };
  }

  for (const line of orderItems) {
    const { error: stockErr } = await supabase.rpc("decrement_resale_stock", {
      p_product_id: line.product_id,
      p_quantity: line.quantity,
    });
    // The payment succeeded, so never fail the webhook over stock. Log it instead.
    if (stockErr) {
      console.error(`Stock not reduced for order ${orderId}, product ${line.product_id}: ${stockErr.message}`);
    }
  }

  return { statusCode: 200, body: "OK" };
};
