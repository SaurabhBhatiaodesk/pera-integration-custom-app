// app/routes/api.pickup.jsx
import { json } from "@remix-run/node";
import { cors } from "remix-utils/cors";
import db from "../db.server";
import {
  buildPickupResponse,
  makeShopifyGqlClient,
} from "../utils/pickup.server";

export async function loader({ request }) {
  // Keep your existing “method not allowed” behavior for GETs
  if (request.method === "OPTIONS") {
    return cors(request, json({ message: "CORS preflight successful" }, { status: 200 }));
  }
  return new Response("Method Not Allowed", { status: 405 });
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return cors(request, json({ message: "CORS preflight successful" }, { status: 200 }));
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { myShopifyDomain, pincode, variantId, radiusKm } = body || {};

    if (!myShopifyDomain) {
      return cors(
        request,
        json({ success: false, error: "Invalid or missing Shopify domain." }, { status: 400 })
      );
    }

    const shopifyDomainRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
    if (!shopifyDomainRegex.test(myShopifyDomain)) {
      return cors(
        request,
        json({ success: false, error: "Invalid Shopify domain format. Expected example.myshopify.com" }, { status: 400 })
      );
    }

    const session = await db.session.findFirst({ where: { shop: myShopifyDomain } });
    if (!session?.accessToken) {
      return cors(
        request,
        json({ success: false, error: "No session found. Please authenticate the shop." }, { status: 403 })
      );
    }

    const gql = makeShopifyGqlClient(session.shop, session.accessToken);
    const result = await buildPickupResponse({
      pincode,
      variantId,
      radiusKm,
      gql,
      shop: session.shop,
    });

    return cors(request, json({ success: true, ...result }, { status: 200 }));
  } catch (error) {
    return cors(
      request,
      json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "An unexpected error occurred while processing the request",
          meta: error?.meta,
          code: error?.code,
        },
        { status: error?.status || 500 }
      )
    );
  }
}