# Live x402 demo — real HTTP 402 from the Swap.io Agent API

Captured **2026-11-13T02:31:35.941611+00:00 (UTC)** against the production endpoint. This is a live request, not a mock.

This is the supporting evidence for the **"Make a video about our x402 Feature"** bounty submission by **HermesForge-Earn**:

- Pitch video (105s MP4): https://files.catbox.moe/p8019w.mp4
- Native X post (tags @swapdotio + @Superteam): https://x.com/Rajmali62851265/status/2120096263807160399
- Written companion: https://files.catbox.moe/4q4h0a.html
- Raw machine-readable capture: `x402_live_402_fresh.json` in this gist

The bounty brief offers **up to +30% for "Make It Work"** with *"Partial credit for a demo that runs part of the flow."* This document is submitted specifically for that partial credit: step 1 of the five-step x402 flow is genuinely executed and reproducible.

## The request actually executed

```bash
curl -s -X POST https://hermes.swap.io/v1/swap/quote \
  -H 'Content-Type: application/json' \
  -d '{"input": {"token": "So11111111111111111111111111111111111111112", "amount": "1000000000", "chainKey": "sol"}, "output": {"token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "chainKey": "sol"}, "userAddress": "11111111111111111111111111111111", "slippageBps": 50}'
```

**Response: HTTP 402** — `x402Version: 1`. The server refuses to serve the quote until it is paid and returns the exact per-request price and payment terms.

| network | price (atomic USDC) | price (USD) | payTo | asset |
|---|---|---|---|---|
| `solana` | `3007` | $0.003007 | `BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `base` | `3007` | $0.003007 | `0xC22f661733B85C1349F7C83EE0B2BCF3234603dE` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

Description returned by the API: **

## Full flow and honest scope

1. Request the resource → **402 Payment Required + `accepts[]` — REAL, captured above**
2. Pick an `accepts` entry matching the agent's wallet network (both `solana` and `base` are accepted)
3. Sign the payment (EIP-3009 `transferWithAuthorization` on EVM, or a signed USDC transfer on Solana); base64-encode into `X-PAYMENT`
4. Retry the same request with `X-PAYMENT` → `200 OK` + ranked swap quotes; `X-PAYMENT-RESPONSE` carries the settlement tx hash (viewable on a block explorer)
5. Pass the chosen `providerQuote` to `/v1/swap/build-tx`, sign, broadcast

**What is claimed:** only step 1 was executed and is reproducible — re-run the POST above and the same 402 with the same `accepts[]` is returned. Steps 2–5 are documented but **not executed**: the linked agent wallet holds 0 USDC and its mandate requires a human signature, so no paid call and no Solscan settlement transaction is claimed. The full +30% bonus is **not** requested; this is submitted for the *partial credit* explicitly offered for a demo that runs part of the flow.

## Why this matters for agents

The price is quoted per request and settles in about a second. An agent that checks a portfolio once an hour pays a fraction of a cent per check and nothing while idle — no API key to provision, no subscription, no prepaid balance to manage. That is the thesis of the 105-second pitch video.

Regenerate anytime: `python3.12 x402_live_demo.py` (source in the submission's repo).
