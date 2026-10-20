import { z } from "zod";

export const MAX_MESSAGE = 8000;
export const MAX_CONTEXT = 20000;
export const MAX_TURNS = 20;
export const MODEL = "openai/gpt-oss-20b";

const short = z.string().max(1200);
const evidenceSchema = z.object({
  sourceId: z.string().max(30),
  quote: z.string().min(1).max(1800),
}).strict();

export const measurementSchema = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(["systolic_bp", "diastolic_bp", "other"]),
  value: z.number(),
  unit: z.string().max(60).nullable().describe("Explicitly supplied unit; null if missing. Never convert units."),
  referenceRange: z.string().max(180).nullable().describe("Verbatim supplied lab range, otherwise null"),
  timing: z.string().max(180).nullable().describe("Supplied date, fasting or measurement context, otherwise null"),
  evidence: evidenceSchema,
}).strict();

export const factSchema = z.object({
  category: z.enum(["age", "sex", "pregnancy", "symptoms", "conditions", "medications", "allergies", "food_preferences", "activity", "other_health"]),
  detail: short,
  evidence: z.array(evidenceSchema).min(1).max(4),
}).strict();

export const intakeSchema = z.object({
  scope: z.enum(["health", "unrelated", "mixed"]),
  route: z.enum(["clarify", "ready"]),
  reply: short.describe("A friendly response, concise follow-up question, or acknowledgment; no diagnosis"),
  pendingQuestion: short.nullable(),
  conflicts: z.array(short).max(8),
  measurements: z.array(measurementSchema).max(50),
  facts: z.array(factSchema).max(50),
  clarificationNeeded: z.array(short).max(8),
}).strict();

export const summarySchema = z.object({
  urgentReview: z.boolean(),
  emergencyNow: z.boolean(),
  urgentReason: short.describe("Empty string unless urgent medical review is needed"),
  specialistDietNeeded: z.boolean(),
  dietReason: short.describe("Empty string unless individualized clinician/dietitian review is needed"),
  overview: z.string().min(40).max(1200).describe("A meaningful review, not a list of extracted fields"),
  findings: z.array(z.object({ title: z.string().max(120), explanation: z.string().min(20).max(1200) }).strict()).min(1).max(8),
  missingContext: z.array(short).max(5),
  nextSteps: z.array(short).max(5),
  followUpQuestions: z.array(short).max(3),
}).strict();

export const dietSchema = z.object({
  kind: z.enum(["sample_day", "general", "clinician_review"]),
  note: short,
  meals: z.array(z.object({
    meal: z.string().max(60),
    foods: short,
    reason: z.string().max(500),
  }).strict()).max(5),
  habits: z.array(short).max(5),
  questions: z.array(short).max(3),
}).strict();

export const questionsSchema = z.object({
  questions: z.array(z.string().min(8).max(220)).min(1).max(3),
}).strict();

export const sourceSchema = z.object({ id: z.string().max(30), text: z.string().max(MAX_MESSAGE) }).strict();

export const stateSchema = z.object({
  version: z.literal(2),
  sessionId: z.string().uuid(),
  expiresAt: z.number().int(),
  revision: z.number().int().nonnegative(),
  phase: z.enum(["waiting", "intake", "summary", "questions", "complete", "urgent"]),
  sources: z.array(sourceSchema).max(MAX_TURNS),
  intake: intakeSchema.nullable(),
  summary: summarySchema.nullable(),
  diet: dietSchema.nullable(),
  alerts: z.array(short).max(5),
  emergencyNow: z.boolean(),
}).strict();

export const requestSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("intake"), message: z.string().trim().min(1).max(MAX_MESSAGE), checkpoint: z.string().max(220000).nullable() }).strict(),
  z.object({ stage: z.literal("summary"), checkpoint: z.string().min(1).max(220000) }).strict(),
  z.object({ stage: z.literal("diet"), checkpoint: z.string().min(1).max(220000) }).strict(),
  z.object({ stage: z.literal("questions"), checkpoint: z.string().min(1).max(220000) }).strict(),
]);

export type Measurement = z.infer<typeof measurementSchema>;
export type HealthFact = z.infer<typeof factSchema>;
export type Intake = z.infer<typeof intakeSchema>;
export type HealthSummary = z.infer<typeof summarySchema>;
export type DietPlan = z.infer<typeof dietSchema>;
export type FollowUpQuestions = z.infer<typeof questionsSchema>;
export type HealthState = z.infer<typeof stateSchema>;
export type HealthRequest = z.infer<typeof requestSchema>;
export type Stage = HealthRequest["stage"];
export type Source = z.infer<typeof sourceSchema>;

export type HealthResponse = {
  checkpoint: string;
  revision: number;
  phase: HealthState["phase"];
  nextStage: "summary" | "diet" | "questions" | null;
  message: string;
  intake: Intake | null;
  summary: HealthSummary | null;
  diet: DietPlan | null;
  alerts: string[];
  emergencyNow: boolean;
};

export type ApiErrorBody = { error: { code: string; message: string; retryAfter?: number } };
