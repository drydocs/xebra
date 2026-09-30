import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decideGate } from "./lib/admin/gate";

/** Gate for the admin panel only. See lib/admin/gate.ts for why this is not the security boundary. */
export function middleware(req: NextRequest) {
  const decision = decideGate({
    password: process.env.ADMIN_PASSWORD,
    allowedIps: process.env.ADMIN_ALLOWED_IPS,
    authorization: req.headers.get("authorization"),
    clientIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });
  if (decision.allow) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  }
  return new NextResponse(decision.status === 404 ? "Not found" : "Unauthorized", {
    status: decision.status,
    headers: decision.challenge
      ? { "WWW-Authenticate": 'Basic realm="xebra-admin", charset="UTF-8"' }
      : {},
  });
}

export const config = { matcher: ["/admin", "/admin/:path*"] };
