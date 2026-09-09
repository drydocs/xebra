import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { authorizeBearer, isStellarTxHash } from "@xebra/relay-core";

/**
 * The relay's submission endpoint.
 *
 * # Why this exists
 *
 * Until `contracts/stellar-cctp-wrapper` is deployed, the app burns straight through Circle's
 * contract, and those burns carry nothing on chain that identifies them as ours — the burn
 * watcher has no event to key off. The frontend therefore hands the relay the transaction hash
 * it just signed. The same endpoint doubles as the manual recovery path for any burn.
 *
 * # Why it is authenticated, when everything else here is permissionless
 *
 * Minting is not free to us: `used_nonce` rent alone is 867,621 lamports per transfer,
 * permanently. Circle's TokenMessengerMinter on Stellar serves *every* CCTP user, so an open
 * endpoint lets anyone paste in strangers' burn hashes and have this service sponsor their
 * mints indefinitely. That is a pure drain with no fee revenue against it.
 *
 * A bearer token shared with the web app's *server-side* route is the mitigation. It never
 * reaches a browser: `apps/web/app/api/relay/burns/route.ts` reads it from server env and
 * proxies. Comparison is constant-time over SHA-256 digests, so token length does not leak and
 * `timingSafeEqual`'s equal-length requirement is satisfied without a branch on length.
 *
 * Note what the token does *not* protect: it gates who can spend our SOL, not who can receive
 * funds. A burn is always claimable by anyone with the attestation, including the user, with or
 * without this service (docs/architecture.md §5). Losing the token cannot strand anyone.
 */

export type SubmitHandler = (txHash: string) => Promise<{ jobId: string; created: boolean }>;

export interface RelayHttpOptions {
  submit: SubmitHandler;
  /** Shared secret. Required — a relay that would sponsor mints for unauthenticated callers is
   *  a configuration error, not a mode. */
  submitToken: string;
  /** Reports whether the process is healthy enough to take traffic. */
  health?: () => Promise<{ ok: boolean; detail?: Record<string, unknown> }>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readJson(req: IncomingMessage, limitBytes = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Bounded so a large body cannot be used to exhaust memory on an unauthenticated route.
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The request handler, exported separately from the server so it can be tested without
 *  binding a port. */
export function createRelayHandler(options: RelayHttpOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay.invalid");

    if (req.method === "GET" && url.pathname === "/health") {
      const result = (await options.health?.()) ?? { ok: true };
      send(res, result.ok ? 200 : 503, result);
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/burns") {
      send(res, 404, { error: "not found" });
      return;
    }

    if (!authorizeBearer(req.headers.authorization, options.submitToken)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : "invalid JSON" });
      return;
    }

    const txHash =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).txHash
        : undefined;

    if (!isStellarTxHash(txHash)) {
      send(res, 400, { error: "txHash must be a 64-character lower-case hex string" });
      return;
    }

    try {
      const result = await options.submit(txHash);
      options.log?.("burn submitted", { txHash, ...result });
      // 200 rather than 201 on a duplicate: the caller retrying must see success, not a
      // conflict. Idempotency is the point — the frontend retries on a flaky network, and a
      // second POST for the same burn must not look like a failure.
      send(res, result.created ? 201 : 200, result);
    } catch (err) {
      options.log?.("burn submission failed", {
        txHash,
        error: err instanceof Error ? err.message : String(err),
      });
      send(res, 500, { error: "could not queue the burn" });
    }
  };
}

export function startRelayHttpServer(options: RelayHttpOptions & { port: number }): Server {
  const handle = createRelayHandler(options);
  const server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { error: "internal error" }));
  });
  server.listen(options.port);
  return server;
}
