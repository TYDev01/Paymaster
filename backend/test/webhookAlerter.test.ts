import {createHmac} from "node:crypto";
import {describe, expect, it} from "vitest";

import type {Alert} from "../src/monitoring/alerting.js";
import {CompositeAlerter} from "../src/monitoring/alerting.js";
import {AlertDeliveryError, WebhookAlerter, type FetchLike} from "../src/monitoring/webhookAlerter.js";

interface Posted {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Records what was posted and replays a scripted sequence of responses. */
function recorder(statuses: readonly (number | "throw")[] = [200]): {
  fetch: FetchLike;
  posts: Posted[];
} {
  const posts: Posted[] = [];
  let call = 0;
  const fetch: FetchLike = async (url, init) => {
    posts.push({url, headers: init.headers, body: JSON.parse(init.body) as unknown});
    const status = statuses[Math.min(call, statuses.length - 1)] ?? 200;
    call += 1;
    if (status === "throw") throw new Error("network down");
    return {ok: status >= 200 && status < 300, status};
  };
  return {fetch, posts};
}

const options = {
  url: "https://pager.example.com/hook",
  format: "generic" as const,
  timeoutMs: 1_000,
  retries: 0,
  minSeverity: "warning" as const,
};

const alert: Alert = {
  key: "deposit-low:8453",
  severity: "critical",
  title: "deposit below threshold",
  detail: "chain 8453 deposit is 0.01 ETH",
  labels: {chainId: "8453"},
};

describe("WebhookAlerter", () => {
  it("posts the generic payload with the alert's identity and labels", async () => {
    const {fetch, posts} = recorder();
    await new WebhookAlerter(options, fetch, () => 1_700_000_000_000).fire(alert);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(options.url);
    expect(posts[0]!.body).toEqual({
      event: "fire",
      key: "deposit-low:8453",
      severity: "critical",
      title: "deposit below threshold",
      detail: "chain 8453 deposit is 0.01 ETH",
      labels: {chainId: "8453"},
      source: "paymaster",
      timestamp: 1_700_000_000,
    });
  });

  it("signs the generic payload the same way inbound requests are signed", async () => {
    const secret = "a".repeat(32);
    const {fetch, posts} = recorder();
    await new WebhookAlerter({...options, signingSecret: secret}, fetch, () => 1_700_000_000_000).fire(alert);

    const {headers, body} = posts[0]!;
    const canonical = `1700000000\nPOST\n/hook\n${JSON.stringify(body)}`;
    expect(headers["x-timestamp"]).toBe("1700000000");
    expect(headers["x-signature"]).toBe(createHmac("sha256", secret).update(canonical, "utf8").digest("hex"));
  });

  it("opens and closes a PagerDuty incident under one dedup key", async () => {
    const {fetch, posts} = recorder();
    const alerter = new WebhookAlerter({...options, format: "pagerduty", routingKey: "rk"}, fetch);

    await alerter.fire(alert);
    await alerter.resolve(alert.key);

    expect(posts[0]!.body).toMatchObject({
      routing_key: "rk",
      event_action: "trigger",
      dedup_key: "deposit-low:8453",
      payload: {severity: "critical", source: "paymaster"},
    });
    expect(posts[1]!.body).toEqual({routing_key: "rk", event_action: "resolve", dedup_key: "deposit-low:8453"});
  });

  it("refuses a pagerduty configuration with no routing key", () => {
    expect(() => new WebhookAlerter({...options, format: "pagerduty"})).toThrow(/routing key/);
  });

  it("drops alerts below the configured severity, and their resolutions with them", async () => {
    const {fetch, posts} = recorder();
    const alerter = new WebhookAlerter({...options, minSeverity: "critical"}, fetch);

    await alerter.fire({...alert, key: "stake-low:8453", severity: "warning"});
    // The resolve must NOT be sent: nothing was paged, and a stray resolve can close an unrelated
    // incident that happens to share the key.
    await alerter.resolve("stake-low:8453");
    await alerter.fire(alert);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({key: "deposit-low:8453"});
  });

  it("does not resolve a key it never fired", async () => {
    const {fetch, posts} = recorder();
    await new WebhookAlerter(options, fetch).resolve("never-fired");
    expect(posts).toHaveLength(0);
  });

  it("retries a 5xx and succeeds", async () => {
    const {fetch, posts} = recorder([500, 200]);
    await new WebhookAlerter({...options, retries: 1}, fetch).fire(alert);
    expect(posts).toHaveLength(2);
  });

  it("gives up after exhausting retries", async () => {
    const {fetch, posts} = recorder(["throw"]);
    await expect(new WebhookAlerter({...options, retries: 1}, fetch).fire(alert)).rejects.toBeInstanceOf(
      AlertDeliveryError,
    );
    expect(posts).toHaveLength(2);
  });

  it("does not retry a 4xx, which is a configuration error rather than a blip", async () => {
    const {fetch, posts} = recorder([403]);
    await expect(new WebhookAlerter({...options, retries: 3}, fetch).fire(alert)).rejects.toThrow(/HTTP 403/);
    expect(posts).toHaveLength(1);
  });

  it("cannot take the alerting path down when composed: a dead pager still leaves the log sink", async () => {
    const {fetch} = recorder(["throw"]);
    const delivered: string[] = [];
    const composite = new CompositeAlerter([
      {fire: (a) => void delivered.push(a.key), resolve: () => undefined},
      new WebhookAlerter({...options, retries: 0}, fetch),
    ]);

    await expect(composite.fire(alert)).resolves.toBeUndefined();
    expect(delivered).toEqual(["deposit-low:8453"]);
  });
});
