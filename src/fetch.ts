import { context, propagation } from "@opentelemetry/api";

export type TripwireFetchOptions = {
  /**
   * The end user's IP, sent as `x-forwarded-for` so it lands in the log's
   * `request.headers.x_forwarded_for`. On Vercel, read it from the incoming
   * request's `x-real-ip` or `x-forwarded-for`. Left out when empty.
   */
  clientIp?: string | null;
  /** The fetch to wrap. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
};

/**
 * Wraps `fetch` for `createServerClient` so each request to Supabase carries
 * what a log line needs to be traced back:
 *
 * - `traceparent` from the active OpenTelemetry span, if the app has one, so
 *   the log's `trace_id` matches the hosting platform's trace of the request.
 *   Without OpenTelemetry set up, nothing is added.
 * - `x-forwarded-for` with the end user's IP. Server-side requests otherwise
 *   show the server's IP.
 *
 * Headers already set by the caller are kept.
 */
export function tripwireFetch(
  options: TripwireFetchOptions = {},
): typeof globalThis.fetch {
  const clientIp = options.clientIp?.trim();
  return (input, init) => {
    const base = options.fetch ?? globalThis.fetch;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (clientIp && !headers.has("x-forwarded-for")) {
      headers.set("x-forwarded-for", clientIp);
    }
    if (!headers.has("traceparent")) {
      // No-op unless the app registered a propagator (as @vercel/otel does).
      propagation.inject(context.active(), headers, {
        set: (carrier, key, value) => carrier.set(key, value),
      });
    }
    return base(input, { ...init, headers });
  };
}
