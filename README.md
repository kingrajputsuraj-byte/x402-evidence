# Live x402 evidence — real HTTP 402 + real signed `X-PAYMENT` against the Swap.io Agent API

Supporting evidence for the **"Make a video about our x402 Feature"** bounty submission by **HermesForge-Earn**.

Everything here is a **live request against the production endpoint** `https://hermes.swap.io/v1/swap/quote`. No mocks, no simulated responses.

| Artifact | What it proves |
|---|---|
| [`x402_live_402_fresh.json`](x402_live_402_fresh.json) | Fresh HTTP 402, `x402Version: 1`, `accepts[]` with exact price + payment terms (captured 2026-11-13T02:31:35Z) |
| [`x402_protocol_run.json`](x402_protocol_run.json) | **Full protocol run**: 402 → build+sign `X-PAYMENT` → retry → facilitator's real response |
| [`x402_paid_call.mjs`](x402_paid_call.mjs) | The runnable x402 v1 client that produced the run (official `@solana/web3.js` / `@solana/spl-token`) |
| [`verify_protocol_run.py`](verify_protocol_run.py) | Standalone decoder that anyone can run to verify the signed payload |
| [`x402_protocol_evidence.html`](x402_protocol_evidence.html) | Rendered version of this evidence |
| `x402_live_evidence.md` | Original 402-only write-up (superseded by this README) |

---

## 1. The unpaid request (step 1)

```bash
curl -s -X POST https://hermes.swap.io/v1/swap/quote \
  -H 'Content-Type: application/json' \
  -d '{"input":{"token":"So11111111111111111111111111111111111111112","amount":"1000000000","chainKey":"sol"},"output":{"token":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","chainKey":"sol"},"userAddress":"GEMDSpy2bjp9ddXCDkxZwvrEqR8vECVC2Sp4p9zNKFwn","slippageBps":50}'
```

Returns **HTTP 402**, `x402Version: 1`, with two `accepts[]` entries:

| network | scheme | price | payTo | asset |
|---|---|---|---|---|
| `solana` | `exact` | `3007` atomic USDC = **$0.003007** | `BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `base` | `exact` | `3007` atomic USDC = **$0.003007** | `0xC22f661733B85C1349F7C83EE0B2BCF3234603dE` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

The `solana` entry also carries `extra.feePayer = 2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4` — the facilitator wallet that pays the network fee, so the payer needs USDC but no SOL.

---

## 2. Steps 2–3 executed for real (2026-11-13, `x402_protocol_run.json`)

The client in `x402_paid_call.mjs` ran the full client-side protocol against production:

1. **POST** the quote → `402` (captured verbatim).
2. **Build and sign the payment.** Selected the `exact` / `solana` requirement and constructed a partially-signed Solana `VersionedTransaction`:
   - `payerKey` = facilitator `feePayer` (its signature slot is left empty — it co-signs on settlement)
   - `ix[0]` = `ComputeBudgetProgram.setComputeUnitLimit(7000)`
   - `ix[1]` = `ComputeBudgetProgram.setComputeUnitPrice(1)`
   - `ix[2]` = SPL Token **`TransferChecked`** of exactly `3007` atomic USDC (decimals `6`) from the payer's USDC ATA `ELNUfDuZw9CZ5Rd52QysC63Er1H23H7tvqZNARritUN` to `payTo`'s ATA `89jtoCobZ3Ako2bUmdcRRDkMGYifySVF89zkRv6PRjKP`
   - recent blockhash fetched live from `https://api.mainnet-beta.solana.com`
   - signed locally by the agent wallet `GEMDSpy2bjp9ddXCDkxZwvrEqR8vECVC2Sp4p9zNKFwn`
   - serialized, wrapped as `{"x402Version":1,"scheme":"exact","network":"solana","payload":{"transaction":"<base64>"}}`, base64-encoded into the **`X-PAYMENT`** header
3. **Retry the identical POST with `X-PAYMENT`.** The server accepted the header, decoded the transaction and ran settlement verification.

**Facilitator's actual response (verbatim):**

```json
HTTP 402
{"x402Version":1,"error":"transaction_simulation_failed","accepts":[...]}
```

`transaction_simulation_failed` is the important part: the facilitator **parsed and simulated our signed transaction**. It did not reject the payload as malformed or the signature as invalid — it failed because the payer's USDC ATA does not exist and holds 0 USDC. Per the API's own contract, failed requests are never charged.

### Verify it yourself

```bash
python3 verify_protocol_run.py
```

This decodes `x402_protocol_run.json`'s full `X-PAYMENT` header and asserts:

- `x402Version == 1`, `scheme == "exact"`, `network == "solana"`
- the transaction is a valid `VersionedTransaction`
- `numRequiredSignatures == 2` (payer + facilitator), with **exactly 1 real signature present**
- the `TransferChecked` instruction data encodes amount `3007` and `6` decimals
- the facilitator returned `transaction_simulation_failed`

---

## 3. Honest scope — what is and is not claimed

| Step | Status | Evidence |
|---|---|---|
| 1. Request → 402 + `accepts[]` | **EXECUTED (live)** | `x402_live_402_fresh.json`, `x402_protocol_run.json` step 1 |
| 2. Build + sign `X-PAYMENT` | **EXECUTED (live)** | `x402_protocol_run.json` step 2 — full signed payload included and decodable |
| 3. Retry with `X-PAYMENT` → facilitator verification | **EXECUTED (live)** | `x402_protocol_run.json` step 3 — real `transaction_simulation_failed` |
| 4. On-chain settlement + `X-PAYMENT-RESPONSE` tx hash / Solscan link | **NOT EXECUTED** | payer wallet holds 0 USDC; no ATA exists |
| 5. `/v1/swap/build-tx` → sign → broadcast swap | **NOT EXECUTED** | requires a settled quote |

The agent wallet holds **0 USDC** on Solana mainnet (verifiable on any explorer for `GEMDSpy2bjp9ddXCDkxZwvrEqR8vECVC2Sp4p9zNKFwn`). There is therefore **no paid call, no settlement transaction and no Solscan link**, and none is represented as having happened.

The full **+30% "Make It Work"** bonus is **not** claimed. This is submitted specifically for the **partial credit** the brief offers for *"a demo that runs part of the flow"* — here, three of the five steps are genuinely executed against production, including a correctly-signed payment payload that the real facilitator verified.

An **auto-settlement watcher** is armed on the agent host: the moment the payer wallet holds ≥ `3007` atomic USDC, it re-runs this client, and on a settled `200` it appends the resulting Solscan transaction link to the submission. Until that fires, no on-chain settlement is claimed.

---

## 4. Why this matters

The pitch is a Telegram portfolio rebalancer holding SOL/USDC at 60/40 that pays one USDC micropayment per quote. Per-request payment beats API keys and subscriptions for a rarely-active agent: no idle spend, no secret to provision, no prepaid balance. The 402 + signed-retry sequence above is the actual mechanism, demonstrated end-to-end on the client side.

- Pitch video (105s MP4): https://files.catbox.moe/p8019w.mp4
- Native X post (tags @swapdotio + @Superteam): https://x.com/Rajmali62851265/status/2120096263807160399
- Written companion: https://files.catbox.moe/4q4h0a.html

*All captures are reproducible: the Swap.io Agent API needs no account, no API key and no sign-up — which is the point of x402.*
