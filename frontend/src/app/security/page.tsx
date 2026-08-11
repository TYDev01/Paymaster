"use client";

import {LuBan, LuKeyRound, LuShieldAlert} from "react-icons/lu";

import {PageHeader} from "@/components/panels/page-header";
import {Panel} from "@/components/viz/panel";
import {StatTile} from "@/components/viz/stat-tile";
import {BreakdownBars} from "@/components/viz/breakdown-bars";
import {RateChart} from "@/components/viz/rate-chart";
import {latestRate, useTelemetry} from "@/hooks/use-telemetry";
import {formatCount, formatRate} from "@/lib/format";
import {SERIES, STATUS} from "@/components/viz/theme";

export default function SecurityPage() {
  const {telemetry, rates} = useTelemetry();
  const abuse = telemetry?.abuse;
  const authRate = latestRate(rates, "authFailures");

  return (
    <>
      <PageHeader
        title="Security"
        description="Pre-authentication throttling and abuse detection. These counters are deliberately unlabelled by IP: an attacker picks their own source address, so an ip label would be unbounded cardinality — the offending addresses are in the alert log, not here."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Auth failures"
          value={authRate === undefined ? formatCount(abuse?.authFailures) : formatRate(authRate, "")}
          unit={authRate === undefined ? "total" : "/s"}
          caption="Either credential stuffing, or an integrator deployed a bad key. Many source IPs is the first; one is the second."
          icon={LuKeyRound}
          severity={authRate !== undefined && authRate > 1 ? "warning" : undefined}
          spark={rates.map((point) => point.authFailures)}
          sparkColor={STATUS.warning}
          delay={0}
        />
        <StatTile
          label="IP blocks"
          value={formatCount(abuse?.ipBlocks)}
          unit="total"
          caption="Each one is an IP crossing the auth-failure threshold. Several at once is a distributed attempt, not one bad client."
          icon={LuBan}
          severity={(abuse?.ipBlocks ?? 0) > 0 ? "warning" : "good"}
          delay={0.04}
        />
        <StatTile
          label="Pre-auth rejections"
          value={formatCount(abuse?.rejectionsByReason.reduce((sum, item) => sum + item.value, 0))}
          unit="total"
          caption="Refused before authentication ran — which is what protects the auth path itself."
          icon={LuShieldAlert}
          delay={0.08}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Authentication failures"
          subtitle="Per second, since this page opened"
          hint="The backend pages once per blocked IP. This is the campaign view: many IPs, none individually past the threshold, is invisible to a per-IP alert and obvious here."
          delay={0.12}
        >
          <RateChart
            data={rates as unknown as Record<string, number>[]}
            series={[{key: "authFailures", label: "Auth failures", color: STATUS.warning}]}
            emptyDetail="Rates need two scrapes; the first point appears one interval after the page loads."
          />
        </Panel>

        <Panel
          title="Rejections by reason"
          subtitle="Throttled vs blocked, cumulative"
          hint="Throttled means over the rate limit for a window. Blocked means the IP crossed the auth-failure threshold and is refused outright until the window rolls."
          delay={0.16}
        >
          <BreakdownBars
            items={abuse?.rejectionsByReason ?? []}
            emptyTitle="No pre-auth rejections"
            emptyDetail="No request has been throttled or blocked before reaching authentication."
            colorFor={(item) => (item.key === "blocked" ? STATUS.critical : SERIES[3])}
          />
        </Panel>
      </div>
    </>
  );
}
