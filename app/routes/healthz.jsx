// app/routes/healthz.jsx
import { json } from "@remix-run/node";

export async function loader() {
  return json({ ok: true, time: new Date().toISOString() });
}
