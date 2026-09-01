import {LuTriangleAlert} from "react-icons/lu";

/**
 * The documentation, as one scrollable page with anchors rather than a route per section.
 *
 * Deliberate: the whole thing is about 15 minutes of reading, and a reader hunting a specific error
 * code wants ctrl-F to find it, which it cannot do across seven routes. It is also a server
 * component — nothing here is interactive except the sidebar, so none of this prose reaches the
 * browser as JavaScript.
 */

/** A callout. `tone` encodes the consequence, not the decoration: warn is a trap, stop is a rule. */
function Note({
  title,
  tone = "plain",
  children,
}: {
  title: string;
  tone?: "plain" | "warn" | "stop";
  children: React.ReactNode;
}) {
  const edge =
    tone === "warn"
      ? "border-l-warning"
      : tone === "stop"
        ? "border-l-critical"
        : "border-l-ash-600";
  const label = tone === "warn" ? "text-warning" : tone === "stop" ? "text-critical" : "text-ash-600";
  return (
    <div className={`mb-5 max-w-[72ch] rounded-r-md border border-l-2 border-ash-800 bg-oil-850 p-4 ${edge}`}>
      <p className={`mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] ${label}`}>{title}</p>
      {children}
    </div>
  );
}

/** Tables get their own horizontal scroller so a wide row never scrolls the page sideways. */
function Table({children}: {children: React.ReactNode}) {
  return (
    <div className="mb-5 max-w-[72ch] overflow-x-auto rounded-md border border-ash-800">
      <table>{children}</table>
    </div>
  );
}

const SURPRISES = [
  {
    title: "A paymaster must be staked, not just funded",
    body: (
      <>
        <p>
          The deposit pays for gas. The <em>stake</em> is what makes a bundler willing to look at the
          paymaster at all — both contracts read their own storage during validation, which ERC-7562
          permits only for a staked entity.
        </p>
        <p>
          An unstaked paymaster is not &ldquo;less safe&rdquo;, it is inert: rundler rejects every
          operation with <code>-32502</code> before anything reaches the chain. Rundler&rsquo;s stock
          minimum is 1 ETH, so a testnet-sized stake needs <code>--min_stake_value</code> lowered to
          match. It accepts a stake exactly <em>equal</em> to the floor — the comparison is{" "}
          <code>&gt;=</code>.
        </p>
      </>
    ),
  },
  {
    title: "The bundler needs an RPC that runs custom JS tracers",
    body: (
      <>
        <p>
          Safe-mode validation calls <code>debug_traceCall</code> with a JavaScript tracer. Alchemy
          and Infura serve <code>debug_traceCall</code> only for their <em>built-in</em> tracers and
          reject custom JS with <code>-32600 invalid tracer value</code> — at any price, on any plan.
          Free public endpoints have no <code>debug_*</code> at all.
        </p>
        <p>
          See <a href="#rpc">The RPC problem</a>, which is the longest-running trap here.
        </p>
      </>
    ),
  },
  {
    title: "paymasterKind must match the deployed contract",
    body: (
      <p>
        <code>VerifyingPaymaster</code> and <code>TenantPaymaster</code> use different EIP-712 domains
        and different <code>paymasterAndData</code> layouts, so their signatures are not
        interchangeable. A mismatch is not a startup error — it is an on-chain <code>AA34</code> on{" "}
        <em>every</em> sponsorship, pointing at the signature rather than at the configuration line
        that caused it.
      </p>
    ),
  },
  {
    title: "Policies are resolved per tenant",
    body: (
      <p>
        The sponsor path looks up the policy inside the <em>caller&rsquo;s own</em> tenant,
        deliberately, so one customer can never be served another&rsquo;s rules. A tenant with no
        policy therefore cannot sponsor anything — which is why signup provisions one, and why the
        bootstrap seeder (which fills an <em>empty</em> policy table exactly once) does not cover
        tenants created later.
      </p>
    ),
  },
  {
    title: "Failed sponsorships consume quota",
    body: (
      <>
        <p>
          A sponsorship reserves <code>maxCost</code> against the wallet&rsquo;s quota when it is{" "}
          <em>signed</em>, and the reconciler only corrects that from a receipt once the operation{" "}
          <em>lands</em>. Operations signed and never submitted hold their reservation forever.
        </p>
        <p>
          This bites hard while debugging: a wallet can exhaust a daily spend quota without a single
          successful sponsorship, then return <code>429</code> for the rest of the day.
        </p>
      </>
    ),
  },
];

export default function DocsPage() {
  return (
    <div className="docs-prose">
      <section id="overview">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--phosphor-dim)]">
          ERC-4337 · EntryPoint v0.7
        </p>
        <h1 className="mb-3 text-[2rem] font-semibold leading-tight tracking-tight text-ash-100 text-balance">
          Sponsor gas for your users
        </h1>
        <p className="max-w-[66ch] text-base leading-relaxed text-ash-400">
          A self-hosted account-abstraction platform: a paymaster you own end to end, a backend that
          decides and signs sponsorships, and a bundler on your own infrastructure. No dependency on
          any hosted paymaster or bundler service.
        </p>

        <div className="my-6 max-w-[72ch] overflow-x-auto rounded-md border border-ash-800 bg-oil-900 p-5">
          <pre className="!m-0 !border-0 !bg-transparent !p-0 text-[12.5px] text-ash-500">
            {`Wallet ──▶ SDK ──▶ Bundler (rundler) ──▶ `}
            <span className="c-hl">RPC router</span>
            {` ──▶ EntryPoint ──▶ chain
                └──▶ Paymaster API ──▶ (policy + signature) ──▶ paymasterAndData`}
          </pre>
        </div>

        <p>
          These docs have <strong>two audiences</strong>, and reading the wrong one is a twenty-minute
          mistake. Integrating with a paymaster somebody else runs? You only need{" "}
          <a href="#integrate">Integrate</a>. Running the platform yourself? Everything applies.
        </p>
      </section>

      <section id="surprises">
        <h2>Five things that surprise people</h2>
        <p>
          Collected because each one cost real debugging time, and each fails somewhere that points
          away from its cause.
        </p>

        <div className="max-w-[72ch] overflow-hidden rounded-md border border-ash-800">
          {SURPRISES.map((s, i) => (
            <div
              key={s.title}
              className={`grid grid-cols-[2.5rem_1fr] bg-oil-850 ${i < SURPRISES.length - 1 ? "border-b border-ash-800" : ""}`}
            >
              <div className="flex justify-center border-r border-ash-800 bg-oil-900 pt-4">
                <LuTriangleAlert className="size-3.5 text-warning" aria-hidden />
              </div>
              <div className="p-4">
                <h3 className="!mt-0 !mb-1.5 !text-[0.95rem]">{s.title}</h3>
                <div className="text-[0.875rem] [&>p:last-child]:!mb-0">{s.body}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="integrate">
        <h2>Integrate: the five steps</h2>
        <p>
          You have an account on a paymaster someone else runs, and you want your users&rsquo;
          transactions to cost them nothing. The whole thing is five steps and one rule.
        </p>

        <Note title="The rule" tone="stop">
          <p className="!mb-0">
            <strong>Your API key belongs on a server you control.</strong> It is a bearer secret with
            no origin or domain binding — a key shipped to a browser can be read out of the page by
            anyone who loads it and used to spend your balance until it is empty. Nothing downstream
            can protect you from that.
          </p>
        </Note>

        <div className="mb-6 max-w-[72ch] overflow-x-auto rounded-md border border-ash-800 bg-oil-900 p-5">
          <pre className="!m-0 !border-0 !bg-transparent !p-0 text-[12.5px] text-ash-500">
            {`your users ──▶ your app ──▶ `}
            <span className="c-hl">your backend</span>
            {` ──▶ paymaster API   (decides + signs)
                                        └──▶ bundler         (submits on chain)`}
          </pre>
        </div>

        <h3>1 · Sign up</h3>
        <p>
          Sign in at <code>/dashboard</code>. On first sign-in you get a tenant of your own — the
          boundary everything hangs off: your balance, your keys, your policy, your usage. The
          isolation is enforced in the query layer, not by convention.
        </p>
        <p>
          Your tenant automatically gets a starter policy. Typical opening limits are 100 operations
          and 0.1 ETH per wallet per day.
        </p>

        <h3 id="funding">2 · Fund your balance</h3>
        <p>
          On a multi-tenant deployment your gas comes from a balance <em>you own on chain</em> — not
          an invoice, not a prepaid credit in someone&rsquo;s database. A deposit held by the
          paymaster contract and attributed to you, spendable only by your operations, enforced by the
          contract rather than the operator&rsquo;s bookkeeping.
        </p>
        <p>
          Go to <code>/dashboard/funding</code>, enter an amount, press <strong>Deposit</strong>. Two
          things about it are unusual:
        </p>

        <Note title="Credited to your tenant key">
          <p className="!mb-0">
            Not to your wallet address. The contract cannot work out which tenant a plain transfer
            belongs to — the id is hashed one-way, so a sender address maps to nothing. That is why
            funding is a call to <code>depositFor(bytes32)</code> and not a transfer.
          </p>
        </Note>

        <Note title="A direct send fails rather than vanishes">
          <p className="!mb-0">
            <code>TenantPaymaster</code> has no plain-transfer path, so ETH sent straight to the
            paymaster address <em>reverts</em> and you keep your money. (<code>VerifyingPaymaster</code>{" "}
            does have one — the two contracts differ here.)
          </p>
        </Note>

        <pre>
          <code>
            <span className="c-dim"># funding by hand, if you prefer</span>
            {`
cast send <paymaster> `}
            <span className="c-str">&quot;depositFor(bytes32)&quot;</span>
            {` <your-tenant-key> \\
  --value 0.05ether --rpc-url <rpc> --private-key <key>`}
          </code>
        </pre>

        <p>
          If the deployment runs a <em>verifying</em> paymaster instead, there is no balance of yours
          to fund: the operator sponsors from one shared deposit and your usage is bounded by policy
          alone. The funding page says so when that is the case.
        </p>

        <h3>3 · Mint an API key</h3>
        <p>
          <code>/dashboard/keys</code> → <strong>Sponsor</strong> role → mint. The secret is shown once
          and stored only as a hash; lose it and the fix is to mint a replacement and revoke the old
          one.
        </p>
        <p>
          <code>Sponsor</code> can spend your balance within policy and nothing else — it cannot mint
          keys, change policy, or read your account. A leaked key is bounded by your quotas, which is
          the strongest argument for keeping them tight.
        </p>

        <h3 id="sdk">4 · Call it from your server</h3>
        <pre>
          <code>npm install @paymaster/sdk viem</code>
        </pre>

        <pre>
          <code>
            <span className="c-key">import</span>
            {" {SponsoredBundlerClient} "}
            <span className="c-key">from</span> <span className="c-str">&quot;@paymaster/sdk&quot;</span>
            {`;

`}
            <span className="c-key">const</span>
            {` client = `}
            <span className="c-key">new</span>
            {` SponsoredBundlerClient({
  entryPoint: `}
            <span className="c-str">&quot;0x0000000071727De22E5E9d8BAf0edAc6f37da032&quot;</span>
            {`,
  chainId: 11155111,
  bundler: {endpoint: process.env.BUNDLER_URL},
  paymaster: {endpoint: process.env.PAYMASTER_URL, apiKey: process.env.PAYMASTER_API_KEY},
});

`}
            <span className="c-key">const</span>
            {` receipt = `}
            <span className="c-key">await</span>
            {` client.sendUserOperation(
  {
    sender: smartAccountAddress,
    nonce: `}
            <span className="c-key">await</span>
            {` readNonceFromEntryPoint(smartAccountAddress),
    callData: encodedCall,
    `}
            <span className="c-dim">{"// Read fees from the chain. Below its floor, the bundler rejects."}</span>
            {`
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  },
  {signUserOperationHash: `}
            <span className="c-key">async</span>
            {` (hash) => owner.signMessage({message: {raw: hash}})},
);`}
          </code>
        </pre>

        <p>
          <code>sendUserOperation</code> does the whole round trip: estimates gas, asks the paymaster
          to sponsor, has you sign the resulting hash, submits to the bundler, waits for the receipt.
        </p>
        <p>
          <strong>The SDK never sees a private key.</strong> You hand it a{" "}
          <code>signUserOperationHash</code> callback, so signing stays wherever you keep it —
          including an HSM or a remote signer. For the two halves separately, use{" "}
          <code>prepareUserOperation</code>, or <code>PaymasterClient</code> and{" "}
          <code>BundlerClient</code> directly.
        </p>

        <Note title="The smart account is yours to provide" tone="warn">
          <p className="!mb-0">
            Sponsorship pays gas for an account; it does not create one. The account must{" "}
            <strong>already be deployed</strong>, or validation fails with <code>AA20</code> — an
            error that names the account and not the missing deployment. Any ERC-4337 v0.7 account
            works, and it needs no balance. That is the entire point.
          </p>
        </Note>

        <h3>5 · Watch your balance</h3>
        <p>
          A deposit that reaches zero fails <strong>every</strong> operation with <code>AA31</code>,
          and nothing warns you first if you are not looking. The operator&rsquo;s funding monitor
          alerts below a threshold — but that alert goes to <em>them</em>, not to you. Alert on it
          yourself.
        </p>
      </section>

      <section id="errors">
        <h2>Error reference</h2>

        <Note title="Read code, not error">
          <p className="!mb-0">
            Every policy refusal comes back with the same top-level{" "}
            <code>error: &quot;SPONSORSHIP_DENIED&quot;</code>; the reason is the <code>code</code>{" "}
            beside it. Branching on <code>error</code> collapses &ldquo;you are out of money&rdquo; and
            &ldquo;that account is blocklisted&rdquo; into one case.
          </p>
        </Note>

        <pre>
          <code>
            {"{"}
            <span className="c-str">&quot;error&quot;</span>
            {": "}
            <span className="c-str">&quot;SPONSORSHIP_DENIED&quot;</span>
            {", "}
            <span className="c-str">&quot;code&quot;</span>
            {": "}
            <span className="c-str">&quot;TENANT_BALANCE_INSUFFICIENT&quot;</span>
            {"}"}
          </code>
        </pre>

        <p>
          The status says what <em>kind</em> of response is appropriate, and the three differ
          meaningfully: <strong>402</strong> add funds, <strong>429</strong> back off and retry,{" "}
          <strong>403</strong> this will never be allowed as written.
        </p>

        <Table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Code</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="font-mono tabular-nums">402</td>
              <td>
                <code>TENANT_BALANCE_INSUFFICIENT</code>
              </td>
              <td>Your own balance is empty. Deposit more</td>
            </tr>
            <tr>
              <td className="font-mono tabular-nums">402</td>
              <td>
                <code>SUBSCRIPTION_LAPSED</code>
              </td>
              <td>Platform subscription unpaid — separate from your gas balance, which is untouched</td>
            </tr>
            <tr>
              <td className="font-mono tabular-nums">429</td>
              <td>
                <code>QUOTA_EXCEEDED</code>
              </td>
              <td>A quota is exhausted. Retry after it resets</td>
            </tr>
            <tr>
              <td className="font-mono tabular-nums">429</td>
              <td>
                <code>SPEND_CAP_EXCEEDED</code>
              </td>
              <td>
                A policy spend cap, <em>not</em> your balance — fixed by changing the rule, not by
                funding
              </td>
            </tr>
            <tr>
              <td className="font-mono tabular-nums">403</td>
              <td>
                <code>CHAIN_DISABLED</code>
              </td>
              <td>
                That <code>chainId</code> is not enabled for you
              </td>
            </tr>
            <tr>
              <td className="font-mono tabular-nums">403</td>
              <td>
                <code>SENDER_NOT_ALLOWED</code>
                <br />
                <code>SENDER_BLOCKED</code>
              </td>
              <td>The account is outside an allowlist, or on a blocklist</td>
            </tr>
            <tr>
              <td className="font-mono tabular-nums">403</td>
              <td>
                <code>TARGET_NOT_ALLOWED</code>
                <br />
                <code>METHOD_NOT_ALLOWED</code>
                <br />
                <code>VALUE_NOT_ALLOWED</code>
              </td>
              <td>The call is outside policy — what it touches, which function, or how much value</td>
            </tr>
            <tr>
              <td className="font-mono tabular-nums">403</td>
              <td>
                <code>CALLDATA_UNDECODABLE</code>
              </td>
              <td>A rule needed to inspect the call and could not parse it</td>
            </tr>
            <tr>
              <td className="font-mono tabular-nums">403</td>
              <td>
                <code>TOKEN_BALANCE_INSUFFICIENT</code>
              </td>
              <td>A rule requires the sender to hold a token, and it does not</td>
            </tr>
            <tr>
              <td className="font-mono tabular-nums">403</td>
              <td>
                <code>RULE_ERROR</code>
              </td>
              <td>A rule failed to evaluate. The operator&rsquo;s problem, not yours</td>
            </tr>
          </tbody>
        </Table>

        <p>
          Outside the policy engine: <strong>400</strong> <code>INVALID_REQUEST</code> for a malformed
          user operation (the message names the field), <strong>401</strong> for a key that is wrong,
          revoked or missing its <code>Authorization: Bearer</code> header, and <strong>503</strong>{" "}
          when a chain&rsquo;s RPC is unreachable.
        </p>

        <h3>Three failures that are not the paymaster&rsquo;s</h3>
        <Table>
          <thead>
            <tr>
              <th>Code</th>
              <th>What it actually means</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>AA20</code>
              </td>
              <td>Your smart account is not deployed on chain yet. Deploy it</td>
            </tr>
            <tr>
              <td>
                <code>AA31</code>
              </td>
              <td>
                The <em>operator&rsquo;s</em> deposit is exhausted, not yours. Tell them
              </td>
            </tr>
            <tr>
              <td>
                <code>AA34</code>
              </td>
              <td>
                The attestation did not verify on chain. Almost always a configuration mismatch on the
                operator&rsquo;s side — a <code>paymasterKind</code> disagreeing with the deployed
                contract, or a signer key that is not the address the contract stores
              </td>
            </tr>
          </tbody>
        </Table>
      </section>

      <section id="production">
        <h2>Going to production</h2>
        <ul>
          <li>
            <strong>Rotate the key you developed with</strong>, and revoke it. Anything pasted into a
            terminal, a CI log or a chat message should be considered burned.
          </li>
          <li>
            <strong>Mint one key per service</strong>, named after the thing that holds it, so revoking
            one does not take down everything else.
          </li>
          <li>
            <strong>Set quotas you would be comfortable losing.</strong> They are what bounds a leaked
            key.
          </li>
          <li>
            <strong>Monitor the balance yourself</strong> rather than relying on the operator&rsquo;s
            alert.
          </li>
          <li>
            <strong>Confirm the chain.</strong> A <code>chainId</code> that is not enabled fails fast,
            which is the good case; a paymaster address pointing at the wrong deployment fails as{" "}
            <code>AA34</code>, which is not.
          </li>
        </ul>
      </section>

      <section id="architecture">
        <h2>Architecture</h2>
        <Table>
          <thead>
            <tr>
              <th>Component</th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Paymaster</td>
              <td>
                Solidity. Sponsors a UserOperation when an authorised backend signer has attested to
                it, bound by EIP-712 to one chain and one deployment. Rotatable signer set, emergency
                pause, two-step ownership
              </td>
            </tr>
            <tr>
              <td>Backend</td>
              <td>
                TypeScript / NestJS / viem. A policy engine that decides <em>whether</em> to sponsor
                and a signature engine that produces the on-chain attestation, behind an authenticated
                HTTP API. PostgreSQL for durable state, Redis for cross-replica quotas
              </td>
            </tr>
            <tr>
              <td>Bundler</td>
              <td>rundler, run on your own infrastructure. Not a hosted service</td>
            </tr>
            <tr>
              <td>RPC router</td>
              <td>
                Splits the bundler&rsquo;s RPC traffic by method so a rate-limited tracing provider is
                only used where it is irreplaceable
              </td>
            </tr>
            <tr>
              <td>SDK</td>
              <td>
                Framework-agnostic TypeScript client driving both the paymaster and the bundler in one
                call
              </td>
            </tr>
          </tbody>
        </Table>

        <h3>Verify against the real thing</h3>
        <p>Every layer is tested against real infrastructure, not mocks:</p>
        <ul>
          <li>
            the signature engine&rsquo;s digest is asserted equal to the <strong>deployed
            EntryPoint&rsquo;s</strong> own <code>getHash</code>;
          </li>
          <li>
            <code>maxCost</code> is bracketed against a real EntryPoint&rsquo;s prefund requirement to
            the wei;
          </li>
          <li>
            quota atomicity is proven against a <strong>real Redis</strong>, the schema against a{" "}
            <strong>real PostgreSQL</strong>;
          </li>
          <li>
            the paymaster is accepted — and an unstaked one <strong>rejected</strong> — by a{" "}
            <strong>real bundler</strong> running full trace validation;
          </li>
          <li>the SDK drives the real backend and real bundler to land an operation on chain.</li>
        </ul>
        <p>
          Where a test could pass while the system is wrong, that gap is closed by mutation: the
          load-bearing tests have each been shown to fail when the code they guard is broken.
        </p>
      </section>

      <section id="rpc">
        <h2>The RPC problem</h2>
        <p>
          Rundler validates in safe mode, which enforces the ERC-7562 storage rules — the rules that
          make the paymaster&rsquo;s stake load-bearing. That requires <code>debug_traceCall</code>{" "}
          <strong>with a custom JavaScript tracer</strong>, and that one requirement narrows the field
          sharply.
        </p>

        <Table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>debug_traceCall</th>
              <th>Custom JS tracer</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                QuickNode, Chainstack
                <br />
                self-hosted geth / reth
              </td>
              <td>yes</td>
              <td>
                <strong>yes</strong>
              </td>
            </tr>
            <tr>
              <td>Alchemy, Infura</td>
              <td>built-in tracers only</td>
              <td>
                no — <code>-32600</code>
              </td>
            </tr>
            <tr>
              <td>Free public endpoints</td>
              <td>
                no — <code>-32601</code>
              </td>
              <td>no</td>
            </tr>
          </tbody>
        </Table>

        <p>Check any candidate endpoint before committing to it:</p>
        <pre>
          <code>./deploy/check-rpc.sh https://your-endpoint</code>
        </pre>

        <h3>Why there is a router</h3>
        <p>
          The providers that qualify tend to meter hardest. Measured on this stack, a single sponsored
          operation issues about <strong>369 ordinary reads</strong> against{" "}
          <strong>3 trace calls</strong> — so a free tier&rsquo;s 15 requests/second is exhausted by
          traffic that has nothing to do with validating, and every operation dies as{" "}
          <code>internal error: rpc provider error</code>.
        </p>
        <p>
          The router splits by method: <code>debug_*</code> and <code>trace_*</code> to the tracing
          provider, everything else to a second endpoint that never needs debug support. Both can be
          free tiers.
        </p>

        <Note title="Two settings that are wrong by default" tone="warn">
          <p>
            <code>USER_OPERATION_EVENT_BLOCK_DISTANCE</code> — rundler&rsquo;s default searches from
            block 0 to latest, a range every provider rejects.
          </p>
          <p className="!mb-0">
            <code>RUST_LOG</code> — rundler logs <em>nothing</em> by default. An empty{" "}
            <code>docker compose logs bundler</code> looks like a quiet bundler and is actually an
            unset filter; it is what turns an opaque provider error into a named quota limit.
          </p>
        </Note>
      </section>

      <section id="deploy">
        <h2>Deploying</h2>
        <p>
          Deploy once; every later boot reads the result back. <code>start.sh</code> deliberately will
          not deploy for you — it spends real ETH, and a boot script should not.
        </p>

        <pre>
          <code>
            {`cp contracts/.env.example contracts/.env
`}
            <span className="c-dim"># DEPLOYER_KEY (funded), PAYMASTER_OWNER, PAYMASTER_SIGNER</span>
            {`

cd contracts && set -a && source .env && set +a
forge script script/DeployPaymaster.s.sol:DeployPaymaster \\
  --rpc-url `}
            <span className="c-str">&quot;$RPC_URL&quot;</span>
            {` --broadcast --verify --private-key `}
            <span className="c-str">&quot;$DEPLOYER_KEY&quot;</span>
          </code>
        </pre>

        <p>
          Budget roughly <code>STAKE_WEI + DEPOSIT_WEI + ~0.007 ETH</code> of gas. The deploy funds and
          stakes in the <em>same broadcast</em>, because a paymaster is non-functional without both and
          the gap between &ldquo;deployed&rdquo; and &ldquo;usable&rdquo; is where a step gets
          forgotten.
        </p>

        <Note title="Ownership handover is not complete until accepted" tone="warn">
          <p className="!mb-0">
            <code>addStake</code> is owner-only, so the contract is deployed owned by the{" "}
            <em>deployer</em>, funded, staked, and only then handed over via <code>Ownable2Step</code>.
            Until the new owner calls <code>acceptOwnership()</code>, the deployer key still controls
            the paymaster — treat it as privileged for that window.
          </p>
        </Note>
      </section>

      <section id="truth">
        <h2>Where the source of truth is</h2>
        <p>Documentation drifts. These do not.</p>
        <Table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Authority</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>What is deployed</td>
              <td>
                <code>contracts/broadcast/&lt;script&gt;/&lt;chainId&gt;/run-latest.json</code>, written
                by the deploy itself
              </td>
            </tr>
            <tr>
              <td>What the backend serves</td>
              <td>
                <code>GET /health/ready</code> — every configured chain, its block height, whether it is
                healthy
              </td>
            </tr>
            <tr>
              <td>What a policy allows</td>
              <td>
                The <code>policies</code> and <code>policy_rules</code> tables, per tenant. Only the rows
                decide
              </td>
            </tr>
            <tr>
              <td>Whether an endpoint qualifies</td>
              <td>
                <code>./deploy/check-rpc.sh</code>
              </td>
            </tr>
          </tbody>
        </Table>

        <p className="mt-8 border-t border-ash-800 pt-5 text-[0.8rem] text-ash-600">
          Deeper operator documentation — security, runbooks, disaster recovery, monitoring — lives in{" "}
          <code>docs/</code> in the repository. This page collects the parts most often needed first.
        </p>
      </section>
    </div>
  );
}
