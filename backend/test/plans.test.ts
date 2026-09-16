import {describe, expect, it} from "vitest";

import {InvalidPlansError, parsePlansJson, planView, UnknownPlanError} from "../src/billing/plans.js";

const GROWTH = {
  id: "growth",
  name: "Growth",
  periodSeconds: 2_592_000,
  priceWei: {"11155111": "10000000000000000", "8453": "5000000000000000"},
  limits: {operationsPerDay: "10000", weiPerDay: "200000000000000000"},
  chainIds: [11155111, 8453],
};

describe("plan catalogue", () => {
  it("parses prices as exact wei per chain, never through a float", () => {
    const catalogue = parsePlansJson(JSON.stringify([{...GROWTH, priceWei: {"1": "123456789012345678901"}}]));
    expect(catalogue.get("growth").priceWei.get(1)).toBe(123_456_789_012_345_678_901n);
  });

  it("reads limits and chain access", () => {
    const plan = parsePlansJson(JSON.stringify([GROWTH])).get("growth");
    expect(plan.limits.operationsPerDay).toBe(10_000n);
    expect(plan.limits.weiPerDay).toBe(200_000_000_000_000_000n);
    expect(plan.chainIds).toEqual([11155111, 8453]);
  });

  it("treats an unset or empty PLANS as selling nothing", () => {
    expect(parsePlansJson(undefined).size).toBe(0);
    expect(parsePlansJson("  ").size).toBe(0);
  });

  it("refuses a default plan that does not exist, rather than applying no ceiling", () => {
    expect(() => parsePlansJson(JSON.stringify([GROWTH]), "enterprise")).toThrow(/DEFAULT_PLAN_ID/);
    expect(() => parsePlansJson(undefined, "growth")).toThrow(InvalidPlansError);
  });

  it("names the offending field", () => {
    expect(() => parsePlansJson(JSON.stringify([{...GROWTH, priceWei: {"1": 1000}}]))).toThrow(
      /PLANS\[0\.priceWei\.1\]/,
    );
    expect(() => parsePlansJson(JSON.stringify([{...GROWTH, priceWei: {"1": "0"}}]))).toThrow(/free grant/);
    expect(() => parsePlansJson(JSON.stringify([{...GROWTH, periodSeconds: 60}]))).toThrow(/periodSeconds/);
    expect(() => parsePlansJson("not json")).toThrow(/not valid JSON/);
  });

  it("refuses duplicate plan ids", () => {
    expect(() => parsePlansJson(JSON.stringify([GROWTH, GROWTH]))).toThrow(/duplicate plan id/);
  });

  it("reports an unknown plan by name", () => {
    expect(() => parsePlansJson(JSON.stringify([GROWTH])).get("nope")).toThrow(UnknownPlanError);
  });

  it("renders a plan with string amounts for the API", () => {
    const view = planView(parsePlansJson(JSON.stringify([GROWTH])).get("growth"));
    expect(view.priceWei).toEqual({"11155111": "10000000000000000", "8453": "5000000000000000"});
    expect(view.limits).toEqual({operationsPerDay: "10000", weiPerDay: "200000000000000000"});
  });
});
