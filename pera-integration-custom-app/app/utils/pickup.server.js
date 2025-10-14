// app/utils/pickup.server.js

// ✅ Axios ESM interop (Remix/Vite friendly)
import axiosCjs from "axios";
const axios = axiosCjs.default;

import { LRUCache } from "lru-cache";

// ---------- Config (env with safe defaults) ----------
const {
  GOOGLE_MAPS_KEY,
  SHOPIFY_API_VERSION = "2024-07",
  DEFAULT_RADIUS_KM = "100",
  GEOCODER_MODE = "auto", // "auto" | "google" | "osm"
} = process.env;

// ---------- Errors & helpers ----------
class AppError extends Error {
  constructor(message, { code = "app_error", status = 500, meta = {} } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.meta = meta;
  }
}
export class InvalidPincodeError extends AppError {
  constructor(pin) {
    super("Please enter a valid 4- or 6-digit postcode/pincode.", {
      code: "invalid_pincode",
      status: 400,
      meta: { pincode: pin },
    });
  }
}
class GeocodeNoResultError extends AppError {
  constructor(query) {
    super("Pickup not available for this pincode.", {
      code: "pin_unavailable",
      status: 422,
      meta: { query: String(query) },
    });
  }
}
class GeocodeProviderError extends AppError {
  constructor(provider, reason, meta = {}) {
    super(`Geocoding provider error: ${provider}`, {
      code: "geocode_provider_error",
      status: 502,
      meta: { provider, reason, ...meta },
    });
  }
}
class ShopifyGQLError extends AppError {
  constructor(messages) {
    super("Shopify GraphQL error.", {
      code: "shopify_graphql_error",
      status: 502,
      meta: { messages },
    });
  }
}

export function numberOr(a, fb) {
  return Number.isFinite(Number(a)) ? Number(a) : fb;
}
const toRad = (d) => (d * Math.PI) / 180;
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Caches ----------
const geocodeCache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 60 * 24 });
const locationGeoCache = new LRUCache({
  max: 2000,
  ttl: 1000 * 60 * 60 * 24 * 7,
});
const shopifyLocationsCache = new LRUCache({
  max: 200,
  ttl: 1000 * 60 * 30,
});

// ---------- Geocoding (Google → OSM) ----------
export async function geocode(address) {
  const original = String(address).trim();
  const key = `geo:${original}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const mode = (GEOCODER_MODE || "auto").toLowerCase();
  const cacheOk = (res) => {
    geocodeCache.set(key, res);
    return res;
  };

  // Detect numeric postcodes
  const is6 = /^\d{6}$/.test(original);
  const is4 = /^\d{4}$/.test(original);
  const isPinLike = is6 || is4;

  // 1) Google first (if allowed)
  if (mode !== "osm") {
    try {
      const url = "https://maps.googleapis.com/maps/api/geocode/json";
      let params;
      if (is6) {
        // 6-digit → assume India
        params = { key: GOOGLE_MAPS_KEY, components: `postal_code:${original}|country:IN` };
      } else if (is4) {
        // 4-digit → assume Australia
        params = { key: GOOGLE_MAPS_KEY, components: `postal_code:${original}|country:AU` };
      } else {
        // freeform text; keep a light region hint
        params = { key: GOOGLE_MAPS_KEY, address: original, region: "in" };
      }

      const { data } = await axios.get(url, { params });
      if (data.status === "OK" && data.results?.length) {
        const { lat, lng } = data.results[0].geometry.location;
        const formatted = data.results[0].formatted_address;
        return cacheOk({ lat, lng, formatted });
      } else if (mode === "google") {
        const msg = data.error_message ? ` - ${data.error_message}` : "";
        throw new GeocodeProviderError("google", `status=${data.status}${msg}`, {
          query: original,
        });
      }
    } catch (err) {
      if (mode === "google") throw err;
      // fall through to OSM
    }
  }

  // 2) OSM structured search
  if (isPinLike) {
    try {
      const osmUrl = "https://nominatim.openstreetmap.org/search";
      const params = is6
        ? { postalcode: original, country: "India", format: "jsonv2", addressdetails: 1, limit: 1 }
        : { postalcode: original, country: "Australia", format: "jsonv2", addressdetails: 1, limit: 1 };
      const headers = {
        "User-Agent": "ClickAndCollect/1.0 (contact: dev@example.com)",
        "Accept-Language": "en-IN,en;q=0.9",
      };
      const { data } = await axios.get(osmUrl, { params, headers });
      if (Array.isArray(data) && data.length > 0) {
        const it = data[0];
        return cacheOk({
          lat: Number(it.lat),
          lng: Number(it.lon),
          formatted: it.display_name,
        });
      }
    } catch {
      // continue to freeform
    }
  }

  // 3) OSM freeform fallback
  try {
    const osmUrl = "https://nominatim.openstreetmap.org/search";
    const params = is6
      ? { q: `${original}, India`, format: "jsonv2", addressdetails: 1, countrycodes: "in", limit: 1 }
      : is4
      ? { q: `${original}, Australia`, format: "jsonv2", addressdetails: 1, countrycodes: "au", limit: 1 }
      : { q: original, format: "jsonv2", addressdetails: 1, limit: 1 };
    const headers = {
      "User-Agent": "ClickAndCollect/1.0 (contact: dev@example.com)",
      "Accept-Language": "en-IN,en;q=0.9",
    };
    const { data } = await axios.get(osmUrl, { params, headers });
    if (Array.isArray(data) && data.length > 0) {
      const it = data[0];
      return cacheOk({
        lat: Number(it.lat),
        lng: Number(it.lon),
        formatted: it.display_name,
      });
    }
  } catch {}

  throw new GeocodeNoResultError(original);
}

// ---------- Shopify GraphQL helpers (per-shop session) ----------
function assertNoGqlErrors(resp) {
  if (resp?.data?.errors?.length) {
    const msgs = resp.data.errors.map((e) => e.message);
    throw new ShopifyGQLError(msgs);
  }
}

export function makeShopifyGqlClient(shop, accessToken) {
  if (!shop || !accessToken) {
    throw new AppError("Missing shop or access token for Shopify client.", {
      code: "shopify_auth_missing",
      status: 401,
    });
  }
  return axios.create({
    baseURL: `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

export async function fetchShopifyLocations(gql, shop) {
  const cacheKey = `locations:${shop}`;
  if (shopifyLocationsCache.has(cacheKey)) return shopifyLocationsCache.get(cacheKey);

  const locations = [];
  let cursor = null;
  let hasNext = true;

  const query = `
    query Locations($first:Int!, $after:String) {
      locations(first: $first, after: $after) {
        edges {
          cursor
          node {
            id
            name
            isActive
            fulfillsOnlineOrders
            address { address1 address2 city province country zip }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  while (hasNext) {
    const resp = await gql.post("", { query, variables: { first: 100, after: cursor } });
    assertNoGqlErrors(resp);
    const edges = resp?.data?.data?.locations?.edges || [];
    for (const e of edges) {
      const n = e.node;
      if (n.isActive /* && n.fulfillsOnlineOrders */) locations.push(n);
    }
    hasNext = resp?.data?.data?.locations?.pageInfo?.hasNextPage;
    cursor = edges.length ? edges[edges.length - 1].cursor : null;
  }

  shopifyLocationsCache.set(cacheKey, locations);
  return locations;
}

export async function getInventoryItemIdForVariant(gql, variantIdOrGid) {
  const gid = String(variantIdOrGid).startsWith("gid://")
    ? variantIdOrGid
    : `gid://shopify/ProductVariant/${variantIdOrGid}`;

  const query = `
    query InvItem($id: ID!) {
      productVariant(id: $id) { id inventoryItem { id } }
    }
  `;
  const resp = await gql.post("", { query, variables: { id: gid } });
  assertNoGqlErrors(resp);
  const id = resp?.data?.data?.productVariant?.inventoryItem?.id;
  if (!id) {
    throw new AppError("InventoryItem not found for this variant", {
      code: "inventory_item_missing",
      status: 404,
    });
  }
  return id;
}

export async function getInventoryByLocation(gql, invItemGid) {
  const query = `
    query Levels($id: ID!) {
      inventoryItem(id: $id) {
        id
        inventoryLevels(first: 250) {
          edges {
            node {
              quantities(names: "available") { name quantity }
              location { id name }
            }
          }
        }
      }
    }
  `;
  const resp = await gql.post("", { query, variables: { id: invItemGid } });
  assertNoGqlErrors(resp);

  const edges = resp?.data?.data?.inventoryItem?.inventoryLevels?.edges || [];
  const map = new Map();
  for (const e of edges) {
    const q = e.node.quantities?.find((q) => q.name === "available");
    map.set(e.node.location.id, q ? q.quantity : 0);
  }
  return map;
}

export async function geocodeShopifyLocation(loc) {
  const key = `loc:${loc.id}`;
  if (locationGeoCache.has(key)) return locationGeoCache.get(key);

  const a = loc.address || {};
  const fullAddr = [a.address1, a.address2, a.city, a.province, a.country, a.zip]
    .filter(Boolean)
    .join(", ");

  try {
    const g = await geocode(fullAddr);
    locationGeoCache.set(key, g);
    return g;
  } catch {
    if (a.zip) {
      try {
        const g2 = await geocode(a.zip);
        locationGeoCache.set(key, g2);
        return g2;
      } catch {}
    }
    const fail = { lat: 0, lng: 0, formatted: "Geocode failed" };
    locationGeoCache.set(key, fail);
    return fail;
  }
}

export async function buildPickupResponse({
  pincode,
  variantId,
  radiusKm,
  gql,
  shop,
}) {
  if (!pincode) {
    throw new AppError("pincode is required.", {
      code: "pincode_required",
      status: 400,
    });
  }

  // ✅ Accept 4 or 6 digit numeric codes
  if (!/^\d{4}$|^\d{6}$/.test(String(pincode).trim())) {
    throw new InvalidPincodeError(pincode);
  }

  const RADIUS = numberOr(radiusKm, numberOr(DEFAULT_RADIUS_KM, 100));
  const pin = await geocode(String(pincode));
  const locations = await fetchShopifyLocations(gql, shop);

  let invItemGid = null;
  let qtyByLoc = new Map();
  if (variantId) {
    invItemGid = await getInventoryItemIdForVariant(gql, variantId);
    qtyByLoc = await getInventoryByLocation(gql, invItemGid);
  }

  const enriched = (
    await Promise.all(
      locations.map(async (loc) => {
        const g = await geocodeShopifyLocation(loc);
        if (g.lat === 0 && g.lng === 0) return null;
        const distanceKm = haversineKm(
          { lat: pin.lat, lng: pin.lng },
          { lat: g.lat, lng: g.lng }
        );
        const qty = qtyByLoc.has(loc.id) ? qtyByLoc.get(loc.id) : null;
        const status = qty === null ? "unknown" : qty > 0 ? "instock" : "outofstock";
        return {
          locationId: loc.id,
          name: loc.name,
          address: { ...loc.address, formatted: g.formatted },
          coordinates: { lat: g.lat, lng: g.lng },
          distanceKm: Number(distanceKm.toFixed(2)),
          available: qty,
          status,
        };
      })
    )
  ).filter(Boolean);

  const inRadius = enriched
    .filter((x) => x.distanceKm <= RADIUS)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const outOfRadius = enriched
    .filter((x) => x.distanceKm > RADIUS)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    input: {
      pincode,
      geocoded: { lat: pin.lat, lng: pin.lng, address: pin.formatted },
      radiusKm: RADIUS,
      variantId: variantId ?? null,
      inventoryItemGid: invItemGid ?? null,
    },
    inRadius,
    outOfRadius,
  };
}