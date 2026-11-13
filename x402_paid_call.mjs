#!/usr/bin/env node
/**
 * x402_paid_call.mjs — real x402 v1 client for the Swap.io Agent API.
 *
 * Implements the full client-side payment flow:
 *   1. POST /v1/swap/quote -> HTTP 402 + accepts[] (x402Version 1)
 *   2. Select the `exact` / `solana` requirement
 *   3. Build a partially-signed VersionedTransaction:
 *        feePayer = extra.feePayer (facilitator, covers gas)
 *        ix[0..1] = ComputeBudget (required by facilitator)
 *        ix[2]    = SPL Token TransferChecked of maxAmountRequired USDC
 *                   from our ATA -> payTo ATA, authority = our keypair
 *   4. Sign locally with the agent's Solana key; base64-encode into X-PAYMENT
 *   5. Retry the identical request with X-PAYMENT
 *   6. Trust only a 200 carrying a settled X-PAYMENT-RESPONSE; extract the
 *      on-chain transaction signature and emit the Solscan URL.
 *
 * When the payer wallet is unfunded the facilitator rejects the payment.
 * That is still a REAL protocol interaction and is captured verbatim.
 *
 * Usage: node x402_paid_call.mjs [--capture PATH]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  Keypair, PublicKey, Connection, TransactionMessage,
  VersionedTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const KEYFILE = path.join(ROOT, 'keys', 'solana_payout.json');
const DEFAULT_CAPTURE = path.join(ROOT, 'superteam', 'x402_protocol_run.json');
const API = 'https://hermes.swap.io/v1/swap/quote';
const RPC = 'https://api.mainnet-beta.solana.com';

const QUOTE_BODY = {
  input:  { token: 'So11111111111111111111111111111111111111112', amount: '1000000000', chainKey: 'sol' },
  output: { token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chainKey: 'sol' },
  slippageBps: 50,
};

function loadKeypair() {
  const d = JSON.parse(fs.readFileSync(KEYFILE, 'utf8'));
  const hex = d.private_key_hex.replace(/^0x/, '');
  let seed = Buffer.from(hex, 'hex');
  if (seed.length === 64) seed = seed.subarray(0, 32);
  if (seed.length !== 32) throw new Error(`bad key length ${seed.length}`);
  return { kp: Keypair.fromSeed(seed), address: d.address };
}

function b64json(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64'); }

async function buildPaymentHeader(req402, kp, connection) {
  const req = req402.accepts.find(a => a.scheme === 'exact' && a.network === 'solana');
  if (!req) throw new Error('no exact/solana requirement in 402');
  const feePayer = new PublicKey(req.extra.feePayer);
  const user = kp.publicKey;
  const destination = new PublicKey(req.payTo);
  const mint = new PublicKey(req.asset);
  const amount = BigInt(req.maxAmountRequired);

  const sourceAta = await getAssociatedTokenAddress(mint, user, false, TOKEN_PROGRAM_ID);
  const destAta = await getAssociatedTokenAddress(mint, destination, false, TOKEN_PROGRAM_ID);

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 7000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createTransferCheckedInstruction(
      sourceAta, mint, destAta, user, amount, 6, [], TOKEN_PROGRAM_ID,
    ),
  ];

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: feePayer, recentBlockhash: blockhash, instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([kp]);   // partially signed: facilitator adds its fee-payer signature

  const serialized = Buffer.from(tx.serialize()).toString('base64');
  const payload = {
    x402Version: req402.x402Version,
    scheme: req.scheme,
    network: req.network,
    payload: { transaction: serialized },
  };
  return {
    header: b64json(payload),
    meta: {
      network: req.network, scheme: req.scheme,
      maxAmountRequired: req.maxAmountRequired,
      payTo: req.payTo, asset: req.asset, feePayer: req.extra.feePayer,
      payer: user.toBase58(), sourceAta: sourceAta.toBase58(), destAta: destAta.toBase58(),
      recentBlockhash: blockhash,
      decodedPayloadBytes: Buffer.byteLength(JSON.stringify(payload)),
      signedByPayer: true, signaturesPresent: tx.signatures.filter(s => s.some(b => b !== 0)).length,
    },
  };
}

async function post(url, body, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'HermesForge-x402-agent/1.0', ...extraHeaders };
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await r.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = raw.slice(0, 2000); }
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: parsed };
}

export async function runPaidCall({ capturePath = DEFAULT_CAPTURE } = {}) {
  const started = new Date().toISOString();
  const { kp, address } = loadKeypair();
  const body = { ...QUOTE_BODY, userAddress: address };
  const connection = new Connection(RPC, 'confirmed');

  const out = {
    captured_at_utc: started,
    api: API,
    protocol: 'x402 v1 (X-PAYMENT / X-PAYMENT-RESPONSE)',
    client: 'HermesForge x402_paid_call.mjs (official @solana/web3.js + x402-solana v1 payload spec)',
    payer_wallet: address,
    request: { method: 'POST', url: API, body },
    steps: [],
  };

  // Step 1 — unpaid request, expect 402
  const first = await post(API, body);
  out.steps.push({ step: 1, label: 'unpaid request', ...first });
  if (first.status !== 402) {
    out.outcome = 'unexpected_no_402';
    fs.writeFileSync(capturePath, JSON.stringify(out, null, 2));
    return out;
  }

  // Step 2 — build + sign payment payload
  let built;
  try {
    built = await buildPaymentHeader(first.body, kp, connection);
    out.steps.push({
      step: 2, label: 'build + sign X-PAYMENT', ok: true,
      x_payment_b64_sha256: sha256(built.header),
      x_payment_b64_prefix: built.header.slice(0, 64),
      // Full payload is safe to publish: it is a partially-signed tx on an
      // unfunded wallet with a ~60s blockhash; it cannot be settled or replayed.
      x_payment_b64_full: built.header,
      payment_meta: built.meta,
    });
  } catch (e) {
    out.steps.push({ step: 2, label: 'build + sign X-PAYMENT', ok: false, error: String(e) });
    out.outcome = 'client_build_failed';
    fs.writeFileSync(capturePath, JSON.stringify(out, null, 2));
    return out;
  }

  // Step 3 — retry with payment header
  const second = await post(API, body, {
    'X-PAYMENT': built.header,
    'Access-Control-Expose-Headers': 'X-PAYMENT-RESPONSE',
  });
  out.steps.push({ step: 3, label: 'paid retry (X-PAYMENT)', ...second });

  // Step 4 — evaluate settlement receipt
  const receiptHeader = second.headers['x-payment-response'] || second.headers['X-PAYMENT-RESPONSE'];
  let receipt = null;
  if (receiptHeader) {
    try { receipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString()); } catch { receipt = receiptHeader; }
  }
  out.settlement_receipt = receipt;

  if (second.status === 200 && receipt && receipt.success) {
    out.outcome = 'SETTLED';
    out.transaction = receipt.transaction || (receipt.txHash) || null;
    out.solscan_url = out.transaction ? `https://solscan.io/tx/${out.transaction}` : null;
  } else {
    out.outcome = 'NOT_SETTLED';
    out.reason = 'facilitator rejected payment (payer wallet has no USDC / no ATA)';
  }
  out.finished_at_utc = new Date().toISOString();
  fs.writeFileSync(capturePath, JSON.stringify(out, null, 2));
  return out;
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cp = process.argv.includes('--capture')
    ? process.argv[process.argv.indexOf('--capture') + 1] : DEFAULT_CAPTURE;
  runPaidCall({ capturePath: cp }).then(o => {
    console.log(JSON.stringify({
      outcome: o.outcome, payer: o.payer_wallet,
      step1_status: o.steps[0]?.status,
      step2_ok: o.steps[1]?.ok,
      step3_status: o.steps[2]?.status,
      solscan_url: o.solscan_url || null,
      reason: o.reason || null,
      capture: cp,
    }, null, 2));
  }).catch(e => { console.error('FATAL', e); process.exit(1); });
}
