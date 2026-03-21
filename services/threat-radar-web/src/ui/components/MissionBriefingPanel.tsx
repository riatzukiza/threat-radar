import { useEffect, useMemo, useState } from "react";

import { fetchBlueskyTimeline, fetchSignalFeed, fetchWorkspaceConfig } from "../../api/client";
import type { BlueskyTimelinePost, OperatorSession, RadarTile, SignalFeedItem, WorkspaceConfig } from "../../api/types";
import { buildNarrativeCandidates, deriveStrategyLines, extractGeoHotspots } from "../objective-engine";

export interface MissionBriefingPanelProps {
  readonly apiUrl: string;
  readonly session: OperatorSession;
  readonly sessionId: string;
  readonly tiles: readonly RadarTile[];
}

function worldX(lon: number, width: number): number {
  return ((lon + 180) / 360) * width;
}

function worldY(lat: number, height: number): number {
  return ((90 - lat) / 180) * height;
}

export function MissionBriefingPanel({ apiUrl, session, sessionId, tiles }: MissionBriefingPanelProps): JSX.Element {
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [signals, setSignals] = useState<SignalFeedItem[]>([]);
  const [posts, setPosts] = useState<BlueskyTimelinePost[]>([]);

  useEffect(() => {
    void fetchWorkspaceConfig(apiUrl, sessionId).then(setWorkspace).catch(() => {});
    void fetchSignalFeed(apiUrl, undefined, 120).then(setSignals).catch(() => {});
    void fetchBlueskyTimeline(apiUrl, sessionId, 30).then(setPosts).catch(() => {});
  }, [apiUrl, sessionId]);

  const objective = workspace?.prefs.objective ?? "";
  const longTermObjective = workspace?.prefs.longTermObjective ?? "";
  const strategicNotes = workspace?.prefs.strategicNotes ?? "";

  const strategyLines = useMemo(
    () => deriveStrategyLines(objective, longTermObjective, strategicNotes),
    [objective, longTermObjective, strategicNotes],
  );

  const narratives = useMemo(
    () => buildNarrativeCandidates({ objective, longTermObjective, strategicNotes, signals, posts, tiles }),
    [objective, longTermObjective, strategicNotes, signals, posts, tiles],
  );

  const hotspots = useMemo(() => extractGeoHotspots(signals, posts), [signals, posts]);

  const mapWidth = 520;
  const mapHeight = 240;

  return (
    <section className="mission-briefing-panel" data-testid="mission-briefing-panel">
      <div className="mission-briefing-header">
        <div>
          <div className="mission-briefing-eyebrow">World interface</div>
          <h2>Objective-driven narrative layer</h2>
        </div>
        <div className="mission-briefing-meta">
          <span>{signals.length} raw signals</span>
          <span>{posts.length} Bluesky posts</span>
          <span>{tiles.length} active radars</span>
        </div>
      </div>

      <div className="mission-briefing-grid">
        <section className="mission-card mission-card-objective">
          <h3>Objective stack</h3>
          {objective ? (
            <>
              <div className="mission-objective-block">
                <span>Immediate objective</span>
                <strong>{objective}</strong>
              </div>
              {longTermObjective && (
                <div className="mission-objective-block">
                  <span>Long-term direction</span>
                  <strong>{longTermObjective}</strong>
                </div>
              )}
              {strategicNotes && (
                <div className="mission-objective-notes">
                  <span>Strategic notes</span>
                  <p>{strategicNotes}</p>
                </div>
              )}
            </>
          ) : (
            <p className="mission-empty">Set an objective in the operator panel to make the interface reason backward from the change you want to see.</p>
          )}

          <div className="mission-strategy-lines">
            {strategyLines.map((line) => (
              <article key={line.id} className="mission-strategy-line">
                <span className={`mission-horizon mission-horizon-${line.horizon}`}>{line.horizon}</span>
                <strong>{line.title}</strong>
                <p>{line.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mission-card mission-card-map">
          <div className="mission-card-header">
            <h3>World map</h3>
            <span>Heuristic geolocation from signals/posts</span>
          </div>
          <svg viewBox={`0 0 ${mapWidth} ${mapHeight}`} className="mission-world-map" role="img" aria-label="World signal map">
            <rect x="0" y="0" width={mapWidth} height={mapHeight} rx="18" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.05)" />
            {[0.25, 0.5, 0.75].map((ratio) => (
              <line key={`lat-${ratio}`} x1="0" x2={mapWidth} y1={mapHeight * ratio} y2={mapHeight * ratio} stroke="rgba(255,255,255,0.05)" strokeDasharray="4 8" />
            ))}
            {[0.2, 0.4, 0.6, 0.8].map((ratio) => (
              <line key={`lon-${ratio}`} y1="0" y2={mapHeight} x1={mapWidth * ratio} x2={mapWidth * ratio} stroke="rgba(255,255,255,0.04)" strokeDasharray="4 8" />
            ))}
            {hotspots.slice(0, 8).map((spot) => {
              const x = worldX(spot.lon, mapWidth);
              const y = worldY(spot.lat, mapHeight);
              const radius = Math.min(18, 5 + spot.count * 2);
              return (
                <g key={spot.id}>
                  <circle cx={x} cy={y} r={radius} fill="rgba(34,211,238,0.16)" />
                  <circle cx={x} cy={y} r={3.5} fill="var(--cyan)" />
                  <text x={x + 8} y={y - 8} fill="var(--ink)" fontSize="10">{spot.label}</text>
                </g>
              );
            })}
          </svg>
          <div className="mission-hotspot-list">
            {hotspots.slice(0, 5).map((spot) => (
              <div key={spot.id} className="mission-hotspot-item">
                <strong>{spot.label}</strong>
                <span>{spot.count} mentions</span>
                <p>{spot.examples[0] ?? ""}</p>
              </div>
            ))}
            {hotspots.length === 0 && <p className="mission-empty">No geolocated clusters yet.</p>}
          </div>
        </section>
      </div>

      <section className="mission-card mission-card-narratives">
        <div className="mission-card-header">
          <h3>Narrative candidates</h3>
          <span>Compression without collapsing complexity</span>
        </div>
        <div className="mission-narrative-list">
          {narratives.map((narrative) => (
            <article key={narrative.id} className="mission-narrative-card">
              <div className="mission-narrative-head">
                <strong>{narrative.title}</strong>
                <span className={`mission-relation mission-relation-${narrative.relationToGoal}`}>{narrative.relationToGoal}</span>
              </div>
              <p>{narrative.summary}</p>
              <div className="mission-narrative-meta">
                <span>{narrative.supportCount} supporting items</span>
                <span>{narrative.sourceTypes.join(", ")}</span>
              </div>
              <div className="mission-narrative-support">
                {narrative.supportingItems.map((item) => (
                  <span key={`${narrative.id}-${item}`} className="mission-support-chip">{item}</span>
                ))}
              </div>
              <div className="mission-challenge-box">
                <span>Challenge</span>
                <p>{narrative.challenge}</p>
              </div>
            </article>
          ))}
          {narratives.length === 0 && <p className="mission-empty">No narrative candidates yet. Add an objective and let the feed accumulate.</p>}
        </div>
      </section>
    </section>
  );
}
