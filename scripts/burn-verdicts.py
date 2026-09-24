#!/usr/bin/env python3
"""
Circle's verdict on every burn an account sent since a cutoff, read from the Iris sandbox.

Used to bisect the lowest `max_fee` Circle's Forwarding Service accepts (see
scripts/test-cctp-forwarding.sh). Reads the account's recent Stellar TESTNET transactions from
Horizon, keeps the expensive ones (a burn costs several times an approve), and asks Iris what each
became. The max_fee shown is Circle's own record of the burn, so it never depends on a log kept by
whoever sent it.

    scripts/burn-verdicts.py <stellar-identity-or-G-address> <since, e.g. 2026-09-21T10:56>

`forwardState`: COMPLETE = Circle minted it; FAILED (+ error code) = it did not; no message = Iris
has not indexed the burn. FAILED is visible as soon as the message is attested; COMPLETE arrives
minutes later.
"""
import json
import subprocess
import sys
import urllib.request

HORIZON = "https://horizon-testnet.stellar.org"
IRIS = "https://iris-api-sandbox.circle.com/v2/messages/27"
BURN_FEE_FLOOR = 20000  # an approve costs ~11.5k stroops here, a burn 29k+


def fetch(url):
    req = urllib.request.Request(url, headers={"user-agent": "curl/8"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def main():
    who, since = sys.argv[1], sys.argv[2]
    addr = who if who.startswith("G") else subprocess.run(
        ["stellar", "keys", "address", who], capture_output=True, text=True, check=True
    ).stdout.strip()
    recs = fetch(f"{HORIZON}/accounts/{addr}/transactions?order=desc&limit=50")["_embedded"]["records"]
    burns = sorted(
        (t for t in recs if int(t["fee_charged"]) > BURN_FEE_FLOOR and t["created_at"] >= since),
        key=lambda t: t["created_at"],
    )
    print(f"{len(burns)} burns since {since}")
    print("%-9s %-5s %-8s %-8s %-13s %-18s %s" % ("time", "dest", "maxFee", "charged", "forwardState", "error", "tx"))
    for t in burns:
        h = t["hash"]
        try:
            m = fetch(f"{IRIS}?transactionHash={h}")["messages"][0]
        except Exception:
            print("%-9s %-5s %-8s %-8s %-13s %-18s %s" % (t["created_at"][11:19], "-", "-", "-", "no message", "", h))
            continue
        dm = m.get("decodedMessage") or {}
        b = dm.get("decodedMessageBody") or {}
        print("%-9s %-5s %-8s %-8s %-13s %-18s %s" % (
            t["created_at"][11:19], dm.get("destinationDomain"), b.get("maxFee"), b.get("feeExecuted"),
            m.get("forwardState"), m.get("forwardErrorCode"), h))


main()
