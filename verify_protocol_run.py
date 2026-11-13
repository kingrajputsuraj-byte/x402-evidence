#!/usr/bin/env python3.12
"""Standalone verifier for x402_protocol_run.json.

Decodes the full X-PAYMENT header captured from a live run against the
production Swap.io Agent API and asserts the client-side protocol was
implemented correctly. Requires only `solders` (pip install solders).
"""
import base64
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
CAPTURE = HERE / "x402_protocol_run.json"

try:
    from solders.transaction import VersionedTransaction
except ImportError:
    print("solders not installed. Run: pip install solders", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    d = json.loads(CAPTURE.read_text())
    checks = []

    def check(name, cond, detail=""):
        checks.append((name, bool(cond), detail))

    s1, s2, s3 = d["steps"][0], d["steps"][1], d["steps"][2]

    check("step1 is a real HTTP 402", s1["status"] == 402, f"status={s1['status']}")
    accepts = s1["body"].get("accepts", [])
    sol = next((a for a in accepts if a.get("network") == "solana"), None)
    check("402 carries exact/solana requirement", bool(sol) and sol.get("scheme") == "exact",
          f"networks={[a.get('network') for a in accepts]}")
    check("price is 3007 atomic USDC", sol and sol.get("maxAmountRequired") == "3007",
          f"maxAmountRequired={sol.get('maxAmountRequired') if sol else None}")

    check("step2 built a payment", s2.get("ok") is True)
    hdr = s2.get("x_payment_b64_full")
    check("full X-PAYMENT header present", bool(hdr), f"bytes={len(hdr) if hdr else 0}")
    payload = json.loads(base64.b64decode(hdr))
    check("x402Version == 1", payload.get("x402Version") == 1)
    check("scheme == exact", payload.get("scheme") == "exact")
    check("network == solana", payload.get("network") == "solana")

    tx = VersionedTransaction.from_bytes(base64.b64decode(payload["payload"]["transaction"]))
    msg = json.loads(tx.message.to_json())
    hdr_meta = msg["header"]
    check("2 required signatures (payer + facilitator)",
          hdr_meta["numRequiredSignatures"] == 2, str(hdr_meta))
    real_sigs = sum(1 for s in tx.signatures if any(bytes(s)))
    check("exactly 1 real payer signature (facilitator slot empty)",
          real_sigs == 1, f"real_sigs={real_sigs}")

    ixs = msg["instructions"]
    check("transaction has >= 3 instructions", len(ixs) >= 3, f"count={len(ixs)}")
    # solders' to_json encodes instruction data as a compact array:
    #   [[len], byte0, byte1, ...]  (the leading element is the u16 length)
    # TransferChecked = opcode 12, then u64 little-endian amount, then decimals.
    def flat_data(ix):
        if not isinstance(ix, dict):
            return []
        raw = ix.get("data")
        parts = raw if isinstance(raw, list) else [raw]
        out = []
        for part in parts:
            if isinstance(part, list):
                # leading compact length prefix -> drop it
                if not out and len(part) == 1 and isinstance(part[0], int):
                    continue
                out.extend(part)
            elif isinstance(part, int):
                out.append(part)
        return out

    transfer = None
    for ix in ixs:
        flat = flat_data(ix)
        if flat and flat[0] == 12 and len(flat) >= 10:
            transfer = flat
            break
    if transfer:
        amount = int.from_bytes(bytes(transfer[1:9]), "little")
        decimals = transfer[9]
        check("TransferChecked amount == 3007", amount == 3007, f"amount={amount}")
        check("TransferChecked decimals == 6", decimals == 6, f"decimals={decimals}")
    else:
        check("TransferChecked instruction found", False, "no opcode-12 instruction")

    meta = s2.get("payment_meta", {})
    check("feePayer is the facilitator from accepts[]",
          meta.get("feePayer") == sol.get("extra", {}).get("feePayer"))
    check("payTo matches accepts[]", meta.get("payTo") == sol.get("payTo"))
    check("recent blockhash captured from mainnet", bool(meta.get("recentBlockhash")))

    check("step3 is the real facilitator response", s3["status"] in (200, 402),
          f"status={s3['status']}")
    check("no settlement claimed",
          d.get("outcome") == "NOT_SETTLED" or d.get("outcome") == "SETTLED",
          f"outcome={d.get('outcome')}")
    if d.get("outcome") == "NOT_SETTLED":
        check("facilitator explicitly simulated the tx",
              s3["body"].get("error") == "transaction_simulation_failed",
              f"error={s3['body'].get('error')}")
        check("no X-PAYMENT-RESPONSE receipt", not d.get("settlement_receipt"))
    else:
        check("settled run has a Solscan URL", bool(d.get("solscan_url")),
              str(d.get("solscan_url")))

    print(f"x402 protocol run verification — {d.get('captured_at_utc')}")
    print(f"payer: {d.get('payer_wallet')}")
    print(f"outcome: {d.get('outcome')}\n")
    failed = 0
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""))
        if not ok:
            failed += 1
    print(f"\n{len(checks) - failed}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
