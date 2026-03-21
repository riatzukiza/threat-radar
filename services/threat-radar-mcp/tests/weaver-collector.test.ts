import { describe, it, expect, vi } from "vitest";

import { WeaverCollector } from "../src/collectors/weaver.js";

function makeStatusResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    state: "running",
    started_at: 1774030000000,
    metrics: {
      discovered: 120,
      fetched: 48,
      frontier_size: 72,
      errors: 3,
    },
    active_domains: ["www.iea.org", "www.ukmto.org"],
    domain_distribution: {
      "www.iea.org": 42,
      "www.ukmto.org": 7,
      "example.com": 999,
    },
    world_watch_seed_count: 5,
    ...overrides,
  };
}

function makeGraphResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    graph: {
      nodes: [
        {
          id: "url:https://www.iea.org/topics/the-middle-east-and-global-energy-markets",
          kind: "url",
          label: "IEA Middle East market page",
          url: "https://www.iea.org/topics/the-middle-east-and-global-energy-markets",
          domain: "www.iea.org",
          status: "fetched",
          title: "The Middle East and global energy markets",
          source_url: "https://www.iea.org/topics/the-middle-east-and-global-energy-markets",
          fetched_at: 1774030100000,
          discovered_at: 1774030005000,
          source_family: "web",
          compliance: "allowed",
        },
        {
          id: "url:https://www.iea.org/search?q=heating",
          kind: "url",
          label: "Irrelevant IEA search result",
          url: "https://www.iea.org/search?q=heating",
          domain: "www.iea.org",
          status: "queued",
          title: "Heating results",
          source_url: "https://www.iea.org/search?q=heating",
          fetched_at: 1774030090000,
          discovered_at: 1774030004000,
          source_family: "web",
          compliance: "allowed",
        },
        {
          id: "url:https://example.com/off-topic",
          kind: "url",
          label: "Off-topic node",
          url: "https://example.com/off-topic",
          domain: "example.com",
          status: "fetched",
          title: "Completely unrelated",
          source_url: "https://example.com/",
          fetched_at: 1774030110000,
          discovered_at: 1774030003000,
          source_family: "web",
          compliance: "allowed",
        },
      ],
      counts: { nodes_total: 120, edges_total: 240 },
    },
    ...overrides,
  };
}

describe("weaver collector", () => {
  it("builds bounded crawler signals from status + graph data", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/weaver/status")) {
        return new Response(JSON.stringify(makeStatusResponse()), { status: 200 });
      }
      if (url.includes("/api/weaver/graph")) {
        return new Response(JSON.stringify(makeGraphResponse()), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const collector = new WeaverCollector({ fetchImpl: fetchMock as typeof fetch });
    const signals = await collector.collect({
      baseUrl: "http://127.0.0.1:8793",
      domainAllowlist: ["iea.org", "ukmto.org"],
      keywords: ["middle east", "hormuz", "energy markets"],
      domainSignalLimit: 4,
      recentNodeLimit: 4,
      graphNodeLimit: 200,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals.length).toBeGreaterThanOrEqual(3);

    const titles = signals.map((signal) => signal.title);
    expect(titles.some((title) => title?.endsWith("crawler status summary"))).toBe(true);
    expect(titles.some((title) => title?.endsWith("crawler activity: www.iea.org"))).toBe(true);
    expect(titles).toContain("The Middle East and global energy markets");

    const offTopic = signals.find((signal) => signal.links?.includes("https://example.com/off-topic"));
    expect(offTopic).toBeUndefined();
  });

  it("can run without graph node ingestion", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/weaver/status")) {
        return new Response(JSON.stringify(makeStatusResponse()), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const collector = new WeaverCollector({ fetchImpl: fetchMock as typeof fetch });
    const signals = await collector.collect({
      domainAllowlist: ["ukmto.org"],
      recentNodeLimit: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals.some((signal) => signal.title === "Crawler status summary")).toBe(true);
    expect(signals.some((signal) => signal.title === "Crawler activity: www.ukmto.org")).toBe(true);
  });
});
