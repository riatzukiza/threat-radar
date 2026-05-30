import { describe, expect, it } from "vitest";

import {
  extractHashtags,
  jetstreamEventToRawCollectorOutput,
  matchesJetstreamRule,
  normalizeJetstreamRule,
} from "../src/jetstream.js";

describe("jetstream helpers", () => {
  it("extracts hashtags case-insensitively", () => {
    expect(extractHashtags("Watching #Hormuz and #Shipping #hormuz")).toEqual(["hormuz", "shipping"]);
  });

  it("normalizes rule input and rejects unsafe network-wide rules by default", () => {
    expect(() => normalizeJetstreamRule("radar-1", {
      hashtags: ["Hormuz"],
      wantedUsers: [],
      wantedDids: [],
      allowNetworkWide: false,
    }, [])).toThrow(/allowNetworkWide/);

    const rule = normalizeJetstreamRule("radar-1", {
      hashtags: ["Hormuz", "shipping"],
      keywords: ["strait of hormuz"],
      allowNetworkWide: true,
    }, []);

    expect(rule.hashtags).toEqual(["hormuz", "shipping"]);
    expect(rule.keywords).toEqual(["strait of hormuz"]);
    expect(rule.enabled).toBe(true);
    expect(rule.allowNetworkWide).toBe(true);
  });

  it("matches posts using did, hashtag, and keyword filters", () => {
    const rule = normalizeJetstreamRule("radar-1", {
      wantedDids: ["did:plc:test123"],
      hashtags: ["hormuz"],
      keywords: ["shipping lane"],
    }, []);

    const matchingEvent = {
      did: "did:plc:test123",
      kind: "commit",
      time_us: 1774000000000000,
      commit: {
        operation: "create",
        collection: "app.bsky.feed.post",
        rkey: "abc",
        record: {
          text: "Critical #Hormuz shipping lane disruption update",
          createdAt: "2026-03-20T00:00:00.000Z",
        },
      },
    };
    expect(matchesJetstreamRule(matchingEvent, rule)).toBe(true);

    const wrongDid = { ...matchingEvent, did: "did:plc:other" };
    expect(matchesJetstreamRule(wrongDid, rule)).toBe(false);
  });

  it("converts a jetstream post into collector output", () => {
    const signal = jetstreamEventToRawCollectorOutput({
      did: "did:plc:test123",
      kind: "commit",
      time_us: 1774000000000000,
      commit: {
        operation: "create",
        collection: "app.bsky.feed.post",
        rkey: "abc",
        record: {
          text: "Watching #Hormuz tanker movements closely",
          createdAt: "2026-03-20T00:00:00.000Z",
          facets: [
            {
              features: [{ uri: "https://example.com/report" }],
            },
          ],
        },
      },
    });

    expect(signal).not.toBeNull();
    expect(signal?.provenance.source_type).toBe("bluesky");
    expect(signal?.links).toContain("https://example.com/report");
    expect(signal?.domain_tags).toContain("jetstream");
    expect(signal?.domain_tags).toContain("hormuz");
  });
});
