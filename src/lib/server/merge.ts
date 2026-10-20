import type { HealthFact, Intake, Measurement } from "../schemas";
import { normalize } from "./evidence";

function metric(reading: Measurement): string {
  return reading.kind === "other" ? normalize(reading.name) : reading.kind;
}

function sameReading(left: Measurement, right: Measurement): boolean {
  return metric(left) === metric(right) && left.value === right.value
    && normalize(left.unit ?? "") === normalize(right.unit ?? "")
    && normalize(left.timing ?? "") === normalize(right.timing ?? "");
}

function sameFact(left: HealthFact, right: HealthFact): boolean {
  return left.category === right.category && normalize(left.detail) === normalize(right.detail);
}

function correctionFor(message: string, name: string): boolean {
  return /\b(?:correction|correcting|actually|i meant|was wrong|instead|replace|not\s+\d+\s+(?:but|it is))\b/i.test(message)
    && (name === "systolic_bp" || name === "diastolic_bp" ? /\b(?:bp|blood pressure|systolic|diastolic)\b/i.test(message) : normalize(message).includes(name));
}

export function mergeIntake(previous: Intake | null, next: Intake, latestMessage: string, latestSourceId: string): Intake {
  if (!previous) return next;
  const measurements = [...next.measurements];
  const conflicts = [...next.conflicts];
  for (const old of previous.measurements) {
    const matching = next.measurements.filter((item) => metric(item) === metric(old));
    const newer = matching.filter((item) => item.evidence.sourceId === latestSourceId);
    const isCorrection = correctionFor(latestMessage, metric(old));
    if (newer.length > 0 && isCorrection) {
      for (let index = measurements.length - 1; index >= 0; index--) {
        if (measurements[index].evidence.sourceId !== latestSourceId && sameReading(measurements[index], old)) measurements.splice(index, 1);
      }
      continue;
    }
    if (!matching.some((item) => sameReading(item, old))) measurements.push(old);
    if (newer.some((item) => item.value !== old.value && !item.timing && !old.timing)) {
      const question = `Is the newer ${old.name} value a correction, or a separate reading taken at another time?`;
      if (!conflicts.includes(question)) conflicts.push(question);
    }
  }

  const facts = [...next.facts];
  for (const old of previous.facts) {
    const newer = facts.filter((item) => item.category === old.category && item.evidence.some((proof) => proof.sourceId === latestSourceId));
    const replacesScalar = ["age", "sex", "pregnancy", "food_preferences", "activity"].includes(old.category)
      && newer.length > 0 && /\b(?:correction|actually|i meant|now|instead)\b/i.test(latestMessage);
    const replacesUnknownAllergy = old.category === "allergies" && /\b(?:no known|none|no allergies)\b/i.test(old.detail) && newer.length > 0;
    if (replacesScalar || replacesUnknownAllergy) {
      for (let index = facts.length - 1; index >= 0; index--) {
        if (sameFact(facts[index], old) && facts[index].evidence.every((proof) => proof.sourceId !== latestSourceId)) facts.splice(index, 1);
      }
      continue;
    }
    if (!facts.some((item) => sameFact(item, old))) facts.push(old);
  }
  return { ...next, measurements: measurements.slice(0, 50), facts: facts.slice(0, 50), conflicts: conflicts.slice(0, 8) };
}
