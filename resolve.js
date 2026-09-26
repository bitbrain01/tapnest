// netlify/functions/resolve.js
//
// Setup:
// 1. npm install @supabase/supabase-js in your project root
// 2. In Netlify dashboard: Site settings -> Environment variables, add:
//    SUPABASE_URL              = https://<project-ref>.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY = <service role key, from Supabase API settings>
//    PUBLIC_APP_URL             = https://yourapp.netlify.app  (or custom domain)
// 3. Route short links to this function — see netlify.toml redirect below.

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BOT_UA_PATTERNS = [
  "bot", "spider", "crawl", "facebookexternalhit", "slurp", "preview",
];

function isLikelyBot(userAgent) {
  if (!userAgent) return true;
  const ua = userAgent.toLowerCase();
  return BOT_UA_PATTERNS.some((p) => ua.includes(p));
}

function deviceTypeFromUA(userAgent) {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  if (/mobile|iphone|android/.test(ua)) return "mobile";
  if (/tablet|ipad/.test(ua)) return "tablet";
  return "desktop";
}

exports.handler = async (event) => {
  // Expect the shortcode as a path segment: /r/:shortcode
  // or as a query param: /.netlify/functions/resolve?code=ABC12
  const pathParts = event.path.split("/").filter(Boolean);
  const shortcode = event.queryStringParameters?.code || pathParts[pathParts.length - 1];

  if (!shortcode) {
    return { statusCode: 400, body: "Missing shortcode" };
  }

  const { data: item, error } = await supabase
    .from("items")
    .select("id, resolve_type, current_target_url, status")
    .eq("shortcode", shortcode)
    .single();

  if (error || !item) {
    return { statusCode: 404, body: "Not found" };
  }

  if (item.status === "unclaimed") {
    // First scan of a card sold via the "configure later" path.
    // Send them to the activation flow on the app domain instead of
    // logging a normal scan / resolving a destination.
    const activateUrl = `${process.env.PUBLIC_APP_URL}/activate/${item.id}`;
    return {
      statusCode: 302,
      headers: { Location: activateUrl },
      body: "",
    };
  }

  if (item.status !== "active") {
    return { statusCode: 404, body: "Not found" };
  }

  const channel = event.queryStringParameters?.c || "qr";
  const userAgent = event.headers["user-agent"];
  const referrer = event.headers["referer"] || event.headers["referrer"];
  const country =
    event.headers["x-country"] ||
    event.headers["cf-ipcountry"] ||
    (event.headers["x-nf-geo"]
      ? JSON.parse(Buffer.from(event.headers["x-nf-geo"], "base64").toString()).country?.code
      : null);

  await supabase.from("scans").insert({
    item_id: item.id,
    channel,
    is_bot: isLikelyBot(userAgent),
    device_type: deviceTypeFromUA(userAgent),
    browser: userAgent,
    referrer,
    country,
  });

  let destination;
  if (item.resolve_type === "external_url") {
    if (!item.current_target_url) {
      return { statusCode: 404, body: "This link has no destination set yet" };
    }
    destination = item.current_target_url;
  } else {
    destination = `${process.env.PUBLIC_APP_URL}/p/${item.id}`;
  }

  return {
    statusCode: 302,
    headers: { Location: destination },
    body: "",
  };
};