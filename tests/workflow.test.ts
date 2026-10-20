import assert from "node:assert/strict";
import { test } from "node:test";
import { dietSchema, intakeSchema, summarySchema, type Intake, type HealthSummary, type DietPlan, type Stage } from "../src/lib/schemas";
import { newState, readCheckpoint, signCheckpoint } from "../src/lib/server/checkpoint";
import { unsupportedReviewUnits, verifyEvidence } from "../src/lib/server/evidence";
import { ProviderHttpError, publicError } from "../src/lib/server/errors";
import { assertSameOrigin } from "../src/lib/server/origin";
import { runStage, type ModelRunner } from "../src/lib/server/workflow";
import { immediateEmergency } from "../src/lib/emergency";
import { mergeIntake } from "../src/lib/server/merge";
import { parseModelOutput } from "../src/lib/server/model-output";
import { providerForStage, shouldFallbackFromHuggingFace } from "../src/lib/server/provider-routing";
import { runCompatibleModel } from "../src/lib/server/compatible-model";

const SECRET = "test-signing-secret-not-for-production-123456789";
const NOW = 1792468800000;
const TEXT = "I am 32 years old. Hemoglobin 13 g/dL. No known food allergies. Vegetarian meals.";

function intake(changes: Partial<Intake> = {}): Intake {
  return intakeSchema.parse({ scope: "health", route: "ready", reply: "Thanks for sharing.", pendingQuestion: null, conflicts: [],
    measurements: [{ name: "Hemoglobin", kind: "other", value: 13, unit: "g/dL", referenceRange: null, timing: null, evidence: { sourceId: "m1", quote: "Hemoglobin 13 g/dL" } }],
    facts: [
      { category: "age", detail: "32 years old", evidence: [{ sourceId: "m1", quote: "32 years old" }] },
      { category: "allergies", detail: "No known food allergies", evidence: [{ sourceId: "m1", quote: "No known food allergies" }] },
      { category: "food_preferences", detail: "Vegetarian meals", evidence: [{ sourceId: "m1", quote: "Vegetarian meals" }] },
    ], clarificationNeeded: [], ...changes });
}
function summary(changes: Partial<HealthSummary> = {}): HealthSummary {
  return summarySchema.parse({ urgentReview: false, emergencyNow: false, urgentReason: "", specialistDietNeeded: false, dietReason: "", overview: "This information offers a starting point, but it cannot establish your overall health on its own.", findings: [{ title: "Review the context", explanation: "The reported detail needs context before it can support a more specific conclusion." }], missingContext: ["Lab reference range"], nextSteps: ["Review the original report."], followUpQuestions: ["How long have you felt this way?"], ...changes });
}
function diet(changes: Partial<DietPlan> = {}): DietPlan {
  return { kind: "sample_day", note: "Illustrative adult meals, not a prescribed diet.", meals: [{ meal: "Breakfast", foods: "Oats and fruit", reason: "Variety" }], habits: ["Choose varied foods."], questions: ["Do you have any other food restrictions?"], ...changes };
}
function model(answers: Partial<Record<Stage, unknown>>) {
  const calls: { stage: Stage; input: unknown }[] = [];
  const runModel: ModelRunner = async (stage, _system, input, schema) => { calls.push({ stage, input }); return schema.parse(answers[stage]); };
  return { calls, dependencies: { secret: SECRET, now: NOW, runModel } };
}

test("valid health information completes intake, summary and food stages", async () => {
  const { dependencies, calls } = model({ intake: intake(), summary: summary(), diet: diet() });
  const first = await runStage({ stage: "intake", message: TEXT, checkpoint: null }, dependencies);
  assert.equal(first.nextStage, "summary");
  const second = await runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies);
  assert.equal(second.nextStage, "diet");
  const third = await runStage({ stage: "diet", checkpoint: second.checkpoint }, dependencies);
  assert.equal(third.phase, "complete");
  assert.equal(third.diet?.meals.length, 1);
  assert.deepEqual(calls.map((call) => call.stage), ["intake", "summary", "diet"]);
});

test("greeting returns a friendly scope response without storing invented facts", async () => {
  const { dependencies, calls } = model({ intake: intake({ scope: "unrelated" }) });
  const result = await runStage({ stage: "intake", message: "How are you?", checkpoint: null }, dependencies);
  assert.match(result.message, /health notes/i);
  assert.equal(result.nextStage, null);
  assert.equal(result.intake, null);
  assert.equal(readCheckpoint(result.checkpoint, SECRET, NOW).sources.length, 0);
  assert.equal(calls.length, 1);
});

test("vague health input asks for details instead of failing", async () => {
  const { dependencies } = model({ intake: intake({ route: "clarify", reply: "What symptoms concern you?", pendingQuestion: "What symptoms concern you?", measurements: [], facts: [] }) });
  const result = await runStage({ stage: "intake", message: "Help with my health.", checkpoint: null }, dependencies);
  assert.equal(result.phase, "waiting");
  assert.equal(result.nextStage, null);
  assert.match(result.message, /symptoms/i);
});

test("follow-up after vague input receives previous context and source IDs", async () => {
  const firstModel = model({ intake: intake({ route: "clarify", reply: "What symptoms concern you?", pendingQuestion: "What symptoms concern you?", measurements: [], facts: [] }) });
  const first = await runStage({ stage: "intake", message: "Help with my health.", checkpoint: null }, firstModel.dependencies);
  const nextModel = model({ intake: intake({ measurements: [], facts: [{ category: "symptoms", detail: "Tiredness", evidence: [{ sourceId: "m2", quote: "I feel tired" }] }] }) });
  const next = await runStage({ stage: "intake", message: "I feel tired", checkpoint: first.checkpoint }, nextModel.dependencies);
  assert.equal(next.nextStage, "summary");
  const sent = nextModel.calls[0].input as { pendingQuestion: string; sources: unknown[] };
  assert.equal(sent.pendingQuestion, "What symptoms concern you?");
  assert.equal(sent.sources.length, 2);
});

test("symptoms without measurements reach summary and general food guidance", async () => {
  const { dependencies } = model({ intake: intake({ measurements: [], facts: [{ category: "symptoms", detail: "Feeling tired", evidence: [{ sourceId: "m1", quote: "I feel tired" }] }] }), summary: summary(), diet: diet() });
  const first = await runStage({ stage: "intake", message: "I feel tired", checkpoint: null }, dependencies);
  const second = await runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies);
  const third = await runStage({ stage: "diet", checkpoint: second.checkpoint }, dependencies);
  assert.equal(third.diet?.kind, "general");
  assert.deepEqual(third.diet?.meals, []);
});

test("old health context does not make an unrelated follow-up acceptable", async () => {
  const firstModel = model({ intake: intake() });
  const first = await runStage({ stage: "intake", message: TEXT, checkpoint: null }, firstModel.dependencies);
  const other = model({ intake: intake({ scope: "mixed" }) });
  const next = await runStage({ stage: "intake", message: "Now write a Python game", checkpoint: first.checkpoint }, other.dependencies);
  assert.equal(next.nextStage, null);
  assert.equal(next.revision, first.revision);
  assert.equal(readCheckpoint(next.checkpoint, SECRET, NOW).sources.length, 1);
});

test("invented numeric values, quotes, units and ranges fail evidence checks", () => {
  for (const change of [
    { value: 130 }, { unit: "mg/dL" }, { evidence: { sourceId: "m1", quote: "Hemoglobin 14 g/dL" } },
    { referenceRange: "12-15 g/dL" }, { evidence: { sourceId: "other", quote: "Hemoglobin 13 g/dL" } },
  ]) {
    const result = intake();
    Object.assign(result.measurements[0], change);
    assert.throws(() => verifyEvidence(result, [{ id: "m1", text: TEXT }]), /verify|match|range|unit/i);
  }
});

test("minor quote formatting is replaced with the exact source wording", () => {
  const message = "My body temperature is 36.7°C, and I have no current symptoms.";
  const result = intake({ measurements: [{ name: "Body temperature", kind: "other", value: 36.7, unit: "degrees Celsius", referenceRange: null, timing: null,
    evidence: { sourceId: "m1", quote: "body temperature is 36.7 °C" } }],
  facts: [{ category: "symptoms", detail: "No current symptoms", evidence: [{ sourceId: "m1", quote: "no symptoms" }] }] });
  verifyEvidence(result, [{ id: "m1", text: message }]);
  assert.equal(result.measurements[0].evidence.quote, "body temperature is 36.7°C");
  assert.equal(result.measurements[0].unit, "°C");
  assert.equal(result.facts[0].evidence[0].quote, "no current symptoms");
  result.measurements[0].evidence.quote = "body temperature is 37.7 °C";
  assert.throws(() => verifyEvidence(result, [{ id: "m1", text: message }]), /quoted health detail/i);
});

test("missing measurement unit stays unknown and does not block a limited summary", async () => {
  const result = intake();
  result.measurements[0].unit = null;
  const { dependencies } = model({ intake: result });
  const first = await runStage({ stage: "intake", message: TEXT, checkpoint: null }, dependencies);
  assert.equal(first.intake?.measurements[0].unit, null);
  assert.equal(first.nextStage, "summary");
});

test("unresolved conflicting readings produce a clarification outcome", async () => {
  const { dependencies } = model({ intake: intake({ conflicts: ["Is this a correction or a new reading?"], reply: "Is this a correction?", pendingQuestion: "Is this a correction?" }) });
  const first = await runStage({ stage: "intake", message: TEXT, checkpoint: null }, dependencies);
  assert.equal(first.phase, "waiting");
  assert.equal(first.nextStage, null);
});

test("verified high blood pressure overrides a missed urgent flag and blocks diet", async () => {
  const reading = intake({ facts: [] });
  reading.measurements = [{ name: "Systolic blood pressure", kind: "systolic_bp", value: 190, unit: "mmHg", referenceRange: null, timing: null, evidence: { sourceId: "m1", quote: "BP 190/90 mmHg" } }];
  const { dependencies, calls } = model({ intake: reading, summary: summary(), diet: diet() });
  const first = await runStage({ stage: "intake", message: "BP 190/90 mmHg", checkpoint: null }, dependencies);
  const second = await runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies);
  assert.equal(second.phase, "urgent");
  assert.equal(second.summary?.urgentReview, true);
  assert.equal(second.nextStage, null);
  await assert.rejects(runStage({ stage: "diet", checkpoint: second.checkpoint }, dependencies), /Food planning requires/);
  assert.deepEqual(calls.map((call) => call.stage), ["intake", "summary"]);
});

test("specialist diet decision suppresses a generated menu", async () => {
  const { dependencies } = model({ intake: intake(), summary: summary({ specialistDietNeeded: true, dietReason: "Individual dietitian review is needed." }), diet: diet() });
  const first = await runStage({ stage: "intake", message: TEXT, checkpoint: null }, dependencies);
  const second = await runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies);
  const third = await runStage({ stage: "diet", checkpoint: second.checkpoint }, dependencies);
  assert.equal(third.diet?.kind, "clinician_review");
  assert.deepEqual(third.diet?.meals, []);
  assert.deepEqual(third.diet?.habits, []);
});

test("age in months cannot be mistaken for adult context", async () => {
  const health = intake();
  health.facts[0] = { category: "age", detail: "32 months old", evidence: [{ sourceId: "m1", quote: "32 months old" }] };
  const { dependencies } = model({ intake: health, summary: summary(), diet: diet() });
  const first = await runStage({ stage: "intake", message: TEXT.replace("32 years old", "32 months old"), checkpoint: null }, dependencies);
  const second = await runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies);
  const third = await runStage({ stage: "diet", checkpoint: second.checkpoint }, dependencies);
  assert.notEqual(third.diet?.kind, "sample_day");
});

test("signed checkpoints reject changes, expiry and invalid signatures", () => {
  const token = signCheckpoint(newState(NOW), SECRET, NOW);
  assert.equal(readCheckpoint(token, SECRET, NOW).version, 2);
  const [payload, signature] = token.split(".");
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), phase: "summary" })).toString("base64url");
  assert.throws(() => readCheckpoint(`${changed}.${signature}`, SECRET, NOW), /invalid or has expired/);
  assert.throws(() => readCheckpoint(token, SECRET, NOW + 31 * 60000), /invalid or has expired/);
  assert.throws(() => readCheckpoint(`${payload}.bad`, SECRET, NOW), /invalid or has expired/);
});

test("out-of-order stage request does not call the model", async () => {
  const { dependencies, calls } = model({ diet: diet() });
  const token = signCheckpoint(newState(NOW), SECRET, NOW);
  await assert.rejects(runStage({ stage: "diet", checkpoint: token }, dependencies), /requires a completed summary/);
  assert.equal(calls.length, 0);
});

test("failed summary can be retried without repeating extraction", async () => {
  const firstModel = model({ intake: intake() });
  const first = await runStage({ stage: "intake", message: TEXT, checkpoint: null }, firstModel.dependencies);
  let count = 0;
  const failThenSucceed: ModelRunner = async (_stage, _system, _input, schema) => {
    count++;
    if (count === 1) throw new Error("temporary provider error");
    return schema.parse(summary());
  };
  const dependencies = { secret: SECRET, now: NOW, runModel: failThenSucceed };
  await assert.rejects(runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies));
  const retried = await runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies);
  assert.equal(retried.phase, "summary");
  assert.equal(firstModel.calls.length, 1);
  assert.equal(count, 2);
});

test("new health details invalidate the old summary and diet", async () => {
  const initial = model({ intake: intake(), summary: summary(), diet: diet() });
  const first = await runStage({ stage: "intake", message: TEXT, checkpoint: null }, initial.dependencies);
  const second = await runStage({ stage: "summary", checkpoint: first.checkpoint }, initial.dependencies);
  const third = await runStage({ stage: "diet", checkpoint: second.checkpoint }, initial.dependencies);
  const updated = intake();
  updated.facts.push({ category: "symptoms", detail: "Tired for three days", evidence: [{ sourceId: "m2", quote: "Tired for three days" }] });
  const nextModel = model({ intake: updated });
  const next = await runStage({ stage: "intake", message: "Tired for three days", checkpoint: third.checkpoint }, nextModel.dependencies);
  assert.equal(next.revision, third.revision + 1);
  assert.equal(next.summary, null);
  assert.equal(next.diet, null);
  assert.match((nextModel.calls[0].input as { pendingQuestion: string }).pendingQuestion, /How long/);
});

test("required summary safety fields are never given guessed defaults", () => {
  const missing = { ...summary() } as Partial<HealthSummary>;
  delete missing.urgentReview;
  delete missing.specialistDietNeeded;
  delete missing.emergencyNow;
  assert.equal(summarySchema.safeParse(missing).success, false);
});

test("unexpected intake categories keep lifestyle details instead of failing extraction", () => {
  const candidate = intake({ facts: [
    { category: "other_health", detail: "Slept for 7 hours", evidence: [{ sourceId: "m1", quote: "Slept for 7 hours" }] },
    { category: "other_health", detail: "Drank 1.8 liters of water", evidence: [{ sourceId: "m1", quote: "Drank 1.8 liters of water" }] },
    { category: "allergies", detail: "Peanut allergy", evidence: [{ sourceId: "m1", quote: "Peanut allergy" }] },
  ] }) as unknown as { facts: { category: string; detail: string; evidence: { sourceId: string; quote: string }[] }[] };
  candidate.facts[0].category = "sleep";
  candidate.facts[1].category = "hydration";
  candidate.facts[2].category = "food_allergy";
  const parsed = parseModelOutput("intake", intakeSchema, candidate);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.facts.map((fact) => fact.category), ["other_health", "other_health", "allergies"]);
  assert.deepEqual(parsed.data.facts.map((fact) => fact.detail), ["Slept for 7 hours", "Drank 1.8 liters of water", "Peanut allergy"]);
  assert.deepEqual(parsed.data.facts[0].evidence, [{ sourceId: "m1", quote: "Slept for 7 hours" }]);
});

test("null measurement placeholders do not discard valid readings", () => {
  const candidate = intake();
  const raw = { ...candidate, measurements: [candidate.measurements[0], null, candidate.measurements[0], null] };
  const parsed = parseModelOutput("intake", intakeSchema, raw);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.measurements.length, 2);
  assert.equal(parseModelOutput("intake", intakeSchema, { ...candidate, measurements: ["13 g/dL"] }).success, false);
});

test("output repair does not invent missing fields or relax non-intake safety checks", () => {
  const candidate = { ...intake(), facts: [{ category: "sleep", detail: "Slept for 7 hours", evidence: [{ sourceId: "m1", quote: "Slept for 7 hours" }] }] };
  delete (candidate as Partial<Intake>).scope;
  assert.equal(parseModelOutput("intake", intakeSchema, candidate).success, false);
  const missingSafety = { ...summary() } as Partial<HealthSummary>;
  delete missingSafety.emergencyNow;
  assert.equal(parseModelOutput("summary", summarySchema, missingSafety).success, false);
});

test("a follow-up adds hemoglobin while keeping the earlier partial BP reading and rebuilding review and food", async () => {
  const firstReading = intake({ facts: [], measurements: [{ name: "Systolic blood pressure", kind: "systolic_bp", value: 120, unit: null, referenceRange: null, timing: null, evidence: { sourceId: "m1", quote: "BP is 120" } }] });
  const initial = model({ intake: firstReading, summary: summary(), diet: diet() });
  const first = await runStage({ stage: "intake", message: "BP is 120", checkpoint: null }, initial.dependencies);
  const reviewed = await runStage({ stage: "summary", checkpoint: first.checkpoint }, initial.dependencies);
  const finished = await runStage({ stage: "diet", checkpoint: reviewed.checkpoint }, initial.dependencies);
  const nextReading = intake({ facts: [], measurements: [{ name: "Hemoglobin", kind: "other", value: 12.4, unit: "g/dL", referenceRange: null, timing: null, evidence: { sourceId: "m2", quote: "hemoglobin is 12.4 g/dL" } }] });
  const followUp = model({ intake: nextReading, summary: summary({ overview: "The two reported readings add useful context, although missing details limit what they can show about your health." }), diet: diet() });
  const added = await runStage({ stage: "intake", message: "hemoglobin is 12.4 g/dL", checkpoint: finished.checkpoint }, followUp.dependencies);
  assert.equal(added.intake?.measurements.length, 2);
  assert.equal(added.intake?.measurements[0].value, 12.4);
  assert.equal(added.intake?.measurements[1].value, 120);
  assert.equal(added.summary, null);
  assert.equal(added.diet, null);
  const newReview = await runStage({ stage: "summary", checkpoint: added.checkpoint }, followUp.dependencies);
  assert.equal(((followUp.calls.find((call) => call.stage === "summary")?.input as { health: { measurements: unknown[] } }).health.measurements).length, 2);
  const newFood = await runStage({ stage: "diet", checkpoint: newReview.checkpoint }, followUp.dependencies);
  assert.equal(newFood.phase, "complete");
  assert.equal(newFood.revision, finished.revision + 1);
});

test("clear first-person emergency bypasses the model and pauses food planning", async () => {
  const { dependencies, calls } = model({});
  const result = await runStage({ stage: "intake", message: "I am dying", checkpoint: null }, dependencies);
  assert.equal(result.phase, "urgent");
  assert.equal(result.emergencyNow, true);
  assert.equal(result.nextStage, null);
  assert.match(result.message, /call emergency services now/i);
  assert.equal(calls.length, 0);
  assert.equal(immediateEmergency("I'm dying to try this restaurant"), false);
  assert.equal(immediateEmergency("I am not dying"), false);
});

test("emergency decision in health review stops the food call", async () => {
  const { dependencies, calls } = model({ intake: intake(), summary: summary({ emergencyNow: true, urgentReview: false, urgentReason: "Emergency symptoms reported." }) });
  const first = await runStage({ stage: "intake", message: TEXT, checkpoint: null }, dependencies);
  const result = await runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies);
  assert.equal(result.phase, "urgent");
  assert.equal(result.emergencyNow, true);
  assert.equal(result.summary?.urgentReview, true);
  assert.deepEqual(calls.map((call) => call.stage), ["intake", "summary"]);
});

test("a fourth call supplies missing Food Ideas questions only when needed", async () => {
  const { dependencies, calls } = model({ intake: intake({ facts: [] }), summary: summary(), diet: diet({ kind: "general", questions: [] }), questions: { questions: ["What foods do you normally eat?", "Are there foods you avoid?"] } });
  const first = await runStage({ stage: "intake", message: TEXT, checkpoint: null }, dependencies);
  const reviewed = await runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies);
  const food = await runStage({ stage: "diet", checkpoint: reviewed.checkpoint }, dependencies);
  assert.equal(food.nextStage, "questions");
  const result = await runStage({ stage: "questions", checkpoint: food.checkpoint }, dependencies);
  assert.equal(result.phase, "complete");
  assert.equal(result.diet?.questions.length, 2);
  assert.deepEqual(calls.map((call) => call.stage), ["intake", "summary", "diet", "questions"]);
});

test("undated changed readings ask whether they are a correction; explicit corrections replace", () => {
  const old = intake({ facts: [], measurements: [{ name: "Hemoglobin", kind: "other", value: 12, unit: "g/dL", referenceRange: null, timing: null, evidence: { sourceId: "m1", quote: "Hemoglobin 12 g/dL" } }] });
  const newer = intake({ facts: [], measurements: [{ name: "Hemoglobin", kind: "other", value: 13, unit: "g/dL", referenceRange: null, timing: null, evidence: { sourceId: "m2", quote: "Hemoglobin 13 g/dL" } }] });
  const unclear = mergeIntake(old, newer, "Hemoglobin 13 g/dL", "m2");
  assert.equal(unclear.measurements.length, 2);
  assert.match(unclear.conflicts[0], /correction|separate reading/i);
  const corrected = mergeIntake(old, newer, "Actually, my Hemoglobin is 13 g/dL", "m2");
  assert.equal(corrected.measurements.length, 1);
  assert.equal(corrected.measurements[0].value, 13);
});

test("unsupported units in a review trigger one grounded rewrite before display", async () => {
  const reading = intake({ facts: [], measurements: [{ name: "Systolic blood pressure", kind: "systolic_bp", value: 120, unit: null, referenceRange: null, timing: null, evidence: { sourceId: "m1", quote: "BP 120" } }] });
  const wrong = summary({ overview: "The reported blood pressure is 120 mmHg, but other context is still needed to make sense of the reading." });
  const right = summary({ overview: "The reported top blood-pressure number is 120, with no unit provided. More context is needed to understand it." });
  assert.deepEqual(unsupportedReviewUnits(wrong, reading), [120]);
  assert.deepEqual(unsupportedReviewUnits(right, reading), []);
  let reviews = 0;
  const runModel: ModelRunner = async (stage, _system, _input, schema) => {
    if (stage === "intake") return schema.parse(reading);
    reviews += 1;
    return schema.parse(reviews === 1 ? wrong : right);
  };
  const dependencies = { secret: SECRET, now: NOW, runModel };
  const first = await runStage({ stage: "intake", message: "BP 120", checkpoint: null }, dependencies);
  const reviewed = await runStage({ stage: "summary", checkpoint: first.checkpoint }, dependencies);
  assert.equal(reviews, 2);
  assert.equal(reviewed.summary?.overview, right.overview);
});

test("new allergy and explicit age correction replace outdated context", () => {
  const previous = intake({ measurements: [], facts: [
    { category: "age", detail: "24 years old", evidence: [{ sourceId: "m1", quote: "24 years old" }] },
    { category: "allergies", detail: "No known food allergies", evidence: [{ sourceId: "m1", quote: "No known food allergies" }] },
  ] });
  const updated = intake({ measurements: [], facts: [
    ...previous.facts,
    { category: "age", detail: "Actually I am 25", evidence: [{ sourceId: "m2", quote: "Actually I am 25" }] },
    { category: "allergies", detail: "Peanut allergy", evidence: [{ sourceId: "m2", quote: "Peanut allergy" }] },
  ] });
  const merged = mergeIntake(previous, updated, "Actually I am 25. Peanut allergy.", "m2");
  assert.deepEqual(merged.facts.map((fact) => fact.detail), ["Actually I am 25", "Peanut allergy"]);
});

test("separate reports have separate session identifiers", () => {
  assert.notEqual(newState(NOW).sessionId, newState(NOW).sessionId);
});

test("safe errors never expose the provider payload", () => {
  const output = publicError({ status: 400, message: "private medical text and secret key", error: { failed_generation: "private payload" } });
  assert.doesNotMatch(JSON.stringify(output), /private|secret/);
  assert.equal(output.code, "MODEL_RESPONSE");
});

test("rate limit errors return a bounded retry delay", () => {
  const output = publicError({ status: 429, headers: new Headers({ "retry-after": "15" }) });
  assert.equal(output.status, 429);
  assert.equal(output.retryAfter, 15);
});

test("configured providers take only their assigned stages", () => {
  const keys = { OPENROUTER_API_KEY: "or-test", HF_TOKEN: "hf-test" };
  assert.deepEqual((["intake", "summary", "diet", "questions"] as Stage[]).map((stage) => providerForStage(stage, keys)),
    ["groq", "openrouter", "huggingface", "huggingface"]);
  assert.equal(providerForStage("summary", { OPENROUTER_API_KEY: "" }), "groq");
  assert.equal(providerForStage("diet", { HF_TOKEN: "your_hf_token" }), "groq");
});

test("Hugging Face credit and transport failures can fall back to OpenRouter", () => {
  assert.equal(shouldFallbackFromHuggingFace(new ProviderHttpError("huggingface", 402, null)), true);
  assert.equal(shouldFallbackFromHuggingFace(new ProviderHttpError("huggingface", 429, "15")), true);
  assert.equal(shouldFallbackFromHuggingFace(new TypeError("fetch failed")), true);
  assert.equal(shouldFallbackFromHuggingFace(new ProviderHttpError("huggingface", 401, null)), false);
  const credits = publicError(new ProviderHttpError("huggingface", 402, null));
  assert.equal(credits.code, "PROVIDER_CREDITS");
});

test("OpenRouter summary excludes Groq and validates structured JSON", async () => {
  let endpoint = "";
  let body: Record<string, unknown> = {};
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    endpoint = String(url);
    body = JSON.parse(String(options?.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify(summary()) } }] });
  }) as typeof fetch;
  const result = await runCompatibleModel({ provider: "openrouter", apiKey: "or-test", model: "openai/gpt-oss-20b",
    stage: "summary", system: "Review health details", input: { health: {} }, schema: summarySchema, fetcher });
  assert.match(endpoint, /openrouter\.ai/);
  assert.deepEqual((body.provider as { ignore: string[] }).ignore, ["groq"]);
  assert.equal((body.response_format as { type: string }).type, "json_schema");
  assert.equal(result.emergencyNow, false);
});

test("Hugging Face food stage repairs malformed JSON once without calling Groq", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    assert.match(String(url), /huggingface\.co/);
    bodies.push(JSON.parse(String(options?.body)));
    return Response.json({ choices: [{ message: { content: bodies.length === 1 ? "not JSON" : JSON.stringify(diet()) } }] });
  }) as typeof fetch;
  const result = await runCompatibleModel({ provider: "huggingface", apiKey: "hf-test", model: "Qwen/Qwen3.8-27B:cerebras",
    stage: "diet", system: "Suggest foods", input: { health: {} }, schema: dietSchema, fetcher });
  assert.equal(bodies.length, 2);
  assert.equal((bodies[1].response_format as { type: string }).type, "json_object");
  assert.equal(result.kind, "sample_day");
});

test("same-origin check uses the public Host rather than Next's internal URL", () => {
  assert.doesNotThrow(() => assertSameOrigin(new Request("http://localhost:3000/api/health", { headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } })));
  assert.doesNotThrow(() => assertSameOrigin(new Request("https://internal/api/health", { headers: { host: "health.example.com", origin: "https://health.example.com" } })));
  assert.throws(() => assertSameOrigin(new Request("https://internal/api/health", { headers: { host: "health.example.com", origin: "https://unrelated.example" } })), /from this app/);
  assert.throws(() => assertSameOrigin(new Request("https://internal/api/health", { headers: { host: "health.example.com", origin: "null" } })), /from this app/);
});
