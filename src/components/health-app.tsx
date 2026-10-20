"use client";

import { ArrowUp, ArrowUpRight, CircleAlert, Leaf, LoaderCircle, LockKeyhole, MessageCircle, Moon, Plus, RotateCcw, ShieldCheck, Sparkles, Sun } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_MESSAGE, type ApiErrorBody, type HealthRequest, type HealthResponse, type Stage } from "@/lib/schemas";
import { immediateEmergency } from "@/lib/emergency";
import { EmergencyActions } from "./emergency-actions";
import { HealthReport } from "./health-report";

type Message = { id: number; role: "assistant" | "user"; text: string };
type UiError = { code: string; message: string; retryAt: number };
const WELCOME: Message = { id: 0, role: "assistant", text: "Hi, let’s start with you. Share how you’re feeling, any health readings you have, or what you’d like to understand. We’ll take it one step at a time." };
const EXAMPLE = "I am 32 years old, female, not pregnant. I have felt tired for three days, with no chest pain, shortness of breath or fainting. My blood pressure today is 128/82 mmHg, hemoglobin 12.4 g/dL (lab reference range 12.0-15.5 g/dL), fasting glucose 94 mg/dL, weight 65 kg and height 165 cm. I have no known medical conditions, take no medicines and have no known food allergies. I prefer vegetarian Bangladeshi meals. I walk 30 minutes most days and sleep around six hours.";
const STAGE_LABEL: Record<Stage, string> = { intake: "Organizing what you shared", summary: "Reviewing your health context", diet: "Considering suitable food ideas", questions: "Finding helpful follow-up questions" };

export function HealthApp() {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [draft, setDraft] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<Stage | null>(null);
  const [report, setReport] = useState<HealthResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [tick, setTick] = useState(Date.now());
  const [activeView, setActiveView] = useState<"chat" | "report">("chat");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const checkpoint = useRef<string | null>(null);
  const retryRequest = useRef<HealthRequest | null>(null);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const id = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, busy]);
  useEffect(() => {
    const saved = window.localStorage.getItem("healthnotes-theme");
    const selected = saved === "dark" || saved === "light" ? saved : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = selected;
    setTheme(selected);
  }, []);
  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => {
    if (!error?.retryAt) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [error?.retryAt]);

  function append(role: Message["role"], text: string) {
    setMessages((old) => [...old, { id: ++id.current, role, text }]);
  }

  async function runSequence(first: HealthRequest) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const run = ++generation.current;
    let request = first;
    setError(null);
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        setBusy(request.stage);
        retryRequest.current = request;
        const response = await fetch("/api/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal, cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (run !== generation.current) return;
        if (!response.ok) {
          const details = (payload as ApiErrorBody | null)?.error;
          const delay = details?.retryAfter || (response.status === 429 ? Number(response.headers.get("retry-after")) || 60 : 0);
          setTick(Date.now());
          setError({ code: details?.code || (response.status === 429 ? "RATE_LIMIT" : "REQUEST_FAILED"), message: details?.message || (response.status === 429 ? "The app's request limit was reached. Please wait, then retry this step." : "This step couldn't finish. Please try again."), retryAt: delay ? Date.now() + delay * 1000 : 0 });
          return;
        }
        if (!payload) throw new Error("Invalid server response");
        const data = payload as HealthResponse;
        checkpoint.current = data.checkpoint;
        if (!data.nextStage) {
          setReport(data);
          setStale(false);
          const followUp = data.phase === "complete" ? (data.summary?.followUpQuestions[0] || data.diet?.questions[0]) : null;
          append("assistant", data.message + (followUp ? `\n\n${followUp}` : ""));
          retryRequest.current = null;
          return;
        }
        request = { stage: data.nextStage, checkpoint: data.checkpoint };
      }
    } catch (cause) {
      if (controller.signal.aborted || run !== generation.current) return;
      setError({ code: "NETWORK_ERROR", message: "We couldn't connect to the app. Check your connection, then retry this step.", retryAt: 0 });
    } finally {
      if (run === generation.current) setBusy(null);
    }
  }

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim() || !consent || busy || error) return;
    const text = draft.trim();
    append("user", text);
    setDraft("");
    setStale(!!report);
    void runSequence({ stage: "intake", message: text, checkpoint: checkpoint.current });
  }

  function reset() {
    generation.current += 1;
    abort.current?.abort();
    checkpoint.current = null;
    retryRequest.current = null;
    setMessages([WELCOME]);
    setReport(null);
    setStale(false);
    setDraft("");
    setError(null);
    setBusy(null);
    setActiveView("chat");
    textarea.current?.focus();
  }

  function fill(text: string) {
    setDraft(text);
    setActiveView("chat");
    window.requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function chooseTheme() {
    const selected = theme === "light" ? "dark" : "light";
    setTheme(selected);
    document.documentElement.dataset.theme = selected;
    window.localStorage.setItem("healthnotes-theme", selected);
  }

  const waitSeconds = error ? Math.max(0, Math.ceil((error.retryAt - tick) / 1000)) : 0;
  const restartRequired = error && ["SESSION_EXPIRED", "CONTEXT_LIMIT", "WRONG_STAGE"].includes(error.code);

  return <main className="app-shell">
    <header className="site-header"><a className="brand" href="/" aria-label="Health Notes home"><span className="brand-mark"><Leaf size={24} strokeWidth={1.8} /></span><span>health<span className="brand-light">notes</span><span className="brand-period">.</span></span></a><div className="header-actions"><button type="button" className="theme-button" onClick={chooseTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`} title="Change app theme">{theme === "light" ? <Moon size={16} /> : <Sun size={16} />}<span>{theme === "light" ? "Dark" : "Light"} theme</span></button><button type="button" className="button-secondary" onClick={reset}><Plus size={16} />New report</button></div></header>

    <section className="hero"><div><p className="eyebrow"><span className="tiny-line" />YOUR HEALTH, IN CONTEXT</p><h1>Your health,<br /><span>a little clearer.</span></h1><p className="hero-description">Share symptoms, readings, and everyday habits. Get a thoughtful review and useful next steps.</p></div><div className="hero-aside" aria-hidden="true"><span className="hero-glow" /><div className="hero-aside-icon"><SproutIcon /></div><div className="hero-tags"><span>Understand</span><span>Track</span><span>Eat well</span></div></div></section>

    <div className="mobile-view-switch" aria-label="App view"><button type="button" className={activeView === "chat" ? "active" : ""} onClick={() => setActiveView("chat")}><MessageCircle size={16} />Conversation</button><button type="button" className={activeView === "report" ? "active" : ""} onClick={() => setActiveView("report")}><ActivityIcon />Your notes{report?.summary && <span className="notification-dot" />}</button></div>

    <div className={`workspace mobile-${activeView}`}>
      <section className="chat-panel panel" aria-labelledby="conversation-heading">
        <div className="panel-header"><div><span className="panel-kicker">ONE STEP AT A TIME</span><h2 id="conversation-heading">Let’s start with you</h2></div><span className="chat-header-icon"><MessageCircle size={20} strokeWidth={1.5} /></span></div>
        <div className="messages" role="log" tabIndex={0} aria-label="Health conversation" aria-live="polite" aria-busy={!!busy}>
          <div className="conversation-date">YOUR HEALTH, IN YOUR WORDS</div>
          {messages.map((message) => <article key={message.id} className={`chat-message ${message.role}`}><span className="message-avatar" aria-hidden="true">{message.role === "assistant" ? <Leaf size={15} /> : "You"}</span><div className="message-content"><span className="message-author">{message.role === "assistant" ? "Health Notes" : "You"}</span><div className="message-bubble">{message.text.split("\n\n").map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div></div></article>)}
          {messages.length === 1 && <div className="starter-options"><p>Not sure where to start?</p><button type="button" onClick={() => fill("I have been feeling tired and weak lately, but I don't have any health measurements. What should I consider?")}><span><span className="starter-dot mint" />I’d like to talk about symptoms</span><ArrowUpRight size={15} /></button><button type="button" onClick={() => fill("Here are my health readings: ")}><span><span className="starter-dot peach" />I have some health readings</span><ArrowUpRight size={15} /></button><button type="button" onClick={() => fill(EXAMPLE)}><span><span className="starter-dot lavender" />Try a fictional example</span><Sparkles size={14} /></button></div>}
          {busy && <div className="thinking" role="status"><span className="thinking-dots"><i /><i /><i /></span><span>{STAGE_LABEL[busy]}…</span></div>}
          <div ref={bottom} />
        </div>

        {error && <div className="error-notice" role="alert"><CircleAlert size={18} /><div><strong>{error.code === "SETUP_REQUIRED" ? "One small setup step" : "Let’s pick up where we left off"}</strong><p>{error.message}</p><div className="error-actions">{restartRequired ? <button type="button" onClick={reset}>Start a new report <ArrowUpRight size={14} /></button> : <button type="button" disabled={!!busy || waitSeconds > 0} onClick={() => { if (retryRequest.current) void runSequence(retryRequest.current); }}><RotateCcw size={13} />{waitSeconds ? `Retry in ${waitSeconds}s` : "Retry this step"}</button>}</div></div></div>}

        <form className="composer" onSubmit={send}>
          {immediateEmergency(draft) && <EmergencyActions compact />}
          {messages.length > 1 && !busy && report?.summary && <button type="button" className="mobile-report-link" onClick={() => { setActiveView("report"); document.querySelector(".report-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Your updated health notes are ready <ArrowUpRight size={14} /></button>}
          <label className="sr-only" htmlFor="health-message">Your health information or follow-up</label><div className="composer-input"><textarea id="health-message" ref={textarea} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={MAX_MESSAGE} placeholder="How have you been feeling? Share symptoms, readings, or a little about yourself…" rows={4} disabled={!!busy} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } }} /><div className="composer-input-footer"><span>Symptoms, readings, or a follow-up</span><span>{draft.length.toLocaleString()} / 8,000</span></div></div>
          <label className="consent-label"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>I understand my health notes are sent to Groq for extraction and, when configured, OpenRouter for summaries and Hugging Face for food ideas.</span></label>
          <button className="button-primary send-button" type="submit" disabled={!draft.trim() || !consent || !!busy || !!error}>{busy ? <><LoaderCircle size={17} className="spin" />{STAGE_LABEL[busy]}…</> : <><span>{messages.length === 1 ? "Make sense of my notes" : "Send a follow-up"}</span><ArrowUp size={17} /></>}</button>
          <p className="composer-privacy"><LockKeyhole size={11} />Notes stay in this tab. Refreshing clears this conversation.</p>
        </form>
      </section>
      <HealthReport report={report} busy={busy} stale={stale} onPrompt={fill} />
    </div>

    <footer className="site-footer"><div><ShieldCheck size={16} /><p>For understanding, not diagnosis. AI can miss important details.<br className="footer-break" /> Review concerns with a healthcare professional; seek urgent care for severe or sudden symptoms.</p></div><span>MADE FOR A LITTLE MORE CLARITY <Leaf size={13} /></span></footer>
  </main>;
}

function SproutIcon() {
  return <svg viewBox="0 0 54 54" width="54" height="54" fill="none" aria-hidden="true"><path d="M27 43V25m0 7C15 32 9 25 10 15c11-1 18 5 17 17Zm0-5c0-12 6-18 17-18 0 11-5 18-17 18Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M18 43h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function ActivityIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
