import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { describe, expect, it } from "vitest";
import { connectEvm, evmEntries, reduceAnnouncements } from "./evm";
import { isSolanaWallet, pickSolanaAccount, solanaEntries } from "./solana";
import type { Eip1193Provider } from "./types";

const provider = (accounts: unknown): Eip1193Provider => ({
  request: async () => accounts,
});
const detail = (rdns: string, name: string, icon = "data:image/svg+xml;base64,AAAA") => ({
  info: { uuid: rdns, name, icon, rdns },
  provider: provider([]),
});

describe("EIP-6963", () => {
  it("keys announcements by rdns so a repeat is one wallet", () => {
    let m = reduceAnnouncements(new Map(), detail("io.metamask", "MetaMask"));
    m = reduceAnnouncements(m, detail("io.metamask", "MetaMask"));
    m = reduceAnnouncements(m, detail("app.phantom", "Phantom"));
    expect(evmEntries(m, null).map((e) => e.name)).toEqual(["MetaMask", "Phantom"]);
  });
  it("ignores malformed announcements", () => {
    let m = reduceAnnouncements(new Map(), null);
    m = reduceAnnouncements(m, { info: { rdns: 1 }, provider: {} });
    m = reduceAnnouncements(m, { info: { rdns: "x", name: "X" } });
    expect(m.size).toBe(0);
  });
  it("drops icons that are not data: images or https", () => {
    const m = reduceAnnouncements(new Map(), detail("evil", "Evil", "javascript:alert(1)"));
    expect(evmEntries(m, null)[0]?.icon).toBeNull();
  });
  it("offers the legacy global only when nothing announced", () => {
    expect(evmEntries(new Map(), provider([]))[0]?.key).toBe("evm:injected");
    expect(evmEntries(new Map(), null)).toEqual([]);
    const m = reduceAnnouncements(new Map(), detail("io.metamask", "MetaMask"));
    expect(evmEntries(m, provider([])).some((e) => e.key === "evm:injected")).toBe(false);
  });
  it("connects and validates the address", async () => {
    const entry = evmEntries(reduceAnnouncements(new Map(), detail("a", "A")), null)[0];
    if (!entry) throw new Error("no entry");
    const good = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
    expect((await connectEvm(entry, provider([good]))).address).toBe(good);
    await expect(connectEvm(entry, provider([]))).rejects.toThrow(/address/);
    await expect(connectEvm(entry, provider(["nope"]))).rejects.toThrow(/address/);
  });
});

const fakeWallet = (name: string, chains: string[], connect = true) =>
  ({
    name,
    icon: "data:image/png;base64,AAAA",
    version: "1.0.0",
    chains,
    features: connect ? { "standard:connect": {} } : {},
    accounts: [],
  }) as unknown as Wallet;

describe("Wallet Standard (Solana)", () => {
  it("keeps only Solana wallets that can connect", () => {
    const list = [
      fakeWallet("Phantom", ["solana:mainnet"]),
      fakeWallet("Rabby", ["eip155:1"]),
      fakeWallet("NoConnect", ["solana:mainnet"], false),
    ];
    expect(list.map(isSolanaWallet)).toEqual([true, false, false]);
    expect(solanaEntries(list).map((e) => e.name)).toEqual(["Phantom"]);
  });
  it("prefers a Solana account when a wallet is multi-chain", () => {
    const acct = (address: string, chains: string[]) =>
      ({ address, chains }) as unknown as WalletAccount;
    const picked = pickSolanaAccount([
      acct("0xabc", ["eip155:1"]),
      acct("SoL111", ["solana:mainnet"]),
    ]);
    expect(picked?.address).toBe("SoL111");
    expect(pickSolanaAccount([acct("0xabc", ["eip155:1"])])).toBeNull();
  });
});
