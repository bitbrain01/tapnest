// netlify/functions/create-checkout-session.js
//
// Called from the shop frontend when the buyer clicks "Checkout."
// Creates a Stripe Checkout Session and a matching `orders` +
// `order_items` row (status: pending) before redirecting to Stripe.
//
// Setup: npm install stripe @supabase/supabase-js
// Env vars: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//           SHOP_URL (e.g. https://tapnest.us)

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const body = JSON.parse(event.body);
  // Expected shape from the frontend cart:
  // {
  //   cart: [{ product_id, quantity }],
  //   user_id: "..." | null,        // null for guest checkout
  //   guest_email: "..." | null
  // }
  const { cart, user_id, guest_email } = body;

  if (!cart || cart.length === 0) {
    return { statusCode: 400, body: "Cart is empty" };
  }

  // Fetch product details (price, name) server-side — never trust
  // prices sent from the client.
  const productIds = cart.map((c) => c.product_id);
  const { data: products, error: prodErr } = await supabase
    .from("products")
    .select("id, name, base_price_usd, stock_quantity, active")
    .in("id", productIds);

  if (prodErr) {
    return { statusCode: 500, body: `Failed to load products: ${prodErr.message}` };
  }

  // Validate stock and build line items
  const lineItems = [];
  let subtotal = 0;

  for (const cartLine of cart) {
    const product = products.find((p) => p.id === cartLine.product_id);
    if (!product || !product.active) {
      return { statusCode: 400, body: `Product ${cartLine.product_id} not found or inactive` };
    }
    if (product.stock_quantity !== null && product.stock_quantity < cartLine.quantity) {
      return { statusCode: 400, body: `${product.name} is out of stock` };
    }
    const unitAmount = Math.round(product.base_price_usd * 100);
    subtotal += unitAmount * cartLine.quantity;
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: { name: product.name },
        unit_amount: unitAmount,
      },
      quantity: cartLine.quantity,
    });
  }

  // Create the pending order first
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .insert({
      user_id: user_id ?? null,
      guest_email: guest_email ?? null,
      status: "pending",
      subtotal_usd: subtotal / 100,
      total_usd: subtotal / 100, // add shipping calculation here later if needed
    })
    .select()
    .single();

  if (orderErr) {
    return { statusCode: 500, body: `Failed to create order: ${orderErr.message}` };
  }

  // Create matching order_items rows (item_id left null — resale
  // products don't allocate a smart item)
  const orderItemRows = cart.map((c) => {
    const product = products.find((p) => p.id === c.product_id);
    return {
      order_id: order.id,
      product_id: c.product_id,
      quantity: c.quantity,
      unit_price_usd: product.base_price_usd,
      configure_now: false,
    };
  });

  const { error: itemsErr } = await supabase.from("order_items").insert(orderItemRows);
  if (itemsErr) {
    return { statusCode: 500, body: `Failed to create order items: ${itemsErr.message}` };
  }

  // Create the Stripe Checkout Session
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: lineItems,
    customer_email: guest_email ?? undefined,
    success_url: `${process.env.SHOP_URL}/orders/${order.id}?success=true`,
    cancel_url: `${process.env.SHOP_URL}/cart?cancelled=true`,
    shipping_address_collection: { allowed_countries: ["US", "CA"] }, // adjust as needed
    metadata: { order_id: order.id },
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ checkout_url: session.url }),
  };
};