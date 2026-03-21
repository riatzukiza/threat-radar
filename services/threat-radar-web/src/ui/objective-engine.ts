import type { BlueskyTimelinePost, RadarTile, SignalFeedItem } from "../api/types";

export interface StrategyLine {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly horizon: "now" | "next" | "later";
}

export interface NarrativeCandidate {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly relationToGoal: "helps" | "hinders" | "mixed";
  readonly supportCount: number;
  readonly sourceTypes: string[];
  readonly supportingItems: string[];
  readonly challenge: string;
}

export interface GeoHotspot {
  readonly id: string;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  readonly count: number;
  readonly examples: string[];
}

interface EvidenceDoc {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly sourceType: string;
  readonly tags: readonly string[];
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "their", "there", "about", "after", "before", "through", "while", "where", "which", "because", "would", "could", "should", "have", "has", "will", "just", "more", "than", "when", "what", "want", "need", "still", "also", "they", "them", "been", "into", "onto", "over", "under", "like", "basicly", "basically",
]);

const LOCATION_LEXICON: ReadonlyArray<{ label: string; lat: number; lon: number; aliases: readonly string[] }> = [
  { label: "Strait of Hormuz", lat: 26.57, lon: 56.25, aliases: ["strait of hormuz", "straight of hormuz", "hormuz"] },
  { label: "Persian Gulf", lat: 26.0, lon: 52.0, aliases: ["persian gulf", "gulf"] },
  { label: "Gulf of Oman", lat: 23.6, lon: 58.2, aliases: ["gulf of oman"] },
  { label: "Iran", lat: 32.0, lon: 53.0, aliases: ["iran", "iranian"] },
  { label: "Oman", lat: 21.5, lon: 55.9, aliases: ["oman", "omani"] },
  { label: "Saudi Arabia", lat: 24.0, lon: 45.0, aliases: ["saudi arabia", "saudi"] },
  { label: "United Arab Emirates", lat: 24.4, lon: 54.3, aliases: ["uae", "united arab emirates", "dubai", "abu dhabi"] },
  { label: "Israel", lat: 31.0, lon: 35.0, aliases: ["israel", "israeli"] },
  { label: "Gaza", lat: 31.45, lon: 34.39, aliases: ["gaza"] },
  { label: "Europe", lat: 50.0, lon: 10.0, aliases: ["europe", "european", "eu"] },
  { label: "China", lat: 35.0, lon: 104.0, aliases: ["china", "chinese"] },
  { label: "United States", lat: 39.8, lon: -98.6, aliases: ["united states", "u.s.", "usa", "washington"] },
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && !STOPWORDS.has(value));
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function docsFromInputs(signals: readonly SignalFeedItem[], posts: readonly BlueskyTimelinePost[]): EvidenceDoc[] {
  const signalDocs = signals.map((signal) => ({
    id: signal.id,
    title: signal.title ?? signal.text.slice(0, 80),
    body: `${signal.title ?? ""} ${signal.text}`.trim(),
    sourceType: signal.provenance.source_type,
    tags: signal.domain_tags,
  }));

  const postDocs = posts.map((post) => ({
    id: post.uri,
    title: post.author.displayName ?? post.author.handle ?? "Bluesky post",
    body: post.text,
    sourceType: "bluesky-home",
    tags: [],
  }));

  return [...signalDocs, ...postDocs];
}

function topTerms(text: string, count: number): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([term]) => term);
}

export function deriveStrategyLines(objective: string, longTermObjective: string, strategicNotes: string): StrategyLine[] {
  const full = `${objective} ${longTermObjective} ${strategicNotes}`.toLowerCase();
  const lines: StrategyLine[] = [];

  const push = (id: string, title: string, description: string, horizon: StrategyLine["horizon"]): void => {
    if (!lines.some((line) => line.id === id)) {
      lines.push({ id, title, description, horizon });
    }
  };

  if (full.includes("hormuz") || full.includes("shipping") || full.includes("strait")) {
    push("shipping-risk", "Reduce shipping risk", "Track navigation integrity, insurer sentiment, and attack tempo so commercial transit can resume safely.", "now");
    push("diplomatic-space", "Create diplomatic space", "Surface openings that lower immediate escalation pressure and widen the chance of reopening routes.", "next");
  }

  if (full.includes("energy") || full.includes("price") || full.includes("oil")) {
    push("price-pressure", "Lower acute price pressure", "Aggregate signals around transit flow, insurance, and buffer stress that directly drive energy price spikes.", "now");
    push("efficiency", "Increase efficiency before demand expands", "Look for narratives where extra supply only drives more demand, then surface demand-side interventions and efficiency levers.", "next");
    push("diversification", "Diversify away from oil dependency", "Track technologies, policies, and supply-chain bottlenecks that shape the long-term move away from fossil dependence.", "later");
  }

  if (full.includes("wake up call") || full.includes("divers") || full.includes("renewable") || full.includes("green")) {
    push("structural-shift", "Turn disruption into a structural shift", "Collect narratives that connect the immediate crisis to energy diversification, materials constraints, and resilience planning.", "later");
  }

  if (lines.length === 0) {
    push("sensemaking", "Clarify the objective", "Name the world-state you want, the world-state you fear, and the constraints you refuse to violate.", "now");
  }

  return lines;
}

function relationToGoal(docText: string, objective: string): NarrativeCandidate["relationToGoal"] {
  const text = docText.toLowerCase();
  const goal = objective.toLowerCase();
  const helps = (goal.includes("open") && /reopen|restore|de-escalat|transit|shipping|efficiency|diversif/.test(text))
    || (goal.includes("price") && /price|supply|buffer|efficiency|renewable|demand/.test(text));
  const hinders = /attack|closure|disrupt|interference|insurance stress|critical/.test(text);
  if (helps && hinders) return "mixed";
  if (helps) return "helps";
  if (hinders) return "hinders";
  return "mixed";
}

export function buildNarrativeCandidates(args: {
  objective: string;
  longTermObjective: string;
  strategicNotes: string;
  signals: readonly SignalFeedItem[];
  posts: readonly BlueskyTimelinePost[];
  tiles: readonly RadarTile[];
}): NarrativeCandidate[] {
  const docs = docsFromInputs(args.signals, args.posts);
  const objectiveText = `${args.objective} ${args.longTermObjective} ${args.strategicNotes}`.trim();
  const latestSubmissionReasons = args.tiles.flatMap((tile) => Object.values(tile.latestSubmission?.signal_scores ?? {}).map((score) => score.reason));
  const groups = new Map<string, EvidenceDoc[]>();

  for (const doc of docs) {
    const location = LOCATION_LEXICON.find((entry) => entry.aliases.some((alias) => doc.body.toLowerCase().includes(alias)))?.label;
    const term = topTerms(`${doc.title} ${doc.body} ${doc.tags.join(" ")}`, 1)[0] ?? doc.sourceType;
    const key = `${location ?? "Global"}:${term}`;
    const current = groups.get(key) ?? [];
    current.push(doc);
    groups.set(key, current);
  }

  const candidates = [...groups.entries()].map(([key, group]) => {
    const [location, term] = key.split(":");
    const body = group.map((doc) => doc.body).join(" ");
    const sources = unique(group.map((doc) => doc.sourceType));
    const relation = relationToGoal(body, objectiveText || latestSubmissionReasons.join(" "));
    const supportCount = group.length;
    const title = `${location}: ${term.replace(/-/g, " ")}`;
    const challenge = sources.length < 2
      ? "Challenge: this narrative is still thin and mostly single-channel."
      : latestSubmissionReasons[0]
        ? `Challenge: compare against the model's stated uncertainty — ${latestSubmissionReasons[0]}`
        : "Challenge: ask what evidence would falsify this narrative, not just support it.";

    return {
      id: key,
      title,
      summary: `Across ${supportCount} items from ${sources.length} source channels, this narrative clusters around ${location.toLowerCase()} and ${term.replace(/-/g, " ")}.`,
      relationToGoal: relation,
      supportCount,
      sourceTypes: sources,
      supportingItems: group.slice(0, 3).map((doc) => doc.title),
      challenge,
    } satisfies NarrativeCandidate;
  });

  return candidates
    .sort((a, b) => {
      const relationScore = (value: NarrativeCandidate["relationToGoal"]): number => value === "hinders" ? 3 : value === "mixed" ? 2 : 1;
      return (b.supportCount * 10 + relationScore(b.relationToGoal)) - (a.supportCount * 10 + relationScore(a.relationToGoal));
    })
    .slice(0, 6);
}

export function extractGeoHotspots(signals: readonly SignalFeedItem[], posts: readonly BlueskyTimelinePost[]): GeoHotspot[] {
  const hits = new Map<string, { spec: typeof LOCATION_LEXICON[number]; count: number; examples: string[] }>();
  const docs = docsFromInputs(signals, posts);

  for (const doc of docs) {
    const haystack = `${doc.title} ${doc.body}`.toLowerCase();
    for (const spec of LOCATION_LEXICON) {
      if (spec.aliases.some((alias) => haystack.includes(alias))) {
        const current = hits.get(spec.label) ?? { spec, count: 0, examples: [] };
        current.count += 1;
        if (current.examples.length < 3) {
          current.examples.push(doc.title);
        }
        hits.set(spec.label, current);
        break;
      }
    }
  }

  return [...hits.values()]
    .sort((a, b) => b.count - a.count || a.spec.label.localeCompare(b.spec.label))
    .map((entry) => ({
      id: entry.spec.label,
      label: entry.spec.label,
      lat: entry.spec.lat,
      lon: entry.spec.lon,
      count: entry.count,
      examples: entry.examples,
    }));
}
