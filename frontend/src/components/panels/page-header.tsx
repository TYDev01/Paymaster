"use client";

import {motion} from "motion/react";

/** The one-line answer, then the detail. Every page opens the same way so the eye knows where to go. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{opacity: 0, y: -6}}
      animate={{opacity: 1, y: 0}}
      transition={{duration: 0.3, ease: [0.22, 0.61, 0.36, 1]}}
      className="mb-6 flex flex-wrap items-end justify-between gap-4"
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ash-100">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ash-500">{description}</p>
      </div>
      {actions}
    </motion.div>
  );
}
