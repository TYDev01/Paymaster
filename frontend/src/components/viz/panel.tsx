"use client";

import {motion} from "motion/react";
import {LuInfo} from "react-icons/lu";

import {cn} from "@/lib/utils";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";

/**
 * The container every chart and table sits in.
 *
 * It exists so the *frame* is uniform and recessive and the data is the only thing that varies:
 * same border, same padding, same title weight everywhere. The optional `hint` carries the caveat
 * a number needs to be read correctly — the difference between "committed" and "spent", say — where
 * an operator will actually see it, rather than in documentation they will not have open.
 */
export function Panel({
  title,
  subtitle,
  hint,
  actions,
  className,
  children,
  delay = 0,
}: {
  title: string;
  subtitle?: string;
  hint?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  delay?: number;
}) {
  return (
    <motion.section
      initial={{opacity: 0, y: 8}}
      animate={{opacity: 1, y: 0}}
      transition={{duration: 0.32, delay, ease: [0.22, 0.61, 0.36, 1]}}
      className={cn(
        "flex flex-col rounded-lg border border-border bg-card",
        // A hairline highlight along the top edge lifts the card off a near-black page without
        // adding a heavier border, which would compete with the data.
        "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]",
        className,
      )}
    >
      <header className="flex items-start gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-sm font-medium text-ash-100">{title}</h2>
            {hint !== undefined ? (
              <Tooltip>
                <TooltipTrigger
                  className="text-ash-600 transition-colors hover:text-ash-300"
                  aria-label={`About ${title}`}
                >
                  <LuInfo className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs leading-relaxed">{hint}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          {subtitle !== undefined ? <p className="mt-0.5 truncate text-xs text-ash-500">{subtitle}</p> : null}
        </div>
        {actions}
      </header>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </motion.section>
  );
}

/**
 * What a chart shows before it has anything to show.
 *
 * Distinct from an error and distinct from zero: "waiting for data" is a real, common state on a
 * page whose history starts when you open it, and it must not be mistaken for "nothing is
 * happening" — which is a fact about the system rather than about the page.
 */
export function EmptyState({title, detail}: {title: string; detail?: string}) {
  return (
    <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-1 px-4 text-center">
      <p className="text-xs font-medium text-ash-400">{title}</p>
      {detail !== undefined ? <p className="max-w-sm text-[11px] leading-relaxed text-ash-600">{detail}</p> : null}
    </div>
  );
}
