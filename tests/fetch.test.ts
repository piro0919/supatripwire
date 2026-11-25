import {
  context,
  propagation,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  TraceState,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tripwireFetch } from "../src/fetch.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

/** A fetch that records the headers it was called with. */
function recorder() {
  const calls: Headers[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers));
    return new Response(null, { status: 204 });
  };
  return { fetch, calls };
}

describe("tripwireFetch without OpenTelemetry", () => {
  it("adds x-forwarded-for and keeps the headers supabase-js set", async () => {
    const { fetch, calls } = recorder();
    // supabase-js passes its headers as a Headers object.
    await tripwireFetch({ clientIp: " 203.0.113.7 ", fetch })(
      "https://abc.supabase.co/rest/v1/projects",
      { headers: new Headers({ apikey: "k", Authorization: "Bearer t" }) },
    );
    expect(Object.fromEntries(calls[0] ?? [])).toEqual({
      apikey: "k",
      authorization: "Bearer t",
      "x-forwarded-for": "203.0.113.7",
    });
  });

  it("adds nothing for an empty IP, and no traceparent without a propagator", async () => {
    const { fetch, calls } = recorder();
    await tripwireFetch({ clientIp: "", fetch })("https://x", {});
    await tripwireFetch({ clientIp: null, fetch })("https://x");
    expect(calls.map((h) => [...h])).toEqual([[], []]);
  });

  it("leaves out an IP that is not a valid header value instead of failing", async () => {
    const { fetch, calls } = recorder();
    const response = await tripwireFetch({
      clientIp: "203.0.113.7\n198.51.100.1",
      fetch,
    })("https://x", {});
    expect(response.status).toBe(204);
    expect(calls[0]?.has("x-forwarded-for")).toBe(false);
  });

  it("does not overwrite headers the caller already set", async () => {
    const { fetch, calls } = recorder();
    await tripwireFetch({ clientIp: "203.0.113.7", fetch })("https://x", {
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    expect(calls[0]?.get("x-forwarded-for")).toBe("198.51.100.1");
  });

  it("takes the headers of a Request when no init is given", async () => {
    const { fetch, calls } = recorder();
    await tripwireFetch({ clientIp: "203.0.113.7", fetch })(
      new Request("https://x", { headers: { apikey: "k" } }),
    );
    expect(calls[0]?.get("apikey")).toBe("k");
    expect(calls[0]?.get("x-forwarded-for")).toBe("203.0.113.7");
  });
});

describe("tripwireFetch with OpenTelemetry", () => {
  beforeAll(() => {
    // What @vercel/otel registers: a context manager and the W3C propagator.
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    // W3C trace context plus baggage, as many setups register.
    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [
          new W3CTraceContextPropagator(),
          new W3CBaggagePropagator(),
        ],
      }),
    );
  });

  afterAll(() => {
    context.disable();
    propagation.disable();
  });

  const active = propagation.setBaggage(
    trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      traceState: new TraceState("vendor=abc"),
    }),
    propagation.createBaggage({ userEmail: { value: "a@example.com" } }),
  );

  it("sends the trace context but never the app's baggage", async () => {
    const { fetch, calls } = recorder();
    const wrapped = tripwireFetch({ fetch });
    await context.with(active, () => wrapped("https://x", {}));
    await context.with(active, () =>
      wrapped("https://x", {
        headers: { baggage: "tenant=a", tracestate: "own=1" },
      }),
    );
    expect(calls[0]?.get("tracestate")).toBe("vendor=abc");
    expect(calls[0]?.has("baggage")).toBe(false);
    expect(calls[1]?.get("baggage")).toBe("tenant=a");
    expect(calls[1]?.get("tracestate")).toBe("own=1");
  });

  it("sends the active span's trace id as traceparent", async () => {
    const { fetch, calls } = recorder();
    const wrapped = tripwireFetch({ fetch });
    await context.with(active, () => wrapped("https://x", {}));
    expect(calls[0]?.get("traceparent")).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("adds no traceparent outside a span", async () => {
    const { fetch, calls } = recorder();
    await tripwireFetch({ fetch })("https://x", {});
    expect(calls[0]?.has("traceparent")).toBe(false);
  });

  it("keeps a traceparent the caller already set", async () => {
    const { fetch, calls } = recorder();
    const own = "00-11111111111111111111111111111111-2222222222222222-01";
    const wrapped = tripwireFetch({ fetch });
    await context.with(active, () =>
      wrapped("https://x", { headers: { traceparent: own } }),
    );
    expect(calls[0]?.get("traceparent")).toBe(own);
  });
});
