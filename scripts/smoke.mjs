// Optional live check against the running local server. Uses fictional data only.
// It consumes Groq quota. No keys, checkpoints or health payloads are printed.
import assert from "node:assert/strict";

const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
const mode = process.argv[2] || "measurements";

async function call(request) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${base}/api/health`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(request) });
    const data = await response.json();
    if (response.status === 429 && data.error?.retryAfter > 0 && data.error.retryAfter <= 20 && attempt < 2) {
      console.log(JSON.stringify({ stage: request.stage, status: 429, waitingSeconds: data.error.retryAfter, reusingCompletedStages: true }));
      await new Promise((resolve) => setTimeout(resolve, data.error.retryAfter * 1000 + 500));
      continue;
    }
    if (!response.ok) {
      console.log(JSON.stringify({ stage: request.stage, status: response.status, code: data.error?.code, retryAfter: data.error?.retryAfter }));
      throw new Error(`Live check stopped: ${data.error?.code || response.status}`);
    }
    console.log(JSON.stringify({ stage: request.stage, phase: data.phase, nextStage: data.nextStage, readings: data.intake?.measurements.length ?? 0 }));
    return data;
  }
  throw new Error("Live check exceeded its bounded retry count.");
}

async function complete(result) {
  while (result.nextStage) result = await call({ stage: result.nextStage, checkpoint: result.checkpoint });
  return result;
}

if (mode === "measurements" || mode === "large") {
  const message = mode === "large" ? "I am a 35-year-old woman, not pregnant or breastfeeding. Weight 72 kg; height 165 cm; blood pressure today 134/86 mmHg; resting pulse 78 bpm; temperature 36.8 C; oxygen saturation 98%. Yesterday, after a 10-hour fast, my results were: Hemoglobin 12.1 g/dL (reference 12.0-15.5 g/dL); ferritin 18 ng/mL (reference 15-150 ng/mL); fasting glucose 108 mg/dL (reference 70-99 mg/dL); HbA1c 5.8% (reference 4.0-5.6%); total cholesterol 218 mg/dL (desirable below 200 mg/dL); LDL 140 mg/dL (desirable below 100 mg/dL); HDL 48 mg/dL (desirable at least 50 mg/dL); triglycerides 150 mg/dL (desirable below 150 mg/dL); creatinine 0.8 mg/dL (reference 0.6-1.1 mg/dL); sodium 139 mmol/L (reference 135-145 mmol/L); potassium 4.2 mmol/L (reference 3.5-5.0 mmol/L). I have felt tired in the afternoon for three days, but have no chest pain, difficulty breathing, fainting or sudden weakness. I have no diagnosed conditions and take no medicines. I have a peanut allergy and lactose intolerance. I eat eggs and fish but no red meat. Please avoid peanuts, peanut oil, milk and regular yogurt. I prefer affordable Bangladeshi meals, typically rice, lentils, fish and vegetables. I work at a desk, sleep six hours and walk 20 minutes three days a week. I want educational food ideas, not a diagnosis." : "I am 32 years old, female, not pregnant. My hemoglobin is 12.4 g/dL (lab reference range 12.0-15.5 g/dL), blood pressure today 128/82 mmHg, fasting glucose 94 mg/dL, weight 65 kg, height 165 cm. I have no current symptoms, known conditions, medicines or food allergies. I prefer vegetarian Bangladeshi meals.";
  const initial = await call({ stage: "intake", checkpoint: null, message });
  const report = await complete(initial);
  assert.equal(report.phase, "complete");
  assert.equal(typeof report.summary.urgentReview, "boolean");
  assert.equal(typeof report.summary.specialistDietNeeded, "boolean");
  assert.ok(report.intake.measurements.length >= (mode === "large" ? 18 : 5));
  assert.ok(report.diet);
} else if (mode === "conversation") {
  const vague = await call({ stage: "intake", checkpoint: null, message: "I have a health concern. Can you help?" });
  assert.equal(vague.nextStage, null);
  assert.equal(vague.phase, "waiting");
  const next = await call({ stage: "intake", checkpoint: vague.checkpoint, message: "I have felt tired and weak for three days. I do not have any health measurements or reports. I have no chest pain, trouble breathing or fainting." });
  assert.equal(next.nextStage, "summary");
  const report = await complete(next);
  assert.equal(report.phase, "complete");
  assert.equal(report.intake.measurements.length, 0);
  assert.equal(report.diet.kind, "general");
  assert.equal(report.diet.meals.length, 0);
} else if (mode === "scope") {
  const report = await call({ stage: "intake", checkpoint: null, message: "How are you?" });
  assert.equal(report.nextStage, null);
  assert.equal(report.intake, null);
} else if (mode === "review") {
  const first = await call({ stage: "intake", checkpoint: null, message: "I am 24 years old and drink 4 litres of water daily. I want to understand this habit, but I have no other readings." });
  const report = await complete(first);
  assert.equal(report.phase, "complete");
  assert.ok(report.summary.overview.length >= 40);
  assert.ok(report.summary.findings.length >= 1);
  assert.ok(report.diet);
  console.log(JSON.stringify({ fictionalReview: report.summary.overview, finding: report.summary.findings[0].explanation, foodKind: report.diet.kind, foodQuestions: report.diet.questions.length }));
} else if (mode === "followup") {
  const first = await call({ stage: "intake", checkpoint: null, message: "My blood pressure top number is 120. I do not know the bottom number or the unit." });
  console.log(JSON.stringify({ fictionalFirstReply: first.message, pendingQuestion: first.intake?.pendingQuestion, factCategories: first.intake?.facts.map((fact) => fact.category) ?? [] }));
  const initial = await complete(first);
  assert.equal(initial.phase, "complete");
  const added = await call({ stage: "intake", checkpoint: initial.checkpoint, message: "My hemoglobin result is 12.4 g/dL. Please update my review." });
  const report = await complete(added);
  assert.equal(report.phase, "complete");
  assert.ok(report.intake.measurements.some((item) => item.kind === "systolic_bp" && item.value === 120));
  assert.ok(report.intake.measurements.some((item) => item.name.toLowerCase().includes("hemoglobin") && item.value === 12.4));
  assert.equal(report.revision, initial.revision + 1);
  console.log(JSON.stringify({ combinedReadingCount: report.intake.measurements.length, updatedReview: report.summary.overview, foodKind: report.diet.kind }));
} else if (mode === "emergency") {
  const report = await call({ stage: "intake", checkpoint: null, message: "I am dying" });
  assert.equal(report.phase, "urgent");
  assert.equal(report.emergencyNow, true);
  assert.equal(report.nextStage, null);
  assert.equal(report.diet, null);
} else {
  throw new Error("Choose measurements, large, conversation, scope, review, followup or emergency.");
}
console.log(`Live ${mode} check passed.`);
