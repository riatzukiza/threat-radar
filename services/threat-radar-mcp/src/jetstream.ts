import { createHash } from "node:crypto";

import { AtpAgent } from "@atproto/api";
import RedisConstructor from "ioredis";
import WebSocket from "ws";

import type { RawCollectorOutput } from "@workspace/radar-core";

export interface JetstreamRuleInput {
  wantedUsers?: string[];
  wantedDids?: string[];
  hashtags?: string[];
  keywords?: string[];
  windowSeconds?: number;
  maxEvents?: number;
  enabled?: boolean;
  allowNetworkWide?: boolean;
}

export interface JetstreamRule extends JetstreamRuleInput {
  radarId: string;
  wantedUsers: string[];
  wantedDids: string[];
  hashtags: string[];
  keywords: string[];
  windowSeconds: number;
  maxEvents: number;
  enabled: boolean;
  allowNetworkWide: boolean;
  updatedAt: string;
}

export interface JetstreamMonitorOptions {
  redisUrl: string;
  jetstreamUrl?: string;
  atprotoService?: string;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

type JetstreamCommitEvent = {
  did?: string;
  time_us?: number;
  kind?: string;
  commit?: {
    operation?: string;
    collection?: string;
    rkey?: string;
    record?: Record<string, unknown>;
  };
};

const DEFAULT_WINDOW_SECONDS = 60 * 60;
const DEFAULT_MAX_EVENTS = 250;
const DEFAULT_JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe";
const DEFAULT_ATPROTO_SERVICE = "https://public.api.bsky.app";
const POST_COLLECTION = "app.bsky.feed.post";
const RADARS_SET_KEY = "threat-radar:jetstream:radars";
const CURSOR_KEY = "threat-radar:jetstream:cursor";

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(parts: unknown[]): string {
  const digest = createHash("sha1");
  for (const part of parts) {
    digest.update(typeof part === "string" ? part : JSON.stringify(part));
  }
  return digest.digest("hex");
}

function normalizeList(values?: readonly string[]): string[] {
  return [...new Set((values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0))];
}

function normalizeLowerList(values?: readonly string[]): string[] {
  return [...new Set((values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0))];
}

export function extractHashtags(text: string): string[] {
  const matches = text.match(/(^|\s)#([A-Za-z0-9_\-]+)/g) ?? [];
  return [...new Set(matches.map((match) => match.trim().replace(/^#/, "").split("#").pop() ?? "").map((value) => value.toLowerCase()).filter(Boolean))];
}

function extractLinks(record: Record<string, unknown>): string[] {
  const links: string[] = [];
  const facets = Array.isArray(record.facets) ? record.facets : [];
  for (const facet of facets) {
    if (!facet || typeof facet !== "object") continue;
    const features = Array.isArray((facet as { features?: unknown[] }).features)
      ? (facet as { features?: unknown[] }).features ?? []
      : [];
    for (const feature of features) {
      if (!feature || typeof feature !== "object") continue;
      const uri = (feature as { uri?: unknown }).uri;
      if (typeof uri === "string" && uri.length > 0) {
        links.push(uri);
      }
    }
  }

  const embed = record.embed;
  if (embed && typeof embed === "object") {
    const externalUri = (embed as { external?: { uri?: unknown } }).external?.uri;
    if (typeof externalUri === "string" && externalUri.length > 0) {
      links.push(externalUri);
    }
  }

  return [...new Set(links)];
}

function eventTimestampMillis(event: JetstreamCommitEvent): number {
  if (typeof event.time_us === "number" && Number.isFinite(event.time_us)) {
    return Math.floor(event.time_us / 1000);
  }
  const createdAt = event.commit?.record?.createdAt;
  if (typeof createdAt === "string") {
    const parsed = Date.parse(createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export function normalizeJetstreamRule(radarId: string, input: JetstreamRuleInput, resolvedDids: string[]): JetstreamRule {
  const wantedUsers = normalizeList(input.wantedUsers);
  const wantedDids = [...new Set([...normalizeList(input.wantedDids), ...resolvedDids])];
  const hashtags = normalizeLowerList(input.hashtags);
  const keywords = normalizeLowerList(input.keywords);
  const windowSeconds = Math.max(60, Math.min(7 * 24 * 60 * 60, Math.round(input.windowSeconds ?? DEFAULT_WINDOW_SECONDS)));
  const maxEvents = Math.max(10, Math.min(2000, Math.round(input.maxEvents ?? DEFAULT_MAX_EVENTS)));
  const enabled = input.enabled ?? true;
  const allowNetworkWide = input.allowNetworkWide ?? false;

  if (enabled && wantedDids.length === 0 && hashtags.length === 0 && keywords.length === 0) {
    throw new Error("Jetstream rule must define at least one DID, hashtag, or keyword filter");
  }
  if (enabled && wantedDids.length === 0 && !allowNetworkWide) {
    throw new Error("Jetstream rule without explicit DIDs requires allowNetworkWide=true");
  }

  return {
    radarId,
    wantedUsers,
    wantedDids,
    hashtags,
    keywords,
    windowSeconds,
    maxEvents,
    enabled,
    allowNetworkWide,
    updatedAt: nowIso(),
  };
}

export function matchesJetstreamRule(event: JetstreamCommitEvent, rule: JetstreamRule): boolean {
  if (!rule.enabled) return false;
  const did = String(event.did ?? "").trim();
  if (rule.wantedDids.length > 0 && !rule.wantedDids.includes(did)) {
    return false;
  }

  const record = event.commit?.record ?? {};
  const text = typeof record.text === "string" ? record.text : "";
  const haystack = `${text}\n${typeof record.title === "string" ? record.title : ""}`.toLowerCase();
  const hashtags = extractHashtags(text);

  if (rule.hashtags.length > 0 && !rule.hashtags.some((tag) => hashtags.includes(tag))) {
    return false;
  }
  if (rule.keywords.length > 0 && !rule.keywords.some((keyword) => haystack.includes(keyword))) {
    return false;
  }
  return true;
}

export function jetstreamEventToRawCollectorOutput(event: JetstreamCommitEvent): RawCollectorOutput | null {
  if (event.kind !== "commit") return null;
  if (event.commit?.collection !== POST_COLLECTION) return null;
  const op = event.commit?.operation;
  if (op !== "create" && op !== "update") return null;
  const did = String(event.did ?? "").trim();
  const rkey = String(event.commit?.rkey ?? "").trim();
  const record = event.commit?.record ?? {};
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!did || !rkey || !text) return null;

  const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date(eventTimestampMillis(event)).toISOString();
  const hashtags = extractHashtags(text);
  const links = extractLinks(record);
  const postUri = `at://${did}/${POST_COLLECTION}/${rkey}`;
  const parentUri = record.reply && typeof record.reply === "object"
    ? ((record.reply as { parent?: { uri?: unknown } }).parent?.uri as string | undefined)
    : undefined;

  return {
    id: `jetstream-${stableHash([did, rkey, event.time_us ?? createdAt])}`,
    provenance: {
      source_type: "bluesky",
      author: did,
      post_uri: postUri,
      parent_uri: parentUri,
      confidence_class: parentUri ? "commentary" : "firsthand",
      retrieved_at: nowIso(),
    },
    text,
    title: typeof record.title === "string" ? record.title : undefined,
    links,
    domain_tags: ["jetstream", ...hashtags],
    observed_at: createdAt,
    ingested_at: nowIso(),
    content_hash: stableHash(["jetstream-content", did, text]),
    metadata: {
      jetstream: {
        did,
        rkey,
        collection: POST_COLLECTION,
        operation: op,
        time_us: event.time_us,
      },
      hashtags,
    },
  };
}

function configKey(radarId: string): string {
  return `threat-radar:jetstream:config:${radarId}`;
}

function windowKey(radarId: string): string {
  return `threat-radar:jetstream:window:${radarId}`;
}

function eventKey(radarId: string, eventId: string): string {
  return `threat-radar:jetstream:event:${radarId}:${eventId}`;
}

export class JetstreamService {
  private readonly redis: any;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly jetstreamUrl: string;
  private readonly agent: AtpAgent;
  private socket: WebSocket | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: JetstreamMonitorOptions) {
    const RedisCtor = RedisConstructor as unknown as { new(url: string, options: Record<string, unknown>): any };
    this.redis = new RedisCtor(options.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.logger = options.logger ?? console;
    this.jetstreamUrl = options.jetstreamUrl ?? DEFAULT_JETSTREAM_URL;
    this.agent = new AtpAgent({ service: options.atprotoService ?? DEFAULT_ATPROTO_SERVICE });
  }

  async init(): Promise<void> {
    if (this.redis.status === "wait") {
      await this.redis.connect();
    }
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
    await this.redis.quit();
  }

  async listRules(): Promise<JetstreamRule[]> {
    const radarIds = await this.redis.smembers(RADARS_SET_KEY);
    const rules: JetstreamRule[] = [];
    for (const radarId of radarIds) {
      const raw = await this.redis.get(configKey(radarId));
      if (!raw) continue;
      rules.push(JSON.parse(raw) as JetstreamRule);
    }
    return rules.sort((a, b) => a.radarId.localeCompare(b.radarId));
  }

  async getRule(radarId: string): Promise<JetstreamRule | null> {
    const raw = await this.redis.get(configKey(radarId));
    return raw ? (JSON.parse(raw) as JetstreamRule) : null;
  }

  async putRule(radarId: string, input: JetstreamRuleInput): Promise<JetstreamRule> {
    const resolvedDids = await this.resolveUsersToDids(input.wantedUsers ?? []);
    const rule = normalizeJetstreamRule(radarId, input, resolvedDids);
    await this.redis.multi()
      .sadd(RADARS_SET_KEY, radarId)
      .set(configKey(radarId), JSON.stringify(rule))
      .exec();
    await this.refreshConnection();
    return rule;
  }

  async deleteRule(radarId: string): Promise<void> {
    await this.redis.multi()
      .del(configKey(radarId))
      .del(windowKey(radarId))
      .srem(RADARS_SET_KEY, radarId)
      .exec();
    await this.refreshConnection();
  }

  async listWindowEvents(radarId: string, limit?: number): Promise<JetstreamCommitEvent[]> {
    const rule = await this.getRule(radarId);
    if (!rule) return [];
    const maximum = Math.max(1, Math.min(rule.maxEvents, limit ?? rule.maxEvents));
    const minimumScore = Date.now() - (rule.windowSeconds * 1000);
    const ids = await this.redis.zrevrangebyscore(windowKey(radarId), "+inf", minimumScore, "LIMIT", 0, maximum);
    if (ids.length === 0) return [];
    const values = await this.redis.mget(ids.map((eventId: string) => eventKey(radarId, eventId)));
    return values
      .filter((value: string | null): value is string => typeof value === "string")
      .map((value: string) => JSON.parse(value) as JetstreamCommitEvent);
  }

  async status(): Promise<Record<string, unknown>> {
    const rules = await this.listRules();
    return {
      running: this.running,
      connected: this.socket?.readyState === WebSocket.OPEN,
      jetstreamUrl: this.jetstreamUrl,
      ruleCount: rules.length,
      activeRules: rules.filter((rule) => rule.enabled).map((rule) => ({
        radarId: rule.radarId,
        wantedDids: rule.wantedDids.length,
        hashtags: rule.hashtags,
        keywords: rule.keywords,
        windowSeconds: rule.windowSeconds,
      })),
      cursor: await this.redis.get(CURSOR_KEY),
    };
  }

  async ensureRunning(): Promise<void> {
    await this.init();
    this.running = true;
    await this.refreshConnection();
  }

  private async resolveUsersToDids(users: string[]): Promise<string[]> {
    const dids: string[] = [];
    for (const user of normalizeList(users)) {
      if (user.startsWith("did:")) {
        dids.push(user);
        continue;
      }
      try {
        const response = await this.agent.com.atproto.identity.resolveHandle({ handle: user });
        if (response.data.did) {
          dids.push(response.data.did);
        }
      } catch (error) {
        this.logger.warn(`[jetstream] failed to resolve handle ${user}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return [...new Set(dids)];
  }

  private async refreshConnection(): Promise<void> {
    if (!this.running) return;
    const rules = (await this.listRules()).filter((rule) => rule.enabled);
    if (rules.length === 0) {
      if (this.socket) {
        this.logger.info("[jetstream] no active rules; closing socket");
        this.socket.close();
        this.socket = null;
      }
      return;
    }

    const wantedDids = [...new Set(rules.flatMap((rule) => rule.wantedDids))];
    const cursor = await this.redis.get(CURSOR_KEY);
    const url = new URL(this.jetstreamUrl);
    url.searchParams.append("wantedCollections", POST_COLLECTION);
    for (const did of wantedDids) {
      url.searchParams.append("wantedDids", did);
    }
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }

    this.logger.info(`[jetstream] connecting to ${url.toString()} (${rules.length} active rules)`);
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on("open", () => {
      this.logger.info("[jetstream] socket open");
    });

    socket.on("message", async (data: WebSocket.RawData) => {
      try {
        const raw = typeof data === "string" ? data : data.toString();
        const event = JSON.parse(raw) as JetstreamCommitEvent;
        await this.handleEvent(event, rules);
      } catch (error) {
        this.logger.warn(`[jetstream] message handling failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    socket.on("close", () => {
      if (!this.running) return;
      this.logger.warn("[jetstream] socket closed; scheduling reconnect");
      this.scheduleReconnect();
    });

    socket.on("error", (error: Error) => {
      this.logger.error(`[jetstream] socket error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.refreshConnection();
    }, 5_000);
  }

  private async handleEvent(event: JetstreamCommitEvent, rules: JetstreamRule[]): Promise<void> {
    if (typeof event.time_us === "number") {
      await this.redis.set(CURSOR_KEY, String(event.time_us));
    }
    for (const rule of rules) {
      if (!matchesJetstreamRule(event, rule)) continue;
      await this.storeEvent(rule, event);
    }
  }

  private async storeEvent(rule: JetstreamRule, event: JetstreamCommitEvent): Promise<void> {
    const eventId = stableHash([rule.radarId, event.did ?? "", event.commit?.rkey ?? "", event.time_us ?? event.commit?.record?.createdAt ?? nowIso()]);
    const score = eventTimestampMillis(event);
    const ttlSeconds = Math.max(rule.windowSeconds * 2, 60 * 60);
    const minScore = Date.now() - (rule.windowSeconds * 1000);
    await this.redis.multi()
      .set(eventKey(rule.radarId, eventId), JSON.stringify(event), "EX", ttlSeconds)
      .zadd(windowKey(rule.radarId), String(score), eventId)
      .zremrangebyscore(windowKey(rule.radarId), 0, minScore)
      .expire(windowKey(rule.radarId), ttlSeconds)
      .exec();
  }
}

export async function collectJetstreamWindowSignals(service: JetstreamService, radarId: string, limit?: number): Promise<RawCollectorOutput[]> {
  const events = await service.listWindowEvents(radarId, limit);
  return events
    .map((event) => jetstreamEventToRawCollectorOutput(event))
    .filter((signal): signal is RawCollectorOutput => Boolean(signal));
}
