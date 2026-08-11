"use client";

import {useEffect, useState} from "react";
import {LuBookOpen, LuExternalLink, LuTriangleAlert} from "react-icons/lu";
import {motion} from "motion/react";

import {PageHeader} from "@/components/panels/page-header";
import {Panel, EmptyState} from "@/components/viz/panel";
import {StatusPill} from "@/components/viz/status";
import {Skeleton} from "@/components/ui/skeleton";
import type {Severity} from "@/lib/telemetry";
import type {AlertRuleView} from "@/app/api/alerts/route";

/**
 * The alert catalogue.
 *
 * This page is careful about one thing: it shows what WOULD fire and what to do about it, and it
 * does not claim anything is firing. Rule evaluation belongs to Prometheus and routing to
 * Alertmanager; a dashboard that guessed at firing state would eventually disagree with the pager,
 * and the pager is the one that wakes people up.
 */
export default function AlertsPage() {
  const [rules, setRules] = useState<AlertRuleView[]>();
  const [error, setError] = useState<string>();
  const [source, setSource] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/alerts", {cache: "no-store"});
        const body = (await response.json()) as {rules: AlertRuleView[]; source?: string; error?: string};
        if (cancelled) return;
        setRules(body.rules);
        setSource(body.source);
        setError(body.error);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = groupBy(rules ?? [], (rule) => rule.group);

  return (
    <>
      <PageHeader
        title="Alerts"
        description="The Prometheus rules this deployment ships, read from the same alerts.yml that Prometheus loads and the Helm chart injects. Evaluation and paging happen there, not here."
      />

      {error !== undefined ? (
        <Panel title="Rules unavailable">
          <EmptyState title="Could not read the rule file" detail={error} />
        </Panel>
      ) : rules === undefined ? (
        <div className="space-y-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-28 w-full rounded-lg bg-oil-850" />
          ))}
        </div>
      ) : rules.length === 0 ? (
        <Panel title="No rules">
          <EmptyState title="The rule file parsed but contained no alerts" detail={source} />
        </Panel>
      ) : (
        <div className="space-y-4">
          {Object.entries(groups).map(([group, groupRules], groupIndex) => (
            <Panel
              key={group}
              title={group}
              subtitle={`${groupRules.length} rule${groupRules.length === 1 ? "" : "s"}`}
              delay={groupIndex * 0.05}
            >
              <ul className="space-y-3">
                {groupRules.map((rule, index) => (
                  <RuleCard key={rule.name} rule={rule} index={index} />
                ))}
              </ul>
            </Panel>
          ))}
          <p className="px-1 text-[11px] text-ash-600">Source: {source}</p>
        </div>
      )}
    </>
  );
}

function RuleCard({rule, index}: {rule: AlertRuleView; index: number}) {
  return (
    <motion.li
      initial={{opacity: 0, y: 6}}
      animate={{opacity: 1, y: 0}}
      transition={{duration: 0.28, delay: index * 0.03}}
      className="rounded-md border border-border bg-oil-900 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-sm font-medium text-ash-100">{rule.name}</h3>
            <StatusPill severity={severityOf(rule.severity)} label={rule.severity} />
            {rule.forDuration !== undefined ? (
              <span className="rounded border border-ash-800 bg-oil-800 px-1.5 py-0.5 text-[10px] text-ash-500">
                for {rule.forDuration}
              </span>
            ) : null}
            {rule.needsTuning ? (
              <span className="inline-flex items-center gap-1 rounded border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
                <LuTriangleAlert className="size-2.5" aria-hidden />
                threshold needs tuning
              </span>
            ) : null}
          </div>
          {rule.summary !== undefined ? <p className="mt-1 text-xs text-ash-300">{rule.summary}</p> : null}
        </div>

        {rule.runbookUrl !== undefined ? (
          <a
            href={rule.runbookUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-ash-800 px-2 py-1 text-[11px] text-ash-400 transition-colors hover:border-ash-600 hover:text-ash-100"
          >
            <LuBookOpen className="size-3" aria-hidden />
            Runbook
            <LuExternalLink className="size-2.5" aria-hidden />
          </a>
        ) : null}
      </div>

      {rule.description !== undefined ? (
        <p className="mt-2 text-[11px] leading-relaxed text-ash-500">{rule.description}</p>
      ) : null}

      <pre className="mt-2 overflow-x-auto rounded border border-ash-800 bg-oil-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ash-400">
        {rule.expr}
      </pre>
    </motion.li>
  );
}

function severityOf(value: string): Severity {
  return value === "critical" || value === "warning" || value === "serious" || value === "good" ? value : "unknown";
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    (groups[key(item)] ??= []).push(item);
  }
  return groups;
}
