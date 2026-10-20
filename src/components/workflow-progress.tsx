import { Check, LoaderCircle } from "lucide-react";
import type { HealthResponse, Stage } from "@/lib/schemas";

const steps = [{ key: "intake", label: "Organize" }, { key: "summary", label: "Understand" }, { key: "diet", label: "Food ideas" }] as const;

export function WorkflowProgress({ busy, report }: { busy: Stage | null; report: HealthResponse | null }) {
  const complete = [!!report?.intake && report.phase !== "waiting", !!report?.summary, !!report?.diet];
  return <ol className="workflow-progress" aria-label="Report progress">
    {steps.map((step, index) => <li key={step.key} className={busy === step.key ? "is-working" : complete[index] ? "is-done" : ""} aria-current={busy === step.key ? "step" : undefined}>
      <span className="step-dot">{busy === step.key ? <LoaderCircle size={13} className="spin" /> : complete[index] ? <Check size={13} /> : index + 1}</span>
      <span>{step.label}</span>
    </li>)}
  </ol>;
}
