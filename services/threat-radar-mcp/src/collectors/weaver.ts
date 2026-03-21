import { createHash } from "node:crypto";

import type { RawCollectorOutput } from "@workspace/radar-core";

export interface WeaverCollectorConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface WeaverQuery {
  baseUrl?: string;
  domainAllowlist?: string[];
  keywords?: string[];
  domainSignalLimit?: number;
  recentNodeLimit?: number;
  graphNodeLimit?: number;
  includeStatusSummary?: boolean;
}

type WeaverStatus = {
  ok?: boolean;
  state?: string;
  started_at?: number;
  metrics?: Record<string, number>;
  active_domains?: string[];
  domain_distribution?: Record<string, number>;
  world_watch_seed_count?: number;
};

type WeaverGraphNode = {
  id?: string;
  kind?: string;
  label?: string;
  url?: string;
  domain?: string;
  status?: string;
  title?: string;
  source_url?: string;
  discovered_at?: number;
  fetched_at?: number | null;
  content_type?: string | null;
  source_family?: string | null;
  compliance?: string | null;
};

type WeaverGraphResponse = {
  ok?: boolean;
  graph?: {
    nodes?: WeaverGraphNode[];
    counts?: Record<string, number>;
  };
};

function nowIso(): string {
  return new Date().toISOString();
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, "");
}

function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase();
}

function topicLabelFromKeywords(keywords: readonly string[]): string | null {
  const first = keywords[0]?.trim();
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function hostFromUrl(value?: string): string {
  if (!value) return "";
  try {
    return normalizeHost(new URL(value).hostname);
  } catch {
    return "";
  }
}

function matchesAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  return allowedHosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

function keywordMatch(haystack: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const lowered = haystack.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword));
}

function stableHash(kind: string, payload: Record<string, unknown>): string {
  const digest = createHash("sha1")
    .update(kind)
    .update(JSON.stringify(payload))
    .digest("hex");
  return digest;
}

function makeStatusSignal(status: WeaverStatus, allowedHosts: readonly string[], topicLabel?: string | null): RawCollectorOutput {
  const metrics = status.metrics ?? {};
  const topDomains = Object.entries(status.domain_distribution ?? {})
    .filter(([domain]) => matchesAllowedHost(normalizeHost(domain), allowedHosts))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain, count]) => `${domain}=${count}`)
    .join(", ");

  const prefix = topicLabel ? `${topicLabel} crawler` : "Crawler";
  const text = [
    `${prefix} status: ${status.state ?? "unknown"}.`,
    `discovered=${metrics.discovered ?? 0}, fetched=${metrics.fetched ?? 0}, frontier=${metrics.frontier_size ?? 0}, errors=${metrics.errors ?? 0}.`,
    `watch_seeds=${status.world_watch_seed_count ?? 0}, active_domains=${(status.active_domains ?? []).length}.`,
    topDomains ? `tracked_domains=${topDomains}.` : "",
  ].filter(Boolean).join(" ");

  return {
    id: `weaver-status-${stableHash("status", { text, started_at: status.started_at ?? 0 })}`,
    provenance: {
      source_type: "api",
      author: "fork-tales-weaver",
      confidence_class: "synthesis",
      retrieved_at: nowIso(),
    },
    text,
    title: `${prefix} status summary`,
    links: [],
    domain_tags: ["crawler", "weaver", ...allowedHosts.slice(0, 4)],
    observed_at: nowIso(),
    ingested_at: nowIso(),
    content_hash: stableHash("status-content", { text }),
    metadata: {
      state: status.state ?? "unknown",
      metrics,
      active_domains: status.active_domains ?? [],
      world_watch_seed_count: status.world_watch_seed_count ?? 0,
    },
  };
}

function makeDomainSignal(status: WeaverStatus, domain: string, count: number, topicLabel?: string | null): RawCollectorOutput {
  const active = (status.active_domains ?? []).map(normalizeHost).includes(normalizeHost(domain));
  const prefix = topicLabel ? `${topicLabel} crawler` : "Crawler";
  const text = `${prefix} domain activity on ${domain}: nodes=${count}, active=${active}, crawler_state=${status.state ?? "unknown"}.`;
  return {
    id: `weaver-domain-${stableHash("domain", { domain, count, active, state: status.state ?? "unknown" })}`,
    provenance: {
      source_type: "api",
      author: "fork-tales-weaver",
      confidence_class: "synthesis",
      retrieved_at: nowIso(),
    },
    text,
    title: `${prefix} activity: ${domain}`,
    links: [],
    domain_tags: ["crawler", "weaver", normalizeHost(domain)],
    observed_at: nowIso(),
    ingested_at: nowIso(),
    content_hash: stableHash("domain-content", { domain, count, active }),
    metadata: {
      domain,
      tracked_nodes: count,
      active,
      crawler_state: status.state ?? "unknown",
    },
  };
}

function makeNodeSignal(node: WeaverGraphNode): RawCollectorOutput {
  const domain = normalizeHost(node.domain ?? hostFromUrl(node.url));
  const title = (node.title ?? "").trim() || node.label || node.url || node.id || "crawler node";
  const text = [
    `Crawler node on ${domain || "unknown-domain"}: ${title}.`,
    node.status ? `status=${node.status}.` : "",
    node.source_url ? `source=${node.source_url}.` : "",
    node.compliance ? `compliance=${node.compliance}.` : "",
  ].filter(Boolean).join(" ");

  return {
    id: `weaver-node-${stableHash("node", { url: node.url ?? node.id ?? title, title, status: node.status ?? "unknown" })}`,
    provenance: {
      source_type: "api",
      author: "fork-tales-weaver",
      post_uri: node.url,
      parent_uri: node.source_url,
      confidence_class: "commentary",
      retrieved_at: nowIso(),
    },
    text,
    title,
    links: [node.url, node.source_url].filter((value): value is string => typeof value === "string" && value.length > 0),
    domain_tags: ["crawler", "weaver", ...(domain ? [domain] : []), ...(node.status ? [String(node.status)] : [])],
    observed_at: new Date((node.fetched_at ?? node.discovered_at ?? Date.now())).toISOString(),
    ingested_at: nowIso(),
    content_hash: stableHash("node-content", { text, url: node.url ?? node.id ?? title }),
    metadata: {
      node_id: node.id,
      url: node.url,
      domain,
      status: node.status,
      source_url: node.source_url,
      source_family: node.source_family,
      content_type: node.content_type,
      discovered_at: node.discovered_at,
      fetched_at: node.fetched_at,
      compliance: node.compliance,
    },
  };
}

export class WeaverCollector {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config?: WeaverCollectorConfig) {
    this.baseUrl = (config?.baseUrl ?? "http://127.0.0.1:8793").replace(/\/$/, "");
    this.fetchImpl = config?.fetchImpl ?? fetch;
  }

  async collect(query: WeaverQuery = {}): Promise<RawCollectorOutput[]> {
    const baseUrl = (query.baseUrl ?? this.baseUrl).replace(/\/$/, "");
    const domainAllowlist = (query.domainAllowlist ?? []).map(normalizeHost).filter(Boolean);
    const keywords = (query.keywords ?? []).map(normalizeKeyword).filter(Boolean);
    const topicLabel = topicLabelFromKeywords(keywords);
    const domainSignalLimit = clampInt(query.domainSignalLimit ?? 6, 1, 25);
    const recentNodeLimit = clampInt(query.recentNodeLimit ?? 8, 0, 50);
    const graphNodeLimit = clampInt(query.graphNodeLimit ?? 800, 50, 5000);
    const includeStatusSummary = query.includeStatusSummary ?? true;

    const status = await this.fetchJson<WeaverStatus>(`${baseUrl}/api/weaver/status`);
    const signals: RawCollectorOutput[] = [];

    if (includeStatusSummary) {
      signals.push(makeStatusSignal(status, domainAllowlist, topicLabel));
    }

    const matchingDomains = Object.entries(status.domain_distribution ?? {})
      .filter(([domain, count]) => Number.isFinite(count) && matchesAllowedHost(normalizeHost(domain), domainAllowlist))
      .sort((a, b) => b[1] - a[1])
      .slice(0, domainSignalLimit);

    for (const [domain, count] of matchingDomains) {
      signals.push(makeDomainSignal(status, domain, count, topicLabel));
    }

    if (recentNodeLimit > 0) {
      const graph = await this.fetchJson<WeaverGraphResponse>(`${baseUrl}/api/weaver/graph?node_limit=${graphNodeLimit}&edge_limit=0`);
      const seenUrls = new Set<string>();
      const recentNodes = (graph.graph?.nodes ?? [])
        .filter((node) => node.kind === "url")
        .filter((node) => matchesAllowedHost(normalizeHost(node.domain ?? hostFromUrl(node.url)), domainAllowlist))
        .filter((node) => keywordMatch([node.title, node.url, node.source_url, node.label].filter(Boolean).join(" "), keywords))
        .filter((node) => {
          const key = node.url ?? node.id ?? "";
          if (!key || seenUrls.has(key)) return false;
          seenUrls.add(key);
          return true;
        })
        .sort((a, b) => (Number(b.fetched_at ?? b.discovered_at ?? 0) - Number(a.fetched_at ?? a.discovered_at ?? 0)))
        .slice(0, recentNodeLimit);

      for (const node of recentNodes) {
        signals.push(makeNodeSignal(node));
      }
    }

    return signals;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`weaver request failed (${response.status}): ${url}`);
    }
    return response.json() as Promise<T>;
  }
}
