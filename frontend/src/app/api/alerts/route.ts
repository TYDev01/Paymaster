import {readFile} from "node:fs/promises";
import {join} from "node:path";

import {NextResponse} from "next/server";
import {parse} from "yaml";

/**
 * The alert catalogue, read from the repository's own rule file.
 *
 * Deliberately the SAME file Prometheus loads and the Helm chart injects
 * (`deploy/monitoring/prometheus/alerts.yml`) rather than a copy maintained for the UI. A dashboard
 * that lists alerts which no longer exist — or omits ones that do — is worse than one that lists
 * none, because it is quietly wrong in the direction of false confidence.
 *
 * This lists what WOULD fire and what to do about it. It does not claim anything is firing now:
 * that requires Alertmanager or a Prometheus rule evaluation, neither of which this app is.
 */
export interface AlertRuleView {
  readonly name: string;
  readonly group: string;
  readonly severity: string;
  readonly expr: string;
  readonly forDuration: string | undefined;
  readonly summary: string | undefined;
  readonly description: string | undefined;
  readonly runbookUrl: string | undefined;
  /** True when the threshold ships as a placeholder that has to be tuned to real traffic. */
  readonly needsTuning: boolean;
}

interface RawRule {
  alert?: string;
  expr?: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

// Route handlers are uncached in Next 16, which is what a monitoring endpoint needs; no opt-out
// is required, and adding `force-dynamic` would only imply that caching was otherwise in play.
export async function GET() {
  const path =
    process.env["PAYMASTER_ALERT_RULES"] ??
    join(process.cwd(), "..", "deploy", "monitoring", "prometheus", "alerts.yml");

  try {
    const source = await readFile(path, "utf8");
    const document = parse(source) as {groups?: {name?: string; rules?: RawRule[]}[]};

    const rules: AlertRuleView[] = (document.groups ?? []).flatMap((group) =>
      (group.rules ?? [])
        .filter((rule) => rule.alert !== undefined)
        .map((rule) => ({
          name: rule.alert!,
          group: group.name ?? "ungrouped",
          severity: rule.labels?.["severity"] ?? "unknown",
          expr: (rule.expr ?? "").trim(),
          forDuration: rule.for,
          summary: rule.annotations?.["summary"],
          description: rule.annotations?.["description"],
          runbookUrl: rule.annotations?.["runbook_url"],
          // The rule file marks these with a TUNE comment; the placeholder thresholds are the two
          // that depend on traffic volume, and an operator should know which numbers are guesses.
          needsTuning: ["PaymasterGasCommitmentSurge", "PaymasterDenialSurge"].includes(rule.alert!),
        })),
    );

    return NextResponse.json({source: path, rules});
  } catch (error) {
    return NextResponse.json(
      {
        source: path,
        rules: [],
        error: `could not read the alert rules: ${error instanceof Error ? error.message : String(error)}`,
      },
      {status: 200},
    );
  }
}
