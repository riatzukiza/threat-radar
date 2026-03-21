import { useEffect, useMemo, useState } from "react";

import {
  collectJetstream,
  createDraft,
  deleteDraft,
  fetchBlueskyTimeline,
  fetchDrafts,
  fetchJetstreamRule,
  fetchJetstreamStatus,
  fetchWorkspaceConfig,
  publishDraft,
  updateDraft,
  updateJetstreamRule,
  updateWorkspaceConfig,
} from "../../api/client";
import type {
  BlueskyTimelinePost,
  JetstreamRule,
  JetstreamStatus,
  OperatorDraft,
  OperatorSession,
  RadarTile,
  ThreadData,
  WorkspaceConfig,
} from "../../api/types";
import type { SimilarityScore } from "../../embed/useEmbedding";

export interface OperatorDockProps {
  readonly apiUrl: string;
  readonly session: OperatorSession;
  readonly sessionId: string;
  readonly tiles: readonly RadarTile[];
  readonly computeSimilarity: (left: string[], right: string[]) => Promise<SimilarityScore[]>;
  readonly onLogout: () => Promise<void>;
}

function allThreads(tiles: readonly RadarTile[]): ThreadData[] {
  return tiles.flatMap((tile) => tile.threads ?? []);
}

function blueskyWebUrl(uri: string, handle?: string): string | null {
  if (!uri.startsWith("at://")) return null;
  const parts = uri.slice(5).split("/");
  if (parts.length < 3) return null;
  const rkey = parts[2] ?? "";
  const profile = encodeURIComponent(handle ?? parts[0] ?? "");
  if (!rkey || !profile) return null;
  return `https://bsky.app/profile/${profile}/post/${encodeURIComponent(rkey)}`;
}

function normalizeToken(value: string): string {
  return value.trim();
}

function addToken(list: readonly string[] | undefined, rawValue: string): string[] {
  const value = normalizeToken(rawValue);
  if (!value) return [...(list ?? [])];
  const existing = list ?? [];
  const seen = new Set(existing.map((entry) => entry.toLowerCase()));
  if (seen.has(value.toLowerCase())) return [...existing];
  return [...existing, value];
}

function removeToken(list: readonly string[] | undefined, value: string): string[] {
  return (list ?? []).filter((entry) => entry !== value);
}

interface TokenFieldProps {
  readonly label: string;
  readonly items: readonly string[] | undefined;
  readonly value: string;
  readonly placeholder: string;
  readonly addLabel: string;
  readonly onValueChange: (value: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (value: string) => void;
  readonly helper?: string;
  readonly extraAction?: JSX.Element;
}

function TokenField({
  label,
  items,
  value,
  placeholder,
  addLabel,
  onValueChange,
  onAdd,
  onRemove,
  helper,
  extraAction,
}: TokenFieldProps): JSX.Element {
  return (
    <div className="operator-token-field">
      <span>{label}</span>
      <div className="operator-token-input-row">
        <input
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
        />
        <button className="operator-button" type="button" onClick={onAdd}>{addLabel}</button>
        {extraAction}
      </div>
      {helper && <p className="operator-hint">{helper}</p>}
      <div className="operator-chip-list">
        {(items ?? []).map((item) => (
          <span key={`${label}-${item}`} className="operator-chip">
            <span>{item}</span>
            <button type="button" className="operator-chip-remove" onClick={() => onRemove(item)} aria-label={`Remove ${item}`}>
              ×
            </button>
          </span>
        ))}
        {(items ?? []).length === 0 && <p className="operator-empty">No {label.toLowerCase()} set.</p>}
      </div>
    </div>
  );
}

export function OperatorDock({ apiUrl, session, sessionId, tiles, computeSimilarity, onLogout }: OperatorDockProps): JSX.Element {
  const [drafts, setDrafts] = useState<OperatorDraft[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [jetstreamStatus, setJetstreamStatus] = useState<JetstreamStatus | null>(null);
  const [selectedRadarId, setSelectedRadarId] = useState<string>(tiles[0]?.radar.id ?? "");
  const [rule, setRule] = useState<Partial<JetstreamRule>>({ enabled: true, windowSeconds: 3600, maxEvents: 250 });
  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [semanticQuery, setSemanticQuery] = useState("emerging narratives");
  const [semanticResults, setSemanticResults] = useState<Array<{ title: string; similarity: number }>>([]);
  const [timelinePosts, setTimelinePosts] = useState<BlueskyTimelinePost[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showProxx, setShowProxx] = useState(true);
  const [userToken, setUserToken] = useState("");
  const [didToken, setDidToken] = useState("");
  const [hashtagToken, setHashtagToken] = useState("");
  const [keywordToken, setKeywordToken] = useState("");

  const radarOptions = useMemo(() => tiles.map((tile) => ({ id: tile.radar.id, name: tile.radar.name })), [tiles]);
  const threads = useMemo(() => allThreads(tiles), [tiles]);

  useEffect(() => {
    if (!selectedRadarId && tiles[0]?.radar.id) {
      setSelectedRadarId(tiles[0].radar.id);
    }
  }, [selectedRadarId, tiles]);

  useEffect(() => {
    void fetchDrafts(apiUrl, sessionId).then(setDrafts).catch(() => {});
    void fetchWorkspaceConfig(apiUrl, sessionId).then((nextWorkspace) => {
      setWorkspace(nextWorkspace);
      setShowProxx(nextWorkspace.prefs.proxxDocked);
    }).catch(() => {});
    void fetchJetstreamStatus(apiUrl).then(setJetstreamStatus).catch(() => {});
    void fetchBlueskyTimeline(apiUrl, sessionId, 20).then(setTimelinePosts).catch(() => {});
  }, [apiUrl, sessionId]);

  useEffect(() => {
    if (!selectedRadarId) return;
    void fetchJetstreamRule(apiUrl, sessionId, selectedRadarId)
      .then((nextRule) => {
        if (nextRule) {
          setRule(nextRule);
        } else {
          setRule({ enabled: true, wantedDids: [session.did], windowSeconds: 3600, maxEvents: 250, allowNetworkWide: false });
        }
      })
      .catch(() => {});
  }, [apiUrl, selectedRadarId, session.did, sessionId]);

  const saveDraft = async (): Promise<void> => {
    if (!draftTitle.trim() || !draftText.trim()) return;
    const nextDraft = activeDraftId
      ? await updateDraft(apiUrl, sessionId, activeDraftId, draftTitle, draftText)
      : await createDraft(apiUrl, sessionId, draftTitle, draftText);
    setStatusMessage(`Draft saved: ${nextDraft.title}`);
    setActiveDraftId(nextDraft.id);
    setDrafts(await fetchDrafts(apiUrl, sessionId));
  };

  const publishCurrentDraft = async (): Promise<void> => {
    if (!draftText.trim()) return;
    const published = await publishDraft(apiUrl, sessionId, draftText, activeDraftId ?? undefined, draftTitle || undefined);
    setStatusMessage(`Published to Bluesky: ${String(published.uri ?? "ok")}`);
    setDrafts(await fetchDrafts(apiUrl, sessionId));
  };

  const runSemanticFeed = async (): Promise<void> => {
    if (!semanticQuery.trim() || threads.length === 0) {
      setSemanticResults([]);
      return;
    }
    const scores = await computeSimilarity([semanticQuery], threads.map((thread) => thread.title));
    setSemanticResults(scores.slice(0, 8).map((score) => ({ title: score.localTitle, similarity: score.similarity })));
  };

  return (
    <aside className="operator-dock">
      <div className="operator-dock-header">
        <div>
          <div className="operator-dock-eyebrow">Operator</div>
          <h2>{session.handle}</h2>
          <p>{session.did}</p>
        </div>
        <button className="operator-button" onClick={() => void onLogout()}>
          Logout
        </button>
      </div>

      {statusMessage && <div className="operator-status-banner">{statusMessage}</div>}

      <section className="operator-section">
        <div className="operator-section-header">
          <h3>Your Bluesky feed</h3>
          <button className="operator-button" type="button" onClick={() => {
            void fetchBlueskyTimeline(apiUrl, sessionId, 20)
              .then((posts) => {
                setTimelinePosts(posts);
                setStatusMessage(`Loaded ${posts.length} Bluesky posts`);
              })
              .catch((err: unknown) => setStatusMessage(err instanceof Error ? err.message : "Failed to load Bluesky feed"));
          }}>Refresh feed</button>
        </div>
        <p className="operator-hint">This is your actual subscribed Bluesky timeline, not a synthetic search result.</p>
        <div className="operator-feed-results">
          {timelinePosts.map((post) => {
            const url = blueskyWebUrl(post.uri, post.author.handle);
            return (
              <article key={post.uri} className="operator-feed-item operator-feed-post">
                <div className="operator-feed-post-head">
                  <strong>{post.author.displayName ?? post.author.handle ?? "Unknown author"}</strong>
                  <span>{post.author.handle ?? post.author.did ?? ""}</span>
                </div>
                <p>{post.text}</p>
                <div className="operator-feed-post-meta">
                  <span>{post.createdAt ? new Date(post.createdAt).toLocaleString() : ""}</span>
                  <span>{post.replyCount ?? 0} replies</span>
                  <span>{post.repostCount ?? 0} reposts</span>
                  <span>{post.likeCount ?? 0} likes</span>
                  {url && <a href={url} target="_blank" rel="noreferrer">Open post</a>}
                </div>
              </article>
            );
          })}
          {timelinePosts.length === 0 && <p className="operator-empty">No Bluesky posts loaded yet.</p>}
        </div>
      </section>

      <section className="operator-section">
        <h3>Jetstream rule</h3>
        <label>
          <span>Radar</span>
          <select value={selectedRadarId} onChange={(event) => setSelectedRadarId(event.target.value)}>
            {radarOptions.map((radar) => (
              <option key={radar.id} value={radar.id}>{radar.name}</option>
            ))}
          </select>
        </label>
        <TokenField
          label="Users / handles"
          items={rule.wantedUsers}
          value={userToken}
          placeholder="you.bsky.social"
          addLabel="Add handle"
          helper="Add one handle at a time; remove with the × buttons."
          onValueChange={setUserToken}
          onAdd={() => {
            setRule((prev) => ({ ...prev, wantedUsers: addToken(prev.wantedUsers, userToken) }));
            setUserToken("");
          }}
          onRemove={(value) => setRule((prev) => ({ ...prev, wantedUsers: removeToken(prev.wantedUsers, value) }))}
        />
        <TokenField
          label="Wanted DIDs"
          items={rule.wantedDids}
          value={didToken}
          placeholder="did:plc:..."
          addLabel="Add DID"
          helper="Best for precise Jetstream targeting."
          onValueChange={setDidToken}
          onAdd={() => {
            setRule((prev) => ({ ...prev, wantedDids: addToken(prev.wantedDids, didToken) }));
            setDidToken("");
          }}
          onRemove={(value) => setRule((prev) => ({ ...prev, wantedDids: removeToken(prev.wantedDids, value) }))}
          extraAction={
            <button
              className="operator-button"
              type="button"
              onClick={() => setRule((prev) => ({ ...prev, wantedDids: addToken(prev.wantedDids, session.did) }))}
            >
              Use my DID
            </button>
          }
        />
        <TokenField
          label="Hashtags"
          items={rule.hashtags}
          value={hashtagToken}
          placeholder="hormuz"
          addLabel="Add hashtag"
          onValueChange={setHashtagToken}
          onAdd={() => {
            const normalized = hashtagToken.replace(/^#/, "");
            setRule((prev) => ({ ...prev, hashtags: addToken(prev.hashtags, normalized) }));
            setHashtagToken("");
          }}
          onRemove={(value) => setRule((prev) => ({ ...prev, hashtags: removeToken(prev.hashtags, value) }))}
        />
        <TokenField
          label="Keywords"
          items={rule.keywords}
          value={keywordToken}
          placeholder="shipping disruption"
          addLabel="Add keyword"
          onValueChange={setKeywordToken}
          onAdd={() => {
            setRule((prev) => ({ ...prev, keywords: addToken(prev.keywords, keywordToken) }));
            setKeywordToken("");
          }}
          onRemove={(value) => setRule((prev) => ({ ...prev, keywords: removeToken(prev.keywords, value) }))}
        />
        <div className="operator-inline-grid">
          <label><span>Window (s)</span><input type="number" value={rule.windowSeconds ?? 3600} onChange={(event) => setRule((prev) => ({ ...prev, windowSeconds: Number(event.target.value) }))} /></label>
          <label><span>Max events</span><input type="number" value={rule.maxEvents ?? 250} onChange={(event) => setRule((prev) => ({ ...prev, maxEvents: Number(event.target.value) }))} /></label>
        </div>
        <label className="operator-checkbox"><input type="checkbox" checked={rule.enabled ?? true} onChange={(event) => setRule((prev) => ({ ...prev, enabled: event.target.checked }))} /> <span>Enabled</span></label>
        <label className="operator-checkbox"><input type="checkbox" checked={rule.allowNetworkWide ?? false} onChange={(event) => setRule((prev) => ({ ...prev, allowNetworkWide: event.target.checked }))} /> <span>Allow network-wide rule without explicit DID/handle targeting</span></label>
        <div className="operator-actions-row">
          <button className="operator-button operator-button-primary" onClick={() => {
            if (!selectedRadarId) return;
            void updateJetstreamRule(apiUrl, sessionId, selectedRadarId, rule)
              .then((nextRule) => {
                setRule(nextRule);
                setStatusMessage("Jetstream rule updated");
                return fetchJetstreamStatus(apiUrl).then(setJetstreamStatus);
              })
              .catch((err: unknown) => setStatusMessage(err instanceof Error ? err.message : "Jetstream update failed"));
          }}>Save rule</button>
          <button className="operator-button" onClick={() => {
            if (!selectedRadarId) return;
            void collectJetstream(apiUrl, sessionId, selectedRadarId)
              .then((result) => setStatusMessage(`Jetstream collect: ${result.collected} new / ${result.duplicates} duplicate`))
              .catch((err: unknown) => setStatusMessage(err instanceof Error ? err.message : "Jetstream collect failed"));
          }}>Collect now</button>
        </div>
        {jetstreamStatus && (
          <div className="operator-status-grid">
            <div className="operator-status-card"><span>Subscriber</span><strong>{jetstreamStatus.running ? "running" : "stopped"}</strong></div>
            <div className="operator-status-card"><span>Connection</span><strong>{jetstreamStatus.connected ? "connected" : "disconnected"}</strong></div>
            <div className="operator-status-card"><span>Rules</span><strong>{jetstreamStatus.ruleCount ?? 0}</strong></div>
            <div className="operator-status-card"><span>Endpoint</span><strong>{jetstreamStatus.jetstreamUrl ?? "n/a"}</strong></div>
          </div>
        )}
        {jetstreamStatus?.activeRules && jetstreamStatus.activeRules.length > 0 && (
          <div className="operator-rule-summary-list">
            {jetstreamStatus.activeRules.map((activeRule) => (
              <div key={activeRule.radarId} className="operator-rule-summary">
                <strong>{radarOptions.find((radar) => radar.id === activeRule.radarId)?.name ?? activeRule.radarId}</strong>
                <span>{activeRule.wantedDids} DIDs · {activeRule.keywords.length} keywords · {activeRule.windowSeconds}s window</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="operator-section">
        <h3>Draft + post</h3>
        <label><span>Title</span><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} placeholder="Threat clock update" /></label>
        <label><span>Text</span><textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} rows={6} maxLength={300} placeholder="Draft your post…" /></label>
        <div className="operator-actions-row">
          <button className="operator-button operator-button-primary" onClick={() => void saveDraft()}>Save draft</button>
          <button className="operator-button" onClick={() => void publishCurrentDraft()}>Post to Bluesky</button>
        </div>
        <div className="operator-draft-list">
          {drafts.map((draft) => (
            <button
              key={draft.id}
              className={`operator-draft-item ${draft.id === activeDraftId ? "operator-draft-item-active" : ""}`}
              onClick={() => {
                setActiveDraftId(draft.id);
                setDraftTitle(draft.title);
                setDraftText(draft.text);
              }}
            >
              <strong>{draft.title}</strong>
              <span>{draft.status} · {new Date(draft.updatedAt).toLocaleString()}</span>
            </button>
          ))}
          {drafts.length === 0 && <p className="operator-empty">No drafts yet.</p>}
        </div>
        {activeDraftId && (
          <button className="operator-button operator-button-danger" onClick={() => {
            const draftId = activeDraftId;
            void deleteDraft(apiUrl, sessionId, draftId)
              .then(async () => {
                setDrafts(await fetchDrafts(apiUrl, sessionId));
                setActiveDraftId(null);
                setDraftTitle("");
                setDraftText("");
              })
              .catch(() => {});
          }}>Delete selected draft</button>
        )}
      </section>

      <section className="operator-section">
        <h3>Semantic feed preview</h3>
        <label><span>Query</span><input value={semanticQuery} onChange={(event) => setSemanticQuery(event.target.value)} placeholder="emerging narratives" /></label>
        <button className="operator-button operator-button-primary" onClick={() => void runSemanticFeed()}>Rank threads</button>
        <div className="operator-feed-results">
          {semanticResults.map((result) => (
            <div key={`${result.title}-${result.similarity}`} className="operator-feed-item">
              <strong>{result.title}</strong>
              <span>{result.similarity.toFixed(2)}</span>
            </div>
          ))}
          {semanticResults.length === 0 && <p className="operator-empty">Run a query to build an embedding-based feed preview from current threads.</p>}
        </div>
      </section>

      <section className="operator-section">
        <h3>MCP servers + Proxx</h3>
        {workspace && (
          <>
            <div className="operator-server-list">
              {workspace.servers.map((server) => {
                const enabled = workspace.prefs.enabledServerIds.includes(server.id);
                return (
                  <label key={server.id} className="operator-server-item">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(event) => {
                        const enabledServerIds = event.target.checked
                          ? [...workspace.prefs.enabledServerIds, server.id]
                          : workspace.prefs.enabledServerIds.filter((candidate) => candidate !== server.id);
                        void updateWorkspaceConfig(apiUrl, sessionId, {
                          enabledServerIds,
                          proxxDocked: workspace.prefs.proxxDocked,
                        }).then((prefs) => setWorkspace({ ...workspace, prefs }));
                      }}
                    />
                    <div>
                      <strong>{server.label}</strong>
                      <p>{server.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
            <label className="operator-checkbox"><input type="checkbox" checked={showProxx} onChange={(event) => {
              setShowProxx(event.target.checked);
              void updateWorkspaceConfig(apiUrl, sessionId, {
                enabledServerIds: workspace.prefs.enabledServerIds,
                proxxDocked: event.target.checked,
              }).then((prefs) => setWorkspace({ ...workspace, prefs }));
            }} /> <span>Dock Proxx in panel</span></label>
            <a className="operator-button" href={workspace.proxxBaseUrl} target="_blank" rel="noreferrer">Open Proxx</a>
            {showProxx && (
              <iframe className="operator-proxx-frame" src={workspace.proxxBaseUrl} title="Proxx workbench" />
            )}
          </>
        )}
      </section>
    </aside>
  );
}
