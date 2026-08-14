import type { Horizon } from "@stellar/stellar-sdk";
import type { claims, intents } from "@xebra/db";
import {
  nativeXlmAssetRef,
  stellarAddressToChainAddress,
  stellarClassicAssetRef,
} from "@xebra/intent-schema";
import { describe, expect, it, vi } from "vitest";
import type { ClaimLookup } from "./lookup-claim.js";
import {
  type StellarFulfillmentSource,
  stellarAmountToStroops,
  verifyStellarFulfillment,
} from "./verify-stellar-fulfillment.js";

const INTENT_HASH = `0x${"66".repeat(32)}` as const;
const RECIPIENT_G = "GAUOB3MN5QAJV75G7ID253KYOWCRYB7U6BQ4WOVPXJAGVRNGRI7NJVTT";

function claimLookup(
  overrides: { destAssetId?: string; minDestAmount?: string } = {},
): ClaimLookup {
  const intent = {
    intentHash: INTENT_HASH,
    destAssetId: overrides.destAssetId ?? nativeXlmAssetRef().assetId,
    minDestAmount: overrides.minDestAmount ?? "500000000", // 50 XLM, 7-decimal stroops
    destAddress: stellarAddressToChainAddress(RECIPIENT_G),
  } as unknown as typeof intents.$inferSelect;

  const claim = {
    intentHash: INTENT_HASH,
    destTxRef: "tx1",
  } as unknown as typeof claims.$inferSelect;

  return { intent, claim };
}

function txFixture(): Horizon.ServerApi.TransactionRecord {
  return {
    memo_type: "hash",
    memo: Buffer.from(INTENT_HASH.slice(2), "hex").toString("base64"),
  } as unknown as Horizon.ServerApi.TransactionRecord;
}

function nativePaymentFixture(
  overrides: { to?: string; amount?: string } = {},
): Horizon.ServerApi.PaymentOperationRecord {
  return {
    id: "op1",
    transaction_hash: "tx1",
    created_at: "2026-01-01T00:00:00Z",
    from: "GFROM",
    to: overrides.to ?? RECIPIENT_G,
    asset_type: "native",
    amount: overrides.amount ?? "50.0000000",
  } as unknown as Horizon.ServerApi.PaymentOperationRecord;
}

describe("stellarAmountToStroops", () => {
  it("parses a whole-and-fraction amount", () => {
    expect(stellarAmountToStroops("50.0000000")).toBe(500_000_000n);
  });

  it("parses an amount with no fractional part", () => {
    expect(stellarAmountToStroops("50")).toBe(500_000_000n);
  });

  it("truncates a fraction longer than 7 digits rather than throwing", () => {
    expect(stellarAmountToStroops("1.23456789")).toBe(12_345_678n);
  });
});

describe("verifyStellarFulfillment", () => {
  it("verifies a well-formed native-XLM payment", async () => {
    const source: StellarFulfillmentSource = {
      getTransaction: vi.fn(async () => txFixture()),
      getPaymentsForTransaction: vi.fn(async () => [nativePaymentFixture()]),
    };

    const result = await verifyStellarFulfillment(source, claimLookup());
    expect(result).toEqual({ ok: true, verified: true });
  });

  it("reports verified=false when no payment matches the intent hash's memo", async () => {
    const source: StellarFulfillmentSource = {
      getTransaction: vi.fn(
        async () => ({ memo_type: "none" }) as unknown as Horizon.ServerApi.TransactionRecord,
      ),
      getPaymentsForTransaction: vi.fn(async () => [nativePaymentFixture()]),
    };

    const result = await verifyStellarFulfillment(source, claimLookup());
    expect(result).toEqual({
      ok: true,
      verified: false,
      reason: "no payment in this transaction satisfies the intent",
    });
  });

  it("reports verified=false when the payment goes to a different recipient", async () => {
    const source: StellarFulfillmentSource = {
      getTransaction: vi.fn(async () => txFixture()),
      getPaymentsForTransaction: vi.fn(async () => [
        nativePaymentFixture({ to: "GWRONGRECIPIENT" }),
      ]),
    };

    const result = await verifyStellarFulfillment(source, claimLookup());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verified).toBe(false);
  });

  it("reports verified=false when the amount is below the required minimum", async () => {
    const source: StellarFulfillmentSource = {
      getTransaction: vi.fn(async () => txFixture()),
      getPaymentsForTransaction: vi.fn(async () => [nativePaymentFixture({ amount: "1.0000000" })]),
    };

    const result = await verifyStellarFulfillment(
      source,
      claimLookup({ minDestAmount: "500000000" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reason).toMatch(/below the required minimum/);
  });

  it("compares assets by hash, not by identity — a matching classic asset passes", async () => {
    const expected = stellarClassicAssetRef("USDC", "GISSUER");
    const source: StellarFulfillmentSource = {
      getTransaction: vi.fn(async () => txFixture()),
      getPaymentsForTransaction: vi.fn(async () => [
        {
          ...nativePaymentFixture(),
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: "GISSUER",
        } as unknown as Horizon.ServerApi.PaymentOperationRecord,
      ]),
    };

    const result = await verifyStellarFulfillment(
      source,
      claimLookup({ destAssetId: expected.assetId }),
    );
    expect(result).toEqual({ ok: true, verified: true });
  });

  it("rejects a payment in a different asset than the intent expects", async () => {
    const source: StellarFulfillmentSource = {
      getTransaction: vi.fn(async () => txFixture()),
      getPaymentsForTransaction: vi.fn(async () => [
        {
          ...nativePaymentFixture(),
          asset_type: "credit_alphanum4",
          asset_code: "OTHER",
          asset_issuer: "GOTHER",
        } as unknown as Horizon.ServerApi.PaymentOperationRecord,
      ]),
    };

    // intent expects native XLM (default), payment is a classic asset -> no match
    const result = await verifyStellarFulfillment(source, claimLookup());
    expect(result).toEqual({
      ok: true,
      verified: false,
      reason: "no payment in this transaction satisfies the intent",
    });
  });

  it("reports verified=false when the destination tx can't be found", async () => {
    const source: StellarFulfillmentSource = {
      getTransaction: vi.fn(async () => {
        throw new Error("not found");
      }),
      getPaymentsForTransaction: vi.fn(),
    };

    const result = await verifyStellarFulfillment(source, claimLookup());
    expect(result).toEqual({ ok: true, verified: false, reason: "destination tx not found" });
  });
});
