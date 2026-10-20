import type { z } from "zod";
import { dietSchema, intakeSchema, questionsSchema, summarySchema, MAX_CONTEXT, MAX_TURNS, type HealthRequest, type HealthResponse, type HealthState, type Stage } from "../schemas";
import { EMERGENCY_MESSAGE, immediateEmergency } from "../emergency";
import { newState, readCheckpoint, signCheckpoint } from "./checkpoint";
import { bloodPressureAlerts, compactHealth, unsupportedReviewUnits, verifyEvidence } from "./evidence";
import { WorkflowError } from "./errors";
import { mergeIntake } from "./merge";
import { DIET_SYSTEM, INTAKE_SYSTEM, QUESTIONS_SYSTEM, SUMMARY_SYSTEM } from "./prompts";

export type ModelRunner = <T>(stage: Stage, system: string, input: unknown, schema: z.ZodType<T>) => Promise<T>;
export type WorkflowDependencies = { secret: string; runModel: ModelRunner; now?: number };

export async function runStage(request: HealthRequest, dependencies: WorkflowDependencies): Promise<HealthResponse> {
  const { secret, runModel } = dependencies;
  const now = dependencies.now ?? Date.now();
  const state: HealthState = request.checkpoint ? readCheckpoint(request.checkpoint, secret, now) : newState(now);

  function response(message: string, nextStage: HealthResponse["nextStage"] = null): HealthResponse {
    return {
      checkpoint: signCheckpoint(state, secret, now), revision: state.revision,
      phase: state.phase, nextStage, message,
      intake: state.intake, summary: state.summary, diet: state.diet, alerts: state.alerts,
      emergencyNow: state.emergencyNow,
    };
  }

  if (request.stage === "intake") {
    if (state.sources.length >= MAX_TURNS || state.sources.reduce((size, source) => size + source.text.length, 0) + request.message.length > MAX_CONTEXT) {
      throw new WorkflowError(422, "CONTEXT_LIMIT", "This conversation has reached its size limit. Download your report, then start a new report with the details you want to keep.");
    }
    const source = { id: `m${state.sources.length + 1}`, text: request.message };
    const sources = [...state.sources, source];
    // Clear, first-person emergencies do not wait for a provider call or consent
    // to display help in the browser. The server also enforces the same path.
    if (immediateEmergency(request.message)) {
      state.sources = sources;
      state.revision += 1;
      state.summary = null;
      state.diet = null;
      state.alerts = [EMERGENCY_MESSAGE];
      state.emergencyNow = true;
      state.phase = "urgent";
      return response(EMERGENCY_MESSAGE);
    }
    const extracted = intakeSchema.parse(await runModel("intake", INTAKE_SYSTEM, {
      latestSourceId: source.id,
      latestMessage: source.text,
      pendingQuestion: state.intake?.pendingQuestion || state.summary?.followUpQuestions[0] || state.diet?.questions[0] || null,
      previousSnapshot: state.intake,
      sources,
    }, intakeSchema));

    // Off-topic text never becomes accepted context, even after a health conversation.
    if (extracted.scope !== "health") {
      return response(extracted.scope === "mixed"
        ? "Please keep your message about your health or food preferences. I can help organize symptoms and readings, but I can't perform unrelated tasks here."
        : "I'm here to help with your health notes. Tell me about your symptoms, health readings or food preferences, and we can take it from there.");
    }

    verifyEvidence(extracted, sources);
    const intake = mergeIntake(state.intake, extracted, source.text, source.id);
    verifyEvidence(intake, sources);
    const useful = intake.measurements.length > 0 || intake.facts.length > 0;
    state.sources = sources;
    state.revision += 1;
    state.intake = intake;
    state.summary = null;
    state.diet = null;
    state.alerts = bloodPressureAlerts(intake);
    state.emergencyNow = false;
    if ((!useful || intake.conflicts.length > 0) && state.alerts.length === 0) {
      state.phase = "waiting";
      intake.route = "clarify";
      if (!intake.pendingQuestion) intake.pendingQuestion = intake.conflicts[0] ?? "What symptoms, readings or nutrition concerns would you like to discuss?";
      return response(intake.reply || intake.pendingQuestion);
    }
    intake.route = "ready";
    intake.pendingQuestion = null;
    state.phase = "intake";
    return response("I've organized the information you shared. I'll put the summary together next.", "summary");
  }

  if (request.stage === "summary") {
    if (state.phase !== "intake" || !state.intake) throw new WorkflowError(409, "WRONG_STAGE", "The summary needs a completed intake first. Send your health information to start the report.");
    const health = compactHealth(state.intake);
    let summary = summarySchema.parse(await runModel("summary", SUMMARY_SYSTEM, { health, alerts: state.alerts }, summarySchema));
    const unsupported = unsupportedReviewUnits(summary, state.intake);
    if (unsupported.length > 0) {
      summary = summarySchema.parse(await runModel("summary", SUMMARY_SYSTEM + "\nCorrection: some reported readings have NO unit. Never add a unit to them. State 'unit not provided' when referring to those values.", { health, alerts: state.alerts, unsupportedUnitValues: unsupported }, summarySchema));
      if (unsupportedReviewUnits(summary, state.intake).length > 0) {
        throw new WorkflowError(502, "INVALID_MODEL_OUTPUT", "The review added a unit that was not supplied. Please retry the review step.");
      }
    }
    if (summary.emergencyNow) summary.urgentReview = true;
    if (state.alerts.length > 0) {
      summary.urgentReview = true;
      summary.urgentReason = state.alerts.join(" ");
    }
    state.summary = summary;
    state.emergencyNow = summary.emergencyNow;
    state.phase = summary.urgentReview ? "urgent" : "summary";
    if (summary.urgentReview) return response("Your summary is ready. Please prioritize the care guidance shown in your report; food planning is paused.");
    return response("Your summary is ready. I'm preparing food suggestions that fit the information you shared.", "diet");
  }

  if (request.stage === "diet") {
    if (state.phase !== "summary" || !state.intake || !state.summary || state.summary.urgentReview || state.alerts.length > 0) {
      throw new WorkflowError(409, "WRONG_STAGE", "Food planning requires a completed summary with no urgent-care pause. Start with your health information or review the care guidance.");
    }
    const { findings: _findings, nextSteps: _nextSteps, ...summary } = state.summary;
    const diet = dietSchema.parse(await runModel("diet", DIET_SYSTEM, { health: compactHealth(state.intake), summary }, dietSchema));
    if (state.summary.specialistDietNeeded) {
      diet.kind = "clinician_review";
      diet.note = state.summary.dietReason || "A clinician or dietitian should review an individualized food plan for your situation.";
    }
    // Symptoms-only or unknown-age cases receive general guidance, not a guessed menu.
    const hasAdultAge = state.intake.facts.some((fact) => {
      if (fact.category !== "age" || /\b(months?|weeks?|days?)\b/i.test(fact.detail)) return false;
      const age = Number(fact.detail.match(/\b\d{1,3}\b/)?.[0]);
      return Number.isFinite(age) && age >= 18 && age <= 120;
    });
    const hasDietContext = state.intake.facts.some((fact) => fact.category === "food_preferences");
    if (diet.kind === "sample_day" && (!hasAdultAge || !hasDietContext || state.intake.measurements.length === 0)) {
      diet.kind = "general";
      diet.note = "These are general food suggestions based on limited information, rather than a personalized meal plan. " + diet.note;
    }
    if (diet.kind !== "sample_day") diet.meals = [];
    if (diet.kind === "clinician_review") diet.habits = [];
    state.diet = diet;
    if (diet.kind !== "sample_day" && diet.questions.length === 0) {
      state.phase = "questions";
      return response("I'm finding a useful question to help improve these food ideas.", "questions");
    }
    state.phase = "complete";
    return response("Your updated health review and food ideas are ready. Add another detail whenever you'd like.");
  }

  if (state.phase !== "questions" || !state.intake || !state.summary || !state.diet) {
    throw new WorkflowError(409, "WRONG_STAGE", "This question step needs completed food guidance first. Start with your health information.");
  }
  const generated = questionsSchema.parse(await runModel("questions", QUESTIONS_SYSTEM, {
    health: compactHealth(state.intake), summary: state.summary,
    food: state.diet,
  }, questionsSchema));
  state.diet.questions = generated.questions;
  state.phase = "complete";
  return response("Your updated health review and food ideas are ready. You can answer a question in Food Ideas or add another detail.");
}
