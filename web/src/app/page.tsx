import Link from "next/link";
import {LuArrowRight, LuCoins, LuGithub, LuKeyRound, LuLock, LuScale, LuServer, LuZap} from "react-icons/lu";

/**
 * The public front page.
 *
 * A server component with no client JavaScript of its own, and deliberately outside the auth
 * layout: someone reading about the product has not signed in, and mounting the identity SDK here
 * would make them pay for a login they are not doing.
 *
 * Written to be checkable rather than persuasive. Every claim below corresponds to something that
 * exists — the per-tenant balance is a contract, the 402 is a real response code, the invariant is
 * a Foundry suite — because a paymaster asks people to trust it with money, and a landing page that
 * oversells is the first evidence that the rest might too.
 */
export const metadata = {
  title: "Paymaster · Gas sponsorship for your dApp",
};

export default function HomePage() {
  return (
    <div className="min-h-screen bg-oil-950">
      <Header />
      <main>
        <Hero />
        <HowItWorks />
        <Guarantees />
        <SelfHosted />
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-ash-800/60 bg-oil-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3.5 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-md bg-ash-200 text-oil-950">
            <LuZap className="size-4" aria-hidden />
          </span>
          <span className="text-sm font-semibold text-ash-100">Paymaster</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/docs" className="text-sm text-ash-400 transition-colors hover:text-ash-100">
            Docs
          </Link>
          <Link
            href="/dashboard"
            className="rounded-md bg-ash-200 px-3.5 py-1.5 text-sm font-medium text-oil-950 transition-colors hover:bg-ash-100"
          >
            Sign in
          </Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="mx-auto max-w-5xl px-4 pb-14 pt-16 sm:px-6 sm:pt-24">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ash-600">ERC-4337 · EntryPoint v0.7</p>
      <h1 className="mt-3 max-w-2xl text-3xl font-semibold leading-tight text-ash-100 sm:text-4xl">
        Your users stop needing ETH to use your app.
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ash-400 sm:text-base">
        Sponsor gas for the transactions you choose, under limits you set. Gas comes out of a balance
        you fund and own on chain — not a shared pool, and not credit we extend you.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 rounded-md bg-ash-200 px-4 py-2.5 text-sm font-medium text-oil-950 transition-colors hover:bg-ash-100"
        >
          Create an account
          <LuArrowRight className="size-4" aria-hidden />
        </Link>
        <a
          href="https://github.com"
          className="inline-flex items-center gap-1.5 rounded-md border border-ash-800 px-4 py-2.5 text-sm text-ash-300 transition-colors hover:border-ash-700 hover:text-ash-100"
        >
          <LuGithub className="size-4" aria-hidden />
          Read the source
        </a>
      </div>

      {/* The integration, in the smallest honest form. Anything shorter would be hiding a step. */}
      <pre className="mt-10 overflow-x-auto rounded-lg border border-ash-800 bg-oil-900 p-4 font-mono text-[11px] leading-relaxed text-ash-400 sm:text-xs">
        <code>{`const {paymasterAndData} = await fetch("https://api.example.com/paymaster/sponsor", {
  method: "POST",
  headers: {authorization: \`Bearer \${PAYMASTER_API_KEY}\`},
  body: JSON.stringify({chainId: 8453, userOperation}),
}).then((r) => r.json());

// Attach it to the operation and send it to your bundler. That is the whole integration.`}</code>
      </pre>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      icon: LuKeyRound,
      title: "Mint a key",
      body: "Sign in, create an organisation, and issue an API key scoped to it. The secret is shown once and stored only as a hash, so a leaked key is revoked rather than recovered.",
    },
    {
      icon: LuCoins,
      title: "Fund a balance",
      body: "Deposit to your own balance, per chain. It is held in the paymaster contract under a key derived from your account, and only your operations can spend it.",
    },
    {
      icon: LuScale,
      title: "Set the limits",
      body: "Allowlist contracts and methods, cap spend per day, throttle per sender. An operation outside your policy is refused before anything is signed.",
    },
  ];

  return (
    <section className="border-t border-ash-800/60 bg-oil-900/40">
      <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
        <h2 className="text-lg font-semibold text-ash-100">How it works</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {steps.map(({icon: Icon, title, body}) => (
            <div key={title} className="rounded-lg border border-ash-800 bg-oil-900 p-4">
              <span className="grid size-8 place-items-center rounded-md border border-ash-800 bg-oil-950 text-ash-400">
                <Icon className="size-4" aria-hidden />
              </span>
              <h3 className="mt-3 text-sm font-medium text-ash-100">{title}</h3>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ash-500">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The claims worth making, each one a property of the system rather than a promise about it.
 *
 * Phrased as what CANNOT happen, because that is the only interesting kind of guarantee for
 * something holding your money.
 */
function Guarantees() {
  const items = [
    {
      title: "Your balance pays for your operations, and nobody else's",
      body: "The tenant is inside the signed attestation and checked on chain, so an attestation issued for one account cannot be edited to spend another's. The contract enforces it; our bookkeeping is not what stands between accounts.",
    },
    {
      title: "The paymaster can never owe more than it holds",
      body: "Sum of all balances stays at or below the EntryPoint deposit. That is asserted by an invariant suite driving real operations through a real EntryPoint, not argued for in a document.",
    },
    {
      title: "Running out of gas money is a 402, not a mystery",
      body: "An unfunded request is refused before anything is signed, with a status code that says to add funds rather than to retry. If your subscription lapses, sponsorship stops — your balance, keys and history do not.",
    },
    {
      title: "We never front your gas, so we never need credit checks",
      body: "The subscription buys platform access; gas comes from your own funded balance. There is no shared deposit to overspend and no invoice for someone else's traffic.",
    },
  ];

  return (
    <section className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
      <h2 className="text-lg font-semibold text-ash-100">What is actually guaranteed</h2>
      <dl className="mt-6 grid gap-4 sm:grid-cols-2">
        {items.map(({title, body}) => (
          <div key={title} className="rounded-lg border border-ash-800 bg-oil-900 p-4">
            <dt className="flex gap-2 text-sm font-medium text-ash-100">
              <LuLock className="mt-0.5 size-3.5 shrink-0 text-ash-600" aria-hidden />
              {title}
            </dt>
            <dd className="mt-1.5 text-[11px] leading-relaxed text-ash-500">{body}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SelfHosted() {
  return (
    <section className="border-t border-ash-800/60 bg-oil-900/40">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-14 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="max-w-xl">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-ash-100">
            <LuServer className="size-4 text-ash-600" aria-hidden />
            Or run the whole thing yourself
          </h2>
          <p className="mt-2 text-[11px] leading-relaxed text-ash-500">
            The paymaster, the policy engine, the contracts and both consoles are one repository with
            a Docker Compose stack and a Helm chart. Self-hosting is the original shape of this
            project, not a downgrade of it — the hosted service is the same code with the multi-tenant
            contract switched on.
          </p>
        </div>
        <a
          href="https://github.com"
          className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border border-ash-800 px-4 py-2.5 text-sm text-ash-300 transition-colors hover:border-ash-700 hover:text-ash-100"
        >
          <LuGithub className="size-4" aria-hidden />
          Deployment guide
        </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-ash-800/60">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-[11px] text-ash-700 sm:px-6">
        <p>Self-hosted ERC-4337 paymaster.</p>
        <Link href="/dashboard" className="transition-colors hover:text-ash-500">
          Sign in
        </Link>
      </div>
    </footer>
  );
}
