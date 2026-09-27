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

  if (!orderId) {
    return { statusCode: 400, body: "Missing order_id in session metadata" };
  }

  const { data: orderItems, error: fetchErr } = await supabase
    .from("order_items")
    .select("product_id, quantity")
    .eq("order_id", orderId);

  if (fetchErr) {
    return { statusCode: 500, body: `Failed to load order items: ${fetchErr.message}` };
  }

  for (const line of orderItems) {
    await supabase.rpc("decrement_resale_stock", {
      p_product_id: line.product_id,
      p_quantity: line.quantity,
    });
  }

  await supabase
    .from("orders")
    .update({
      status: "paid",
      stripe_payment_intent_id: session.payment_intent,
      shipping_address: session.shipping_details ?? session.customer_details ?? null,
    })
    .eq("id", orderId);

  return { statusCode: 200, body: "OK" };
};