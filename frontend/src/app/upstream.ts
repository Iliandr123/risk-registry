import "server-only";

import { ApiError } from "./api";

type IncomingHeaders = Pick<Headers, "get">;

export async function upstream(path: string, init: RequestInit, incoming: IncomingHeaders) {
  const origin = new URL(process.env.RISK_API_ORIGIN ?? "http://127.0.0.1:8080").origin;
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) {
    throw new ApiError(404, "NOT_FOUND", "Операция недоступна.");
  }

  const headers = new Headers(init.headers);
  const cookie = incoming.get("cookie");
  if (cookie) {
    const apiCookies = cookie.split(";").map((value) => value.trim()).filter((value) =>
      value.startsWith("__Host-risk_session=") || value.startsWith("__Host-risk_csrf="));
    if (apiCookies.length) headers.set("cookie", apiCookies.join("; "));
  }
  return fetch(url, { ...init, headers, cache: "no-store", redirect: "manual" });
}
