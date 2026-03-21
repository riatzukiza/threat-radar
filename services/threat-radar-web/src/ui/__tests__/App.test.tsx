import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import type { OperatorAuthState } from "../hooks/useOperatorSession";
import type { OperatorSession } from "../../api/types";

const operatorState: OperatorAuthState = {
  session: null,
  sessionId: null,
  loading: true,
  error: null,
  login: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
};

const radarPollingState = {
  tiles: [],
  loading: false,
  error: null,
  isStale: false,
  lastUpdated: null,
  refetch: vi.fn(),
};

const personalizationState = {
  weights: {
    geopolitical: 50,
    infrastructure: 50,
    economic: 50,
    security: 50,
    climate: 50,
    technology: 50,
  },
  toggles: {
    criticalThinking: true,
    agencyBias: true,
    federation: true,
  },
  setWeight: vi.fn(),
  setToggle: vi.fn(),
  resetToDefaults: vi.fn(),
};

const embeddingState = {
  state: {
    ready: true,
    onnxReady: false,
    activeBackend: "trigram-cpu",
    diagnostics: null,
    error: null,
  },
  computeSimilarity: vi.fn(async () => []),
};

vi.mock("../../api/useRadarPolling", () => ({
  useRadarPolling: () => radarPollingState,
}));

vi.mock("../hooks/usePersonalization", () => ({
  usePersonalization: () => personalizationState,
  applyWeights: vi.fn(),
  computeCompositeScore: vi.fn(),
}));

vi.mock("../../embed/useEmbedding", () => ({
  useEmbedding: () => embeddingState,
}));

vi.mock("../hooks/useOperatorSession", () => ({
  useOperatorSession: () => operatorState,
}));

vi.mock("../components/OperatorDock", () => ({
  OperatorDock: () => <div data-testid="operator-dock">operator dock</div>,
}));

vi.mock("../components/OperatorLoginGate", () => ({
  OperatorLoginGate: () => <div data-testid="operator-login-gate">operator login</div>,
}));

vi.mock("../components/PersonalizationPanel", () => ({
  PersonalizationPanel: () => <div data-testid="personalization-panel">personalization</div>,
}));

vi.mock("../components/FirehosePanel", () => ({
  FirehosePanel: () => <div data-testid="firehose-panel">firehose</div>,
}));

vi.mock("../components/HeroPanel", () => ({
  HeroPanel: () => <div data-testid="hero-panel">hero</div>,
}));

vi.mock("../components/MissionBriefingPanel", () => ({
  MissionBriefingPanel: () => <div data-testid="mission-briefing-panel">briefing</div>,
}));

vi.mock("../components/LoadingSkeleton", () => ({
  LoadingSkeleton: () => <div data-testid="loading-skeleton">loading</div>,
}));

vi.mock("../components/EtaLane", () => ({
  EtaLaneContent: () => <div data-testid="eta-lane">eta</div>,
}));

vi.mock("../components/MuLane", () => ({
  MuLaneContent: () => <div data-testid="mu-lane">mu</div>,
}));

vi.mock("../components/PiLaneConnections", () => ({
  PiLaneConnections: () => <div data-testid="pi-lane">pi</div>,
}));

vi.mock("../components/CriticalThinkingSection", () => ({
  CriticalThinkingSection: () => <div data-testid="critical-thinking">critical</div>,
}));

vi.mock("../components/ActionFeed", () => ({
  ActionFeed: () => <div data-testid="action-feed">actions</div>,
}));

afterEach(() => {
  operatorState.session = null;
  operatorState.sessionId = null;
  operatorState.loading = true;
  operatorState.error = null;
  radarPollingState.tiles = [];
  radarPollingState.loading = false;
  radarPollingState.error = null;
  radarPollingState.isStale = false;
  radarPollingState.lastUpdated = null;
  vi.clearAllMocks();
});

describe("App", () => {
  it("keeps hook ordering stable when operator auth resolves", () => {
    const { rerender } = render(<App />);

    expect(screen.getByText("Checking operator session…")).toBeInTheDocument();

    const session: OperatorSession = {
      id: "sess-1",
      did: "did:plc:test",
      handle: "operator.bsky.social",
      serviceUrl: "https://bsky.social",
    };

    operatorState.loading = false;
    operatorState.session = session;
    operatorState.sessionId = session.id;

    expect(() => rerender(<App />)).not.toThrow();
    expect(screen.getByTestId("operator-dock")).toBeInTheDocument();
    expect(screen.getByTestId("personalization-panel")).toBeInTheDocument();
  });
});
