import { z } from "zod";
import { factSchema, type Stage } from "../schemas";

const factCategories = new Set(factSchema.shape.category.options);
const categoryAliases: Record<string, z.infer<typeof factSchema>["category"]> = {
  allergy: "allergies",
  food_allergy: "allergies",
  medication: "medications",
  medicine: "medications",
  symptom: "symptoms",
  condition: "conditions",
  diet: "food_preferences",
  exercise: "activity",
  physical_activity: "activity",
  gender: "sex",
};

// Groq can return a useful fact under a category outside our enum (for example,
// "sleep" or "hydration"). Keep its detail and evidence, then validate everything.
export function parseModelOutput<T>(stage: Stage, schema: z.ZodType<T>, candidate: unknown) {
  if (stage !== "intake" || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return schema.safeParse(candidate);
  }
  const output = candidate as Record<string, unknown>;
  if (!Array.isArray(output.facts)) return schema.safeParse(candidate);

  const facts = output.facts.map((fact: unknown) => {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) return fact;
    const entry = fact as Record<string, unknown>;
    if (typeof entry.category !== "string" || factCategories.has(entry.category as z.infer<typeof factSchema>["category"])) return fact;
    const alias = entry.category.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return { ...entry, category: categoryAliases[alias] ?? "other_health" };
  });
  const measurements = Array.isArray(output.measurements)
    ? output.measurements.filter((measurement: unknown) => measurement !== null)
    : output.measurements;
  return schema.safeParse({ ...output, facts, measurements });
}
