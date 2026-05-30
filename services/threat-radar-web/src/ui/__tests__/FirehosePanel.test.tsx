import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSignalFeed } from "../../api/client";
import type { RadarTile, SignalFeedItem } from "../../api/types";
import { FirehosePanel, MAX_SIGNAL_FEED, freshnessClass, relativeTime, sourceLinksForSignal } from "../components/FirehosePanel";

vi.mock("../../api/client", () => ({
  fetchSignalFeed: vi.fn(),
}));

const fetchSignalFeedMock = vi.mocked(fetchSignalFeed);

function makeTile(id = "radar-1", name = "Hormuz Threat Clock"): RadarTile {
  return {
    radar: {
      id,
      slug: id,
      name,
      category: "geopolitical",
      status: "active",
    },
    sourceCount: 0,
    submissionCount: 1,
    signalCount: 2,
    threads: [],
  };
}

function makeSignal(overrides: Partial<SignalFeedItem> = {}): SignalFeedItem {
  return {
    id: "sig-1",
    radar_id: "radar-1",
    provenance: {
      source_type: "bluesky",
      author: "operator.bsky.social",
      post_uri: "at://did:plc:test/app.bsky.feed.post/3kabc",
      confidence_class: "commentary",
      retrieved_at: "2026-03-21T00:00:00.000Z",
    },
    text: "Tanker insurance chatter is spiking after new regional warnings and shipping advisories.",
    title: "Insurance chatter spike",
    links: ["https://www.reuters.com/example-story"],
    domain_tags: ["shipping", "insurance", "hormuz"],
    observed_at: "2026-03-20T23:50:00.000Z",
    ingested_at: new Date().toISOString(),
    metadata: {
      source_url: "https://www.iea.org/report/example",
      score: 42,
    },
    category: "geopolitical",
    quality_score: 0.82,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSignalFeedMock.mockResolvedValue([]);
});

describe("freshnessClass", () => {
  it("returns fresh for recent timestamps", () => {
    expect(freshnessClass(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("fresh");
  });

  it("returns aging for mid-age timestamps", () => {
    expect(freshnessClass(new Date(Date.now() - 90 * 60_000).toISOString())).toBe("aging");
  });

  it("returns stale for old timestamps", () => {
    expect(freshnessClass(new Date(Date.now() - 5 * 3600_000).toISOString())).toBe("stale");
  });
});

describe("relativeTime", () => {
  it("formats recent timestamps", () => {
    expect(relativeTime(new Date(Date.now() - 4 * 60_000).toISOString())).toBe("4m ago");
  });
});

describe("sourceLinksForSignal", () => {
  it("converts Bluesky at:// URIs into browser links and preserves outbound links", () => {
    const links = sourceLinksForSignal(makeSignal());
    expect(links.some((link) => link.url === "https://bsky.app/profile/operator.bsky.social/post/3kabc")).toBe(true);
    expect(links.some((link) => link.url === "https://www.reuters.com/example-story")).toBe(true);
  });

  it("deduplicates repeated links", () => {
    const signal = makeSignal({
      links: ["https://example.com/a", "https://example.com/a"],
      metadata: { url: "https://example.com/a" },
    });
    const links = sourceLinksForSignal(signal);
    expect(links.filter((link) => link.url === "https://example.com/a")).toHaveLength(1);
  });
});

describe("FirehosePanel", () => {
  it("loads and renders raw signals by default", async () => {
    fetchSignalFeedMock.mockResolvedValue([makeSignal()]);

    render(<FirehosePanel apiUrl="" tiles={[makeTile()]} />);

    await waitFor(() => {
      expect(screen.getByText("Insurance chatter spike")).toBeInTheDocument();
    });

    expect(fetchSignalFeedMock).toHaveBeenCalledWith("", undefined, MAX_SIGNAL_FEED);
    expect(screen.getByText("Insurance chatter spike")).toBeInTheDocument();
    expect(screen.getAllByText("Hormuz Threat Clock").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("operator.bsky.social").length).toBeGreaterThanOrEqual(1);
  });

  it("shows expandable source links and metadata", async () => {
    fetchSignalFeedMock.mockResolvedValue([makeSignal()]);

    render(<FirehosePanel apiUrl="" tiles={[makeTile()]} />);

    await waitFor(() => {
      expect(screen.getByText("Insurance chatter spike")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Insurance chatter spike"));

    await waitFor(() => {
      expect(screen.getAllByTestId("signal-link").length).toBeGreaterThanOrEqual(2);
    });

    expect(screen.getAllByText(/Tanker insurance chatter is spiking/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Inspect metadata")).toBeInTheDocument();
  });

  it("refetches when radar filter changes", async () => {
    fetchSignalFeedMock.mockResolvedValue([]);

    render(<FirehosePanel apiUrl="" tiles={[makeTile("radar-1", "Hormuz"), makeTile("radar-2", "Jetstream")]} />);

    await waitFor(() => {
      expect(fetchSignalFeedMock).toHaveBeenCalledWith("", undefined, MAX_SIGNAL_FEED);
    });

    fireEvent.change(screen.getByTestId("firehose-radar-filter"), {
      target: { value: "radar-2" },
    });

    await waitFor(() => {
      expect(fetchSignalFeedMock).toHaveBeenLastCalledWith("", "radar-2", MAX_SIGNAL_FEED);
    });
  });

  it("shows an empty state when no raw signals are available", async () => {
    fetchSignalFeedMock.mockResolvedValue([]);

    render(<FirehosePanel apiUrl="" tiles={[makeTile()]} />);

    await waitFor(() => {
      expect(screen.getByTestId("firehose-empty")).toBeInTheDocument();
    });
  });
});
