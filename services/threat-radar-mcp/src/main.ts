import "dotenv/config";
import { randomUUID } from "node:crypto";

import cors from "cors";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createMcpHttpRouter } from "@workspace/mcp-foundation";
import {
  createAuditLogger,
  EvidenceIndex,
  radarAssessmentPacketSchema,
  radarModuleVersionSchema,
  radarSchema,
  reduceRadarPackets,
  reduce as deterministicReduce,
  sourceDefinitionSchema,
  normalize,
  cluster,
  type Radar,
  type RadarAssessmentPacket,
  type RadarModuleVersion,
  type ReducedSnapshot,
  type SignalEvent,
  type SourceDefinition,
  type Thread,
  type RawCollectorOutput,
} from "@workspace/radar-core";
import { getSql, initSchema, closeSql } from "./lib/postgres.js";
import { PostgresRadarStore } from "./store.js";
import { BlueskyCollector, type BlueskyFeedQuery } from "./collectors/bluesky.js";
import { RedditCollector } from "./collectors/reddit.js";
import { WeaverCollector } from "./collectors/weaver.js";
import { collectJetstreamWindowSignals, JetstreamService, type JetstreamRule, type JetstreamRuleInput } from "./jetstream.js";
import { OperatorStore, type OperatorSession, type OperatorDraft } from "./operator-store.js";
import {
  FederationManager,
  createAggregatePayload,
  deserializeEnvelope,
  type AggregateSnapshotPayload,
  type EnsoEnvelope,
} from "./lib/federation.js";

const ENV = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(10002),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ADMIN_AUTH_KEY: z.string().min(12),
  ALLOW_UNAUTH_LOCAL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  JETSTREAM_ENABLED: z.string().optional(),
  JETSTREAM_URL: z.string().url().optional(),
  ATPROTO_SERVICE: z.string().url().optional(),
  PROXX_BASE_URL: z.string().url().optional(),
}).parse(process.env);

const publicBaseUrl = new URL(ENV.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://127.0.0.1:${ENV.PORT}`);
const usePostgres = Boolean(ENV.DATABASE_URL);
const jetstreamEnabled = toBool(ENV.JETSTREAM_ENABLED, true) && Boolean(ENV.REDIS_URL);
const proxxBaseUrl = ENV.PROXX_BASE_URL ?? "https://ussy.promethean.rest";

function nowIso(): string {
  return new Date().toISOString();
}

function latestSubmissionView(packet: RadarAssessmentPacket | undefined): {
  timestamp_utc: string;
  model_id: string;
  model_version?: string;
  sourceCount: number;
  sources: RadarAssessmentPacket["sources"];
  signal_scores: RadarAssessmentPacket["signal_scores"];
  branch_assessment: RadarAssessmentPacket["branch_assessment"];
  uncertainties: RadarAssessmentPacket["uncertainties"];
  calibration_notes?: string;
} | undefined {
  if (!packet) return undefined;
  return {
    timestamp_utc: packet.timestamp_utc,
    model_id: packet.model_id,
    model_version: packet.model_version,
    sourceCount: packet.sources.length,
    sources: packet.sources,
    signal_scores: packet.signal_scores,
    branch_assessment: packet.branch_assessment,
    uncertainties: packet.uncertainties,
    calibration_notes: packet.calibration_notes,
  };
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "::1" || normalized === "127.0.0.1" || normalized === "::ffff:127.0.0.1" || normalized.startsWith("127.");
}

function isLoopbackRequest(req: express.Request): boolean {
  const remote = req.socket.remoteAddress ?? "";
  const forwardedFor = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ?? "";
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").toLowerCase();
  const bareHost = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0] ?? "";
  return isLoopbackAddress(remote) && (!forwardedFor || isLoopbackAddress(forwardedFor)) && (!bareHost || bareHost === "localhost" || bareHost === "127.0.0.1" || bareHost === "::1");
}

function requireAdminKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const supplied = String(req.headers["x-admin-auth-key"] ?? "");
  if (supplied === ENV.ADMIN_AUTH_KEY) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

async function requireOperatorSession(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const sessionId = String(req.headers["x-operator-session"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ ok: false, error: "Operator session required" });
    return;
  }
  const session = await operatorStore.getSession(sessionId);
  if (!session) {
    res.status(401).json({ ok: false, error: "Invalid operator session" });
    return;
  }
  (req as express.Request & { operatorSession?: OperatorSession }).operatorSession = session;
  next();
}

function operatorSessionOf(req: express.Request): OperatorSession {
  const session = (req as express.Request & { operatorSession?: OperatorSession }).operatorSession;
  if (!session) {
    throw new Error("Operator session missing from request context");
  }
  return session;
}

async function loginWithBluesky(identifier: string, password: string, serviceUrl?: string): Promise<OperatorSession> {
  const service = (serviceUrl?.trim() || "https://bsky.social").replace(/\/$/, "");
  const response = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!response.ok) {
    throw new Error(`Bluesky login failed: ${response.status}`);
  }
  const payload = await response.json() as {
    did?: string;
    handle?: string;
    accessJwt?: string;
    refreshJwt?: string;
  };
  if (!payload.did || !payload.accessJwt) {
    throw new Error("Bluesky login response incomplete");
  }
  return operatorStore.createSession({
    did: payload.did,
    handle: payload.handle ?? identifier,
    accessJwt: payload.accessJwt,
    refreshJwt: payload.refreshJwt,
    serviceUrl: service,
  });
}

async function publishDraftToBluesky(session: OperatorSession, text: string): Promise<Record<string, unknown>> {
  const { payload } = await blueskyJsonRequest<Record<string, unknown>>(session, "/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date().toISOString(),
      },
    }),
  });
  return payload;
}

type BlueskyTimelinePost = {
  uri: string;
  author: {
    did?: string;
    handle?: string;
    displayName?: string;
    avatar?: string;
  };
  text: string;
  createdAt?: string;
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  quoteCount?: number;
  labels?: string[];
  externalUrl?: string;
};

async function fetchBlueskyTimeline(session: OperatorSession, limit: number): Promise<BlueskyTimelinePost[]> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const { payload } = await blueskyJsonRequest<{
    feed?: Array<{
      post?: {
        uri?: string;
        author?: {
          did?: string;
          handle?: string;
          displayName?: string;
          avatar?: string;
        };
        record?: {
          text?: string;
          createdAt?: string;
          embed?: {
            external?: {
              uri?: string;
            };
          };
        };
        replyCount?: number;
        repostCount?: number;
        likeCount?: number;
        quoteCount?: number;
        labels?: Array<{ val?: string }>;
        embed?: {
          external?: {
            uri?: string;
          };
        };
      };
    }>;
  }>(session, `/xrpc/app.bsky.feed.getTimeline?limit=${safeLimit}`, {
    headers: {
      Accept: "application/json",
    },
  });

  return (payload.feed ?? [])
    .map((item) => item.post)
    .filter((post): post is NonNullable<typeof post> => Boolean(post?.uri))
    .map((post) => ({
      uri: post.uri ?? "",
      author: {
        did: post.author?.did,
        handle: post.author?.handle,
        displayName: post.author?.displayName,
        avatar: post.author?.avatar,
      },
      text: String(post.record?.text ?? "").trim(),
      createdAt: post.record?.createdAt,
      replyCount: post.replyCount,
      repostCount: post.repostCount,
      likeCount: post.likeCount,
      quoteCount: post.quoteCount,
      labels: (post.labels ?? []).map((label) => label.val).filter((value): value is string => typeof value === "string"),
      externalUrl: post.embed?.external?.uri ?? post.record?.embed?.external?.uri,
    }))
    .filter((post) => post.text.length > 0);
}

function isRefreshableBlueskyError(status: number, body: string): boolean {
  return (status === 400 || status === 401)
    && /expired|jwt|token|auth|session/i.test(body);
}

async function refreshOperatorSession(session: OperatorSession): Promise<OperatorSession> {
  if (!session.refreshJwt) {
    throw new Error("Bluesky session expired and no refresh token is available");
  }

  const response = await fetch(`${session.serviceUrl}/xrpc/com.atproto.server.refreshSession`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.refreshJwt}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Bluesky session refresh failed: ${response.status} ${text}`.trim());
  }

  const payload = JSON.parse(text) as {
    accessJwt?: string;
    refreshJwt?: string;
    did?: string;
    handle?: string;
  };

  const next = await operatorStore.updateSession(session.id, {
    accessJwt: payload.accessJwt ?? session.accessJwt,
    refreshJwt: payload.refreshJwt ?? session.refreshJwt,
    did: payload.did ?? session.did,
    handle: payload.handle ?? session.handle,
    serviceUrl: session.serviceUrl,
  });

  if (!next) {
    throw new Error("Failed to persist refreshed Bluesky session");
  }

  return next;
}

async function blueskyJsonRequest<T>(session: OperatorSession, path: string, init: RequestInit, allowRefresh = true): Promise<{ session: OperatorSession; payload: T }> {
  const execute = async (activeSession: OperatorSession): Promise<{ response: Response; text: string; session: OperatorSession }> => {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${activeSession.accessJwt}`);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }

    const response = await fetch(`${activeSession.serviceUrl}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    return { response, text, session: activeSession };
  };

  const first = await execute(session);
  if (first.response.ok) {
    return { session: first.session, payload: JSON.parse(first.text) as T };
  }

  if (allowRefresh && isRefreshableBlueskyError(first.response.status, first.text)) {
    const refreshed = await refreshOperatorSession(session);
    const second = await execute(refreshed);
    if (second.response.ok) {
      return { session: second.session, payload: JSON.parse(second.text) as T };
    }
    throw new Error(`Bluesky request failed after refresh: ${second.response.status} ${second.text}`.trim());
  }

  throw new Error(`Bluesky request failed: ${first.response.status} ${first.text}`.trim());
}

let store: PostgresRadarStore | InMemoryRadarStore;
const evidenceIndexes = new Map<string, EvidenceIndex>();
let jetstreamService: JetstreamService | null = null;
let operatorStore: OperatorStore;

const MCP_SERVER_REGISTRY = [
  { id: "proxx", label: "Proxx", description: "OpenAI-compatible research and model routing proxy", baseUrl: proxxBaseUrl, kind: "proxy" },
  { id: "radar-mcp", label: "Threat Radar MCP", description: "Radar control plane and collection API", baseUrl: `${publicBaseUrl.toString().replace(/\/$/, "")}/mcp`, kind: "mcp" },
  { id: "jetstream", label: "Jetstream Firehose", description: "Bluesky Jetstream rolling-window ingest", baseUrl: `${publicBaseUrl.toString().replace(/\/$/, "")}/api/jetstream/status`, kind: "stream" },
  { id: "mnemosyne", label: "Mnemosyne", description: "Workspace file memory server", baseUrl: "http://127.0.0.1:4011", kind: "mcp" },
  { id: "mcp-github", label: "GitHub MCP", description: "GitHub operations and review tools", baseUrl: "http://127.0.0.1:4012", kind: "mcp" },
  { id: "mcp-process", label: "Process MCP", description: "Task runner/process control", baseUrl: "http://127.0.0.1:4013", kind: "mcp" },
  { id: "mcp-devtools", label: "Devtools MCP", description: "Browser/devtools hooks", baseUrl: "http://127.0.0.1:4014", kind: "mcp" },
  { id: "mcp-tdd", label: "TDD MCP", description: "Testing automation and coverage helpers", baseUrl: "http://127.0.0.1:4015", kind: "mcp" },
  { id: "mcp-sandboxes", label: "Sandboxes MCP", description: "Sandbox execution utilities", baseUrl: "http://127.0.0.1:4016", kind: "mcp" },
  { id: "mcp-ollama", label: "Ollama MCP", description: "Local model control and inference helpers", baseUrl: "http://127.0.0.1:4017", kind: "mcp" },
  { id: "mcp-exec", label: "Exec MCP", description: "Workspace command execution", baseUrl: "http://127.0.0.1:4018", kind: "mcp" },
] as const;

type InMemoryRadarRecord = {
  radar: Radar;
  moduleVersions: RadarModuleVersion[];
  sources: SourceDefinition[];
  submissions: Array<{ packet: RadarAssessmentPacket; weight: number; receivedAt: string }>;
  liveSnapshot?: ReducedSnapshot;
  dailySnapshots: ReducedSnapshot[];
};

class InMemoryRadarStore {
  private radars = new Map<string, InMemoryRadarRecord>();
  private signals = new Map<string, SignalEvent>();
  private threads = new Map<string, Thread>();

  async getRadar(radarId: string): Promise<Radar | null> {
    const record = this.radars.get(radarId);
    return record?.radar ?? null;
  }

  async listRadars(): Promise<Radar[]> {
    return [...this.radars.values()].map((r) => r.radar);
  }

  async createRadar(radar: Radar): Promise<void> {
    this.radars.set(radar.id, {
      radar,
      moduleVersions: [],
      sources: [],
      submissions: [],
      dailySnapshots: [],
    });
  }

  async updateRadar(radarId: string, updates: Partial<Radar>): Promise<void> {
    const record = this.radars.get(radarId);
    if (record) {
      record.radar = { ...record.radar, ...updates, updated_at: nowIso() };
    }
  }

  async getModuleVersion(moduleVersionId: string): Promise<RadarModuleVersion | null> {
    for (const record of this.radars.values()) {
      const found = record.moduleVersions.find((mv) => mv.id === moduleVersionId);
      if (found) return found;
    }
    return null;
  }

  async listModuleVersions(radarId: string): Promise<RadarModuleVersion[]> {
    return this.radars.get(radarId)?.moduleVersions ?? [];
  }

  async createModuleVersion(mv: RadarModuleVersion): Promise<void> {
    const record = this.radars.get(mv.radar_id);
    if (record) {
      record.moduleVersions.push(mv);
    }
  }

  async listSources(radarId: string): Promise<SourceDefinition[]> {
    return this.radars.get(radarId)?.sources ?? [];
  }

  async createSource(source: SourceDefinition): Promise<void> {
    const record = this.radars.get(source.radar_id);
    if (record) {
      record.sources.push(source);
    }
  }

  async listSubmissions(radarId: string): Promise<Array<{ packet: RadarAssessmentPacket; weight: number; receivedAt: string }>> {
    return this.radars.get(radarId)?.submissions ?? [];
  }

  async createSubmission(packet: RadarAssessmentPacket, weight: number): Promise<void> {
    const record = this.radars.get(packet.radar_id);
    if (record) {
      record.submissions.push({ packet, weight, receivedAt: nowIso() });
    }
  }

  async getLatestLiveSnapshot(radarId: string): Promise<ReducedSnapshot | null> {
    return this.radars.get(radarId)?.liveSnapshot ?? null;
  }

  async getLatestDailySnapshot(radarId: string): Promise<ReducedSnapshot | null> {
    const record = this.radars.get(radarId);
    if (!record) return null;
    return record.dailySnapshots[record.dailySnapshots.length - 1] ?? null;
  }

  async createSnapshot(snapshot: ReducedSnapshot): Promise<void> {
    const record = this.radars.get(snapshot.radar_id);
    if (!record) return;
    if (snapshot.snapshot_kind === "live") {
      record.liveSnapshot = snapshot;
    } else {
      record.dailySnapshots.push(snapshot);
    }
  }

  async listDailySnapshots(radarId: string): Promise<ReducedSnapshot[]> {
    return this.radars.get(radarId)?.dailySnapshots ?? [];
  }

  async createAuditEvent(radarId: string, eventType: string, payload: object): Promise<void> {
    // no-op for in-memory
  }

  async listAuditEvents(radarId: string): Promise<Array<{ event_type: string; payload: object; created_at: string }>> {
    return [];
  }

  // --- Signal CRUD ---

  async createSignal(signal: SignalEvent): Promise<void> {
    this.signals.set(signal.id, signal);
  }

  async getSignal(signalId: string): Promise<SignalEvent | null> {
    return this.signals.get(signalId) ?? null;
  }

  async listSignals(radarId?: string, limit = 100): Promise<SignalEvent[]> {
    const all = [...this.signals.values()];
    const filtered = radarId ? all.filter((s) => s.radar_id === radarId) : all;
    return filtered.sort((a, b) => b.ingested_at.localeCompare(a.ingested_at)).slice(0, limit);
  }

  async updateSignal(signalId: string, updates: Partial<Pick<SignalEvent, "radar_id" | "domain_tags" | "metadata">>): Promise<void> {
    const existing = this.signals.get(signalId);
    if (existing) {
      this.signals.set(signalId, { ...existing, ...updates });
    }
  }

  async findSignalByContentHash(contentHash: string): Promise<SignalEvent | null> {
    for (const signal of this.signals.values()) {
      if (signal.content_hash === contentHash) return signal;
    }
    return null;
  }

  // --- Thread CRUD ---

  async createThread(thread: Thread): Promise<void> {
    this.threads.set(thread.id, thread);
  }

  async getThread(threadId: string): Promise<Thread | null> {
    return this.threads.get(threadId) ?? null;
  }

  async listThreads(radarId?: string, limit = 100): Promise<Thread[]> {
    const all = [...this.threads.values()];
    const filtered = radarId ? all.filter((t) => t.radar_id === radarId) : all;
    return filtered.sort((a, b) => b.timeline.last_updated.localeCompare(a.timeline.last_updated)).slice(0, limit);
  }

  async deleteThreadsByRadar(radarId: string): Promise<number> {
    let deleted = 0;
    for (const [threadId, thread] of this.threads.entries()) {
      if (thread.radar_id === radarId) {
        this.threads.delete(threadId);
        deleted++;
      }
    }
    return deleted;
  }

  async updateThread(threadId: string, updates: Partial<Pick<Thread, "title" | "summary" | "members" | "source_distribution" | "confidence" | "domain_tags" | "status">> & { last_updated?: string }): Promise<void> {
    const existing = this.threads.get(threadId);
    if (!existing) return;
    const merged: Thread = {
      ...existing,
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.summary !== undefined ? { summary: updates.summary } : {}),
      ...(updates.members !== undefined ? { members: updates.members } : {}),
      ...(updates.source_distribution !== undefined ? { source_distribution: updates.source_distribution } : {}),
      ...(updates.confidence !== undefined ? { confidence: updates.confidence } : {}),
      ...(updates.domain_tags !== undefined ? { domain_tags: updates.domain_tags } : {}),
      ...(updates.status !== undefined ? { status: updates.status } : {}),
      timeline: {
        ...existing.timeline,
        ...(updates.last_updated !== undefined ? { last_updated: updates.last_updated } : {}),
      },
    };
    this.threads.set(threadId, merged);
  }
}

function getEvidenceIndex(radarId: string): EvidenceIndex {
  const existing = evidenceIndexes.get(radarId);
  if (existing) return existing;
  const created = new EvidenceIndex();
  evidenceIndexes.set(radarId, created);
  return created;
}

function createDefaultMaritimeTemplate(radarId: string, createdBy: string): RadarModuleVersion {
  return radarModuleVersionSchema.parse({
    id: `${radarId}:module:v1`,
    radar_id: radarId,
    version: 1,
    signal_definitions: [
      { id: "transit_flow", label: "Transit Flow", description: "Observed transit throughput and continuity", scale_labels: ["normal", "stressed", "degraded", "impaired", "broken"] },
      { id: "attack_tempo", label: "Attack Tempo", description: "Frequency and severity of hostile incidents", scale_labels: ["normal", "stressed", "degraded", "impaired", "broken"] },
      { id: "insurance_availability", label: "Insurance Availability", description: "War-risk and marine insurance availability", scale_labels: ["normal", "stressed", "degraded", "impaired", "broken"] },
      { id: "navigation_integrity", label: "Navigation Integrity", description: "GNSS, AIS, routing, and navigation reliability", scale_labels: ["normal", "stressed", "degraded", "impaired", "broken"] },
      { id: "bypass_capacity", label: "Bypass Capacity", description: "Available alternative export and routing capacity", scale_labels: ["normal", "stressed", "degraded", "impaired", "broken"] },
      { id: "asia_buffer_stress", label: "Asia Buffer Stress", description: "Downstream inventory and emergency stock pressure", scale_labels: ["normal", "stressed", "degraded", "impaired", "broken"] },
    ],
    branch_definitions: [
      { id: "reopening", label: "Reopening", description: "Conditions normalizing" },
      { id: "effective_closure", label: "Effective Closure", description: "Sustained disruption persists" },
      { id: "wider_escalation", label: "Wider Escalation", description: "Regional conflict expansion" },
    ],
    source_adapter_refs: [],
    model_weight_table: {
      "perplexity-sonar": 0.25,
      "perplexity-sonar-pro": 0.3,
      "gpt-4o": 0.25,
      "claude-3.5-sonnet": 0.25,
      "gemini-2.5-pro": 0.28,
      "hormuz-bundle-v4": 0.4,
    },
    reducer_config: {
      signal_quantile_low: 0.25,
      signal_quantile_high: 0.75,
      disagreement_divisor: 2,
    },
    validation_rules: {},
    status: "active",
    created_by: createdBy,
    created_at: nowIso(),
  });
}

async function createRadar(input: { slug: string; name: string; category: string; templateId?: string; createdBy: string }): Promise<Radar> {
  const radar = radarSchema.parse({
    id: randomUUID(),
    slug: input.slug,
    name: input.name,
    category: input.category,
    status: "active",
    template_id: input.templateId,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  const initialModule = createDefaultMaritimeTemplate(radar.id, input.createdBy);
  radar.active_module_version_id = initialModule.id;
  await store.createRadar(radar);
  await store.createModuleVersion(initialModule);
  await store.createAuditEvent(radar.id, "radar_created", { slug: input.slug, name: input.name, created_by: input.createdBy });
  return radar;
}

async function addSource(input: SourceDefinition): Promise<SourceDefinition> {
  await store.createSource(input);
  await store.updateRadar(input.radar_id, {});
  await store.createAuditEvent(input.radar_id, "source_added", { source_id: input.id, kind: input.kind });
  return input;
}

async function submitPacket(packet: RadarAssessmentPacket): Promise<{ submissionId: string; weight: number }> {
  const radar = await store.getRadar(packet.radar_id);
  if (!radar) {
    throw new Error(`Unknown radar: ${packet.radar_id}`);
  }
  const moduleVersion = await store.getModuleVersion(radar.active_module_version_id ?? "");
  if (!moduleVersion) {
    throw new Error(`No active module for radar ${packet.radar_id}`);
  }
  if (packet.module_version_id !== moduleVersion.id) {
    throw new Error(`Packet module version ${packet.module_version_id} does not match active module ${moduleVersion.id}`);
  }
  const weight = moduleVersion.model_weight_table[packet.model_id] ?? 0.2;
  await store.createSubmission(packet, weight);
  getEvidenceIndex(packet.radar_id).indexBatch(packet.sources);
  await store.createAuditEvent(packet.radar_id, "packet_submitted", { model_id: packet.model_id, weight });
  return { submissionId: packet.thread_id, weight };
}

async function reduceLive(radarId: string): Promise<ReducedSnapshot> {
  const radar = await store.getRadar(radarId);
  if (!radar) {
    throw new Error(`Unknown radar: ${radarId}`);
  }
  const moduleVersion = await store.getModuleVersion(radar.active_module_version_id ?? "");
  if (!moduleVersion) {
    throw new Error(`No active module for radar ${radarId}`);
  }
  const submissions = await store.listSubmissions(radarId);
  if (submissions.length === 0) {
    throw new Error("No submissions to reduce");
  }
  const snapshot = reduceRadarPackets({
    radarId,
    moduleVersion,
    submissions,
    snapshotKind: "live",
    snapshotId: `${radarId}:live:${Date.now()}`,
  });

  // Auto-cluster signals into threads if none exist yet for this radar
  let threads = await store.listThreads(radarId);
  if (threads.length === 0) {
    const signals = await store.listSignals(radarId);
    if (signals.length > 0) {
      const clustered = cluster(signals);
      for (const thread of clustered) {
        thread.radar_id = radarId;
        await store.createThread(thread);
      }
      threads = clustered;
    }
  }

  // Run the deterministic thread-based reducer if threads exist
  if (threads.length > 0) {
    const deterministicSnapshot = deterministicReduce(threads);
    snapshot.render_state = {
      ...snapshot.render_state,
      deterministicSnapshot,
    };
  }

  await store.createSnapshot(snapshot);
  await store.createAuditEvent(radarId, "live_reduction", { snapshot_id: snapshot.id });
  return snapshot;
}

async function sealDailySnapshot(radarId: string): Promise<ReducedSnapshot> {
  const radar = await store.getRadar(radarId);
  if (!radar) {
    throw new Error(`Unknown radar: ${radarId}`);
  }
  const moduleVersion = await store.getModuleVersion(radar.active_module_version_id ?? "");
  if (!moduleVersion) {
    throw new Error(`No active module for radar ${radarId}`);
  }
  const submissions = await store.listSubmissions(radarId);
  if (submissions.length === 0) {
    throw new Error("No submissions to reduce");
  }
  const snapshot = reduceRadarPackets({
    radarId,
    moduleVersion,
    submissions,
    snapshotKind: "daily",
    snapshotId: `${radarId}:daily:${new Date().toISOString().slice(0, 10)}`,
  });

  // Auto-cluster signals into threads if none exist yet for this radar
  let threads = await store.listThreads(radarId);
  if (threads.length === 0) {
    const signals = await store.listSignals(radarId);
    if (signals.length > 0) {
      const clustered = cluster(signals);
      for (const thread of clustered) {
        thread.radar_id = radarId;
        await store.createThread(thread);
      }
      threads = clustered;
    }
  }

  // Run the deterministic thread-based reducer if threads exist
  if (threads.length > 0) {
    const deterministicSnapshot = deterministicReduce(threads);
    snapshot.render_state = {
      ...snapshot.render_state,
      deterministicSnapshot,
    };
  }

  await store.createSnapshot(snapshot);
  await store.createAuditEvent(radarId, "daily_sealed", { snapshot_id: snapshot.id });
  return snapshot;
}

async function collectBlueskySignals(args: {
  feedUri?: string;
  listUri?: string;
  actor?: string;
  searchQuery?: string;
  limit?: number;
  radarId?: string;
}): Promise<{ collected: number; duplicates: number; total_fetched: number }> {
  const { feedUri, listUri, actor, searchQuery, limit, radarId } = args;
  const collector = new BlueskyCollector();
  const query: BlueskyFeedQuery = {
    limit: limit ?? 25,
  };

  if (feedUri) {
    query.feed = feedUri;
  } else if (listUri) {
    query.list = listUri;
  } else if (actor) {
    query.actor = actor;
  } else if (searchQuery) {
    query.searchQuery = searchQuery;
  }

  const rawSignals = await collector.collectFromFeed(query);

  return persistCollectorSignals(rawSignals, radarId);
}

async function collectRedditSignals(args: {
  subreddits: string[];
  sort?: "hot" | "new" | "top" | "rising";
  limit?: number;
  timeframe?: "hour" | "day" | "week" | "month" | "year" | "all";
  radarId?: string;
}): Promise<{ collected: number; duplicates: number; total_fetched: number }> {
  const { subreddits, sort, limit, timeframe, radarId } = args;
  const collector = new RedditCollector();
  let totalCollected = 0;
  let totalDuplicates = 0;
  let totalFetched = 0;

  for (const subreddit of subreddits) {
    const rawSignals = await collector.collectFromSubreddit({
      subreddit,
      sort: sort ?? "hot",
      limit: limit ?? 25,
      timeframe: timeframe ?? "day",
    });

    totalFetched += rawSignals.length;
    const persisted = await persistCollectorSignals(rawSignals, radarId);
    totalCollected += persisted.collected;
    totalDuplicates += persisted.duplicates;
  }

  return {
    collected: totalCollected,
    duplicates: totalDuplicates,
    total_fetched: totalFetched,
  };
}

async function collectWeaverSignals(args: {
  baseUrl?: string;
  domainAllowlist?: string[];
  keywords?: string[];
  domainSignalLimit?: number;
  recentNodeLimit?: number;
  graphNodeLimit?: number;
  radarId?: string;
}): Promise<{ collected: number; duplicates: number; total_fetched: number }> {
  const collector = new WeaverCollector();
  const rawSignals = await collector.collect(args);
  return persistCollectorSignals(rawSignals, args.radarId);
}

function requireJetstreamService(): JetstreamService {
  if (!jetstreamService) {
    throw new Error("Jetstream integration is disabled; set REDIS_URL and enable JETSTREAM_ENABLED");
  }
  return jetstreamService;
}

async function listJetstreamRules(): Promise<JetstreamRule[]> {
  return requireJetstreamService().listRules();
}

async function getJetstreamRule(radarId: string): Promise<JetstreamRule | null> {
  return requireJetstreamService().getRule(radarId);
}

async function putJetstreamRule(radarId: string, input: JetstreamRuleInput): Promise<JetstreamRule> {
  return requireJetstreamService().putRule(radarId, input);
}

async function deleteJetstreamRule(radarId: string): Promise<void> {
  await requireJetstreamService().deleteRule(radarId);
}

async function collectJetstreamSignals(args: { radarId: string; limit?: number }): Promise<{ collected: number; duplicates: number; total_fetched: number }> {
  const service = requireJetstreamService();
  const rawSignals = await collectJetstreamWindowSignals(service, args.radarId, args.limit);
  return persistCollectorSignals(rawSignals, args.radarId);
}

async function persistCollectorSignals(rawSignals: ReadonlyArray<RawCollectorOutput>, radarId?: string): Promise<{ collected: number; duplicates: number; total_fetched: number }> {
  let collected = 0;
  let duplicates = 0;

  for (const raw of rawSignals) {
    const signal = normalize({
      ...raw,
      radar_id: radarId ?? raw.radar_id,
    });

    if (signal.content_hash) {
      const existing = await store.findSignalByContentHash(signal.content_hash);
      if (existing) {
        duplicates++;
        continue;
      }
    }

    await store.createSignal(signal);
    collected++;
  }

  return { collected, duplicates, total_fetched: rawSignals.length };
}

function retitleCrawlerThreads(threads: ReadonlyArray<Thread>, signals: ReadonlyArray<SignalEvent>): Thread[] {
  const signalById = new Map(signals.map((signal) => [signal.id, signal]));
  const internalTags = new Set(["crawler", "weaver", "queued", "fetching", "fetched", "idle", "active"]);

  return threads.map((thread) => {
    const memberSignals = thread.members
      .map((member) => signalById.get(member.signal_event_id))
      .filter((signal): signal is SignalEvent => Boolean(signal));

    if (memberSignals.length === 0) {
      return thread;
    }

    const crawlerOnly = memberSignals.every((signal) => signal.domain_tags.includes("crawler"));
    if (!crawlerOnly) {
      return thread;
    }

    const watchDomains = [...new Set(memberSignals.flatMap((signal) => signal.domain_tags))]
      .filter((tag) => !internalTags.has(tag))
      .sort();

    const title = watchDomains.length > 0
      ? `Crawler watchlist activity: ${watchDomains.slice(0, 2).join(" + ")}`
      : "Crawler watchlist activity";

    return {
      ...thread,
      title,
      summary: `Synthesized from ${memberSignals.length} crawler-derived signals across ${Math.max(1, watchDomains.length)} tracked watch domains.`,
    };
  });
}

async function clusterRadarSignals(radarId: string): Promise<{ threads_created: number; signal_count: number; threads_replaced: number }> {
  const radar = await store.getRadar(radarId);
  if (!radar) {
    throw new Error(`Unknown radar: ${radarId}`);
  }

  const signals = await store.listSignals(radarId);
  if (signals.length === 0) {
    return { threads_created: 0, signal_count: 0, threads_replaced: 0 };
  }

  const threadsReplaced = await store.deleteThreadsByRadar(radarId);
  const threads = retitleCrawlerThreads(cluster(signals), signals);
  let created = 0;
  for (const thread of threads) {
    thread.radar_id = radarId;
    await store.createThread(thread);
    created++;
  }

  await store.createAuditEvent(radarId, "threads_reclustered", { threads_replaced: threadsReplaced, threads_created: created, signal_count: signals.length });
  return { threads_created: created, signal_count: signals.length, threads_replaced: threadsReplaced };
}

const app = express();
app.set("trust proxy", true);
app.use(cors({ origin: "*", exposedHeaders: ["mcp-session-id"] }));
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// Federation manager — Enso-style peer coordination
// ---------------------------------------------------------------------------
const federationManager = new FederationManager({
  instanceId: randomUUID(),
  instanceName: process.env.FEDERATION_INSTANCE_NAME ?? "threat-radar-local",
  endpoint: publicBaseUrl.toString().replace(/\/$/, ""),
  timeoutMs: Number(process.env.FEDERATION_TIMEOUT_MS ?? "10000"),
  staleAfterMs: Number(process.env.FEDERATION_STALE_MS ?? "300000"),
  maxRetries: Number(process.env.FEDERATION_MAX_RETRIES ?? "3"),
});

app.get("/health", async (_req, res) => {
  const jetstreamStatus = jetstreamService ? await jetstreamService.status() : { enabled: false };
  res.json({
    ok: true,
    service: "threat-radar-mcp",
    storage: usePostgres ? "postgres" : "memory",
    publicBaseUrl: publicBaseUrl.toString(),
    jetstream: jetstreamStatus,
    federation: {
      instanceId: federationManager.getInstanceId(),
      peers: federationManager.listPeers().length,
    },
  });
});

// ---------------------------------------------------------------------------
// Federation API endpoints
// ---------------------------------------------------------------------------

/** GET /api/federation/status — federation state for Π lane */
app.get("/api/federation/status", async (_req, res) => {
  federationManager.markStalePeers();
  res.json(federationManager.getFederationStatus());
});

/** GET /api/federation/peers — list known peers */
app.get("/api/federation/peers", async (_req, res) => {
  federationManager.markStalePeers();
  res.json(federationManager.listPeers().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    endpoint: p.endpoint,
    trustLevel: p.trustLevel,
    status: p.status,
    lastSeen: p.lastSeen,
    snapshotCount: p.snapshots.length,
  })));
});

/** POST /api/federation/receive — receive Enso envelope from a peer */
app.post("/api/federation/receive", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    // Accept either a raw envelope or a JSON string
    let envelope: EnsoEnvelope<AggregateSnapshotPayload>;
    if (typeof body === "string") {
      envelope = deserializeEnvelope(body) as EnsoEnvelope<AggregateSnapshotPayload>;
    } else {
      envelope = body as unknown as EnsoEnvelope<AggregateSnapshotPayload>;
    }

    const result = federationManager.receiveEnvelope(envelope);
    if (result.accepted) {
      res.json({ ok: true, accepted: true });
    } else {
      res.status(403).json({ ok: false, accepted: false, reason: result.reason });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid envelope";
    res.status(400).json({ ok: false, error: message });
  }
});

/** POST /api/federation/peers — add a peer */
app.post("/api/federation/peers", requireAdminKey, async (req, res) => {
  try {
    const body = z.object({
      id: z.string().min(1).default(randomUUID()),
      displayName: z.string().min(1),
      endpoint: z.string().url(),
      atProtocolDid: z.string().optional(),
      trustLevel: z.enum(["trusted", "known", "untrusted"]).default("known"),
    }).parse(req.body);

    federationManager.addPeer(body);
    res.status(201).json({ ok: true, peer: federationManager.getPeer(body.id) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid peer configuration";
    res.status(400).json({ ok: false, error: message });
  }
});

/** DELETE /api/federation/peers/:peerId — remove a peer */
app.delete("/api/federation/peers/:peerId", requireAdminKey, async (req, res) => {
  const rawPeerId = req.params.peerId;
  const peerId = Array.isArray(rawPeerId) ? rawPeerId[0] ?? "" : rawPeerId;
  federationManager.removePeer(peerId);
  res.json({ ok: true });
});

/** POST /api/federation/trust/:peerId — add peer to trust circle */
app.post("/api/federation/trust/:peerId", requireAdminKey, async (req, res) => {
  const rawPeerId = req.params.peerId;
  const peerId = Array.isArray(rawPeerId) ? rawPeerId[0] ?? "" : rawPeerId;
  federationManager.addToTrustCircle(peerId);
  res.json({ ok: true, peerId, trusted: true });
});

/** DELETE /api/federation/trust/:peerId — exclude peer from trust circle */
app.delete("/api/federation/trust/:peerId", requireAdminKey, async (req, res) => {
  const rawPeerId = req.params.peerId;
  const peerId = Array.isArray(rawPeerId) ? rawPeerId[0] ?? "" : rawPeerId;
  federationManager.excludeFromTrustCircle(peerId);
  res.json({ ok: true, peerId, trusted: false });
});

/** POST /api/federation/broadcast — broadcast snapshot to all trusted peers */
app.post("/api/federation/broadcast", requireAdminKey, async (req, res) => {
  try {
    const body = z.object({
      radarId: z.string().min(1),
    }).parse(req.body);

    const radar = await store.getRadar(body.radarId);
    if (!radar) {
      res.status(404).json({ ok: false, error: `Unknown radar: ${body.radarId}` });
      return;
    }

    const liveSnapshot = await store.getLatestLiveSnapshot(body.radarId);
    const threads = await store.listThreads(body.radarId);
    const signals = await store.listSignals(body.radarId);

    const renderState = liveSnapshot?.render_state as Record<string, unknown> | undefined;
    const deterministicSnapshot = renderState?.deterministicSnapshot as {
      scoreRanges?: Record<string, { lower: number; upper: number; median: number }>;
      disagreementIndex?: number;
      narrativeBranches?: unknown[];
      compressionLoss?: number;
    } | undefined;

    const payload = createAggregatePayload(
      {
        radarId: radar.id,
        radarName: radar.name,
        radarCategory: radar.category,
        snapshotKind: "live",
        asOfUtc: liveSnapshot?.as_of_utc ?? new Date().toISOString(),
        threadCount: threads.length,
        signalCount: signals.length,
      },
      deterministicSnapshot,
    );

    const results = await federationManager.broadcastSnapshot(payload);
    const summary = Object.fromEntries(results);
    res.json({ ok: true, results: summary });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Broadcast failed";
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/radars", async (_req, res) => {
  const radars = await store.listRadars();
  const result = await Promise.all(radars.map(async (radar) => {
    const sources = await store.listSources(radar.id);
    const signals = await store.listSignals(radar.id);
    const submissions = await store.listSubmissions(radar.id);
    const latestSubmission = submissions[submissions.length - 1]?.packet;
    const liveSnapshot = await store.getLatestLiveSnapshot(radar.id);
    const latestDailySnapshot = await store.getLatestDailySnapshot(radar.id);
    const threads = await store.listThreads(radar.id);
    return {
      radar,
      sourceCount: sources.length,
      signalCount: signals.length,
      submissionCount: submissions.length,
      latestSubmission: latestSubmissionView(latestSubmission),
      liveSnapshot,
      latestDailySnapshot,
      threads,
    };
  }));
  res.json(result);
});

app.get("/api/signals", async (req, res) => {
  const rawRadarId = req.query.radarId;
  const rawLimit = req.query.limit;
  const radarId = typeof rawRadarId === "string" && rawRadarId.trim().length > 0 ? rawRadarId.trim() : undefined;
  const limit = Math.max(1, Math.min(500, Number(typeof rawLimit === "string" ? rawLimit : "200") || 200));
  const signals = await store.listSignals(radarId, limit);
  res.json(signals);
});

app.post("/api/radars", requireAdminKey, async (req, res) => {
  const body = z.object({ slug: z.string().min(1), name: z.string().min(1), category: z.string().min(1), templateId: z.string().optional(), createdBy: z.string().min(1).default("admin") }).parse(req.body);
  const radar = await createRadar(body);
  res.status(201).json(radar);
});

app.post("/api/radars/ensure", requireAdminKey, async (req, res) => {
  try {
    const body = z.object({ slug: z.string().min(1), name: z.string().min(1), category: z.string().min(1), templateId: z.string().optional(), createdBy: z.string().min(1).default("admin") }).parse(req.body);
    const existing = (await store.listRadars()).find((radar) => radar.slug === body.slug);
    if (existing) {
      res.json({ ok: true, created: false, radar: existing });
      return;
    }
    const radar = await createRadar(body);
    res.status(201).json({ ok: true, created: true, radar });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to ensure radar";
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/jetstream/status", async (_req, res) => {
  if (!jetstreamService) {
    res.json({ ok: true, enabled: false });
    return;
  }
  res.json({ ok: true, ...(await jetstreamService.status()) });
});

app.get("/api/jetstream/rules", requireAdminKey, async (_req, res) => {
  try {
    const rules = await listJetstreamRules();
    res.json({ ok: true, rules });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to list Jetstream rules";
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/jetstream/rules/:radarId", requireAdminKey, async (req, res) => {
  try {
    const rawRadarId = req.params.radarId;
    const radarId = Array.isArray(rawRadarId) ? rawRadarId[0] ?? "" : rawRadarId;
    const rule = await getJetstreamRule(radarId);
    res.json({ ok: true, rule });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch Jetstream rule";
    res.status(400).json({ ok: false, error: message });
  }
});

app.put("/api/jetstream/rules/:radarId", requireAdminKey, async (req, res) => {
  try {
    const rawRadarId = req.params.radarId;
    const radarId = Array.isArray(rawRadarId) ? rawRadarId[0] ?? "" : rawRadarId;
    const radar = await store.getRadar(radarId);
    if (!radar) {
      res.status(404).json({ ok: false, error: `Unknown radar: ${radarId}` });
      return;
    }
    const body = z.object({
      wantedUsers: z.array(z.string().min(1)).optional(),
      wantedDids: z.array(z.string().min(1)).optional(),
      hashtags: z.array(z.string().min(1)).optional(),
      keywords: z.array(z.string().min(1)).optional(),
      windowSeconds: z.number().int().min(60).max(604800).optional(),
      maxEvents: z.number().int().min(10).max(2000).optional(),
      enabled: z.boolean().optional(),
      allowNetworkWide: z.boolean().optional(),
    }).parse(req.body);
    const rule = await putJetstreamRule(radarId, body);
    res.json({ ok: true, rule });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to store Jetstream rule";
    res.status(400).json({ ok: false, error: message });
  }
});

app.delete("/api/jetstream/rules/:radarId", requireAdminKey, async (req, res) => {
  try {
    const rawRadarId = req.params.radarId;
    const radarId = Array.isArray(rawRadarId) ? rawRadarId[0] ?? "" : rawRadarId;
    await deleteJetstreamRule(radarId);
    res.json({ ok: true, radarId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete Jetstream rule";
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/operator/auth/login", async (req, res) => {
  try {
    const body = z.object({
      identifier: z.string().min(1),
      appPassword: z.string().min(1),
      serviceUrl: z.string().url().optional(),
    }).parse(req.body);
    const session = await loginWithBluesky(body.identifier, body.appPassword, body.serviceUrl);
    res.json({
      ok: true,
      session: {
        id: session.id,
        did: session.did,
        handle: session.handle,
        serviceUrl: session.serviceUrl,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Bluesky login failed";
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/operator/auth/session", requireOperatorSession, async (req, res) => {
  const session = operatorSessionOf(req);
  res.json({
    ok: true,
    session: {
      id: session.id,
      did: session.did,
      handle: session.handle,
      serviceUrl: session.serviceUrl,
    },
  });
});

app.post("/api/operator/auth/logout", requireOperatorSession, async (req, res) => {
  const session = operatorSessionOf(req);
  await operatorStore.deleteSession(session.id);
  res.json({ ok: true });
});

app.get("/api/operator/bluesky/timeline", requireOperatorSession, async (req, res) => {
  try {
    const session = operatorSessionOf(req);
    const rawLimit = req.query.limit;
    const limit = Math.max(1, Math.min(100, Number(typeof rawLimit === "string" ? rawLimit : "25") || 25));
    const posts = await fetchBlueskyTimeline(session, limit);
    res.json({ ok: true, posts });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load Bluesky timeline";
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/operator/drafts", requireOperatorSession, async (req, res) => {
  const session = operatorSessionOf(req);
  const drafts = await operatorStore.listDrafts(session.did);
  res.json({ ok: true, drafts });
});

app.post("/api/operator/drafts", requireOperatorSession, async (req, res) => {
  try {
    const session = operatorSessionOf(req);
    const body = z.object({
      title: z.string().min(1),
      text: z.string().min(1),
    }).parse(req.body);
    const draft = await operatorStore.upsertDraft({
      did: session.did,
      title: body.title,
      text: body.text,
    });
    res.status(201).json({ ok: true, draft });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create draft";
    res.status(400).json({ ok: false, error: message });
  }
});

app.put("/api/operator/drafts/:draftId", requireOperatorSession, async (req, res) => {
  try {
    const session = operatorSessionOf(req);
    const rawDraftId = req.params.draftId;
    const draftId = Array.isArray(rawDraftId) ? rawDraftId[0] ?? "" : rawDraftId;
    const body = z.object({
      title: z.string().min(1),
      text: z.string().min(1),
    }).parse(req.body);
    const draft = await operatorStore.upsertDraft({
      did: session.did,
      draftId,
      title: body.title,
      text: body.text,
    });
    res.json({ ok: true, draft });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update draft";
    res.status(400).json({ ok: false, error: message });
  }
});

app.delete("/api/operator/drafts/:draftId", requireOperatorSession, async (req, res) => {
  const session = operatorSessionOf(req);
  const rawDraftId = req.params.draftId;
  const draftId = Array.isArray(rawDraftId) ? rawDraftId[0] ?? "" : rawDraftId;
  await operatorStore.deleteDraft(session.did, draftId);
  res.json({ ok: true, draftId });
});

app.post("/api/operator/publish/bluesky", requireOperatorSession, async (req, res) => {
  try {
    const session = operatorSessionOf(req);
    const body = z.object({
      text: z.string().min(1).max(300),
      draftId: z.string().optional(),
      title: z.string().optional(),
    }).parse(req.body);
    const published = await publishDraftToBluesky(session, body.text);
    if (body.draftId) {
      await operatorStore.upsertDraft({
        did: session.did,
        draftId: body.draftId,
        title: body.title ?? body.text.slice(0, 48),
        text: body.text,
        status: "published",
        lastPublishedUri: typeof published.uri === "string" ? published.uri : undefined,
      });
    }
    res.json({ ok: true, published });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to publish post";
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/operator/workspace", requireOperatorSession, async (req, res) => {
  const session = operatorSessionOf(req);
  const prefs = await operatorStore.getPrefs(session.did);
  res.json({
    ok: true,
    workspace: {
      proxxBaseUrl,
      servers: MCP_SERVER_REGISTRY,
      prefs,
    },
  });
});

app.put("/api/operator/workspace", requireOperatorSession, async (req, res) => {
  try {
    const session = operatorSessionOf(req);
    const body = z.object({
      enabledServerIds: z.array(z.string().min(1)).optional(),
      proxxDocked: z.boolean().optional(),
      objective: z.string().max(2000).optional(),
      longTermObjective: z.string().max(2000).optional(),
      strategicNotes: z.string().max(4000).optional(),
      challengeMode: z.boolean().optional(),
    }).parse(req.body);
    const prefs = await operatorStore.setPrefs(session.did, body);
    res.json({ ok: true, prefs });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update workspace preferences";
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/operator/jetstream/rules/:radarId", requireOperatorSession, async (req, res) => {
  try {
    const rawRadarId = req.params.radarId;
    const radarId = Array.isArray(rawRadarId) ? rawRadarId[0] ?? "" : rawRadarId;
    const rule = await getJetstreamRule(radarId);
    res.json({ ok: true, rule });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load Jetstream rule";
    res.status(400).json({ ok: false, error: message });
  }
});

app.put("/api/operator/jetstream/rules/:radarId", requireOperatorSession, async (req, res) => {
  try {
    const rawRadarId = req.params.radarId;
    const radarId = Array.isArray(rawRadarId) ? rawRadarId[0] ?? "" : rawRadarId;
    const radar = await store.getRadar(radarId);
    if (!radar) {
      res.status(404).json({ ok: false, error: `Unknown radar: ${radarId}` });
      return;
    }
    const body = z.object({
      wantedUsers: z.array(z.string().min(1)).optional(),
      wantedDids: z.array(z.string().min(1)).optional(),
      hashtags: z.array(z.string().min(1)).optional(),
      keywords: z.array(z.string().min(1)).optional(),
      windowSeconds: z.number().int().min(60).max(604800).optional(),
      maxEvents: z.number().int().min(10).max(2000).optional(),
      enabled: z.boolean().optional(),
      allowNetworkWide: z.boolean().optional(),
    }).parse(req.body);
    const rule = await putJetstreamRule(radarId, body);
    res.json({ ok: true, rule });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update Jetstream rule";
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/operator/jetstream/collect", requireOperatorSession, async (req, res) => {
  try {
    const body = z.object({
      radarId: z.string().min(1),
      limit: z.number().int().min(1).max(2000).optional(),
    }).parse(req.body);
    const result = await collectJetstreamSignals(body);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to collect Jetstream window";
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/submit-packet", requireAdminKey, async (req, res) => {
  try {
    const packet = radarAssessmentPacketSchema.parse(req.body);
    const result = await submitPacket(packet);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid packet";
    res.status(400).json({ error: message });
  }
});

app.post("/api/reduce-live/:radarId", requireAdminKey, async (req, res) => {
  try {
    const rawRadarId = req.params.radarId;
    const radarId = Array.isArray(rawRadarId) ? rawRadarId[0] ?? "" : rawRadarId;
    const snapshot = await reduceLive(radarId);
    res.json({ ok: true, snapshot });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Reduction failed";
    res.status(400).json({ error: message });
  }
});

app.post("/api/seal-daily/:radarId", requireAdminKey, async (req, res) => {
  try {
    const rawRadarId = req.params.radarId;
    const radarId = Array.isArray(rawRadarId) ? rawRadarId[0] ?? "" : rawRadarId;
    const snapshot = await sealDailySnapshot(radarId);
    res.json({ ok: true, snapshot });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Daily sealing failed";
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/collect/bluesky", requireAdminKey, async (req, res) => {
  try {
    const body = z.object({
      feedUri: z.string().optional(),
      listUri: z.string().optional(),
      actor: z.string().optional(),
      searchQuery: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      radarId: z.string().optional(),
    }).parse(req.body);

    if (!body.feedUri && !body.listUri && !body.actor && !body.searchQuery) {
      res.status(400).json({ ok: false, error: "At least one of feedUri, listUri, actor, or searchQuery must be provided" });
      return;
    }
    if (body.feedUri && !body.feedUri.startsWith("at://")) {
      res.status(400).json({ ok: false, error: "feedUri must be a valid AT Protocol URI (at://...)" });
      return;
    }
    if (body.listUri && !body.listUri.startsWith("at://")) {
      res.status(400).json({ ok: false, error: "listUri must be a valid AT Protocol URI (at://...)" });
      return;
    }

    const result = await collectBlueskySignals(body);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Collection failed";
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/collect/reddit", requireAdminKey, async (req, res) => {
  try {
    const body = z.object({
      subreddits: z.array(z.string().min(1)).min(1),
      sort: z.enum(["hot", "new", "top", "rising"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      timeframe: z.enum(["hour", "day", "week", "month", "year", "all"]).optional(),
      radarId: z.string().optional(),
    }).parse(req.body);
    const result = await collectRedditSignals(body);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Collection failed";
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/collect/weaver", requireAdminKey, async (req, res) => {
  try {
    const body = z.object({
      baseUrl: z.string().url().optional(),
      domainAllowlist: z.array(z.string().min(1)).optional(),
      keywords: z.array(z.string().min(1)).optional(),
      domainSignalLimit: z.number().int().min(1).max(25).optional(),
      recentNodeLimit: z.number().int().min(0).max(50).optional(),
      graphNodeLimit: z.number().int().min(50).max(5000).optional(),
      radarId: z.string().optional(),
    }).parse(req.body);
    const result = await collectWeaverSignals(body);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Crawler collection failed";
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/collect/jetstream", requireAdminKey, async (req, res) => {
  try {
    const body = z.object({
      radarId: z.string().min(1),
      limit: z.number().int().min(1).max(2000).optional(),
    }).parse(req.body);
    const result = await collectJetstreamSignals(body);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Jetstream collection failed";
    res.status(400).json({ ok: false, error: message });
  }
});

app.post("/api/cluster/:radarId", requireAdminKey, async (req, res) => {
  try {
    const rawRadarId = req.params.radarId;
    const radarId = Array.isArray(rawRadarId) ? rawRadarId[0] ?? "" : rawRadarId;
    const result = await clusterRadarSignals(radarId);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Clustering failed";
    res.status(400).json({ ok: false, error: message });
  }
});

const server = new McpServer({ name: "threat-radar-mcp", version: "0.1.0" });

server.registerTool(
  "radar_create",
  {
    description: "Create a new threat radar from a template",
    inputSchema: {
      slug: z.string().min(1),
      name: z.string().min(1),
      category: z.string().min(1),
      templateId: z.string().optional(),
      createdBy: z.string().min(1).default("agent"),
    },
  },
  async ({ slug, name, category, templateId, createdBy }): Promise<CallToolResult> => {
    try {
      const radar = await createRadar({ slug, name, category, templateId, createdBy });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, radar }, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create radar";
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true };
    }
  },
);

server.registerTool(
  "radar_list",
  {
    description: "List current threat radars",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (): Promise<CallToolResult> => {
    try {
      const radars = await store.listRadars();
      const list = await Promise.all(radars.map(async (radar) => {
        const sources = await store.listSources(radar.id);
        const signals = await store.listSignals(radar.id);
        const submissions = await store.listSubmissions(radar.id);
        const liveSnapshot = await store.getLatestLiveSnapshot(radar.id);
        const dailySnapshots = await store.listDailySnapshots(radar.id);
        return {
          radar,
          sourceCount: sources.length,
          signalCount: signals.length,
          submissionCount: submissions.length,
          hasLiveSnapshot: Boolean(liveSnapshot),
          dailySnapshotCount: dailySnapshots.length,
        };
      }));
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to list radars";
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true };
    }
  },
);

server.registerTool(
  "radar_add_source",
  {
    description: "Attach a typed source definition to a radar",
    inputSchema: { source: sourceDefinitionSchema },
  },
  async ({ source }): Promise<CallToolResult> => {
    try {
      const created = await addSource(source);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, source: created }, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to add source";
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true };
    }
  },
);

server.registerTool(
  "radar_submit_packet",
  {
    description: "Submit a structured assessment packet for a radar",
    inputSchema: { packet: radarAssessmentPacketSchema },
  },
  async ({ packet }): Promise<CallToolResult> => {
    try {
      const result = await submitPacket(packet);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to submit packet";
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true };
    }
  },
);

server.registerTool(
  "radar_reduce_live",
  {
    description: "Produce the current live reduced snapshot for a radar",
    inputSchema: { radarId: z.string().min(1) },
  },
  async ({ radarId }): Promise<CallToolResult> => {
    try {
      const snapshot = await reduceLive(radarId);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, snapshot }, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Reduction failed";
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true };
    }
  },
);

server.registerTool(
  "radar_seal_daily_snapshot",
  {
    description: "Seal an immutable daily snapshot for a radar",
    inputSchema: { radarId: z.string().min(1) },
  },
  async ({ radarId }): Promise<CallToolResult> => {
    try {
      const snapshot = await sealDailySnapshot(radarId);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, snapshot }, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Snapshot sealing failed";
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true };
    }
  },
);

server.registerTool(
  "radar_get_audit_log",
  {
    description: "Get audit events for a radar",
    inputSchema: { radarId: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ radarId }): Promise<CallToolResult> => {
    try {
      const events = await store.listAuditEvents(radarId);
      return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to get audit log";
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true };
    }
  },
);

server.registerTool(
  "radar_collect_bluesky",
  {
    description: "Collect signals from Bluesky public feeds. Accepts a feed URI, actor handle, or search query. Fetches posts via the AT Protocol, normalizes each post into a SignalEvent with source='bluesky', and stores them in Postgres. No authentication needed for public feeds.",
    inputSchema: {
      feedUri: z.string().optional().describe("A Bluesky feed generator URI (at:// URI)"),
      listUri: z.string().optional().describe("A Bluesky list URI (at:// URI)"),
      actor: z.string().optional().describe("A Bluesky actor handle or DID to fetch posts from"),
      searchQuery: z.string().optional().describe("A search query to find posts"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum number of posts to fetch (default: 25)"),
      radarId: z.string().optional().describe("Optional radar ID to associate collected signals with"),
    },
  },
  async ({ feedUri, listUri, actor, searchQuery, limit, radarId }): Promise<CallToolResult> => {
    try {
      if (!feedUri && !listUri && !actor && !searchQuery) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "At least one of feedUri, listUri, actor, or searchQuery must be provided" }) }],
          isError: true,
        };
      }

      if (feedUri && !feedUri.startsWith("at://")) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "feedUri must be a valid AT Protocol URI (at://...)" }) }],
          isError: true,
        };
      }
      if (listUri && !listUri.startsWith("at://")) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "listUri must be a valid AT Protocol URI (at://...)" }) }],
          isError: true,
        };
      }

      const result = await collectBlueskySignals({ feedUri, listUri, actor, searchQuery, limit, radarId });

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Collection failed";
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "radar_collect_reddit",
  {
    description: "Collect signals from Reddit subreddits. Accepts a list of subreddit names, fetches recent posts via the Reddit JSON API (no auth needed), normalizes each post into a SignalEvent with source='reddit', and stores them in Postgres.",
    inputSchema: {
      subreddits: z.array(z.string().min(1)).min(1).describe("List of subreddit names to collect from (e.g., ['machinelearning', 'LocalLLaMA'])"),
      sort: z.enum(["hot", "new", "top", "rising"]).optional().describe("Sort order for posts (default: 'hot')"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum number of posts per subreddit (default: 25)"),
      timeframe: z.enum(["hour", "day", "week", "month", "year", "all"]).optional().describe("Time filter for 'top' sort (default: 'day')"),
      radarId: z.string().optional().describe("Optional radar ID to associate collected signals with"),
    },
  },
  async ({ subreddits, sort, limit, timeframe, radarId }): Promise<CallToolResult> => {
    try {
      const result = await collectRedditSignals({ subreddits, sort, limit, timeframe, radarId });

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Collection failed";
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "radar_collect_weaver",
  {
    description: "Collect signals from the Fork Tales web graph weaver. Uses bounded crawler status/domain activity plus recent graph nodes filtered by allowed domains/keywords.",
    inputSchema: {
      baseUrl: z.string().url().optional().describe("Base URL for the weaver API, default http://127.0.0.1:8793"),
      domainAllowlist: z.array(z.string().min(1)).optional().describe("Optional allowed hostnames/domains to keep the collector focused"),
      keywords: z.array(z.string().min(1)).optional().describe("Optional case-insensitive keywords used to filter graph nodes"),
      domainSignalLimit: z.number().int().min(1).max(25).optional().describe("Maximum number of per-domain activity signals"),
      recentNodeLimit: z.number().int().min(0).max(50).optional().describe("Maximum number of recent graph-node signals"),
      graphNodeLimit: z.number().int().min(50).max(5000).optional().describe("How many graph nodes to inspect from the weaver graph endpoint"),
      radarId: z.string().optional().describe("Optional radar ID to associate collected signals with"),
    },
  },
  async ({ baseUrl, domainAllowlist, keywords, domainSignalLimit, recentNodeLimit, graphNodeLimit, radarId }): Promise<CallToolResult> => {
    try {
      const result = await collectWeaverSignals({
        baseUrl,
        domainAllowlist,
        keywords,
        domainSignalLimit,
        recentNodeLimit,
        graphNodeLimit,
        radarId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Crawler collection failed";
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "radar_set_jetstream_rule",
  {
    description: "Create or update a Jetstream firehose rule for a radar. Supports filtering by specific users/DIDs, hashtags, and keywords with a Redis-backed rolling window.",
    inputSchema: {
      radarId: z.string().min(1),
      wantedUsers: z.array(z.string().min(1)).optional(),
      wantedDids: z.array(z.string().min(1)).optional(),
      hashtags: z.array(z.string().min(1)).optional(),
      keywords: z.array(z.string().min(1)).optional(),
      windowSeconds: z.number().int().min(60).max(604800).optional(),
      maxEvents: z.number().int().min(10).max(2000).optional(),
      enabled: z.boolean().optional(),
      allowNetworkWide: z.boolean().optional(),
    },
  },
  async ({ radarId, ...ruleInput }): Promise<CallToolResult> => {
    try {
      const radar = await store.getRadar(radarId);
      if (!radar) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown radar: ${radarId}` }) }],
          isError: true,
        };
      }
      const rule = await putJetstreamRule(radarId, ruleInput);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, rule }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to store Jetstream rule";
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "radar_collect_jetstream",
  {
    description: "Collect normalized signals from the Redis-backed Jetstream rolling window for a radar.",
    inputSchema: {
      radarId: z.string().min(1),
      limit: z.number().int().min(1).max(2000).optional(),
    },
  },
  async ({ radarId, limit }): Promise<CallToolResult> => {
    try {
      const result = await collectJetstreamSignals({ radarId, limit });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Jetstream collection failed";
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "radar_cluster_signals",
  {
    description: "Explicitly cluster signals for a given radar into threads using TF-IDF cosine similarity. Existing radar threads are replaced before the new clustered thread set is written, preventing duplicate thread growth across recurring cycles.",
    inputSchema: {
      radarId: z.string().min(1).describe("The radar ID whose signals should be clustered"),
    },
  },
  async ({ radarId }): Promise<CallToolResult> => {
    try {
      const result = await clusterRadarSignals(radarId);

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Clustering failed";
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
        isError: true,
      };
    }
  },
);

const mcpRouter = createMcpHttpRouter({
  createServer: () => server,
});

const maybeAdminBypass: RequestHandler = (req, res, next) => {
  if (toBool(ENV.ALLOW_UNAUTH_LOCAL, false) && isLoopbackRequest(req)) {
    next();
    return;
  }
  requireAdminKey(req, res, next);
};

app.post("/mcp", maybeAdminBypass, async (req, res) => {
  await mcpRouter.handlePost(req, res);
});

app.get("/mcp", maybeAdminBypass, async (req, res) => {
  await mcpRouter.handleSession(req, res);
});

app.delete("/mcp", maybeAdminBypass, async (req, res) => {
  await mcpRouter.handleSession(req, res);
});

async function main(): Promise<void> {
  operatorStore = new OperatorStore(ENV.REDIS_URL);
  await operatorStore.init();

  if (usePostgres) {
    await initSchema();
    store = new PostgresRadarStore();
    console.log("[threat-radar-mcp] postgres storage initialized");
  } else {
    store = new InMemoryRadarStore();
    console.log("[threat-radar-mcp] in-memory storage (no DATABASE_URL)");
  }

  if (jetstreamEnabled && ENV.REDIS_URL) {
    jetstreamService = new JetstreamService({
      redisUrl: ENV.REDIS_URL,
      jetstreamUrl: ENV.JETSTREAM_URL,
      atprotoService: ENV.ATPROTO_SERVICE,
      logger: console,
    });
    await jetstreamService.ensureRunning();
    console.log("[threat-radar-mcp] jetstream integration enabled");
  }

  app.listen(ENV.PORT, "0.0.0.0", () => {
    console.log(`[threat-radar-mcp] listening on ${ENV.PORT}`);
  });
}

main().catch((err) => {
  console.error("[threat-radar-mcp] fatal:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  void Promise.all([
    closeSql(),
    jetstreamService?.close(),
    operatorStore?.close(),
  ]).finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void Promise.all([
    closeSql(),
    jetstreamService?.close(),
    operatorStore?.close(),
  ]).finally(() => process.exit(0));
});
