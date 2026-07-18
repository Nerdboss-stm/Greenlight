import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Variants } from "motion/react";
import { ApiClientError, authorGold, getPolicies, runEval, submitBasket } from "../api";
import { Button, PlaneNav } from "../components";
import { SectionRule } from "../components/SectionRule";
import type { CriterionStatus } from "../components/types";
import { STATUS_HEX } from "../components/types";
import type {
  EvalResult,
  GoldCase,
  ModeStats,
  Policy,
  RejectedCandidate,
  Taxonomy as TaxonomyT,
} from "../types";

const POLICY_LABEL: Record<string, string> = {
  home_oxygen: "Home Oxygen · NCD 240.2",
  therapeutic_footwear: "Therapeutic Footwear · L33369",
  cgm: "Continuous Glucose Monitor · L33822",
};
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const labelFor = (slug: string) => POLICY_LABEL[slug] ?? titleCase(slug);

const AUTHOR_TARGETS = 8; // enough to cover every branch + trap for the built-in policies
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const money = (n: number) => `$${n.toFixed(4)}`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
const sleep = (t: number) => new Promise<void>((r) => setTimeout(r, t));

const listV: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.14 } } };
const cardV: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const } },
};

type Candidate =
  | { kind: "rejected"; rej: RejectedCandidate; key: string }
  | { kind: "accepted"; gc: GoldCase; key: string };

interface Progress {
  i: number;
  total: number;
  id: string;
}

export function EvalScreen() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [authorProc, setAuthorProc] = useState<string | null>(null);
  const [authoring, setAuthoring] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>({});

  const [basket, setBasket] = useState<GoldCase[]>([]);
  const [basketSize, setBasketSize] = useState<Record<string, number>>({});

  const [evalProc, setEvalProc] = useState<string | null>(null);
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

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

  const runGoldCases = async (proc: string) => {
    setError(null);
    setAuthorProc(proc);
    setAuthoring(true);
    setCandidates([]);
    setEvalResult(null);
    setEvalProc(null);
    try {
      const res = await authorGold(proc, AUTHOR_TARGETS);
      // Deaths first (bad labels dying in public), then the survivors to act on.
      const combined: Candidate[] = [
        ...res.rejected.map((rej, i) => ({ kind: "rejected" as const, rej, key: `rej-${proc}-${i}` })),
        ...res.accepted.map((gc) => ({ kind: "accepted" as const, gc, key: gc.case_id })),
      ];
      setCandidates(combined);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setAuthoring(false);
    }
  };

  const decide = async (gc: GoldCase, decision: "accept" | "reject") => {
    setDecisions((d) => ({ ...d, [gc.case_id]: decision }));
    setBasket((b) => {
      const without = b.filter((c) => c.case_id !== gc.case_id);
      return decision === "accept" ? [...without, gc] : without;
    });
    try {
      const res = await submitBasket({ procedure: gc.procedure, decisions: { [gc.case_id]: decision } });
      setBasketSize((s) => ({ ...s, [gc.procedure]: res.basket_size }));
    } catch (e) {
      setError(toMessage(e));
    }
  };

  const runEvals = async (proc: string) => {
    setError(null);
    setEvalProc(proc);
    setEvalRunning(true);
    setEvalResult(null);
    const ids = basket.filter((c) => c.procedure === proc).map((c) => c.case_id);
    const resultP = runEval({ procedure: proc, mode: "adversarial" });
    resultP.catch(() => {}); // handled below; avoid unhandled rejection during the tick
    try {
      for (let i = 0; i < ids.length; i++) {
        setProgress({ i: i + 1, total: ids.length, id: ids[i] });
        await sleep(260);
      }
      const res = await resultP;
      setEvalResult(res);
      setProgress(null);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setEvalRunning(false);
    }
  };

  return (
    <div className="gl-shell">
      {/* ---------------- Rail ---------------- */}
      <aside className="gl-rail">
        <div>
          <div className="gl-mark">
            <span className="gl-mark__light" />
            <span className="gl-mark__name">GreenLight</span>
          </div>
          <div className="gl-mark__sub">Eval Harness</div>
        </div>

        <PlaneNav active="evals" />

        <GoldenBasket basket={basket} basketSize={basketSize} />

        <div className="gl-rail__spacer" />
        <div className="gl-rail__foot">
          author → validate → human-verify → score
          <br />
          rejected labels shown, never hidden
          <br />
          single vs adversarial · the ablation
        </div>
      </aside>

      {/* ---------------- Reading column ---------------- */}
      <main className="gl-read">
        <div className="gl-read__inner">
          <header>
            <div className="gl-eyebrow gl-doc__eyebrow">Eval Plane</div>
            <h1 className="gl-doc__title">Eval Panel</h1>
            <p className="gl-doc__sub">
              Author synthetic gold cases, watch the validator kill the bad ones, verify the survivors,
              then score the engine — single vs. adversarial.
            </p>
          </header>

          {error && (
            <div className="gl-errbox">
              <div className="gl-errbox__title">Something went wrong</div>
              <div className="gl-errbox__msg">{error}</div>
            </div>
          )}

          {/* Policy table */}
          <div className="gl-block">
            <SectionRule label="Policies" index="§1" meta={`${policies.length} pinned`} />
            <table className="gl-ptable">
              <thead>
                <tr>
                  <th>Policy</th>
                  <th className="gl-num">Criteria</th>
                  <th className="gl-num">Basket</th>
                  <th className="gl-ptable__act">Gold cases</th>
                  <th className="gl-ptable__act">Evals</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => {
                  const busyAuthor = authoring && authorProc === p.procedure;
                  const busyEval = evalRunning && evalProc === p.procedure;
                  const size = basketSize[p.procedure] ?? basket.filter((c) => c.procedure === p.procedure).length;
                  return (
                    <tr key={p.procedure}>
                      <td>
                        <span className="gl-ptable__name">{labelFor(p.procedure)}</span>
                        <span className="gl-ptable__hash">{p.version_hash}</span>
                      </td>
                      <td className="gl-num">{p.criteria.length}</td>
                      <td className="gl-num">{size || "—"}</td>
                      <td className="gl-ptable__act">
                        <Button onClick={() => runGoldCases(p.procedure)} disabled={authoring || evalRunning}>
                          {busyAuthor ? "Authoring…" : "Run Gold Cases"}
                        </Button>
                      </td>
                      <td className="gl-ptable__act">
                        <Button
                          variant="go"
                          dot
                          onClick={() => runEvals(p.procedure)}
                          disabled={authoring || evalRunning || size === 0}
                        >
                          {busyEval ? "Running…" : "Run Evals"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {policies.length === 0 && (
                  <tr>
                    <td colSpan={5} className="gl-empty">
                      loading pinned policies…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Authoring strip */}
          {(authoring || candidates.length > 0) && authorProc && (
            <div className="gl-block">
              <SectionRule
                label="Authored candidates"
                index="§2"
                meta={authoring ? "authoring…" : `${labelFor(authorProc)}`}
              />
              {authoring && candidates.length === 0 ? (
                <div className="gl-state">
                  <span className="gl-trace__pulse" />
                  <span className="gl-state__label">
                    Authoring candidates with claude-opus-4-8, validating each against the engine…
                  </span>
                </div>
              ) : (
                <motion.div className="gl-strip" variants={listV} initial="hidden" animate="show">
                  {candidates.map((c) =>
                    c.kind === "rejected" ? (
                      <RejectedCard key={c.key} rej={c.rej} />
                    ) : (
                      <CandidateCard
                        key={c.key}
                        gc={c.gc}
                        decision={decisions[c.gc.case_id]}
                        onDecide={decide}
                      />
                    ),
                  )}
                </motion.div>
              )}
            </div>
          )}

          {/* Eval progress + panel */}
          {evalRunning && (
            <div className="gl-block">
              <SectionRule label="Running evals" index="§3" meta={evalProc ? labelFor(evalProc) : ""} />
              <EvalProgress progress={progress} />
            </div>
          )}

          {evalResult && !evalRunning && (
            <EvalPanel result={evalResult} procedure={evalProc} />
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

function GoldenBasket({ basket, basketSize }: { basket: GoldCase[]; basketSize: Record<string, number> }) {
  const verified = Object.values(basketSize).reduce((a, b) => a + b, 0);
  return (
    <div className="gl-field">
      <span className="gl-eyebrow gl-field__label">Golden Basket</span>
      <div className="gl-basket">
        <div className="gl-basket__count">
          <span className="gl-basket__n">{basket.length}</span>
          <span className="gl-basket__k">accepted this session{verified ? ` · ${verified} verified` : ""}</span>
        </div>
        {basket.length === 0 ? (
          <div className="gl-basket__empty">— accept cases to fill —</div>
        ) : (
          <ul className="gl-basket__list">
            {basket.map((c) => (
              <li key={c.case_id}>
                <span className="gl-basket__sq" aria-hidden />
                <span className="gl-basket__id">{c.case_id.replace(/^gold-/, "")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RejectedCard({ rej }: { rej: RejectedCandidate }) {
  return (
    <motion.div className="gl-cand gl-cand--dead" variants={cardV}>
      <div className="gl-cand__head">
        <span className="gl-cand__stamp gl-cand__stamp--reject">rejected</span>
        <span className="gl-cand__branch gl-strike">{rej.branch}</span>
        {rej.intended && <span className="gl-cand__intended gl-strike">intended {rej.intended}</span>}
      </div>
      <p className="gl-cand__reason">{rej.reason}</p>
      {rej.trap && <p className="gl-cand__trap">trap · {rej.trap}</p>}
    </motion.div>
  );
}

function CandidateCard({
  gc,
  decision,
  onDecide,
}: {
  gc: GoldCase;
  decision?: "accept" | "reject";
  onDecide: (gc: GoldCase, d: "accept" | "reject") => void;
}) {
  const p = gc.patient;
  const foot = p.foot_conditions.map((f) => f.display).slice(0, 3);
  const meds = p.meds.map((m) => m.name).slice(0, 3);
  const cls = decision === "accept" ? " gl-cand--accepted" : decision === "reject" ? " gl-cand--dead" : "";
  return (
    <motion.div className={`gl-cand${cls}`} variants={cardV}>
      <div className="gl-cand__head">
        <span className="gl-cand__stamp gl-cand__stamp--pass">validated ✓</span>
        <span className="gl-cand__branch">{gc.case_id.replace(/^gold-[^-]+-/, "").replace(/-[0-9a-f]{8}$/, "")}</span>
        {decision && (
          <span className={`gl-cand__decided gl-cand__decided--${decision}`}>
            {decision === "accept" ? "in basket" : "reviewer-rejected"}
          </span>
        )}
      </div>

      <div className="gl-cand__patient">
        <span className="gl-cand__demo">
          {p.demographics.age} · {p.demographics.sex}
        </span>
        <span className="gl-cand__facts">
          {p.diagnoses.length} dx · {p.meds.length} meds{foot.length ? ` · foot: ${foot.join(", ")}` : ""}
          {meds.length ? ` · meds: ${meds.join(", ")}` : ""}
        </span>
      </div>

      <p className="gl-cand__reason">{gc.reason}</p>

      <div className="gl-cand__expected">
        {Object.entries(gc.expected_criteria).map(([cid, v]) => (
          <span className="gl-exp" key={cid}>
            <span className="gl-square" style={{ backgroundColor: STATUS_HEX[v as CriterionStatus] }} aria-hidden />
            <span className="gl-exp__id">{cid.replace(/^[a-z]+_/, "")}</span>
            <span className="gl-exp__v" data-status={v}>
              {v}
            </span>
          </span>
        ))}
      </div>

      {!decision && (
        <div className="gl-cand__actions">
          <Button variant="go" dot onClick={() => onDecide(gc, "accept")}>
            Accept
          </Button>
          <Button onClick={() => onDecide(gc, "reject")}>Reject</Button>
        </div>
      )}
    </motion.div>
  );
}

function EvalProgress({ progress }: { progress: Progress | null }) {
  const reduce = useReducedMotion();
  return (
    <div className="gl-progress">
      <span className="gl-progress__mark">
        <motion.span
          className="gl-trace__pulse"
          animate={reduce ? undefined : { opacity: [1, 0.25, 1] }}
          transition={reduce ? undefined : { duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
        />
      </span>
      {progress ? (
        <span className="gl-progress__line">
          case {progress.i}/{progress.total} · {progress.id.replace(/^gold-/, "")} ✓
        </span>
      ) : (
        <span className="gl-progress__line">scoring single &amp; adversarial…</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Eval Panel

function EvalPanel({ result, procedure }: { result: EvalResult; procedure: string | null }) {
  const reduce = useReducedMotion();
  // Prefer the both-mode payload; fall back to reconstructing single from delta.
  const single: ModeStats | null =
    result.single ??
    (result.delta != null
      ? {
          case_accuracy: result.case_accuracy - result.delta,
          precision: result.per_criterion.precision,
          recall: result.per_criterion.recall,
          taxonomy: result.taxonomy,
          calibration: result.calibration,
          cost_per_case: result.cost_per_case,
          latency_per_case: result.latency_per_case,
        }
      : null);
  const adversarial: ModeStats = result.adversarial ?? {
    case_accuracy: result.case_accuracy,
    precision: result.per_criterion.precision,
    recall: result.per_criterion.recall,
    taxonomy: result.taxonomy,
    calibration: result.calibration,
    cost_per_case: result.cost_per_case,
    latency_per_case: result.latency_per_case,
  };
  const delta = result.delta ?? (single ? adversarial.case_accuracy - single.case_accuracy : 0);

  return (
    <motion.div
      className="gl-block gl-panel"
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <SectionRule label="Eval Panel" index="§4" meta={procedure ? labelFor(procedure) : result.mode} />

      {/* Hero: single vs adversarial case accuracy */}
      <div className="gl-hero">
        <div className="gl-hero__side">
          <span className="gl-hero__mode">Single</span>
          <span className="gl-hero__num">{single ? pct(single.case_accuracy) : "—"}</span>
          <span className="gl-hero__cap">reviewer only</span>
        </div>
        <div className="gl-hero__mid">
          <span className="gl-hero__arrow">→</span>
          <span className={`gl-hero__delta${delta >= 0 ? " gl-hero__delta--up" : " gl-hero__delta--down"}`}>
            {delta >= 0 ? "+" : ""}
            {pct(delta)}
          </span>
          <span className="gl-hero__cap">ablation Δ</span>
        </div>
        <div className="gl-hero__side gl-hero__side--adv">
          <span className="gl-hero__mode">Adversarial</span>
          <span className="gl-hero__num">{pct(adversarial.case_accuracy)}</span>
          <span className="gl-hero__cap">+ argument layer</span>
        </div>
      </div>

      {/* Failure taxonomy — hand-built thin bars, single vs adversarial */}
      <div className="gl-panel__sub">Failure taxonomy</div>
      <TaxonomyBars single={single?.taxonomy ?? adversarial.taxonomy} adversarial={adversarial.taxonomy} />

      {/* Metric cards */}
      <div className="gl-metrics">
        <MetricPair
          label="Per-criterion precision"
          single={single ? pct(single.precision) : "—"}
          adv={pct(adversarial.precision)}
        />
        <MetricPair
          label="Per-criterion recall"
          single={single ? pct(single.recall) : "—"}
          adv={pct(adversarial.recall)}
        />
        <MetricPair
          label="Author ↔ human calibration"
          single={single ? single.calibration.toFixed(3) : "—"}
          adv={adversarial.calibration.toFixed(3)}
        />
        <MetricSolo label="Decompose F1" value={result.decompose_f1.toFixed(3)} />
        <MetricPair
          label="Cost / case"
          single={single ? money(single.cost_per_case) : "—"}
          adv={money(adversarial.cost_per_case)}
        />
        <MetricPair
          label="Latency / case"
          single={single ? ms(single.latency_per_case) : "—"}
          adv={ms(adversarial.latency_per_case)}
        />
      </div>

      {/* Per-policy table */}
      <div className="gl-panel__sub">Per-policy</div>
      <table className="gl-ptable gl-ptable--tight">
        <thead>
          <tr>
            <th>Policy</th>
            <th className="gl-num">Case accuracy</th>
            <th className="gl-num">Cases</th>
          </tr>
        </thead>
        <tbody>
          {result.per_policy.map((pp) => (
            <tr key={pp.procedure}>
              <td>{labelFor(pp.procedure)}</td>
              <td className="gl-num">{pct(pp.case_accuracy)}</td>
              <td className="gl-num">{pp.cases}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </motion.div>
  );
}

const TAX_LABELS: [keyof TaxonomyT, string][] = [
  ["over_approval", "Over-approval"],
  ["missed_criterion", "Missed criterion"],
  ["hallucinated_evidence", "Hallucinated evidence"],
  ["wrong_policy", "Wrong policy"],
  ["extraction_miss", "Extraction miss"],
];

function TaxonomyBars({ single, adversarial }: { single: TaxonomyT; adversarial: TaxonomyT }) {
  const reduce = useReducedMotion();
  const max = Math.max(
    1,
    ...TAX_LABELS.flatMap(([k]) => [single[k], adversarial[k]]),
  );
  return (
    <div className="gl-tax">
      <div className="gl-tax__legend">
        <span className="gl-tax__key">
          <span className="gl-tax__swatch gl-tax__swatch--single" /> single
        </span>
        <span className="gl-tax__key">
          <span className="gl-tax__swatch gl-tax__swatch--adv" /> adversarial
        </span>
      </div>
      {TAX_LABELS.map(([k, label]) => (
        <div className="gl-tax__row" key={k}>
          <span className="gl-tax__label">{label}</span>
          <div className="gl-tax__bars">
            <Bar count={single[k]} max={max} mode="single" reduce={!!reduce} />
            <Bar count={adversarial[k]} max={max} mode="adv" reduce={!!reduce} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Bar({ count, max, mode, reduce }: { count: number; max: number; mode: "single" | "adv"; reduce: boolean }) {
  const w = count === 0 ? 0 : Math.max(4, (count / max) * 100);
  return (
    <div className={`gl-bar gl-bar--${mode}`}>
      <div className="gl-bar__track">
        <motion.div
          className="gl-bar__fill"
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${w}%` }}
          transition={reduce ? { duration: 0 } : { duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
      <span className="gl-bar__val">{count}</span>
    </div>
  );
}

function MetricPair({ label, single, adv }: { label: string; single: string; adv: string }) {
  return (
    <div className="gl-metric">
      <span className="gl-metric__label">{label}</span>
      <div className="gl-metric__pair">
        <span className="gl-metric__cell">
          <span className="gl-metric__v">{single}</span>
          <span className="gl-metric__k">single</span>
        </span>
        <span className="gl-metric__cell gl-metric__cell--adv">
          <span className="gl-metric__v">{adv}</span>
          <span className="gl-metric__k">adversarial</span>
        </span>
      </div>
    </div>
  );
}

function MetricSolo({ label, value }: { label: string; value: string }) {
  return (
    <div className="gl-metric">
      <span className="gl-metric__label">{label}</span>
      <div className="gl-metric__pair">
        <span className="gl-metric__cell">
          <span className="gl-metric__v">{value}</span>
          <span className="gl-metric__k">policy-level</span>
        </span>
      </div>
    </div>
  );
}
