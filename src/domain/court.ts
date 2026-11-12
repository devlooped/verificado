export const COUNSEL = ["grok", "gemini", "claude", "chatgpt"] as const;
export type Counsel = (typeof COUNSEL)[number];

export const MODEL_NAME: Record<Counsel, string> = {
  grok: "Grok",
  gemini: "Gemini",
  claude: "Claude",
  chatgpt: "ChatGPT",
};

export const COUNSEL_NAMES = new Intl.ListFormat("es-AR", { style: "long", type: "conjunction" }).format(COUNSEL.map((c) => MODEL_NAME[c]));

export type Seat = "judge" | Counsel;

// A model as configured for a role: its AI Gateway id and the effort set for it, if any.
export interface ModelUse {
  id: string;
  effort: string | null;
}

// The models configured when a case opened, keyed by role (judge, counsel.grok, translator...).
export type ModelSnapshot = Record<string, ModelUse>;

export type SeatModels = Partial<Record<Seat, ModelUse>>;

const PROVIDER_MARK: Record<string, Counsel> = { spacexai: "grok", xai: "grok", google: "gemini", anthropic: "claude", openai: "chatgpt" };

// The family whose mark and name a model takes, from its Gateway provider.
export function modelMark(id: string): Counsel | undefined {
  return id.includes("/") ? PROVIDER_MARK[id.split("/", 1)[0]!.toLowerCase()] : undefined;
}

export function modelName(id: string): string {
  const mark = modelMark(id);
  return mark ? MODEL_NAME[mark] : id.split("/", 1)[0]!;
}

// "gpt-6.1-sol high": the model without its provider, then the effort when one was configured.
export function modelDetail(model: ModelUse): string {
  const name = model.id.slice(model.id.indexOf("/") + 1);
  return model.effort ? name + " " + model.effort : name;
}

// Who sat where. The snapshot of the case wins; cases recorded before it existed fall back to the opening event.
export function seatModels(record: { models?: ModelSnapshot }, events: readonly CourtEvent[] = []): SeatModels {
  const seats: SeatModels = {};
  const session = events.find((e) => e.type === "session_opened");
  if (session) {
    seats.judge = { id: session.judgeModel, effort: session.judgeEffort ?? null };
    for (const c of COUNSEL) if (session.counselModels[c]) seats[c] = { id: session.counselModels[c], effort: session.counselEfforts?.[c] ?? null };
  }
  if (record.models?.judge) seats.judge = record.models.judge;
  for (const c of COUNSEL) {
    const model = record.models?.["counsel." + c];
    if (model) seats[c] = model;
  }
  return seats;
}

// Keep the historical identifier for Insostenible so stored cases remain readable.
export const VERDICTS = ["verdadero", "falso", "no_verificable", "enganoso"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const STAGES = ["opening", "rebuttal", "closing"] as const;
export type Stage = (typeof STAGES)[number];

export type CaseStatus = "queued" | "in_session" | "resolved" | "failed";

export type CaseLanguageChoice = "auto" | "es" | "en";

// Quick: each analyst answers and votes on the whole content, with its own
// search. Expert: the whole court (claims, instruction, debate); disabled for
// new cases, kept so that the cases recorded with it still read.
export const CHECK_TYPES = ["quick", "expert"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export type Submission = (
  | { kind: "text"; text: string }
  | { kind: "link"; url: string; note?: string }
  | { kind: "image"; mimeType: string; note?: string }
) & { language?: CaseLanguageChoice; resolvedLanguage?: string; check?: CheckType; identifyClaims?: boolean };

// Absent on cases recorded before check types existed: they were Expert.
export function checkType(s: Submission): CheckType {
  return s.check ?? "expert";
}

// What the moderator finds in the material of a Quick check, before any
// research: claims to check and rate, or questions for the panel to answer,
// without any rating. Cases recorded before the classification are claims.
export const CONTENT_KINDS = ["claims", "questions"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export interface SubmissionContext {
  title: string;
  finalUrl?: string;
  tool: string;
  excerpt: string;
}

// Extraction tool of an uploaded image described by a vision model, followed by the model id.
export const IMAGE_DESCRIPTION_TOOL = "vision:";

// Seats read this description instead of receiving the image itself.
export function imageDescribed(submission: Submission, context?: SubmissionContext): boolean {
  return submission.kind === "image" && Boolean(context?.excerpt) && Boolean(context?.tool.startsWith(IMAGE_DESCRIPTION_TOOL));
}

export interface Claim {
  id: string;
  quote: string;
  text: string;
}

export interface Evidence {
  id: string;
  by: Counsel;
  claimId: string;
  title: string;
  url: string;
  excerpt: string;
  // Optional only for records created before the instruction stage existed.
  stance?: "supports" | "opposes" | "context";
  // The filed text remains available when the displayed text was translated.
  translation?: { language: string; original: { title: string; excerpt: string } };
  sourceId?: string;
  blockIds?: string[];
  commentary?: string;
}

// Pipeline 3: an analyst proposes a source by URL and verbatim quote; the host
// fetches the URL and files it as evidence only if the quote is found there.
export interface EvidenceProposal {
  claimId: string;
  url: string;
  quote: string;
  stance: "supports" | "opposes" | "context";
  commentary?: string;
}

export interface InstructionSearch {
  claimId: string;
  supporting: string;
  opposing: string;
}

export interface UnifiedSource {
  id: string;
  title: string;
  url: string;
  contributions: Evidence[];
  sourceId?: string;
}

export interface SourceView extends UnifiedSource {
  votes: Partial<Record<Counsel, { veto: boolean; reason: string }>>;
  excluded?: boolean;
}

export type CourtEvent =
  | { type: "session_opened"; judgeModel: string; counselModels: Record<Counsel, string>; judgeEffort?: string | null; counselEfforts?: Record<Counsel, string | null>; simulated?: boolean }
  | { type: "claims_entered"; claims: Claim[] }
  | { type: "content_classified"; kind: ContentKind }
  | { type: "dismissed"; reason: string }
  | { type: "instruction_opened" }
  | { type: "evidence_filed"; evidence: Evidence }
  | { type: "evidence_proposed"; by: Counsel; proposal: EvidenceProposal }
  | { type: "instruction_completed"; by: Counsel; searches: InstructionSearch[] }
  | { type: "source_collection_started"; total: number; batches: number }
  | { type: "source_batch_started"; batch: number; batches: number; urls: string[] }
  | { type: "source_batch_completed"; batch: number; batches: number; count: number; completed: number; total: number; failed: number; sources?: { url: string; failed: boolean }[] }
  | { type: "evidence_unified"; sources: UnifiedSource[] }
  | { type: "source_review_vote"; by: Counsel; sourceId: string; veto: boolean; reason: string }
  | { type: "source_decided"; sourceId: string; excluded: boolean }
  | { type: "evidence_settled"; schemaVersion: 2; manifestHash: string }
  | { type: "instruction_closed" }
  | { type: "floor_granted"; to: Counsel; stage: Stage }
  | { type: "statement"; id: string; by: Counsel; stage: Stage; text: string; evidenceIds: string[]; evidenceRunId?: string; modelId?: string; effort?: string | null }
  // Quick check: an analyst's whole answer, and the URLs its provider cited.
  | { type: "quick_response"; by: Counsel; text: string; sources: QuickSource[]; modelId?: string; effort?: string | null }
  | { type: "objection"; id: string; by: Counsel; against: string; grounds: string }
  | { type: "objection_reply"; objectionId: string; by: Counsel; text: string }
  | { type: "ruling"; objectionId: string; sustained: boolean; reason: string }
  | { type: "vote"; by: Counsel; claimId: string; verdict: Verdict; rationale: string }
  | { type: "judgment"; claimId: string; verdict: Verdict; method: "consensus" | "judge"; reasoning: string }
  | { type: "content_vote"; by: Counsel; verdict: Verdict | null; rationale: string }
  | { type: "content_judgment"; verdict: Verdict; method: "consensus" | "judge"; reasoning: string }
  | { type: "case_summary"; text: string }
  // Questions: the moderator's synthesis of the answers, of the majority's
  // opinion when at least three analysts agree, else of each position.
  | { type: "answer_synthesis"; text: string; majority: boolean }
  | { type: "absence"; by: Counsel; stage: Stage | "discovery" | "instruction" | "source_review" | "objection" | "content" | "answer" }
  | { type: "session_closed" };

export interface QuickSource {
  url: string;
  title?: string;
}

export type RecordedEvent = CourtEvent & { seq: number; at: string };

export type CaseRecord = {
  id: string;
  createdAt: string;
  status: CaseStatus;
  submission: Submission;
  ownerId?: string;
  error?: string;
  // Absent until the session opens, and on cases recorded before snapshots existed.
  models?: ModelSnapshot;
  pipelineVersion?: PipelineVersion;
};

// 1: legacy instruction. 2: shared instruction with a host tool loop. 3: shared
// instruction with native provider research and host collection. 4 adds
// durable collection progress; 5 adds batch URLs without changing older replays.
export type PipelineVersion = 1 | 2 | 3 | 4 | 5;
export const LATEST_PIPELINE_VERSION: PipelineVersion = 5;

// Pipelines 2–5 share the durable instruction model (phase sessions,
// sandboxes, settled corpus); they differ only in how sources are researched.
export function sharedPipeline(version: number | null | undefined): version is 2 | 3 | 4 | 5 {
  return version === 2 || version === 3 || version === 4 || version === 5;
}

export function majority(verdicts: Verdict[]): Verdict | undefined {
  return VERDICTS.find((v) => verdicts.filter((x) => x === v).length >= 3);
}

export interface ClaimView extends Claim {
  votes: Partial<Record<Counsel, { verdict: Verdict; rationale: string }>>;
  judgment?: { verdict: Verdict; method: "consensus" | "judge"; reasoning: string };
}

export interface CaseView {
  claims: ClaimView[];
  contentVotes: Partial<Record<Counsel, { verdict: Verdict | null; rationale: string }>>;
  contentVotingRecorded: boolean;
  contentJudgment?: { verdict: Verdict; method: "consensus" | "judge"; reasoning: string };
  // Quick check: each analyst's answer.
  responses: Partial<Record<Counsel, { text: string; sources: QuickSource[] }>>;
  // Absent on cases recorded before the classification: they are claims.
  contentKind?: ContentKind;
  synthesis?: { text: string; majority: boolean };
  evidence: Map<string, Evidence>;
  sources: Map<string, SourceView>;
  struck: Set<string>;
  dismissal?: string;
  summary?: string;
  closed: boolean;
}

export function project(events: readonly CourtEvent[]): CaseView {
  const view: CaseView = { claims: [], contentVotes: {}, contentVotingRecorded: false, responses: {}, evidence: new Map(), sources: new Map(), struck: new Set(), closed: false };
  const objectionTarget = new Map<string, string>();
  const claim = (id: string) => view.claims.find((c) => c.id === id);
  for (const e of events) {
    switch (e.type) {
      case "claims_entered":
        view.claims = e.claims.map((c) => ({ ...c, votes: {} }));
        break;
      case "content_classified":
        view.contentKind = e.kind;
        break;
      case "answer_synthesis":
        view.synthesis = { text: e.text, majority: e.majority };
        break;
      case "dismissed":
        view.dismissal = e.reason;
        break;
      case "evidence_filed":
        view.evidence.set(e.evidence.id, e.evidence);
        break;
      case "evidence_unified":
        view.sources = new Map(e.sources.map((source) => [source.id, { ...source, votes: {} }]));
        break;
      case "source_review_vote": {
        const source = view.sources.get(e.sourceId);
        if (source) source.votes[e.by] = { veto: e.veto, reason: e.reason };
        break;
      }
      case "source_decided": {
        const source = view.sources.get(e.sourceId);
        if (source) source.excluded = e.excluded;
        break;
      }
      case "objection":
        objectionTarget.set(e.id, e.against);
        break;
      case "ruling":
        if (e.sustained) view.struck.add(objectionTarget.get(e.objectionId)!);
        break;
      case "vote": {
        const c = claim(e.claimId);
        if (c) c.votes[e.by] = { verdict: e.verdict, rationale: e.rationale };
        break;
      }
      case "judgment": {
        const c = claim(e.claimId);
        if (c) c.judgment = { verdict: e.verdict, method: e.method, reasoning: e.reasoning };
        break;
      }
      case "quick_response":
        view.responses[e.by] = { text: e.text, sources: e.sources };
        break;
      case "content_vote":
        view.contentVotingRecorded = true;
        view.contentVotes[e.by] = { verdict: e.verdict, rationale: e.rationale };
        break;
      case "content_judgment":
        view.contentVotingRecorded = true;
        view.contentJudgment = { verdict: e.verdict, method: e.method, reasoning: e.reasoning };
        break;
      case "absence":
        if (e.stage === "content") view.contentVotingRecorded = true;
        break;
      case "case_summary":
        view.summary = e.text;
        break;
      case "session_closed":
        view.closed = true;
        break;
    }
  }
  return view;
}
