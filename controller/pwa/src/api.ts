import { createClient } from "@supabase/supabase-js";
import type { State } from "./domain";
// Publishable identifier only. Provider/service-role keys never belong in this project.
export const SUPABASE_URL = "https://yepupldfjtikalfzehvl.supabase.co";
export const PUBLISHABLE_KEY = "sb_publishable_QT1uT47eklMxXZAHNkhmhw_Dh4UB157";
export const auth = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: {
    storage: window.localStorage,
    storageKey: "adarsh-controller-auth",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    for (const key of ["message", "error_description", "details", "hint"]) {
      if (typeof item[key] === "string" && item[key]) return item[key] as string;
    }
    try { return JSON.stringify(value); } catch { return "Request failed."; }
  }
  return "Request failed.";
}
export async function admin<T = State>(
  payload: Record<string, unknown>,
): Promise<T> {
  let {
    data: { session },
  } = await auth.auth.getSession();
  if (!session) throw new Error("Owner login zaroori hai.");
  let response: Response;
  try {
    response = await fetch(
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
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new Error("Controller temporarily unavailable hai. Network/timeout ke baad dobara try karo.");
    throw new Error("Controller temporarily unavailable hai. Network check karke dobara try karo.");
  }
  // A sleeping tab can hold an expired access token despite auto-refresh. Refresh once,
  // then retry the same request; a second 401 is handled below without forcing a re-pair.
  if (response.status === 401) {
    const refreshed = await auth.auth.refreshSession();
    session = refreshed.data.session;
    if (session) {
      try {
        response = await fetch(
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
      } catch {
        throw new Error("Controller temporarily unavailable hai. Network check karke dobara try karo.");
      }
    }
  }
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
    throw new Error(errorText(body.error).slice(0, 240));
  }
  return body as T;
}
