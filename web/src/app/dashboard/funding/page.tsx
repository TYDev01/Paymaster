"use client";

import {useWallets, type ConnectedWallet} from "@privy-io/react-auth";
import {useState, type FormEvent} from "react";
import {LuArrowUpRight, LuCheck, LuCopy, LuExternalLink, LuKeySquare, LuTriangleAlert, LuWallet} from "react-icons/lu";
import {createPublicClient, custom, encodeFunctionData, type Hex} from "viem";

import {Busy, Empty, ErrorNote, Field, Mono, Note, PageHeader, Panel} from "@/components/panel";
import {formatDate, postAccountResource, useAccountResource} from "@/lib/account";

/** The calls this page makes on the paymaster. Inlined rather than imported: a handful of lines, and
 *  the page should not depend on a contract-artifact pipeline to render a button. */
const TENANT_PAYMASTER_ABI = [
  {
    type: "function",
    name: "depositFor",
    stateMutability: "payable",
    inputs: [{name: "tenant", type: "bytes32"}],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawFor",
    stateMutability: "nonpayable",
    inputs: [
      {name: "tenant", type: "bytes32"},
      {name: "to", type: "address"},
      {name: "amount", type: "uint256"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimController",
    stateMutability: "nonpayable",
    inputs: [
      {name: "tenant", type: "bytes32"},
      {name: "controller", type: "address"},
      {name: "deadline", type: "uint48"},
      {name: "signature", type: "bytes"},
    ],
    outputs: [],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// `0n` is a BigInt LITERAL, which this tsconfig's target rejects — the same reason `formatWei`
// below reaches for `BigInt(...)` rather than a literal.
const ZERO = BigInt(0);

type TxState =
  | {phase: "idle"}
  | {phase: "signing"}
  | {phase: "mining"; hash: Hex}
  | {phase: "done"; hash: Hex}
  | {phase: "error"; message: string; hash?: Hex};

/**
 * Where the gas comes from, per chain.
 *
 * The balance is a deposit held by the paymaster contract on chain, so funding it is a transaction
 * the customer sends from THEIR OWN WALLET. No API here could move their money, and none should:
 * the lede promises the balance is "enforced by the paymaster contract rather than by our
 * bookkeeping", which stops being true the moment a deposit routes through us.
 *
 * That does not make the page read-only, though — which is what it used to assume, on the grounds
 * that a button could only hand over the same address already shown. It is the other way round: an
 * address is precisely what does NOT work here, because a deposit is credited by
 * `depositFor(bytes32 tenant)` and a bare transfer carries no tenant. Sending the transaction is
 * the one thing the customer cannot do by copying anything off this page.
 */
interface Funding {
  readonly chainId: number;
  readonly chainName: string;
  readonly paymaster: string;
  readonly paymasterKind: string;
  /** Derived from the tenant id, so not a secret — but it IS how a deposit is credited correctly. */
  readonly tenantKey: string;
  readonly balanceWei: string | null;
  readonly nativeCurrency: {readonly symbol: string; readonly decimals: number};
  readonly explorerUrl: string;
  /** Who may withdraw. Null when unreadable; the zero address when nobody controls it yet. */
  readonly controller: {readonly address: string; readonly activeAt: number; readonly active: boolean} | null;
}

/** What the backend signs so a wallet can claim control. */
interface ControllerAttestation {
  readonly tenantKey: Hex;
  readonly controller: Hex;
  readonly deadline: number;
  readonly signature: Hex;
}

export default function FundingPage() {
  const funding = useAccountResource<Funding[]>("funding");
  const rows = funding.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Funding"
        lede="Gas is paid from a balance you own on chain, one per chain. Only your operations spend it, and that is enforced by the paymaster contract rather than by our bookkeeping."
      />

      {funding.loading && funding.data === undefined ? (
        <Panel>
          <Busy label="Reading your balances…" />
        </Panel>
      ) : funding.error !== undefined ? (
        <Panel>
          <ErrorNote message={funding.error} onRetry={funding.reload} />
        </Panel>
      ) : rows.length === 0 ? (
        <Panel title="No per-tenant balances">
          <Empty>
            <p>
              None of the configured chains uses a per-tenant paymaster, so there is no balance of your own to fund. On
              this deployment the paymaster is a <span className="text-ash-300">verifying</span> one: it sponsors from a
              single deposit held by the operator, and your usage is governed by policy rather than by a balance.
            </p>
            <p className="mt-2">
              This page fills in on a chain configured with{" "}
              <code className="font-mono text-ash-400">paymasterKind: &quot;tenant&quot;</code>.
            </p>
          </Empty>
        </Panel>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <ChainFunding key={row.chainId} row={row} onChanged={funding.reload} />
          ))}
          <Note>
            A deposit is credited to your tenant key, not to your wallet address — Deposit above does that for you.
            Sending funds to the paymaster address directly will simply fail: the contract has no plain-transfer path,
            so the transaction reverts and you keep your money.
          </Note>
        </div>
      )}
    </div>
  );
}

function ChainFunding({row, onChanged}: {row: Funding; onChanged: () => void}) {
  return (
    <Panel
      title={`${row.chainName} · ${row.chainId}`}
      action={
        <a
          href={`${row.explorerUrl.replace(/\/+$/, "")}/address/${row.paymaster}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[11px] text-ash-500 transition-colors hover:text-ash-300"
        >
          Explorer
          <LuExternalLink className="size-3" aria-hidden />
        </a>
      }
    >
      <dl>
        <Field label="Balance">
          {/* A balance that could not be read is NOT zero, and showing zero would tell a customer
              their deposit had vanished. The backend sends null when the RPC failed. */}
          {row.balanceWei === null ? (
            <span className="text-ash-600">unavailable — the chain did not answer</span>
          ) : (
            <span className="text-ash-100">
              {formatWei(row.balanceWei, row.nativeCurrency.decimals)} {row.nativeCurrency.symbol}
            </span>
          )}
        </Field>
        <Field label="Paymaster">
          <CopyableMono value={row.paymaster} />
        </Field>
        <Field label="Your tenant key">
          <CopyableMono value={row.tenantKey} />
        </Field>
        <Field label="Withdrawal wallet">
          {row.controller === null ? (
            <span className="text-ash-600">unavailable — the chain did not answer</span>
          ) : row.controller.address === ZERO_ADDRESS ? (
            <span className="text-ash-500">none yet</span>
          ) : (
            <CopyableMono value={row.controller.address} />
          )}
        </Field>
      </dl>
      <Deposit row={row} onFunded={onChanged} />
      <Withdraw row={row} onChanged={onChanged} />
    </Panel>
  );
}

/**
 * Sends one call to the paymaster from the customer's wallet and waits for it to be mined.
 *
 * Shared by every action on this page, because the part that must never be skipped is the same for
 * all of them: switch the wallet to THIS chain and confirm it actually switched, before anything is
 * signed. A wallet sitting on another chain would otherwise send the call to this address on THAT
 * chain, where it is not our paymaster and may not be a contract at all.
 */
async function sendToPaymaster(
  wallet: ConnectedWallet,
  row: Funding,
  data: Hex,
  value: bigint,
  onState: (state: TxState) => void,
): Promise<boolean> {
  onState({phase: "signing"});
  try {
    await wallet.switchChain(row.chainId);
    const provider = await wallet.getEthereumProvider();

    // Re-read the chain from the provider rather than trusting the switch to have taken effect.
    // A wallet may decline the switch, and some return from `switchChain` before it applies.
    const active = (await provider.request({method: "eth_chainId"})) as string;
    if (Number.parseInt(active, 16) !== row.chainId) {
      onState({
        phase: "error",
        message: `Your wallet is on chain ${Number.parseInt(active, 16)}, not ${row.chainName}. Switch it and try again.`,
      });
      return false;
    }

    const hash = (await provider.request({
      method: "eth_sendTransaction",
      params: [{from: wallet.address, to: row.paymaster, data, value: `0x${value.toString(16)}`}],
    })) as Hex;
    onState({phase: "mining", hash});

    // Waiting matters: the balance above is read from the chain, so refreshing before the
    // transaction is mined shows the OLD number and reads as the action having failed.
    const client = createPublicClient({transport: custom(provider)});
    const receipt = await client.waitForTransactionReceipt({hash, timeout: 180_000});
    if (receipt.status === "success") {
      onState({phase: "done", hash});
      return true;
    }
    onState({phase: "error", message: "The transaction was mined but reverted.", hash});
    return false;
  } catch (err) {
    onState({phase: "error", message: describeWalletError(err)});
    return false;
  }
}

/**
 * Funding a tenant balance, from the customer's own wallet.
 *
 * The whole reason this is a component and not a copyable address: a deposit is credited by
 * `depositFor(bytes32 tenant)`, a CALL WITH AN ARGUMENT. The tenant id is hashed one-way, so the
 * contract cannot recover a tenant from the sender — an address alone is not enough information to
 * credit anyone, which is exactly why handing the customer an address does not help them.
 *
 * The backend is not involved. It never holds, moves or sees these funds; the transaction goes
 * from the customer's wallet to the paymaster contract.
 */
function Deposit({row, onFunded}: {row: Funding; onFunded: () => void}) {
  const {wallets, ready} = useWallets();
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<TxState>({phase: "idle"});

  const wallet = wallets[0];
  const parsed = parseAmount(amount, row.nativeCurrency.decimals);
  const busy = state.phase === "signing" || state.phase === "mining";
  const disabled = !ready || wallet === undefined || parsed === undefined || parsed <= ZERO || busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (wallet === undefined || parsed === undefined || parsed <= ZERO) return;

    const data = encodeFunctionData({
      abi: TENANT_PAYMASTER_ABI,
      functionName: "depositFor",
      // The argument that makes this a deposit for YOU rather than a donation to the contract.
      args: [row.tenantKey as Hex],
    });
    if (await sendToPaymaster(wallet, row, data, parsed, setState)) {
      setAmount("");
      onFunded();
    }
  }

  if (ready && wallet === undefined) {
    return (
      <p className="mt-4 border-t border-ash-800/60 pt-4 text-[11px] leading-relaxed text-ash-600">
        No wallet is connected to this account, so there is nothing to fund from. Sign in again to have one created, or
        connect an existing wallet.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 border-t border-ash-800/60 pt-4">
      <label htmlFor={`amount-${row.chainId}`} className="text-[11px] uppercase tracking-wide text-ash-600">
        Add funds
      </label>
      <AmountRow
        id={`amount-${row.chainId}`}
        value={amount}
        onChange={(value) => {
          setAmount(value);
          if (state.phase === "error" || state.phase === "done") setState({phase: "idle"});
        }}
        symbol={row.nativeCurrency.symbol}
        busy={busy}
        disabled={disabled}
        label={state.phase === "signing" ? "Confirm in wallet…" : state.phase === "mining" ? "Mining…" : "Deposit"}
        icon={<LuWallet className="size-4" aria-hidden />}
      />

      {amount.trim() !== "" && parsed === undefined ? (
        <p className="mt-1.5 text-[11px] text-ash-600">
          Enter an amount like 0.05 — up to {row.nativeCurrency.decimals} decimal places.
        </p>
      ) : (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ash-600">
          Sent from your wallet to the paymaster, credited to your tenant key. We never hold it.
        </p>
      )}

      <TxFeedback row={row} state={state} done="Deposited. Your balance above is updated." />
    </form>
  );
}

/**
 * Taking money back out, without asking the platform.
 *
 * Two steps the first time, one afterwards. A balance is withdrawable by its CONTROLLER, and the
 * contract cannot tell on its own which wallet that should be — so the platform signs an attestation
 * naming the wallet the customer is signed in with, and the customer submits it. That claim waits a
 * day before it can withdraw: it is the window in which a claim made with a stolen platform key would
 * be noticed and cancelled. After that, withdrawals are one transaction, from the controller only.
 */
function Withdraw({row, onChanged}: {row: Funding; onChanged: () => void}) {
  const {wallets, ready} = useWallets();
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<TxState>({phase: "idle"});

  const wallet = wallets[0];
  if (!ready || wallet === undefined || row.controller === null) return null;

  const controller = row.controller.address;
  const busy = state.phase === "signing" || state.phase === "mining";
  const isController = controller.toLowerCase() === wallet.address.toLowerCase();

  async function claim() {
    if (wallet === undefined) return;
    setState({phase: "signing"});
    let attestation: ControllerAttestation;
    try {
      attestation = await postAccountResource<ControllerAttestation>("controller", {
        chainId: row.chainId,
        controller: wallet.address,
      });
    } catch (err) {
      setState({phase: "error", message: err instanceof Error ? err.message : String(err)});
      return;
    }

    const data = encodeFunctionData({
      abi: TENANT_PAYMASTER_ABI,
      functionName: "claimController",
      args: [attestation.tenantKey, attestation.controller, attestation.deadline, attestation.signature],
    });
    if (await sendToPaymaster(wallet, row, data, ZERO, setState)) onChanged();
  }

  async function withdraw(event: FormEvent) {
    event.preventDefault();
    const parsed = parseAmount(amount, row.nativeCurrency.decimals);
    if (wallet === undefined || parsed === undefined || parsed <= ZERO) return;

    const data = encodeFunctionData({
      abi: TENANT_PAYMASTER_ABI,
      functionName: "withdrawFor",
      // Paid to the controller's own wallet. Choosing another destination is possible on chain, but
      // offering it here would make a single mistyped address the way a customer loses a balance.
      args: [row.tenantKey as Hex, wallet.address as Hex, parsed],
    });
    if (await sendToPaymaster(wallet, row, data, ZERO, setState)) {
      setAmount("");
      onChanged();
    }
  }

  // Nobody controls this balance yet: offer to claim it for the signed-in wallet.
  if (controller === ZERO_ADDRESS) {
    return (
      <div className="mt-4 border-t border-ash-800/60 pt-4">
        <p className="text-[11px] uppercase tracking-wide text-ash-600">Withdraw</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ash-500">
          To take funds back out, first make this wallet (<Mono>{shortAddress(wallet.address)}</Mono>) the withdrawal
          wallet for this balance. It is one transaction, and withdrawals open 24 hours after it is mined.
        </p>
        <button
          type="button"
          onClick={() => void claim()}
          disabled={busy}
          className="mt-2 flex items-center gap-2 rounded-md border border-ash-700 px-3 py-1.5 text-sm text-ash-200 transition-colors hover:border-ash-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <LuKeySquare className="size-4" aria-hidden />
          {state.phase === "signing" ? "Confirm in wallet…" : state.phase === "mining" ? "Mining…" : "Use this wallet"}
        </button>
        <TxFeedback row={row} state={state} done="This wallet now controls withdrawals. They open in 24 hours." />
      </div>
    );
  }

  // Someone else controls it. Only that wallet (or the operator) can change it.
  if (!isController) {
    return (
      <p className="mt-4 border-t border-ash-800/60 pt-4 text-[11px] leading-relaxed text-ash-600">
        Withdrawals go through <Mono>{shortAddress(controller)}</Mono>, which is not the wallet you are signed in with.
        Sign in with that wallet to withdraw — it can also hand control to another wallet. If it has been lost, ask your
        platform operator to reset it.
      </p>
    );
  }

  // Decided by the backend when the page loaded, not by reading the clock during render.
  if (!row.controller.active) {
    return (
      <p className="mt-4 border-t border-ash-800/60 pt-4 text-[11px] leading-relaxed text-ash-500">
        This wallet controls withdrawals. They open on {formatDate(row.controller.activeAt)} — new withdrawal wallets
        wait a day, so a claim nobody expected can be stopped first.
      </p>
    );
  }

  const parsed = parseAmount(amount, row.nativeCurrency.decimals);
  const tooMuch = parsed !== undefined && row.balanceWei !== null && parsed > BigInt(row.balanceWei);
  const disabled = parsed === undefined || parsed <= ZERO || tooMuch || busy;

  return (
    <form onSubmit={withdraw} className="mt-4 border-t border-ash-800/60 pt-4">
      <label htmlFor={`withdraw-${row.chainId}`} className="text-[11px] uppercase tracking-wide text-ash-600">
        Withdraw
      </label>
      <AmountRow
        id={`withdraw-${row.chainId}`}
        value={amount}
        onChange={(value) => {
          setAmount(value);
          if (state.phase === "error" || state.phase === "done") setState({phase: "idle"});
        }}
        symbol={row.nativeCurrency.symbol}
        busy={busy}
        disabled={disabled}
        label={state.phase === "signing" ? "Confirm in wallet…" : state.phase === "mining" ? "Mining…" : "Withdraw"}
        icon={<LuArrowUpRight className="size-4" aria-hidden />}
      />
      <p className="mt-1.5 text-[11px] leading-relaxed text-ash-600">
        {tooMuch
          ? "That is more than this balance holds."
          : "Paid to this wallet. Operations in flight may still draw on the balance until they settle."}
      </p>
      <TxFeedback row={row} state={state} done="Withdrawn. Your balance above is updated." />
    </form>
  );
}

function AmountRow(props: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  symbol: string;
  busy: boolean;
  disabled: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="mt-1.5 flex gap-2">
      <div className="relative flex-1">
        <input
          id={props.id}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          inputMode="decimal"
          placeholder="0.05"
          disabled={props.busy}
          className="w-full rounded-md border border-ash-800 bg-oil-950 py-2 pl-3 pr-14 text-sm text-ash-100 outline-none transition-colors focus:border-ash-600 disabled:opacity-50 placeholder:text-ash-700"
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] text-ash-600">
          {props.symbol}
        </span>
      </div>
      <button
        type="submit"
        disabled={props.disabled}
        className="flex shrink-0 items-center gap-2 rounded-md bg-ash-200 px-4 py-2 text-sm font-medium text-oil-950 transition-colors hover:bg-ash-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {props.icon}
        {props.label}
      </button>
    </div>
  );
}

function TxFeedback({row, state, done}: {row: Funding; state: TxState; done: string}) {
  if (state.phase === "error") {
    return (
      <p className="mt-2 flex gap-2 rounded-md border border-critical/25 bg-critical/10 px-3 py-2 text-[11px] leading-relaxed text-critical">
        <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {state.message}
          {state.hash === undefined ? null : <ExplorerTx row={row} hash={state.hash} />}
        </span>
      </p>
    );
  }
  if (state.phase === "mining") {
    return (
      <p className="mt-2 text-[11px] leading-relaxed text-ash-500">
        Waiting for it to be mined — this can take a few blocks.
        <ExplorerTx row={row} hash={state.hash} />
      </p>
    );
  }
  if (state.phase === "done") {
    return (
      <p className="mt-2 flex gap-2 text-[11px] leading-relaxed text-ash-300">
        <LuCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {done}
          <ExplorerTx row={row} hash={state.hash} />
        </span>
      </p>
    );
  }
  return null;
}

function ExplorerTx({row, hash}: {row: Funding; hash: Hex}) {
  return (
    <a
      href={`${row.explorerUrl.replace(/\/+$/, "")}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="ml-1 inline-flex items-center gap-1 underline underline-offset-2 hover:text-ash-200"
    >
      View
      <LuExternalLink className="size-3" aria-hidden />
    </a>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * A decimal token amount to wei, exactly.
 *
 * `parseFloat` then multiply is wrong for the same reason `formatWei` splits strings, and it is not
 * a theoretical wrongness — measured against this function, `0.07` comes out 8 wei light, `1.005`
 * 128 wei heavy and `123.456789` 4096 wei light. Building the integer as a STRING is exact for any
 * value, at any decimals.
 *
 * Returns undefined for anything that is not a plain non-negative decimal — no exponents, no
 * negatives, no more precision than the token has — so the button stays disabled rather than
 * sending a number nobody intended.
 */
function parseAmount(input: string, decimals: number): bigint | undefined {
  const text = input.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return undefined;
  const [whole = "", fraction = ""] = text.split(".");
  // More precision than the token has is a typo, not an amount to silently truncate.
  if (fraction.length > decimals) return undefined;
  return BigInt(`${whole || "0"}${fraction.padEnd(decimals, "0")}`);
}

/**
 * Wallet errors, in words a customer can act on.
 *
 * A rejected signature is the common case and is not an error worth alarming anyone about; the raw
 * shapes differ per wallet, so both the EIP-1193 code and the message are checked.
 */
function describeWalletError(err: unknown): string {
  const code = (err as {code?: unknown})?.code;
  const raw = String((err as {message?: unknown})?.message ?? err ?? "");
  if (code === 4001 || /user rejected|denied|cancell?ed/i.test(raw))
    return "You cancelled the transaction in your wallet.";
  if (code === 4902 || /unrecognized chain|unsupported chain/i.test(raw))
    return "Your wallet does not have this network configured. Add it and try again.";
  if (/insufficient funds/i.test(raw)) return "That wallet does not hold enough to cover the transaction and its gas.";
  return raw === "" ? "The wallet rejected the transaction." : raw;
}

function CopyableMono({value}: {value: string}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-2">
      <Mono title={value}>{value}</Mono>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        aria-label={`Copy ${value}`}
        className="shrink-0 text-ash-600 transition-colors hover:text-ash-300"
      >
        {copied ? <LuCheck className="size-3.5" aria-hidden /> : <LuCopy className="size-3.5" aria-hidden />}
      </button>
    </span>
  );
}

/**
 * Wei as a token amount, without going through a float.
 *
 * `Number(balanceWei)` loses precision above 2^53, which for an 18-decimal token is about 0.009 —
 * well inside the range a real balance occupies. The integer and fractional parts are therefore
 * split as strings, which is exact for any size.
 */
function formatWei(wei: string, decimals: number, places = 6): string {
  let digits = wei.trim();
  if (!/^\d+$/.test(digits)) return "—";
  digits = digits.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits
    .slice(digits.length - decimals)
    .slice(0, places)
    .replace(/0+$/, "");
  const grouped = new Intl.NumberFormat("en").format(BigInt(whole));
  return fraction === "" ? grouped : `${grouped}.${fraction}`;
}
