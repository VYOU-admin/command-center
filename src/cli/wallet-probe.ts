/**
 * `npm run wallet-probe -- [--address 0x...]`
 *
 * READS EVERYTHING KNOWABLE ABOUT THE BOT'S WALLET FROM THE CHAIN, AND THEN RUNS THE
 * REAL ARMING GATE OVER IT.
 *
 * WHY THIS IS A COMMITTED CLI RATHER THAN A QUERY SOMEBODY TYPED. LAUNCHBOT.md section 0
 * has carried a native balance, a WETH and USDG balance, a nonce and a code classification
 * for this wallet since 2026-09-16, and **no code in this repository produced them** —
 * `readWalletState` reads the native balance and nothing else. A figure in a document with
 * no path to reproducing it is exactly the drift both chain documents exist to prevent,
 * and the address those figures were taken against turned out to be wrong, which is how
 * it surfaced. CLAUDE.md: anything that decides something goes in the repository.
 *
 * WHAT IT PROVES, AND THE CONTROL IS THE POINT. A zero balance and a broken reader are
 * indistinguishable from one another — `ROBINHOOD.md`'s standing failure mode, earned by
 * a `balanceOf` reader that turned 490 HTTP 429s into plausible zero balances. So every
 * read is also performed against a CONTROL address known to hold the asset, through the
 * identical code path. A zero from the subject beside a non-zero from the control is a
 * measurement; a zero from both is a broken reader.
 *
 * IT IS READ-ONLY IN THE STRONGEST SENSE AVAILABLE HERE: it goes through `ReadOnlyRpc`,
 * which refuses `eth_sendRawTransaction` and every signing method BY NAME, and it reads
 * no private key because none exists anywhere under `src/`.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { classifyCode } from '../adapters/token-updates/decode.js';
import { id } from 'ethers';
import { RAILS } from '../bot/config.js';
import { configuredWallet, readWalletState, requiredUsd } from '../bot/wallet.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';

/** The pricing assets, from ROBINHOOD.md step 4. Addresses, never symbols. */
const ASSETS = [
  { symbol: 'WETH', address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', decimals: 18 },
  { symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 },
] as const;

/**
 * THE CONTROL. The v4 PoolManager custodies every v4 pool's liquidity on this chain, so
 * it holds native ETH and both pricing assets by construction. It is a READ TARGET only.
 */
const CONTROL = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

/**
 * `balanceOf(address)` — COMPUTED from keccak, never transcribed.
 *
 * This project has shipped a fabricated constant twice: a `Transfer` topic hash that
 * matched zero logs across 100,000 blocks and read as a clean sweep, and a launchpad
 * address whose last twenty-eight characters were invented, which rejected every launch
 * as "not in the list". A four-byte selector is small enough to feel safe to type and
 * has exactly the same failure mode — a wrong selector reverts or returns `0x`, and `0x`
 * is the value this file is trying to tell apart from a real zero.
 */
const BALANCE_OF = id('balanceOf(address)').slice(0, 10);

interface AssetBalance { symbol: string; raw: bigint | null; human: number | null; note: string }

async function readErc20Balance(
  rpc: ReadOnlyRpc, token: string, holder: string, decimals: number,
): Promise<AssetBalance> {
  const data = BALANCE_OF + holder.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const r = await rpc.call('eth_call', [{ to: token, data }, 'latest']);
  /*
   * `0x` IS UNKNOWN, NOT ZERO. Step 1 of ROBINHOOD.md, and here it decides whether a
   * reported zero balance is a fact about the wallet or a fact about the call.
   */
  if (typeof r !== 'string' || r === '0x' || r === '') {
    return { symbol: '', raw: null, human: null, note: `balanceOf returned ${JSON.stringify(r)} `
      + '— the balance is UNKNOWN, not zero' };
  }
  const raw = BigInt(r);
  return { symbol: '', raw, human: Number(raw) / 10 ** decimals, note: 'read' };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ai = args.indexOf('--address');
  const override = ai >= 0 ? String(args[ai + 1] ?? '') : '';
  if (ai >= 0 && !/^0x[0-9a-fA-F]{40}$/.test(override)) {
    throw new Error(`--address must be a 20-byte hex address, got "${override}"`);
  }
  const address = (override || configuredWallet() || '').toLowerCase();
  if (!address) {
    throw new Error('no address: pass --address or set BOT_WALLET_ADDRESS. There is '
      + 'nothing to read and a balance will not be invented for nobody.');
  }

  const app = await bootstrap();
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60000, 200_000));

  /* THE CHAIN IS CONFIRMED BEFORE ANYTHING IS READ FROM IT. A balance read against the
   * wrong chain is a perfectly plausible number about the wrong place. */
  const chainIdHex = String(await rpc.call('eth_chainId', []));
  const chainId = Number(BigInt(chainIdHex));
  if (chainId !== 4663) {
    throw new Error(`endpoint reports chainId ${chainId} (${chainIdHex}); expected 4663 `
      + '(0x1237) — refusing to report a balance from the wrong chain');
  }

  const readAll = async (who: string): Promise<{
    nativeWei: bigint; nativeEth: number; nonce: number; code: string;
    codeClass: string; assets: AssetBalance[];
  }> => {
    const bal = String(await rpc.call('eth_getBalance', [who, 'latest']));
    if (!bal.startsWith('0x')) {
      throw new Error(`eth_getBalance returned ${bal} for ${who}; UNKNOWN, not zero`);
    }
    const nonceHex = String(await rpc.call('eth_getTransactionCount', [who, 'latest']));
    const code = String(await rpc.call('eth_getCode', [who, 'latest']));
    const assets: AssetBalance[] = [];
    for (const a of ASSETS) {
      const b = await readErc20Balance(rpc, a.address, who, a.decimals);
      assets.push({ ...b, symbol: a.symbol });
    }
    const wei = BigInt(bal);
    return {
      nativeWei: wei, nativeEth: Number(wei) / 1e18, nonce: Number(BigInt(nonceHex)),
      code, codeClass: classifyCode(code), assets,
    };
  };

  const subject = await readAll(address);
  const control = await readAll(CONTROL);

  log.info('WALLET, READ FROM THE CHAIN', {
    address,
    chain_id: chainId, chain_id_hex: chainIdHex,
    native_wei: subject.nativeWei.toString(),
    native_eth: subject.nativeEth,
    nonce: subject.nonce,
    code: subject.code === '0x' ? '0x' : `${subject.code.slice(0, 12)}… (${subject.code.length} chars)`,
    code_class: subject.codeClass,
    balances: subject.assets.map((a) => `${a.symbol} ${a.human === null ? 'UNKNOWN' : a.human} (${a.note})`),
  });

  /*
   * THE CONTROL IS REPORTED WHETHER OR NOT THE SUBJECT READ ZERO. Printing it only when
   * the answer is inconvenient is how a check becomes a rationalisation.
   */
  log.info('CONTROL READ — the same path against an address known to hold the assets', {
    address: CONTROL,
    what_it_is: 'the v4 PoolManager, which custodies every v4 pool\'s liquidity',
    native_eth: control.nativeEth,
    nonce: control.nonce,
    code_class: control.codeClass,
    balances: control.assets.map((a) => `${a.symbol} ${a.human === null ? 'UNKNOWN' : a.human} (${a.note})`),
    verdict: control.nativeEth > 0
      ? 'the reader works; a zero from the subject is the SUBJECT'
      : 'THE CONTROL ALSO READ ZERO — suspect the reader, not the wallet',
  });

  /* THE REAL GATE, over the real code path, so this is not a second implementation. */
  const c = await app.pool.connect();
  try {
    const st = await readWalletState(rpc, c, address);
    log.info('THE ARMING GATE, AS THE BOT ITSELF EVALUATES IT', {
      address: st.address,
      balance_usd: Number(st.balanceUsd.toFixed(2)),
      eth_usd: st.ethUsd,
      required_usd: st.requiredUsd,
      can_arm: st.canArm,
      max_deployed_usd: st.capUsd,
      covers_cap: st.coversCap,
      reason: st.reason,
      note: `the gate is MAX_CONCURRENT ${RAILS.MAX_CONCURRENT} x $`
        + `${RAILS.MAX_POSITION_USD} = $${requiredUsd()}; MAX_DEPLOYED_USD `
        + `$${RAILS.MAX_DEPLOYED_USD} bounds what may ever be deployed and gates nothing here`,
    });
  } finally { c.release(); }

  log.info('wallet-probe complete', { cu_spent: rpc.cuSpent });
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('wallet-probe failed', errorFields(err)); process.exit(1); });
