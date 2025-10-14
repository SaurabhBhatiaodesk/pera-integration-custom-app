import { json } from "@remix-run/node";
import { cors } from "remix-utils/cors";
import db from "../db.server";
import {
  makeShopifyGqlClient,
  fetchShopifyLocations,
} from "../utils/pickup.server";

// Handle GET /locations/test?shopDomain=example.myshopify.com
export async function loader({ request }) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return cors(
      request,
      json({ success: true, message: "CORS preflight successful" }, { status: 200 }),
    );
  }

  try {
    const url = new URL(request.url);
    const shopDomain = url.searchParams.get("shopDomain");

    // Validate domain input
    if (!shopDomain || typeof shopDomain !== "string") {
      return cors(
        request,
        json({ success: false, error: "Missing or invalid shopDomain (e.g. example.myshopify.com)." }, { status: 400 }),
      );
    }

    const shopifyDomainRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
    if (!shopifyDomainRegex.test(shopDomain)) {
      return cors(
        request,
        json({ success: false, error: "Invalid Shopify domain format. Expected example.myshopify.com" }, { status: 400 }),
      );
    }

    // Look up the session in your DB
    const session = await db.session.findFirst({ where: { shop: shopDomain } });
    if (!session?.accessToken) {
      return cors(
        request,
        json({ success: false, error: "No session/access token found for this shop. Please authenticate the shop." }, { status: 403 }),
      );
    }

    // Shopify GraphQL client
    const gql = makeShopifyGqlClient(session.shop, session.accessToken);

    // Fetch active locations
    const locations = await fetchShopifyLocations(gql, session.shop);

    return cors(
      request,
      json(
        {
          success: true,
          shop: session.shop,
          count: locations.length,
          locations,
        },
        { status: 200 },
      ),
    );
  } catch (error) {
    return cors(
      request,
      json(
        {
          success: false,
          error: error?.message || "Unexpected error while fetching locations.",
          code: error?.code,
          meta: error?.meta,
        },
        { status: error?.status || 500 },
      ),
    );
  }
}

// POST not allowed for this test route
export async function action() {
  return new Response("Method Not Allowed", { status: 405 });
}
