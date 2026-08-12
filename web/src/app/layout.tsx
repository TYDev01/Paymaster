import type {Metadata} from "next";
import {Geist, Geist_Mono} from "next/font/google";
import {MotionConfig} from "motion/react";

import "./globals.css";

const sans = Geist({variable: "--font-sans", subsets: ["latin"]});
const mono = Geist_Mono({variable: "--font-geist-mono", subsets: ["latin"]});

export const metadata: Metadata = {
  title: {default: "Paymaster", template: "%s · Paymaster"},
  description: "Sponsor gas for your users. Fund a balance you own on chain, and spend only what you funded.",
};

/**
 * The CUSTOMER-facing app, deliberately a separate deployment from the operator console.
 *
 * They could have been one Next app with two route groups, and that would have been a mistake: the
 * console's server holds `PAYMASTER_ADMIN_KEY`, a platform credential that can read and write every
 * tenant. In one process, every route handler here could read it from the environment, and a single
 * mistake in a customer-facing route would be worth the whole platform. This app's environment
 * simply does not contain it — the strongest form of "cannot", and the reason for the duplication.
 */
export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className="dark">
      <body className={`${sans.variable} ${mono.variable} font-sans`}>
        {/*
          Entrance animations fade in from opacity 0, so content is INVISIBLE until the animation
          runs. `reducedMotion="user"` honours the OS setting and jumps to the end state, which
          keeps the page readable for a reader who asked for reduced motion, and in print.
        */}
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
      </body>
    </html>
  );
}
