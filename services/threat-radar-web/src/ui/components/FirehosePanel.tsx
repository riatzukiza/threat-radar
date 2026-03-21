// ---------------------------------------------------------------------------
// FirehosePanel — raw signal feed inspector.
// Shows actual collected signals with source URLs, provenance, tags, and
// expandable metadata so the dashboard does not feel like an unexplained mock.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchSignalFeed } from "../../api/client";
import type { RadarTile, SignalFeedItem } from "../../api/types";
import { SourceBadge } from "./SourceBadge";

export const MAX_SIGNAL_FEED = 250;
const REFRESH_INTERVAL_MS = 15_000;

export function freshnessClass(timestamp: string): "fresh" | "aging" | "stale" {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageMinutes = ageMs / 60_000;
  if (ageMinutes < 30) return "fresh";
  if (ageMinutes < 180) return "aging";
  return "stale";
}

export function relativeTime(timestamp: string): string {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function toBrowserUrl(uri: string | undefined, author?: string): string | null {
  if (!uri) return null;
  if (/^https?:\/\//.test(uri)) return uri;
  if (!uri.startsWith("at://")) return null;

  const parts = uri.slice(5).split("/");
  if (parts.length < 3) return null;

  const repo = parts[0] ?? "";
  const collection = parts[1] ?? "";
  const rkey = parts[2] ?? "";
  const profile = encodeURIComponent(author ?? repo);

  if (collection === "app.bsky.feed.post" && rkey) {
    return `https://bsky.app/profile/${profile}/post/${encodeURIComponent(rkey)}`;
  }

  if (collection === "app.bsky.actor.profile") {
    return `https://bsky.app/profile/${profile}`;
  }

  return null;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function sourceLinksForSignal(signal: SignalFeedItem): Array<{ label: string; url: string }> {
  const seen = new Set<string>();
  const results: Array<{ label: string; url: string }> = [];

  const push = (label: string, url: string | null | undefined): void => {
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ label, url });
  };

  const postUrl = toBrowserUrl(signal.provenance.post_uri, signal.provenance.author);
  if (signal.provenance.source_type === "bluesky") {
    push("bluesky post", postUrl);
  } else if (signal.provenance.source_type === "reddit") {
    push("reddit thread", postUrl ?? signal.provenance.post_uri);
  } else {
    push("source post", postUrl ?? signal.provenance.post_uri);
  }

  push("source account", toBrowserUrl(signal.provenance.account_uri, signal.provenance.author));

  for (const link of signal.links) {
    push(hostLabel(link), link);
  }

  const metadataSourceUrl = typeof signal.metadata.source_url === "string" ? signal.metadata.source_url : undefined;
  const metadataUrl = typeof signal.metadata.url === "string" ? signal.metadata.url : undefined;
  push(metadataSourceUrl ? hostLabel(metadataSourceUrl) : "metadata source", metadataSourceUrl);
  push(metadataUrl ? hostLabel(metadataUrl) : "metadata url", metadataUrl);

  return results;
}

function signalHeadline(signal: SignalFeedItem): string {
  const title = signal.title?.trim();
  if (title) return title;
  const text = signal.text.trim();
  if (text.length <= 120) return text;
  return `${text.slice(0, 117)}...`;
}

function signalExcerpt(signal: SignalFeedItem): string {
  const text = signal.text.trim();
  if (text.length <= 220) return text;
  return `${text.slice(0, 217)}...`;
}

function confidenceClassLabel(value: SignalFeedItem["provenance"]["confidence_class"]): string {
  return value.replace(/_/g, " ");
}

function QualityBadge({ quality }: { quality?: number }): JSX.Element | null {
  if (quality === undefined) return null;
  const label = quality >= 0.7 ? "high" : quality >= 0.4 ? "medium" : "low";
  return <span className={`fh-quality fh-quality-${label}`}>{label} quality</span>;
}

function ConfidenceBadge({ value }: { value: SignalFeedItem["provenance"]["confidence_class"] }): JSX.Element {
  return (
    <span className="fh-confidence-class" data-testid="confidence-class-badge">
      {confidenceClassLabel(value)}
    </span>
  );
}

function RadarSignalEntry({ signal, radarName }: { signal: SignalFeedItem; radarName: string }): JSX.Element {
  const freshness = freshnessClass(signal.ingested_at);
  const links = sourceLinksForSignal(signal);
  const metadataKeys = Object.keys(signal.metadata);

  return (
    <details className="fh-entry" data-testid="firehose-entry">
      <summary className="fh-entry-summary-row">
        <div className="fh-entry-row">
          <SourceBadge source={signal.provenance.source_type} className="fh-source" />
          <span className={`fh-freshness fh-freshness-${freshness}`} data-testid="freshness-indicator" />
          <span className="fh-timestamp" title={signal.ingested_at}>{relativeTime(signal.ingested_at)}</span>
          <ConfidenceBadge value={signal.provenance.confidence_class} />
          <QualityBadge quality={signal.quality_score} />
          {signal.category && <span className="fh-category-chip">{signal.category}</span>}
        </div>

        <div className="fh-entry-content">
          <span className="fh-entry-title">{signalHeadline(signal)}</span>
          <span className="fh-entry-summary-text">{signalExcerpt(signal)}</span>
        </div>

        <div className="fh-entry-meta">
          <span className="fh-entry-radar">{radarName}</span>
          {signal.provenance.author && <span className="fh-entry-author">{signal.provenance.author}</span>}
          <span className="fh-entry-signals">raw signal</span>
        </div>
      </summary>

      <div className="fh-entry-body" data-testid="signal-entry-body">
        <p className="fh-signal-text">{signal.text}</p>

        <div className="fh-link-list">
          {links.length > 0 ? (
            links.map((link) => (
              <a key={`${signal.id}-${link.url}`} href={link.url} target="_blank" rel="noreferrer" className="fh-link-chip" data-testid="signal-link">
                {link.label}
              </a>
            ))
          ) : (
            <span className="fh-no-links">No direct source URL preserved for this signal.</span>
          )}
        </div>

        <div className="fh-provenance-grid">
          <div className="fh-provenance-item">
            <span>Radar</span>
            <strong>{radarName}</strong>
          </div>
          <div className="fh-provenance-item">
            <span>Observed</span>
            <strong>{new Date(signal.observed_at).toLocaleString()}</strong>
          </div>
          <div className="fh-provenance-item">
            <span>Retrieved</span>
            <strong>{new Date(signal.provenance.retrieved_at).toLocaleString()}</strong>
          </div>
          <div className="fh-provenance-item">
            <span>Author</span>
            <strong>{signal.provenance.author ?? "unknown"}</strong>
          </div>
        </div>

        {signal.domain_tags.length > 0 && (
          <div className="fh-tag-list">
            {signal.domain_tags.map((tag) => (
              <span key={`${signal.id}-${tag}`} className="fh-tag">{tag}</span>
            ))}
          </div>
        )}

        {metadataKeys.length > 0 && (
          <details className="fh-metadata-panel">
            <summary>Inspect metadata</summary>
            <pre>{JSON.stringify(signal.metadata, null, 2)}</pre>
          </details>
        )}
      </div>
    </details>
  );
}

export interface FirehosePanelProps {
  readonly apiUrl: string;
  readonly tiles: readonly RadarTile[];
}

export function FirehosePanel({ apiUrl, tiles }: FirehosePanelProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedRadarId, setSelectedRadarId] = useState<string>("all");
  const [signals, setSignals] = useState<SignalFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const radarOptions = useMemo(
    () => [{ id: "all", name: "All radars" }, ...tiles.map((tile) => ({ id: tile.radar.id, name: tile.radar.name }))],
    [tiles],
  );

  const radarNames = useMemo(
    () => new Map(tiles.map((tile) => [tile.radar.id, tile.radar.name] as const)),
    [tiles],
  );

  const loadSignals = useCallback(async () => {
    setLoading(true);
    try {
      const nextSignals = await fetchSignalFeed(
        apiUrl,
        selectedRadarId === "all" ? undefined : selectedRadarId,
        MAX_SIGNAL_FEED,
      );
      setSignals(nextSignals);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load raw signal feed");
    } finally {
      setLoading(false);
    }
  }, [apiUrl, selectedRadarId]);

  useEffect(() => {
    if (collapsed) return undefined;
    let disposed = false;

    const run = async (): Promise<void> => {
      if (disposed) return;
      await loadSignals();
    };

    void run();
    const interval = window.setInterval(() => void run(), REFRESH_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [collapsed, loadSignals]);

  return (
    <div className={`fh-panel ${collapsed ? "fh-panel--collapsed" : "fh-panel--expanded"}`} data-testid="firehose-panel">
      <button
        className="fh-panel-toggle"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand raw signal feed" : "Collapse raw signal feed"}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 2v20M2 12h4M18 12h4M6 6l2 2M16 6l-2 2M6 18l2-2M16 18l-2-2" strokeLinecap="round" />
        </svg>
        <span className="fh-panel-title">Raw Signal Feed</span>
        <span className="fh-panel-count" data-testid="firehose-count">
          {loading && signals.length === 0 ? "loading…" : `${signals.length} signal${signals.length === 1 ? "" : "s"}`}
        </span>
        <span className="fh-panel-chevron">{collapsed ? "▲" : "▼"}</span>
      </button>

      {!collapsed && (
        <div className="fh-panel-body" data-testid="firehose-body">
          <div className="fh-panel-toolbar">
            <label className="fh-filter-label">
              <span>Radar</span>
              <select data-testid="firehose-radar-filter" value={selectedRadarId} onChange={(event) => setSelectedRadarId(event.target.value)}>
                {radarOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </label>
            <button className="fh-refresh-button" onClick={() => void loadSignals()}>
              Refresh
            </button>
          </div>

          {error && signals.length === 0 ? (
            <div className="fh-empty" data-testid="firehose-error">
              <p>{error}</p>
            </div>
          ) : signals.length === 0 && !loading ? (
            <div className="fh-empty" data-testid="firehose-empty">
              <p>No raw signals yet. Once collectors ingest Bluesky, Reddit, or crawler data, the actual source feed will appear here.</p>
            </div>
          ) : (
            <div className="fh-entries">
              {signals.map((signal) => (
                <RadarSignalEntry
                  key={signal.id}
                  signal={signal}
                  radarName={signal.radar_id ? (radarNames.get(signal.radar_id) ?? signal.radar_id) : "Unassigned"}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
