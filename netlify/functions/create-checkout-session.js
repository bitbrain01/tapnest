// netlify/functions/create-checkout-session.js
//
// Called from the shop frontend when the buyer clicks "Checkout."
// Creates a pending `orders` + `order_items` set, then a Stripe Checkout
// Session, and returns the Stripe URL to redirect to.
//
// Cart payload from the frontend:
// {
//   cart: [
//     {
//       product_id,                // required
//       quantity,                  // required, integer >= 1
//       customization_id,          // optional: a row from product_customizations
//       custom_text,               // optional: only used if the option requires_text
//       reorder_item_id,           // optional: ordering extra hardware for an EXISTING item
//       reorder_shortcode          // optional: must match that item's shortcode if sent
//     }
//   ],
//   user_id: "..." | null,         // null for guest checkout
//   guest_email: "..." | null
// }
//
// All prices are computed HERE from the database. Prices sent by the
// client are never trusted.
//
// Requires migration part11_customization.sql to have been run.
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_CUSTOM_TEXT_LENGTH = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Accept the reorder fields either on the cart line itself or nested under
// customization_details, since the storefront may send either shape.
const getReorderId = (line) =>
  line.reorder_item_id ?? line.customization_details?.reorder_item_id ?? null;
const getReorderShortcode = (line) =>
  line.reorder_shortcode ?? line.customization_details?.reorder_shortcode ?? null;

const fail = (statusCode, message) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: message,
});

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return fail(405, "Method not allowed");
  }

  // Wrap everything so unexpected errors still return CORS headers
  // (otherwise the browser reports a vague "Failed to fetch").
  try {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return fail(400, "Invalid request body");
    }

    const { cart, user_id, guest_email } = body;

    if (!Array.isArray(cart) || cart.length === 0) {
      return fail(400, "Cart is empty");
    }
    for (const line of cart) {
      if (!line.product_id || !Number.isInteger(line.quantity) || line.quantity < 1) {
        return fail(400, "Invalid cart line");
      }
    }

    // ---------- Load products ----------
    const productIds = [...new Set(cart.map((c) => c.product_id))];
    const { data: products, error: prodErr } = await supabase
      .from("products")
      .select("id, name, base_price_usd, stock_quantity, active, locked_use_case, locked_platform_template_id, allowed_use_cases")
      .in("id", productIds);
    if (prodErr) return fail(500, `Failed to load products: ${prodErr.message}`);

    // ---------- Load customization options (if any were selected) ----------
    const customizationIds = [
      ...new Set(cart.map((c) => c.customization_id).filter(Boolean)),
    ];
    let customizations = [];
    if (customizationIds.length > 0) {
      const { data, error } = await supabase
        .from("product_customizations")
        .select(
          "id, product_id, name, extra_price_usd, requires_text, text_label, requires_artwork, is_default, active"
        )
        .in("id", customizationIds);
      if (error) return fail(500, `Failed to load customization options: ${error.message}`);
      customizations = data;
    }

    // ---------- Load existing items for reorder lines (if any) ----------
    const reorderIds = [...new Set(cart.map(getReorderId).filter(Boolean))];
    for (const id of reorderIds) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        return fail(400, "Invalid reorder reference");
      }
    }
    let reorderItems = [];
    if (reorderIds.length > 0) {
      const { data, error } = await supabase
        .from("items")
        .select("id, shortcode, status, use_case, platform_template_id")
        .in("id", reorderIds);
      if (error) return fail(500, `Failed to load reorder items: ${error.message}`);
      reorderItems = data;
    }

    // ---------- Stock check (aggregated per product across cart lines) ----------
    const qtyByProduct = {};
    for (const line of cart) {
      qtyByProduct[line.product_id] = (qtyByProduct[line.product_id] || 0) + line.quantity;
    }
    for (const [productId, qty] of Object.entries(qtyByProduct)) {
      const product = products.find((p) => p.id === productId);
      if (!product || !product.active) {
        return fail(400, `Product ${productId} not found or inactive`);
      }
      if (product.stock_quantity !== null && product.stock_quantity < qty) {
        return fail(400, `${product.name} is out of stock`);
      }
    }

    // ---------- Build Stripe line items + order_items rows ----------
    const lineItems = [];
    const orderItemRows = []; // order_id is added after the order exists
    let subtotalCents = 0;

    for (const line of cart) {
      const product = products.find((p) => p.id === line.product_id);

      let customization = null;
      const customizationData = {};
      let artworkStatus = "not_required";

      if (line.customization_id) {
        customization = customizations.find((c) => c.id === line.customization_id);
        if (!customization || !customization.active || customization.product_id !== product.id) {
          return fail(400, "Invalid customization option for this product");
        }
        if (customization.requires_text) {
          const text = String(line.custom_text || "").trim().slice(0, MAX_CUSTOM_TEXT_LENGTH);
          if (!text) {
            return fail(400, `${customization.name} requires: ${customization.text_label || "custom text"}`);
          }
          customizationData.custom_text = text;
        }
        if (customization.requires_artwork) {
          artworkStatus = "awaiting";
        }
      }

      // ---- Reorder: extra hardware pointing at an existing, active item ----
      let reorderItem = null;
      const reorderId = getReorderId(line);
      if (reorderId) {
        reorderItem = reorderItems.find((i) => i.id === reorderId);
        // Must be an ACTIVE item. Never allow unclaimed inventory to be
        // "reserved" through a reorder.
        if (!reorderItem || reorderItem.status !== "active") {
          return fail(400, "The link you are ordering extra hardware for was not found or is not active");
        }
        const sentShortcode = getReorderShortcode(line);
        if (sentShortcode && sentShortcode !== reorderItem.shortcode) {
          return fail(400, "Reorder details do not match");
        }
        // The product must be compatible with what the item is.
        if (product.locked_use_case) {
          const wrongUseCase = product.locked_use_case !== reorderItem.use_case;
          const wrongPlatform =
            product.locked_platform_template_id &&
            product.locked_platform_template_id !== reorderItem.platform_template_id;
          if (wrongUseCase || wrongPlatform) {
            return fail(400, `${product.name} can't be ordered for that link`);
          }
        } else if (
          Array.isArray(product.allowed_use_cases) &&
          !product.allowed_use_cases.includes(reorderItem.use_case)
        ) {
          return fail(400, `${product.name} can't be ordered for that link`);
        }
        // Store the shortcode from the DATABASE, not the value the browser sent
        customizationData.reorder_item_id = reorderItem.id;
        customizationData.reorder_shortcode = reorderItem.shortcode;
      }

      const extraPrice = customization ? Number(customization.extra_price_usd) : 0;
      const unitAmountCents = Math.round((Number(product.base_price_usd) + extraPrice) * 100);
      subtotalCents += unitAmountCents * line.quantity;

      // Show the customization tier on the Stripe checkout page, but skip
      // the label for the free default option to keep it clean.
      const showTier = customization && !customization.is_default;
      const productData = {
        name: showTier ? `${product.name} - ${customization.name}` : product.name,
      };
      const descriptionParts = [];
      if (customizationData.custom_text) {
        descriptionParts.push(`Custom text: ${customizationData.custom_text}`);
      }
      if (customizationData.reorder_shortcode) {
        descriptionParts.push(`Extra hardware for tapn.st/r/${customizationData.reorder_shortcode}`);
      }
      if (descriptionParts.length > 0) {
        productData.description = descriptionParts.join(" | ");
      }

      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: productData,
          unit_amount: unitAmountCents,
        },
        quantity: line.quantity,
      });

      orderItemRows.push({
        product_id: product.id,
        quantity: line.quantity,
        unit_price_usd: product.base_price_usd,      // base price per unit
        customization_id: customization ? customization.id : null,
        customization_price_usd: extraPrice,          // extra fee per unit, snapshotted
        customization_data: customizationData,
        artwork_status: artworkStatus,
        item_id: reorderItem ? reorderItem.id : null, // existing item for reorders, otherwise set later
        configure_now: false,
      });
    }

    // ---------- Create the pending order ----------
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert({
        user_id: user_id ?? null,
        guest_email: guest_email ?? null,
        status: "pending",
        subtotal_usd: subtotalCents / 100,
        total_usd: subtotalCents / 100, // add shipping here later if needed
      })
      .select()
      .single();
    if (orderErr) return fail(500, `Failed to create order: ${orderErr.message}`);

    const { error: itemsErr } = await supabase
      .from("order_items")
      .insert(orderItemRows.map((row) => ({ ...row, order_id: order.id })));
    if (itemsErr) {
      // Don't leave an orphaned pending order behind
      await supabase.from("orders").delete().eq("id", order.id);
      return fail(500, `Failed to create order items: ${itemsErr.message}`);
    }

    // ---------- Create the Stripe Checkout Session ----------
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
      headers: CORS_HEADERS,
      body: JSON.stringify({ checkout_url: session.url }),
    };
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return fail(500, `Checkout failed: ${err.message}`);
  }
};
