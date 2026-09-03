import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OneClickClient,
  computeQuoteHash,
  type QuoteRequest,
  type QuoteResponse,
} from "../src/services/oneClick.js";
import { jsonResponse, spy } from "./helpers.js";

const quoteReq: QuoteRequest = {
  dry: false,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:zec.omft.near",
  amount: "250000000",
  refundTo: "0x1111111111111111111111111111111111111111",
  refundType: "ORIGIN_CHAIN",
  recipient: "t1Le9mTDaqQUX1ANKaeDchpJsxEY4h5LQCX",
  recipientType: "DESTINATION_CHAIN",
  deadline: "2026-08-05T20:00:00.000Z",
};

describe("OneClickClient", () => {
  it("posts quote to /v0/quote with JWT header when configured", async () => {
    const fetchImpl = spy(async () =>
      jsonResponse({ quoteRequest: quoteReq, quote: { depositAddress: "0xabc" } })
    );
    const client = new OneClickClient({
      baseUrl: "https://1click.chaindefuser.com",
      jwt: "test-jwt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.getQuote(quoteReq);

    const [url, init] = fetchImpl.calls[0] as unknown as [string, RequestInit];
    assert.equal(url, "https://1click.chaindefuser.com/v0/quote");
    assert.equal(init.method, "POST");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-jwt");
    assert.equal(JSON.parse(init.body as string).recipient, quoteReq.recipient);
  });

  it("omits Authorization without JWT (0.2% fee mode)", async () => {
    const fetchImpl = spy(async () => jsonResponse([]));
    const client = new OneClickClient({
      baseUrl: "https://x.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.getTokens();
    const [, init] = fetchImpl.calls[0] as unknown as [string, RequestInit];
    assert.equal((init.headers as Record<string, string>).Authorization, undefined);
  });

  it("throws OneClickError with http status on failure", async () => {
    const fetchImpl = spy(async () => jsonResponse({ error: "bad" }, 400));
    const client = new OneClickClient({
      baseUrl: "https://x.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await assert.rejects(client.getQuote(quoteReq), (err: Error & { httpStatus?: number }) => {
      assert.equal(err.name, "OneClickError");
      assert.equal(err.httpStatus, 400);
      return true;
    });
  });

  it("builds status URL with encoded deposit address", async () => {
    const fetchImpl = spy(async () => jsonResponse({ status: "SUCCESS" }));
    const client = new OneClickClient({
      baseUrl: "https://x.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.getStatus("0xDep osit");
    assert.equal(res.status, "SUCCESS");
    const [url] = fetchImpl.calls[0] as unknown as [string];
    assert.equal(url, "https://x.example/v0/status?depositAddress=0xDep%20osit");
  });
});

describe("computeQuoteHash", () => {
  const quote: QuoteResponse = {
    quoteRequest: quoteReq,
    quote: {
      depositAddress: "0x2222222222222222222222222222222222222222",
      amountIn: "250000000",
      amountOut: "512345678",
    },
  };

  it("is deterministic", () => {
    assert.equal(computeQuoteHash(quote), computeQuoteHash(structuredClone(quote)));
  });

  it("changes when the recipient changes", () => {
    const tampered = structuredClone(quote);
    tampered.quoteRequest.recipient = "t1AttackerAddressAAAAAAAAAAAAAAAAAA";
    assert.notEqual(computeQuoteHash(tampered), computeQuoteHash(quote));
  });

  it("changes when the deposit address changes", () => {
    const tampered = structuredClone(quote);
    tampered.quote.depositAddress = "0x3333333333333333333333333333333333333333";
    assert.notEqual(computeQuoteHash(tampered), computeQuoteHash(quote));
  });
});
