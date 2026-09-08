import { MAINNET_PASSPHRASE, type Network, NETWORKS, type NetworkPreset, PRESETS } from "./networks.js";

/**
 * Resolves the mainnet configuration, applies any explicit overrides, and cross-validates the
 * result so an incoherent mix cannot boot.
 *
 * The failure this prevents was live in this repo: a mainnet Soroban RPC URL paired with a
 * testnet network passphrase parsed fine, started fine, and would have signed transactions
 * against the wrong network. Individually-valid values are not enough — they have to agree.
 *
 * Testnet support has been removed. `NETWORK` must be `mainnet`; anything else is rejected
 * rather than silently accepted, so a stale `NETWORK=testnet` in an old shell or CI job fails
 * loudly instead of half-configuring the app.
 */

/** Any string map — `process.env`, a parsed .env file, or a literal in a test. Deliberately
 *  not `NodeJS.ProcessEnv`, which requires NODE_ENV and forces awkward casts at call sites. */
export type EnvLike = Record<string, string | undefined>;

export interface NetworkConfig extends NetworkPreset {
  /** Which fields came from env rather than the preset. Logged at startup so a surprising
   *  override is visible in production logs instead of being invisible. */
  overrides: string[];
}

export class NetworkConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid network configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "NetworkConfigError";
  }
}

/** Substrings that must never appear in any endpoint or address. */
const NON_MAINNET_MARKERS = [
  "testnet",
  "devnet",
  "sandbox",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
];

export function loadNetworkConfig(env: EnvLike = process.env): NetworkConfig {
  const raw = env.NETWORK?.trim();
  if (!raw) {
    throw new NetworkConfigError([
      "NETWORK is not set. It must be `mainnet`. There is deliberately no default — a " +
        "wrong-but-working default is how a misconfigured build reaches production.",
    ]);
  }
  if (!(NETWORKS as readonly string[]).includes(raw)) {
    throw new NetworkConfigError([
      `NETWORK="${raw}" is not supported. This is a mainnet-only build; testnet and local ` +
        "configurations were removed.",
    ]);
  }

  const preset = PRESETS.mainnet;
  const overrides: string[] = [];

  const pick = (name: string, presetValue: string): string => {
    const override = env[name]?.trim();
    if (override && override !== presetValue) {
      overrides.push(name);
      return override;
    }
    return presetValue;
  };

  const config: NetworkConfig = {
    network: "mainnet",
    stellar: {
      networkPassphrase: pick("STELLAR_NETWORK_PASSPHRASE", preset.stellar.networkPassphrase),
      sorobanRpcUrl: pick("SOROBAN_RPC_URL", preset.stellar.sorobanRpcUrl),
      horizonUrl: pick("HORIZON_URL", preset.stellar.horizonUrl),
      cctpDomainId: Number(pick("STELLAR_CCTP_DOMAIN_ID", String(preset.stellar.cctpDomainId))),
      tokenMessengerAddress: pick(
        "STELLAR_TOKEN_MESSENGER_ADDRESS",
        preset.stellar.tokenMessengerAddress,
      ),
      messageTransmitterAddress: pick(
        "STELLAR_MESSAGE_TRANSMITTER_ADDRESS",
        preset.stellar.messageTransmitterAddress,
      ),
      usdcAddress: pick("STELLAR_USDC_ADDRESS", preset.stellar.usdcAddress),
    },
    solana: {
      rpcUrl: pick("SOLANA_RPC_URL", preset.solana.rpcUrl),
      cctpDomainId: Number(pick("SOLANA_CCTP_DOMAIN_ID", String(preset.solana.cctpDomainId))),
      tokenMessengerAddress: pick(
        "SOLANA_TOKEN_MESSENGER_ADDRESS",
        preset.solana.tokenMessengerAddress,
      ),
      messageTransmitterAddress: pick(
        "SOLANA_MESSAGE_TRANSMITTER_ADDRESS",
        preset.solana.messageTransmitterAddress,
      ),
      usdcAddress: pick("SOLANA_USDC_ADDRESS", preset.solana.usdcAddress),
    },
    irisBaseUrl: pick("IRIS_BASE_URL", preset.irisBaseUrl),
    overrides: [],
  };
  config.overrides = overrides;

  const problems = validate(config);
  if (problems.length > 0) throw new NetworkConfigError(problems);

  return config;
}

/**
 * Returns every incoherence found, rather than throwing on the first — a misconfigured deploy
 * should show you all of it at once, not one problem per restart.
 */
export function validate(config: NetworkConfig): string[] {
  const problems: string[] = [];
  const { stellar, solana, irisBaseUrl } = config;
  const pinned = PRESETS.mainnet;

  // 1. The passphrase is the authoritative network fingerprint.
  if (stellar.networkPassphrase !== MAINNET_PASSPHRASE) {
    problems.push(
      `STELLAR_NETWORK_PASSPHRASE is not the mainnet passphrase. This exact mismatch signs ` +
        `transactions against the wrong network. Got: "${stellar.networkPassphrase}"`,
    );
  }

  // 2. Nothing may carry a non-production marker. Catches a half-finished promotion — a
  //    mainnet passphrase left pointing at a devnet RPC.
  const endpoints: Array<[string, string]> = [
    ["SOROBAN_RPC_URL", stellar.sorobanRpcUrl],
    ["HORIZON_URL", stellar.horizonUrl],
    ["SOLANA_RPC_URL", solana.rpcUrl],
    ["IRIS_BASE_URL", irisBaseUrl],
    ["STELLAR_TOKEN_MESSENGER_ADDRESS", stellar.tokenMessengerAddress],
    ["STELLAR_USDC_ADDRESS", stellar.usdcAddress],
    ["SOLANA_USDC_ADDRESS", solana.usdcAddress],
  ];
  for (const [name, value] of endpoints) {
    const marker = NON_MAINNET_MARKERS.find((m) => value.toLowerCase().includes(m));
    if (marker) problems.push(`${name} contains "${marker}" on a mainnet build: ${value}`);
  }

  // 3. Circle's contract identities are pinned. An override here is almost certainly a
  //    copy-paste from an old runbook.
  const mustMatch: Array<[string, string, string]> = [
    [
      "STELLAR_TOKEN_MESSENGER_ADDRESS",
      stellar.tokenMessengerAddress,
      pinned.stellar.tokenMessengerAddress,
    ],
    ["STELLAR_USDC_ADDRESS", stellar.usdcAddress, pinned.stellar.usdcAddress],
    ["SOLANA_USDC_ADDRESS", solana.usdcAddress, pinned.solana.usdcAddress],
  ];
  for (const [name, actual, expected] of mustMatch) {
    if (actual !== expected) {
      problems.push(
        `${name} is overridden to "${actual}" instead of the verified mainnet value ` +
          `"${expected}". Circle contract addresses are pinned; if Circle genuinely ` +
          `migrated, update packages/network-config and re-run scripts/check-cctp-interface.sh.`,
      );
    }
  }

  // 4. Required addresses.
  const required: Array<[string, string]> = [
    ["STELLAR_TOKEN_MESSENGER_ADDRESS", stellar.tokenMessengerAddress],
    ["STELLAR_MESSAGE_TRANSMITTER_ADDRESS", stellar.messageTransmitterAddress],
    ["STELLAR_USDC_ADDRESS", stellar.usdcAddress],
    ["SOLANA_TOKEN_MESSENGER_ADDRESS", solana.tokenMessengerAddress],
    ["SOLANA_MESSAGE_TRANSMITTER_ADDRESS", solana.messageTransmitterAddress],
    ["SOLANA_USDC_ADDRESS", solana.usdcAddress],
  ];
  for (const [name, value] of required) {
    if (!value) problems.push(`${name} is empty`);
  }

  // 5. Domain ids identify chains and never vary; a changed one means someone edited a value
  //    they should not have.
  if (stellar.cctpDomainId !== pinned.stellar.cctpDomainId) {
    problems.push(
      `STELLAR_CCTP_DOMAIN_ID must be ${pinned.stellar.cctpDomainId}, got ${stellar.cctpDomainId}`,
    );
  }
  if (solana.cctpDomainId !== pinned.solana.cctpDomainId) {
    problems.push(
      `SOLANA_CCTP_DOMAIN_ID must be ${pinned.solana.cctpDomainId}, got ${solana.cctpDomainId}`,
    );
  }

  // 6. Iris has separate production and sandbox deployments; attesting against the wrong one
  //    means every burn stays permanently "pending".
  if (irisBaseUrl !== pinned.irisBaseUrl) {
    problems.push(`IRIS_BASE_URL must be ${pinned.irisBaseUrl}, got ${irisBaseUrl}`);
  }

  return problems;
}

/** Build-time guard. Kept for CI, which asserts the build targets mainnet. */
export function assertNetwork(expected: Network, env: EnvLike = process.env): NetworkConfig {
  const config = loadNetworkConfig(env);
  if (config.network !== expected) {
    throw new NetworkConfigError([
      `Expected to build/run against "${expected}" but NETWORK resolved to "${config.network}".`,
    ]);
  }
  return config;
}

/** Adapter to the shape `packages/cctp-client` already declares in its `types.ts`. */
export function toCctpEnvironmentConfig(config: NetworkConfig) {
  return {
    irisBaseUrl: config.irisBaseUrl,
    stellar: {
      domainId: config.stellar.cctpDomainId,
      tokenMessengerAddress: config.stellar.tokenMessengerAddress,
      messageTransmitterAddress: config.stellar.messageTransmitterAddress,
      usdcAddress: config.stellar.usdcAddress,
    },
    solana: {
      domainId: config.solana.cctpDomainId,
      tokenMessengerAddress: config.solana.tokenMessengerAddress,
      messageTransmitterAddress: config.solana.messageTransmitterAddress,
      usdcAddress: config.solana.usdcAddress,
    },
  };
}

/** One-line startup summary. Log this from every service. */
export function describeNetworkConfig(config: NetworkConfig): string {
  const overrides =
    config.overrides.length > 0 ? ` overrides=[${config.overrides.join(",")}]` : " overrides=none";
  return (
    `network=${config.network} stellar=${config.stellar.sorobanRpcUrl} ` +
    `solana=${config.solana.rpcUrl} iris=${config.irisBaseUrl}${overrides}`
  );
}
