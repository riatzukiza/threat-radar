import { randomUUID } from "node:crypto";

import RedisConstructor from "ioredis";

export interface OperatorSession {
  id: string;
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt?: string;
  serviceUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorDraft {
  id: string;
  did: string;
  title: string;
  text: string;
  status: "draft" | "published";
  createdAt: string;
  updatedAt: string;
  lastPublishedUri?: string;
}

export interface OperatorWorkspacePrefs {
  did: string;
  enabledServerIds: string[];
  proxxDocked: boolean;
  objective: string;
  longTermObjective: string;
  strategicNotes: string;
  challengeMode: boolean;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sessionKey(sessionId: string): string {
  return `threat-radar:operator:session:${sessionId}`;
}

function draftsKey(did: string): string {
  return `threat-radar:operator:drafts:${did}`;
}

function draftKey(did: string, draftId: string): string {
  return `threat-radar:operator:draft:${did}:${draftId}`;
}

function prefsKey(did: string): string {
  return `threat-radar:operator:prefs:${did}`;
}

function normalizePrefs(input: Partial<OperatorWorkspacePrefs> & { did: string }): OperatorWorkspacePrefs {
  return {
    did: input.did,
    enabledServerIds: [...new Set(input.enabledServerIds ?? ["proxx", "radar-mcp", "jetstream", "mnemosyne", "mcp-github"])].sort(),
    proxxDocked: input.proxxDocked ?? true,
    objective: input.objective ?? "",
    longTermObjective: input.longTermObjective ?? "",
    strategicNotes: input.strategicNotes ?? "",
    challengeMode: input.challengeMode ?? true,
    updatedAt: input.updatedAt ?? nowIso(),
  };
}

export class OperatorStore {
  private readonly redis: any | null;
  private readonly sessions = new Map<string, OperatorSession>();
  private readonly drafts = new Map<string, Map<string, OperatorDraft>>();
  private readonly prefs = new Map<string, OperatorWorkspacePrefs>();

  constructor(redisUrl?: string) {
    if (redisUrl) {
      const RedisCtor = RedisConstructor as unknown as { new(url: string, options: Record<string, unknown>): any };
      this.redis = new RedisCtor(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    } else {
      this.redis = null;
    }
  }

  async init(): Promise<void> {
    if (this.redis && this.redis.status === "wait") {
      await this.redis.connect();
    }
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  async createSession(input: Omit<OperatorSession, "id" | "createdAt" | "updatedAt">): Promise<OperatorSession> {
    const session: OperatorSession = {
      id: randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...input,
    };

    if (this.redis) {
      await this.redis.set(sessionKey(session.id), JSON.stringify(session), "EX", 60 * 60 * 24 * 14);
      return session;
    }

    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(sessionId: string): Promise<OperatorSession | null> {
    if (!sessionId) return null;
    if (this.redis) {
      const raw = await this.redis.get(sessionKey(sessionId));
      return raw ? (JSON.parse(raw) as OperatorSession) : null;
    }
    return this.sessions.get(sessionId) ?? null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(sessionKey(sessionId));
      return;
    }
    this.sessions.delete(sessionId);
  }

  async listDrafts(did: string): Promise<OperatorDraft[]> {
    if (this.redis) {
      const ids = await this.redis.smembers(draftsKey(did));
      if (ids.length === 0) return [];
      const values = await this.redis.mget(ids.map((draftId: string) => draftKey(did, draftId)));
      return values
        .filter((value: string | null): value is string => typeof value === "string")
        .map((value: string) => JSON.parse(value) as OperatorDraft)
        .sort((a: OperatorDraft, b: OperatorDraft) => b.updatedAt.localeCompare(a.updatedAt));
    }

    const drafts = [...(this.drafts.get(did)?.values() ?? [])];
    drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return drafts;
  }

  async upsertDraft(input: { did: string; draftId?: string; title: string; text: string; status?: OperatorDraft["status"]; lastPublishedUri?: string }): Promise<OperatorDraft> {
    const currentDraft = input.draftId ? await this.getDraft(input.did, input.draftId) : null;
    const draft: OperatorDraft = {
      id: currentDraft?.id ?? input.draftId ?? randomUUID(),
      did: input.did,
      title: input.title.trim(),
      text: input.text,
      status: input.status ?? currentDraft?.status ?? "draft",
      createdAt: currentDraft?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      lastPublishedUri: input.lastPublishedUri ?? currentDraft?.lastPublishedUri,
    };

    if (this.redis) {
      await this.redis.multi()
        .sadd(draftsKey(input.did), draft.id)
        .set(draftKey(input.did, draft.id), JSON.stringify(draft), "EX", 60 * 60 * 24 * 30)
        .exec();
      return draft;
    }

    const perDid = this.drafts.get(input.did) ?? new Map<string, OperatorDraft>();
    perDid.set(draft.id, draft);
    this.drafts.set(input.did, perDid);
    return draft;
  }

  async getDraft(did: string, draftId: string): Promise<OperatorDraft | null> {
    if (this.redis) {
      const raw = await this.redis.get(draftKey(did, draftId));
      return raw ? (JSON.parse(raw) as OperatorDraft) : null;
    }
    return this.drafts.get(did)?.get(draftId) ?? null;
  }

  async deleteDraft(did: string, draftId: string): Promise<void> {
    if (this.redis) {
      await this.redis.multi()
        .srem(draftsKey(did), draftId)
        .del(draftKey(did, draftId))
        .exec();
      return;
    }
    this.drafts.get(did)?.delete(draftId);
  }

  async getPrefs(did: string): Promise<OperatorWorkspacePrefs> {
    if (this.redis) {
      const raw = await this.redis.get(prefsKey(did));
      if (raw) {
        return normalizePrefs(JSON.parse(raw) as Partial<OperatorWorkspacePrefs> & { did: string });
      }
    } else {
      const current = this.prefs.get(did);
      if (current) return current;
    }

    return normalizePrefs({
      did,
    });
  }

  async setPrefs(did: string, input: Partial<Pick<OperatorWorkspacePrefs, "enabledServerIds" | "proxxDocked" | "objective" | "longTermObjective" | "strategicNotes" | "challengeMode">>): Promise<OperatorWorkspacePrefs> {
    const current = await this.getPrefs(did);
    const next: OperatorWorkspacePrefs = normalizePrefs({
      ...current,
      ...input,
      did,
      updatedAt: nowIso(),
    });

    if (this.redis) {
      await this.redis.set(prefsKey(did), JSON.stringify(next), "EX", 60 * 60 * 24 * 30);
      return next;
    }

    this.prefs.set(did, next);
    return next;
  }
}
