export {
  CODING_GENERAL,
  SCENARIOS,
  SCORING_RULE,
  SCORING_RULE_VERSION,
  UNMEASURED_PRIORITIES,
  assertScenarioIsSatisfiable,
  scenario,
} from "./scenarios.js";

export type {
  ScenarioPriority,
  ScenarioProfile,
  ScenarioRequirement,
} from "./scenarios.js";

export { recommend } from "./recommend.js";

export type {
  RecommendOptions,
  RecommendationCandidate,
  RecommendationCandidateResult,
  RecommendationConstraints,
  RecommendationPricing,
  RecommendationResult,
  ScoredDimension,
} from "./recommend.js";

export {
  RECOMMENDATION_SCHEMA_VERSION,
  assertRecommendation,
  recommendationRecord,
  validateRecommendation,
  RecommendationError,
} from "./record.js";

export type {
  RecommendationRecord,
  RecommendationRecordCandidate,
  RecommendationValidationIssue,
  RecommendationValidationResult,
} from "./record.js";
