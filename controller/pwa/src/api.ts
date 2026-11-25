import { createClient } from "@supabase/supabase-js";
import type { State } from "./domain";
// Publishable identifier only. Provider/service-role keys never belong in this project.
export const SUPABASE_URL = "https://yepupldfjtikalfzehvl.supabase.co";
export const PUBLISHABLE_KEY = "sb_publishable_QT1uT47eklMxXZAHNkhmhw_Dh4UB157";
export const auth = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: {
    storage: window.sessionStorage,
    storageKey: "adarsh-controller-auth",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
export async function admin<T = State>(
  payload: Record<string, unknown>,
): Promise<T> {
  const {
    data: { session },
  } = await auth.auth.getSession();
  if (!session) throw new Error("Owner login zaroori hai.");
  const response = await fetch(
    `${SUPABASE_URL}/functions/v1/controller-admin`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = await response
    .json()
    .catch(() => ({ error: "Backend response samajh nahi aaya." }));
  if (!response.ok || body.ok === false) {
    if (response.status === 409)
      throw new Error(
        "Config kisi aur session mein badla hai. Refresh karke changes dobara karo.",
      );
    if (response.status === 403)
      throw new Error(
        "Is account ko controller-admin access nahi mila. Owner allowlist setup pending ho sakta hai.",
      );
    if (response.status === 404)
      throw new Error("Controller backend abhi deploy nahi hua.");
    if (response.status === 401)
      throw new Error("Session invalid/expired hai. Dobara login karo.");
    if (body.error && typeof body.error === "object") {
      const details = body.error.details;
      const route =
        details && typeof details.route === "string"
          ? ` Route: ${details.route}.`
          : "";
      const model =
        details && typeof details.model === "string"
          ? ` Model: ${details.model}.`
          : "";
      const invalidRoutes = Array.isArray(details?.invalid_routes)
        ? details.invalid_routes
            .slice(0, 4)
            .map((item: Record<string, unknown>) => {
              const key =
                typeof item?.route_key === "string"
                  ? item.route_key.slice(0, 100)
                  : "Route";
              const labels = Array.isArray(item?.unavailable_labels)
                ? item.unavailable_labels
                    .filter((v: unknown) => typeof v === "string")
                    .slice(0, 5)
                    .join(", ")
                    .slice(0, 200)
                : "";
              const reason =
                typeof item?.reason === "string"
                  ? item.reason.slice(0, 80)
                  : "invalid";
              return `${key}: ${reason}${labels ? ` (${labels})` : ""}`;
            })
            .join("; ")
        : "";
      throw new Error(
        `${typeof body.error.message === "string" ? body.error.message.slice(0, 240) : "Configuration/request invalid hai."}${route}${model}${invalidRoutes ? ` ${invalidRoutes}` : ""}`,
      );
    }
    throw new Error(
      typeof body.error === "string"
        ? body.error.slice(0, 240)
        : "Request fail hui. Dobara try karo.",
    );
  }
  return body as T;
}
