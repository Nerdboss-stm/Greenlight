import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ApiClientError, getPolicies, retrievePolicy, streamCase, summarize } from "../api";
import {
  Button,
  DataValue,
  DecisionBanner,
  EvidenceRow,
  FileDrop,
  PatientContextView,
  PolicyView,
  Tag,
  TraceTheater,
  TrustBadges,
} from "../components";
import { SectionRule } from "../components/SectionRule";
import type { CriterionStatus, Verdict as StampVerdict } from "../components/types";
import { ingestFile } from "../lib/ingest";
import type { Criterion, Determination, PatientContext, Policy, TraceEvent } from "../types";

interface Loaded {
  ctx: PatientContext;
  /** the raw record re-sent to /case (the engine re-parses it) */
  raw: Record<string, unknown>;
  modality: string;
  filename: string;
}

interface Demo {
  title: string;
  sub: string;
  file: string;
}

const DEMOS: Demo[] = [
  { title: "COVID-19 / hypoxemia", sub: "Oxygen · acute → DENY", file: "abridge-covid-hypoxemia.json" },
  { title: "Diabetic on brand insulin", sub: "CGM · argue & flip → APPROVE", file: "synthea-cgm-lantus.json" },
  { title: "Insulin diabetic", sub: "CGM · on insulin", file: "synthea-cgm-insulin.json" },
  { title: "Diabetic, no foot condition", sub: "Footwear · outpatient", file: "synthea-footwear-no-foot.json" },
];

const POLICY_LABEL: Record<string, string> = {
  home_oxygen: "Home Oxygen · NCD 240.2",
  therapeutic_footwear: "Therapeutic Footwear · L33369",
  cgm: "Continuous Glucose Monitor · L33822",
};
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const labelFor = (slug: string) => POLICY_LABEL[slug] ?? titleCase(slug);

const VERDICT_LOWER: Record<string, StampVerdict> = {
  APPROVE: "approve",
  DENY: "deny",
  INSUFFICIENT: "insufficient",
};

export function LiveScreen() {
  const reduce = useReducedMotion();

  // intake
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("Parsing patient context…");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // policy
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [procedure, setProcedure] = useState("");
  const [composing, setComposing] = useState(false);
  const [draftName, setDraftName] = useState("");

  // run
  const [runId, setRunId] = useState(0);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [determination, setDetermination] = useState<Determination | null>(null);
  const [performed, setPerformed] = useState(false);
  const [activeCrit, setActiveCrit] = useState<string | null>(null);
  const [showWork, setShowWork] = useState(false);

  const resolved = !!determination && performed;

  useEffect(() => {
    let cancelled = false;
    const load = (attempt = 0) => {
      getPolicies()
        .then((ps) => !cancelled && setPolicies(ps))
        .catch(() => !cancelled && attempt < 3 && setTimeout(() => load(attempt + 1), 1500));
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const toMessage = (e: unknown) =>
    e instanceof ApiClientError ? `${e.type} — ${e.message}` : String((e as Error)?.message ?? e);

  const clearRun = () => {
    setRunning(false);
    setEvents([]);
    setDetermination(null);
    setPerformed(false);
    setActiveCrit(null);
    setShowWork(false);
  };

  const handleFile = async (file: File) => {
    setError(null);
    setPending(true);
    setLoaded(null);
    clearRun();
    setStatus("Reading document…");
    try {
      const ing = await ingestFile(file, setStatus);
      setStatus("Parsing patient context…");
      const ctx = await summarize(ing.input);
      setLoaded({ ctx, raw: ing.input as Record<string, unknown>, modality: ing.label, filename: ing.filename });
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  const loadDemo = async (demo: Demo) => {
    setError(null);
    setPending(true);
    setLoaded(null);
    clearRun();
    setStatus("Parsing patient context…");
    try {
      const res = await fetch(`/demo/${demo.file}`);
      if (!res.ok) throw new Error(`sample not found (${res.status})`);
      const json = (await res.json()) as Record<string, unknown>;
      const ctx = await summarize(json);
      setLoaded({ ctx, raw: json, modality: "FHIR · JSON", filename: demo.file });
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  const pickPolicy = (proc: string) => {
    setProcedure(proc);
    setComposing(false);
    setError(null);
    clearRun();
    setPolicy(proc ? policies.find((p) => p.procedure === proc) ?? null : null);
  };

  const retrieveByName = async () => {
    if (!draftName.trim()) return;
    setError(null);
    setPending(true);
    setStatus("Retrieving policy — connector → web search → fetch → decompose…");
    try {
      const p = await retrievePolicy(draftName.trim());
      setPolicies((prev) => [...prev.filter((x) => x.procedure !== p.procedure), p]);
      setProcedure(p.procedure);
      setPolicy(p);
      setComposing(false);
      setDraftName("");
      clearRun();
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  const newIntake = () => {
    setLoaded(null);
    setPolicy(null);
    setProcedure("");
    setComposing(false);
    setError(null);
    clearRun();
  };

  // The run. streamCase performs live; on ANY stream failure it falls back to
  // the plain response and replays trace[] through onEvent — indistinguishable.
  // We dedupe by seq so a mid-run kill (partial stream, then full replay) is clean.
  const run = async () => {
    if (!loaded || !policy || running) return;
    setError(null);
    setEvents([]);
    setDetermination(null);
    setPerformed(false);
    setActiveCrit(null);
    setShowWork(false);
    setRunId((n) => n + 1);
    setRunning(true);
    try {
      const det = await streamCase(
        { patient_file: loaded.raw, procedure: policy.procedure, mode: "adversarial" },
        (ev) =>
          setEvents((prev) =>
            prev.some((e) => e.seq === ev.seq) ? prev : [...prev, ev].sort((a, b) => a.seq - b.seq),
          ),
      );
      setDetermination(det);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const critMap = useMemo(() => {
    const m = new Map<string, Criterion>();
    policy?.criteria.forEach((c) => m.set(c.id, c));
    return m;
  }, [policy]);

  const arbiterExpr = useMemo(
    () => events.find((e) => e.type === "arbiter_math")?.label ?? "",
    [events],
  );

  const runReady = !!loaded && !!policy && !pending;

  return (
    <div className="gl-shell">
      {/* ---------------- Left rail: the control panel ---------------- */}
      <aside className="gl-rail">
        <div>
          <div className="gl-mark">
            <span className="gl-mark__light" />
            <span className="gl-mark__name">GreenLight</span>
          </div>
          <div className="gl-mark__sub">Prior Authorization</div>
        </div>

        {loaded ? (
          <div className="gl-pcard">
            <span className="gl-eyebrow">Patient</span>
            <div className="gl-pcard__id">
              {loaded.ctx.demographics.age}
              <span className="gl-pcard__sex"> · {loaded.ctx.demographics.sex}</span>
            </div>
            <div className="gl-pcard__chips">
              <span className="gl-chip gl-chip--accent">{loaded.modality}</span>
              <span className="gl-chip">{loaded.ctx.diagnoses.length} dx</span>
              <span className="gl-chip">{loaded.ctx.labs.length} labs</span>
              <span className="gl-chip">{loaded.ctx.meds.length} meds</span>
              <span className="gl-chip">{loaded.ctx.foot_conditions.length} foot</span>
            </div>
            <div className="gl-pcard__file">{loaded.filename}</div>
          </div>
        ) : (
          <FileDrop
            onFile={handleFile}
            accept=".json,.jsonl,.pdf,.txt,.md,.png,.jpg,.jpeg,.webp,.tif,.tiff,image/*"
            disabled={pending}
          />
        )}

        {!loaded && (
          <div className="gl-field">
            <span className="gl-eyebrow gl-field__label">Sample patients</span>
            <div className="gl-demos">
              {DEMOS.map((d) => (
                <button key={d.file} className="gl-demo" onClick={() => loadDemo(d)} disabled={pending}>
                  <span className="gl-demo__title">{d.title}</span>
                  <span className="gl-demo__sub">{d.sub}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="gl-field">
          <span className="gl-eyebrow gl-field__label">Policy</span>
          <div className="gl-select-wrap">
            <select
              className="gl-select"
              value={procedure}
              onChange={(e) => pickPolicy(e.target.value)}
              disabled={pending || running || policies.length === 0}
            >
              <option value="">— choose a policy —</option>
              {policies.map((p) => (
                <option key={p.procedure} value={p.procedure}>
                  {labelFor(p.procedure)}
                </option>
              ))}
            </select>
          </div>

          {composing ? (
            <div className="gl-newpolicy__row">
              <input
                className="gl-input--text"
                value={draftName}
                placeholder="e.g. power mobility device"
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && retrieveByName()}
                autoFocus
              />
              <div className="gl-newpolicy__actions">
                <Button variant="go" dot onClick={retrieveByName} disabled={!draftName.trim() || pending}>
                  Retrieve
                </Button>
                <Button onClick={() => setComposing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <button className="gl-btn gl-newpolicy" onClick={() => setComposing(true)} disabled={pending || running}>
              + New policy
            </button>
          )}

          {policy && !composing && (
            <div className="gl-pcard__chips gl-policychips">
              <span className="gl-chip">{policy.criteria.length} criteria</span>
              <span className="gl-chip">{policy.criteria.filter((c) => c.type === "hard").length} hard</span>
              <span className="gl-chip gl-chip--accent">{policy.version_hash}</span>
            </div>
          )}
        </div>

        <div className="gl-run">
          <Button variant="go" dot onClick={run} disabled={!runReady || running} className="gl-run__btn">
            {running ? "Adjudicating…" : resolved ? "Run again" : "Run adjudication"}
          </Button>
          {!runReady && !running && (
            <div className="gl-run__hint">
              {loaded ? "Choose a policy to adjudicate." : "Load a patient, then choose a policy."}
            </div>
          )}
          {(loaded || policy) && (
            <button className="gl-btn gl-run__reset" onClick={newIntake} disabled={running}>
              New intake
            </button>
          )}
        </div>

        <div className="gl-rail__spacer" />
        <div className="gl-rail__foot">
          adversarial mode · reviewer → argument → arbiter
          <br />
          deterministic arbiter · never the model
          <br />
          fail-closed · absent evidence → insufficient
        </div>
      </aside>

      {/* ---------------- Reading column: the workspace ---------------- */}
      <main className="gl-read">
        {error ? (
          <div className="gl-read__inner">
            <div className="gl-errbox">
              <div className="gl-errbox__title">Something went wrong</div>
              <div className="gl-errbox__msg">{error}</div>
            </div>
          </div>
        ) : pending ? (
          <div className="gl-read__inner">
            <div className="gl-state">
              <motion.span
                className="gl-trace__pulse"
                animate={reduce ? undefined : { opacity: [1, 0.25, 1] }}
                transition={reduce ? undefined : { duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
              />
              <span className="gl-state__label">{status}</span>
            </div>
          </div>
        ) : resolved && determination ? (
          <DeterminationView
            det={determination}
            events={events}
            policy={policy}
            critMap={critMap}
            arbiterExpr={arbiterExpr}
            runId={runId}
            activeCrit={activeCrit}
            onActiveCrit={setActiveCrit}
            showWork={showWork}
            onShowWork={setShowWork}
          />
        ) : running || events.length > 0 ? (
          <div className="gl-read__inner">
            <header>
              <div className="gl-eyebrow gl-doc__eyebrow">Adjudicating</div>
              <h1 className="gl-doc__title">{policy ? labelFor(policy.procedure) : "Case"}</h1>
            </header>
            <TraceTheater
              events={events}
              running={running || !determination}
              onPerformed={() => setPerformed(true)}
            />
          </div>
        ) : loaded && policy ? (
          <>
            <div className="gl-read__inner" style={{ paddingBottom: 0 }}>
              <div className="gl-runbar">
                <div>
                  <span className="gl-eyebrow">Ready to adjudicate</span>
                  <div className="gl-runbar__title">
                    {loaded.ctx.demographics.age} · {loaded.ctx.demographics.sex} against {labelFor(policy.procedure)}
                  </div>
                </div>
                <Button variant="go" dot onClick={run}>
                  Run adjudication
                </Button>
              </div>
            </div>
            <PolicyView policy={policy} label={labelFor(policy.procedure)} />
          </>
        ) : loaded ? (
          <>
            <div className="gl-read__inner" style={{ paddingBottom: 0 }}>
              <div className="gl-hint-bar">Patient loaded — choose a policy in the left rail to adjudicate.</div>
            </div>
            <PatientContextView ctx={loaded.ctx} modality={loaded.modality} filename={loaded.filename} />
          </>
        ) : (
          <div className="gl-read__inner">
            <div className="gl-prompt">
              <div className="gl-prompt__eyebrow gl-eyebrow">Live plane</div>
              <h1 className="gl-prompt__title">Adjudicate a prior authorization</h1>
              <p className="gl-prompt__body">
                Load a patient record on the left and pick a CMS policy. GreenLight retrieves and
                decomposes the policy, a reviewer judges every criterion with tool-grounded citations, an
                argument layer contests the close calls, and a deterministic arbiter returns the decision —
                and shows all of its work.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface DeterminationViewProps {
  det: Determination;
  events: TraceEvent[];
  policy: Policy | null;
  critMap: Map<string, Criterion>;
  arbiterExpr: string;
  runId: number;
  activeCrit: string | null;
  onActiveCrit: (id: string | null) => void;
  showWork: boolean;
  onShowWork: (v: boolean) => void;
}

function DeterminationView({
  det,
  events,
  policy,
  critMap,
  arbiterExpr,
  runId,
  activeCrit,
  onActiveCrit,
  showWork,
  onShowWork,
}: DeterminationViewProps) {
  const reduce = useReducedMotion();
  const stampVerdict = VERDICT_LOWER[det.verdict] ?? "insufficient";

  const active = activeCrit ? det.criteria.find((c) => c.id === activeCrit) ?? null : null;
  const activeCriterion = active ? critMap.get(active.id) : undefined;

  const clauseSource = (() => {
    if (!activeCriterion) return policy?.source;
    const bits: string[] = [];
    if (activeCriterion.threshold) {
      const t = activeCriterion.threshold;
      bits.push(`threshold ${t.op} ${t.value}${t.unit ? ` ${t.unit}` : ""}`);
    }
    if (activeCriterion.context_conditions.length) bits.push(activeCriterion.context_conditions.join(" · "));
    return bits.length ? bits.join(" · ") : policy?.source;
  })();

  const seal = (
    <>
      {policy ? labelFor(policy.procedure) : det.verdict}
      <br />
      {policy?.version_hash ?? "adversarial"}
    </>
  );

  return (
    <motion.div
      className="gl-read__inner"
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <DecisionBanner
        verdict={stampVerdict}
        seal={seal}
        rationale={<span className="gl-mono">{arbiterExpr}</span>}
        stampKey={runId}
        delay={0.05}
      />

      <TrustBadges events={events} determination={det} replayKey={runId} />

      <div className="gl-block">
        <SectionRule label="Criteria" index="§1" meta={`${det.criteria.length}`} />
        <div className="gl-criteria">
          {det.criteria.map((cr) => {
            const c = critMap.get(cr.id);
            return (
              <Tag
                key={cr.id}
                label={c?.text ?? cr.id}
                status={cr.verdict as CriterionStatus}
                clauseRef={cr.policy_clause}
                kind={c?.type}
                active={activeCrit === cr.id}
                onClick={() => onActiveCrit(activeCrit === cr.id ? null : cr.id)}
              />
            );
          })}
        </div>
      </div>

      {active && (
        <div className="gl-block">
          <SectionRule label="Evidence" index="§2" meta={active.id} />
          <EvidenceRow
            replayKey={active.id}
            clauseRef={active.policy_clause}
            clauseText={activeCriterion?.quote || activeCriterion?.text || active.policy_clause}
            clauseSource={clauseSource}
            fieldPath={active.patient_evidence.path || "— not resolved —"}
            patientValue={
              active.patient_evidence.value == null ? (
                <DataValue value="absent" tone="muted" />
              ) : (
                <DataValue value={active.patient_evidence.value} tone={active.verdict as CriterionStatus} />
              )
            }
            patientSource={`confidence ${active.confidence.toFixed(2)}`}
          />
          <p className="gl-evnote">{active.reasoning}</p>
        </div>
      )}
      {!active && <div className="gl-hint-bar gl-hint-bar--quiet">Click any criterion to see its clause meet the chart.</div>}

      <ActionsPanel det={det} />

      <div className="gl-block">
        <button className="gl-showwork" onClick={() => onShowWork(!showWork)}>
          <span className="gl-showwork__mark">{showWork ? "−" : "+"}</span>
          {showWork ? "Hide the work" : "Show the work"}
          <span className="gl-showwork__meta">{events.length} trace events</span>
        </button>
        {showWork && (
          <div className="gl-drawer">
            <TraceTheater events={events} instant />
          </div>
        )}
      </div>

      <div className="gl-trustline">
        Adjudicated by the GreenLight engine · every verdict comes from the deterministic arbiter.{" "}
        <a href="#evals" className="gl-trustline__link">
          See how it scores on the eval harness →
        </a>
      </div>
    </motion.div>
  );
}

function ActionsPanel({ det }: { det: Determination }) {
  const a = det.actions;
  if (det.verdict === "INSUFFICIENT" && a.gap_query) {
    return (
      <div className="gl-actpanel gl-actpanel--amber">
        <div className="gl-actpanel__title">Information gap</div>
        <p className="gl-actpanel__body">{a.gap_query}</p>
        {a.review_queued && <div className="gl-actpanel__meta">Queued for human review.</div>}
      </div>
    );
  }
  if (det.verdict === "DENY" && a.appeal) {
    return (
      <div className="gl-actpanel gl-actpanel--red">
        <div className="gl-actpanel__title">Appeal draft</div>
        <p className="gl-actpanel__body">{a.appeal}</p>
      </div>
    );
  }
  if (det.verdict === "APPROVE") {
    return (
      <div className="gl-actpanel gl-actpanel--green">
        <div className="gl-actpanel__title">Recorded</div>
        <p className="gl-actpanel__body">All hard criteria met — approved and recorded. No query or appeal needed.</p>
      </div>
    );
  }
  return null;
}
