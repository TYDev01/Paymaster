import {AuthProvider} from "@/components/auth-provider";
import {Shell} from "@/components/shell";

/**
 * The signed-in half of the site.
 *
 * The auth provider and the gate live HERE rather than in the root layout, so the public pages do
 * not mount them. Two reasons, and the second is the one that matters:
 *
 *   1. The identity SDK is a large client bundle with network calls of its own. A marketing page
 *      that loads it pays for a login nobody on that page is doing.
 *   2. The gate is a route-level guarantee. Every page under this layout is written as though a
 *      session exists, because inside it one does — and a page added later inherits that without
 *      anyone remembering to add a check.
 */
export default function DashboardLayout({children}: {children: React.ReactNode}) {
  return (
    <AuthProvider>
      <Shell>{children}</Shell>
    </AuthProvider>
  );
}
