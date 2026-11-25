import { context, propagation } from "@opentelemetry/api";

export type TripwireFetchOptions = {
  /**
   * The end user's IP, sent as `x-forwarded-for` so it lands in the log's
   * `request.headers.x_forwarded_for`. On Vercel, read it from the incoming
   * request's `x-forwarded-for`; behind your own proxy, from the header that
   * proxy sets. Left out when empty or not a valid header value.
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
 * Headers already set by the caller are kept, and no other propagated field
 * (such as `baggage`) is sent.
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
      try {
        headers.set("x-forwarded-for", clientIp);
      } catch {
        // Not a valid header value (a line break, say). Leave it out rather
        // than fail every request to Supabase.
      }
    }
    if (!headers.has("traceparent")) {
      // Inject into a scratch carrier and copy only the trace context: a
      // composite propagator also writes baggage, which would overwrite the
      // caller's and send the app's baggage to Supabase. No-op unless the app
      // registered a propagator (as @vercel/otel does).
      const injected = new Headers();
      propagation.inject(context.active(), injected, {
        set: (carrier, key, value) => carrier.set(key, value),
      });
      const traceparent = injected.get("traceparent");
      if (traceparent) {
        headers.set("traceparent", traceparent);
        const tracestate = injected.get("tracestate");
        if (tracestate && !headers.has("tracestate")) {
          headers.set("tracestate", tracestate);
        }
      }
    }
    return base(input, { ...init, headers });
  };
}
