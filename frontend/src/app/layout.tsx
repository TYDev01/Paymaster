import type {Metadata} from "next";
import {Geist, Geist_Mono} from "next/font/google";

import "./globals.css";
import {AppShell} from "@/components/shell/app-shell";
import {TelemetryProvider} from "@/hooks/use-telemetry";
import {TooltipProvider} from "@/components/ui/tooltip";
import {MotionConfig} from "motion/react";

const sans = Geist({variable: "--font-sans", subsets: ["latin"]});
const mono = Geist_Mono({variable: "--font-geist-mono", subsets: ["latin"]});

export const metadata: Metadata = {
  title: "Paymaster Console",
  description: "Operational monitoring for the self-hosted ERC-4337 paymaster.",
};

/**
 * One polling loop for the whole app.
 *
 * The telemetry provider sits above the shell so navigating between pages does not restart the
 * poll or discard the rolling window — the history is the only chart data this app has, and losing
 * it on every route change would make the charts permanently empty for anyone who clicks around.
 */
export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className="dark">
      <body className={`${sans.variable} ${mono.variable} font-sans`}>
        {/*
          Entrance animations fade content in from opacity 0, which means the content is INVISIBLE
          until the animation runs. That is fine in a normal browser and not fine anywhere it does
          not: a reader who asked the OS for reduced motion, a print, a screenshot pipeline. With
          `reducedMotion="user"` motion honours the OS setting and jumps straight to the end state,
          so the page is readable either way and no information depends on an animation completing.
        */}
        <MotionConfig reducedMotion="user">
          <TooltipProvider delay={200}>
            <TelemetryProvider>
              <AppShell>{children}</AppShell>
            </TelemetryProvider>
          </TooltipProvider>
        </MotionConfig>
      </body>
    </html>
  );
}
