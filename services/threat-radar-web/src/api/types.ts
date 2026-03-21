/**
 * Shared types for the threat-radar-web API layer.
 * Mirrors the shape returned by GET /api/radars from threat-radar-mcp.
 */

export type SignalData = {
  median: number;
  range: [number, number];
  agreement: number;
  sample_size: number;
};

export type BranchData = {
  name: string;
  support: string;
  agreement: number;
  triggers: string[];
};

/** Score range from the deterministic reducer (per dimension) */
export type ScoreRangeData = {
  dimension: string;
  min: number;
  max: number;
  median: number;
};

/** Narrative branch from the deterministic reducer */
export type NarrativeBranchData = {
  label: string;
  probability: number;
  evidence: string[];
  realism: number;
  fear: number;
  public_benefit: number;
  actionability: number;
  polarization_risk: number;
  compression_loss: number;
};

/** Output of the deterministic thread-based reducer stored in render_state */
export type DeterministicSnapshotData = {
  scoreRanges: ScoreRangeData[];
  disagreementIndex: number;
  narrativeBranches: NarrativeBranchData[];
  compressionLoss: number;
};

/** Thread member reference */
export type ThreadMemberData = {
  signal_event_id: string;
  relevance: number;
  added_at: string;
};

/** Thread object from the API */
export type ThreadData = {
  id: string;
  radar_id?: string;
  kind: "event" | "narrative" | "local_opportunity";
  title: string;
  summary?: string;
  members: ThreadMemberData[];
  source_distribution: Record<string, number>;
  confidence: number;
  timeline: {
    first_seen: string;
    last_updated: string;
    peak_activity?: string;
  };
  domain_tags: string[];
  status: "emerging" | "active" | "cooling" | "archived";
};

export type SubmissionSourceData = {
  type: "official" | "news" | "social" | "analyst" | "ais" | "other";
  name: string;
  url?: string;
  confidence: number;
  retrieved_at?: string;
  notes?: string;
};

export type SubmissionSignalScoreData = {
  value: number;
  range: [number, number];
  confidence: number;
  reason: string;
  supporting_sources: string[];
};

export type SubmissionBranchAssessmentData = {
  branch: string;
  likelihood_band: "very_low" | "low" | "moderate" | "high" | "very_high";
  confidence: number;
  reason: string;
  key_triggers: string[];
  disconfirming_signals: string[];
};

export type SubmissionUncertaintyData = {
  category: "measurement" | "model" | "temporal" | "coverage" | "other";
  description: string;
  impact: "low" | "moderate" | "high";
  mitigation?: string;
};

export type LatestSubmissionData = {
  timestamp_utc: string;
  model_id: string;
  model_version?: string;
  sourceCount: number;
  sources: SubmissionSourceData[];
  signal_scores: Record<string, SubmissionSignalScoreData>;
  branch_assessment: SubmissionBranchAssessmentData[];
  uncertainties: SubmissionUncertaintyData[];
  calibration_notes?: string;
};

export type SignalFeedItem = {
  id: string;
  radar_id?: string;
  provenance: {
    source_type: "bluesky" | "reddit" | "rss" | "api" | "manual" | "ais";
    author?: string;
    account_uri?: string;
    post_uri?: string;
    parent_uri?: string;
    confidence_class: "firsthand" | "commentary" | "rumor" | "synthesis" | "unknown";
    retrieved_at: string;
  };
  text: string;
  title?: string;
  links: string[];
  domain_tags: string[];
  observed_at: string;
  ingested_at: string;
  metadata: Record<string, unknown>;
  normalized_content?: string;
  category?: string;
  quality_score?: number;
};

export type RadarTile = {
  radar: {
    id: string;
    slug: string;
    name: string;
    category: string;
    status: string;
  };
  sourceCount: number;
  submissionCount: number;
  liveSnapshot?: {
    as_of_utc: string;
    disagreement_index: number;
    quality_score: number;
    signals: Record<string, SignalData>;
    branches: BranchData[];
    model_count: number;
    render_state?: {
      deterministicSnapshot?: DeterministicSnapshotData;
    };
  };
  latestDailySnapshot?: { as_of_utc: string };
  latestSubmission?: LatestSubmissionData;
  threads?: ThreadData[];
  signalCount?: number;
};

export type OperatorSession = {
  id: string;
  did: string;
  handle: string;
  serviceUrl: string;
};

export type BlueskyTimelinePost = {
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

export type OperatorDraft = {
  id: string;
  did: string;
  title: string;
  text: string;
  status: "draft" | "published";
  createdAt: string;
  updatedAt: string;
  lastPublishedUri?: string;
};

export type McpServerInfo = {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  kind: string;
};

export type WorkspacePrefs = {
  did: string;
  enabledServerIds: string[];
  proxxDocked: boolean;
  objective: string;
  longTermObjective: string;
  strategicNotes: string;
  challengeMode: boolean;
  updatedAt: string;
};

export type WorkspaceConfig = {
  proxxBaseUrl: string;
  servers: McpServerInfo[];
  prefs: WorkspacePrefs;
};

export type JetstreamRule = {
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
};

export type JetstreamStatus = {
  enabled?: boolean;
  running?: boolean;
  connected?: boolean;
  jetstreamUrl?: string;
  ruleCount?: number;
  activeRules?: Array<{
    radarId: string;
    wantedDids: number;
    hashtags: string[];
    keywords: string[];
    windowSeconds: number;
  }>;
  cursor?: string | null;
};
