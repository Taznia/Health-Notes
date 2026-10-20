import type { HealthSummary, Intake, Source } from "../schemas";
import { WorkflowError } from "./errors";

export const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();

type Token = { value: string; start: number; end: number };

function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    value: normalize(match[0]), start: match.index, end: match.index + match[0].length,
  }));
}

// The model sometimes changes spacing or punctuation inside an otherwise exact
// quote (for example "36.7 °C" versus "36.7°C"). Recover the original span,
// never keep the model's rewritten wording as a quotation.
function sourceQuote(source: string, quote: string): string | null {
  const wanted = tokens(quote);
  const available = tokens(source);
  if (wanted.length < 2) return null;
  const maxSkipped = Math.min(3, Math.max(1, Math.floor(wanted.length / 3)));
  let best: { text: string; skips: number } | null = null;
  let ambiguous = false;

  for (let start = 0; start < available.length; start++) {
    if (available[start].value !== wanted[0].value) continue;
    let sourceIndex = start + 1;
    let quoteIndex = 1;
    let skips = 0;
    while (sourceIndex < available.length && quoteIndex < wanted.length && skips <= maxSkipped) {
      if (available[sourceIndex].value === wanted[quoteIndex].value) quoteIndex++;
      else skips++;
      sourceIndex++;
    }
    if (quoteIndex !== wanted.length || skips > maxSkipped) continue;
    const span = source.slice(available[start].start, available[sourceIndex - 1].end);
    if (span.length > 1800) continue;
    if (!best || skips < best.skips) {
      best = { text: span, skips };
      ambiguous = false;
    } else if (skips === best.skips && span !== best.text) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best?.text ?? null;
}

function explicitUnit(unit: string, quote: string): string | null {
  if (normalize(quote).includes(normalize(unit))) return unit;
  const equivalents: { requested: RegExp; written: RegExp }[] = [
    { requested: /^(?:°\s*c|celsius|degrees? celsius|deg\.? c)$/i, written: /°\s*c\b|\b(?:degrees?\s+)?celsius\b/i },
    { requested: /^(?:bpm|beats?\s*(?:\/|per)\s*min(?:ute)?)$/i, written: /\bbpm\b|\bbeats?\s*(?:\/|per)\s*min(?:ute)?\b/i },
    { requested: /^breaths?\s*(?:\/|per)\s*min(?:ute)?$/i, written: /\bbreaths?\s*(?:\/|per)\s*min(?:ute)?\b/i },
    { requested: /^(?:liters?|litres?|l)$/i, written: /\blit(?:er|re)s?\b|\bL\b/ },
  ];
  for (const equivalent of equivalents) {
    if (!equivalent.requested.test(unit)) continue;
    const written = quote.match(equivalent.written)?.[0];
    if (written) return written;
  }
  return null;
}

export function verifyEvidence(intake: Intake, sources: Source[]) {
  const sourcesById = new Map(sources.map((source) => [source.id, source.text]));
  const byId = new Map(sources.map((source) => [source.id, normalize(source.text)]));
  const evidenceItems = [...intake.measurements.map((item) => item.evidence), ...intake.facts.flatMap((item) => item.evidence)];
  for (const [index, evidence] of evidenceItems.entries()) {
    const source = sourcesById.get(evidence.sourceId);
    let original = byId.get(evidence.sourceId);
    if (source && original && !original.includes(normalize(evidence.quote))) {
      const recovered = sourceQuote(source, evidence.quote);
      if (recovered) evidence.quote = recovered;
      original = byId.get(evidence.sourceId);
    }
    if (!original || !normalize(evidence.quote) || !original.includes(normalize(evidence.quote))) {
      // Index and failure type only: never log source text, model quotes, or keys.
      console.warn("health_evidence_validation", { index, sourceKnown: Boolean(original), quotePresent: Boolean(normalize(evidence.quote)) });
      throw new WorkflowError(422, "EVIDENCE_MISMATCH", "A quoted health detail did not match your messages. Please clarify the reading or try again with its exact wording.");
    }
  }
  for (const [index, item] of intake.measurements.entries()) {
    const quote = item.evidence.quote.normalize("NFKC");
    const numbers = (quote.match(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []).map((number) => Number(number.replaceAll(",", "")));
    if (!Number.isFinite(item.value) || !numbers.some((value) => Math.abs(value - item.value) <= Math.max(1e-9, Math.abs(value) * 1e-9))) {
      console.warn("health_evidence_validation", { index, reason: "number" });
      throw new WorkflowError(422, "EVIDENCE_MISMATCH", "An extracted number did not match its source. Please write the reading and its unit clearly.");
    }
    if (item.unit) {
      const writtenUnit = explicitUnit(item.unit, quote);
      if (writtenUnit) item.unit = writtenUnit;
    }
    if (item.unit && !normalize(quote).includes(normalize(item.unit))) {
      console.warn("health_evidence_validation", { index, reason: "unit" });
      throw new WorkflowError(422, "EVIDENCE_MISMATCH", "A measurement unit could not be verified. Please copy the reading with its original unit.");
    }
    if (item.referenceRange && !byId.get(item.evidence.sourceId)?.includes(normalize(item.referenceRange))) {
      console.warn("health_evidence_validation", { index, reason: "range" });
      throw new WorkflowError(422, "EVIDENCE_MISMATCH", "A lab reference range could not be verified. Please copy it exactly from your report.");
    }
  }
}

export function bloodPressureAlerts(intake: Intake): string[] {
  const high = intake.measurements.some((item) => normalize(item.unit ?? "").replaceAll(" ", "") === "mmhg" && (
    (item.kind === "systolic_bp" && item.value > 180) || (item.kind === "diastolic_bp" && item.value > 120)
  ));
  return high ? ["A reported blood pressure reading is very high. With chest pain, difficulty breathing, weakness, vision changes or difficulty speaking, contact local emergency services now. Otherwise, recheck after at least one minute and seek prompt medical advice if it remains high. Food planning is paused."] : [];
}

export function compactHealth(intake: Intake) {
  return {
    measurements: intake.measurements.map(({ evidence: _evidence, ...item }) => item),
    facts: intake.facts.map(({ category, detail }) => ({ category, detail })),
    clarificationNeeded: intake.clarificationNeeded,
  };
}

export function unsupportedReviewUnits(summary: HealthSummary, intake: Intake): number[] {
  const review = [summary.overview, summary.urgentReason, ...summary.findings.flatMap((finding) => [finding.title, finding.explanation]), ...summary.missingContext, ...summary.nextSteps, ...summary.followUpQuestions].join(" ");
  const known = intake.measurements.filter((item) => item.unit !== null);
  const units = "mmHg|mg\\/dL|g\\/dL|mmol\\/L|ng\\/mL|kg|lb|cm|mL|litres?|liters?";
  return intake.measurements.filter((item) => item.unit === null && !known.some((reading) => reading.value === item.value)).filter((item) => {
    const value = String(item.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\d])${value}\\s*(?:${units})(?![a-z])`, "i").test(review);
  }).map((item) => item.value);
}
