"use client";

import { Activity, ArrowUpRight, Check, ChevronDown, CircleHelp, ClipboardList, Download, Leaf, ListChecks, Moon, ShieldCheck, Sprout, Sun, Sunrise, Utensils, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { HealthResponse, Stage } from "@/lib/schemas";
import { EmergencyActions } from "./emergency-actions";
import { WorkflowProgress } from "./workflow-progress";

type Tab = "summary" | "readings" | "food";

function BulletList({ items }: { items: string[] }) {
  return <ul className="report-list">{items.map((item, index) => <li key={index}><span className="list-dot" />{item}</li>)}</ul>;
}

function SectionTitle({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return <h3 className="section-title"><Icon size={16} strokeWidth={1.7} />{children}</h3>;
}

function PromptCard({ title, questions, onPrompt, food = false }: { title: string; questions: string[]; onPrompt: (text: string) => void; food?: boolean }) {
  return <div className="prompt-card">
    <SectionTitle icon={CircleHelp}>{title}</SectionTitle>
    {questions.map((question, index) => <div className="prompt-question" key={`${question}-${index}`}><p>{question}</p><button type="button" onClick={() => onPrompt(`My answer to "${question}": `)}>Answer in chat <ArrowUpRight size={14} /></button></div>)}
    {food && <div className="prompt-starters"><span>Or start with a detail</span><button type="button" onClick={() => onPrompt("My usual meals are: ")}>My usual meals</button><button type="button" onClick={() => onPrompt("Foods I avoid are: ")}>Foods I avoid</button><button type="button" onClick={() => onPrompt("My food preferences are: ")}>My preferences</button></div>}
  </div>;
}

function EmptyReport() {
  return <div className="empty-report">
    <div className="empty-illustration" aria-hidden="true"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="leaf-center"><Sprout size={34} strokeWidth={1.3} /></span><span className="orbit-point point-one" /><span className="orbit-point point-two" /></div>
    <span className="eyebrow">A LITTLE CONTEXT GOES A LONG WAY</span>
    <h3>Your story.<br />A clearer picture.</h3>
    <p>Start with what you know. We’ll help you bring the details together, one step at a time.</p>
    <div className="empty-steps">
      <div><span>01</span><p><strong>Bring your notes together</strong><small>Symptoms, readings and a little about you.</small></p></div>
      <div><span>02</span><p><strong>Make sense of the details</strong><small>A clear summary with helpful next steps.</small></p></div>
      <div><span>03</span><p><strong>Explore thoughtful food ideas</strong><small>Suggestions shaped around what you share.</small></p></div>
    </div>
    <div className="optional-note"><CircleHelp size={15} /><span>No measurements? Start with how you feel.</span></div>
  </div>;
}

export function HealthReport({ report, busy, stale, onPrompt }: { report: HealthResponse | null; busy: Stage | null; stale: boolean; onPrompt: (text: string) => void }) {
  const [tab, setTab] = useState<Tab>("summary");
  const { intake = null, summary = null, diet = null, alerts = [] } = report ?? {};
  const urgent = !!summary?.urgentReview || alerts.length > 0 || !!report?.emergencyNow;
  const pending = report?.phase === "waiting";
  const measurements = intake?.measurements ?? [];
  const allergies = intake?.facts.filter((fact) => fact.category === "allergies") ?? [];

  function download() {
    if (!report) return;
    const payload = { createdAt: new Date().toISOString(), purpose: "Educational health notes; not a diagnosis", measurements, healthContext: intake?.facts, summary, foodGuidance: diet, alerts };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "health-notes.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  return <section className="report-panel panel" aria-labelledby="report-heading">
    <div className="panel-header report-header"><div><span className="panel-kicker">THE BIGGER PICTURE</span><h2 id="report-heading">Your health notes</h2></div><button className="icon-button" type="button" disabled={!intake} onClick={download} title="Download report" aria-label="Download health report"><Download size={18} /></button></div>
    {(busy || stale) && report && <div className="report-version" role="status">{busy ? "Updating all sections with your new information…" : "Showing your last complete report. Retry the unfinished update."}</div>}
    <WorkflowProgress report={report} busy={busy} />
    <div className="report-tabs" role="tablist" aria-label="Report sections">
      {([{ key: "summary", label: "Summary", icon: ClipboardList }, { key: "readings", label: "Readings", icon: Activity }, { key: "food", label: "Food ideas", icon: Utensils }] as const).map(({ key, label, icon: Icon }) => <button type="button" role="tab" id={`tab-${key}`} aria-controls={`panel-${key}`} aria-selected={tab === key} key={key} onClick={() => setTab(key)} className={tab === key ? "active" : ""}><Icon size={15} />{label}{key === "readings" && measurements.length > 0 && <span className="count-badge">{measurements.length}</span>}</button>)}
    </div>
    <div className="report-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
      {!intake && !urgent && <EmptyReport />}
      {urgent && (report?.emergencyNow ? <EmergencyActions /> : <div className="care-alert" role="alert"><ShieldCheck size={19} /><div><strong>Medical care comes first</strong><p>{alerts[0] || summary?.urgentReason || "Please seek prompt medical review. Food planning is paused."}</p></div></div>)}
      {!intake && urgent && tab === "food" && <div className="partial-report"><h3>Food planning is paused.</h3><p>Please prioritize the care guidance above.</p></div>}
      {intake && <>
        {pending && tab !== "food" && <PromptCard title="A question to continue" questions={[intake.pendingQuestion || report?.message || "What health concern would you like to discuss?"]} onPrompt={onPrompt} />}
        {tab === "summary" && <>
          {summary ? <>
            <div className="report-intro"><span className="eyebrow">BASED ON WHAT YOU SHARED</span><h3>A note on your health</h3><p>{summary.overview}</p></div>
            {summary.findings.length > 0 && <div className="findings">{summary.findings.map((finding, index) => <article className="finding" key={index}><span className="finding-mark"><Activity size={14} /></span><div><h4>{finding.title}</h4><p>{finding.explanation}</p></div></article>)}</div>}
            {summary.nextSteps.length > 0 && <div className="next-steps"><SectionTitle icon={ListChecks}>A few next steps</SectionTitle><BulletList items={summary.nextSteps} /></div>}
            {summary.followUpQuestions.length > 0 && <PromptCard title="A little more context would help" questions={summary.followUpQuestions} onPrompt={onPrompt} />}
            {summary.missingContext.length > 0 && <details className="report-details"><summary>What’s still unknown <ChevronDown size={15} /></summary><BulletList items={summary.missingContext} /></details>}
          </> : <div className="partial-report"><span className="partial-icon"><Leaf size={25} /></span><h3>{pending ? "A good place to begin." : "Your details are coming together."}</h3><p>{pending ? "You don't need a perfect health report. Tell us what you're noticing, or add any readings you have." : "Your information is organized. The summary will appear here when the next step is complete."}</p>{intake.facts.length > 0 && <div className="context-facts">{intake.facts.slice(0, 7).map((fact, index) => <div key={index}><span>{fact.category.replaceAll("_", " ")}</span><p>{fact.detail}</p></div>)}</div>}</div>}
          {diet && !urgent && <button type="button" className="food-ready" onClick={() => setTab("food")}><span className="food-ready-icon"><Utensils size={18} /></span><span><strong>Your food suggestions are ready</strong><small>A practical next step, based on your notes.</small></span><ArrowUpRight size={18} /></button>}
        </>}
        {tab === "readings" && <>
          <div className="report-intro"><span className="eyebrow">THE DETAILS YOU PROVIDED</span><h3>{measurements.length ? "Your readings, organized." : "Symptoms count, too."}</h3><p>{measurements.length ? "Check these values against your original notes. Missing units stay unknown; the app does not convert them." : "No numeric measurements were provided. We can still use your symptoms and health context for a limited summary."}</p></div>
          {measurements.length > 0 && <div className="readings-list">{measurements.map((reading, index) => <details className="reading" key={index}><summary><span><strong>{reading.name}</strong><small>{reading.timing || "Timing not provided"}</small></span><span className="reading-value">{reading.value}<small>{reading.unit || "unit unknown"}</small></span><ChevronDown size={14} /></summary><div className="reading-evidence"><p><strong>Source:</strong> “{reading.evidence.quote}”</p><p><strong>Lab reference:</strong> {reading.referenceRange || "Not supplied"}</p></div></details>)}</div>}
          {intake.clarificationNeeded.length > 0 && <PromptCard title="Details to clarify" questions={intake.clarificationNeeded} onPrompt={onPrompt} />}
          {intake.facts.length > 0 && <><SectionTitle icon={ClipboardList}>Your health context</SectionTitle><div className="context-facts">{intake.facts.map((fact, index) => <div key={index}><span>{fact.category.replaceAll("_", " ")}</span><p>{fact.detail}</p></div>)}</div></>}
        </>}
        {tab === "food" && <>
          {urgent ? <div className="partial-report"><ShieldCheck size={30} /><h3>Let’s prioritize care.</h3><p>Food planning is paused while you review the medical care guidance above.</p></div> : diet ? <>
            <div className="report-intro"><span className="eyebrow">{diet.kind === "sample_day" ? "AN ILLUSTRATIVE DAY OF EATING" : diet.kind === "general" ? "A FEW EVERYDAY IDEAS" : "PERSONAL GUIDANCE MATTERS"}</span><h3>{diet.kind === "sample_day" ? "Thoughtful food, simple choices." : diet.kind === "general" ? "Start with the basics." : "A plan that needs a closer look."}</h3><p>{diet.note}</p></div>
            {allergies.length > 0 && <div className="allergy-note"><ShieldCheck size={16} /><div><strong>Check your food restrictions</strong>{allergies.map((fact, index) => <p key={index}>{fact.detail}</p>)}<small>Verify ingredients and cross-contact before using suggestions.</small></div></div>}
            {diet.meals.length > 0 && <div className="meal-list">{diet.meals.map((meal, index) => {
              const Icon = index === 0 ? Sunrise : index === 1 ? Sun : index === 2 ? Moon : Leaf;
              return <article className="meal" key={index}><span className="meal-icon"><Icon size={21} strokeWidth={1.5} /></span><div><span className="meal-time">{meal.meal}</span><h4>{meal.foods}</h4><p>{meal.reason}</p></div></article>;
            })}</div>}
            {diet.habits.length > 0 && <div className="next-steps"><SectionTitle icon={Check}>Small, everyday habits</SectionTitle><BulletList items={diet.habits} /></div>}
            <PromptCard title="Make these ideas more useful" questions={diet.questions.length ? diet.questions : summary?.followUpQuestions ?? []} onPrompt={onPrompt} food />
            {diet.kind === "sample_day" && <p className="report-smallprint">An educational example, not a prescribed diet. Portions and medical restrictions need individual review.</p>}
          </> : pending ? <PromptCard title="Help us tailor food ideas" questions={[intake.pendingQuestion || report?.message || "What health detail would you like to share?"]} onPrompt={onPrompt} food /> : <div className="partial-report"><span className="partial-icon"><Utensils size={26} /></span><h3>Food ideas come next.</h3><p>Once we understand your health notes, this space will hold suggestions that respect what you’ve shared.</p></div>}
        </>}
      </>}
    </div>
    <div className="report-footer"><ShieldCheck size={14} /><span>A starting point for understanding, not a medical diagnosis.</span></div>
  </section>;
}
