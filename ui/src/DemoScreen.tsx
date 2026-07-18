import { useState } from "react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import {
  Button,
  DataValue,
  DecisionBanner,
  EvidenceRow,
  SectionRule,
  Tag,
  TraceTheater,
} from "./components";
import type { CriterionStatus, TraceEvent, Verdict } from "./components";

/* ---- Sample case: Home Oxygen Therapy · CMS NCD 240.2 ---------------- */

interface Criterion {
  id: string;
  label: string;
  status: CriterionStatus;
  ref: string;
  kind: "hard" | "soft";
}

interface Evidence {
  clauseRef: string;
  clauseText: string;
  clauseSource: string;
  fieldPath: string;
  patientSource: string;
  value: (spo2: number, status: CriterionStatus) => React.ReactNode;
}

const EVIDENCE: Record<string, Evidence> = {
  spo2: {
    clauseRef: "NCD 240.2 §A",
    clauseText:
      "Arterial oxygen saturation at or below 88 percent, measured at rest while breathing room air.",
    clauseSource: "CMS National Coverage Determination 240.2 · 42 CFR",
    fieldPath: "labs.spo2 · resting · room air",
    patientSource: "encounter 2026·07·14 · pulse oximetry · source_span: note§Vitals",
    value: (spo2, status) => <DataValue value={spo2} unit="%" size="lg" tone={status} />,
  },
  dx: {
    clauseRef: "NCD 240.2 §B",
    clauseText:
      "A diagnosis of a disease for which home oxygen therapy is medically necessary, such as chronic obstructive pulmonary disease.",
    clauseSource: "CMS National Coverage Determination 240.2",
    fieldPath: "diagnoses[0].icd10",
    patientSource: "problem list · onset 2025·11·02 · COPD w/ exacerbation",
    value: () => <DataValue value="J44.9" size="lg" tone="met" />,
  },
  mgmt: {
    clauseRef: "NCD 240.2 §C",
    clauseText:
      "Alternative treatment measures have been tried or considered and deemed clinically ineffective.",
    clauseSource: "CMS National Coverage Determination 240.2",
    fieldPath: "meds[] · rxnorm",
    patientSource: "medication history · tiotropium, budesonide–formoterol · ≥ 90 d",
    value: () => <DataValue value="2 agents" size="lg" tone="met" />,
  },
  retest: {
    clauseRef: "NCD 240.2 §E",
    clauseText:
      "A repeat arterial blood gas or oximetry study obtained within 90 days prior to recertification.",
    clauseSource: "CMS National Coverage Determination 240.2",
    fieldPath: "labs.spo2[] · repeat",
    patientSource: "no qualifying repeat study on file",
    value: () => <DataValue value="—" size="lg" tone="muted" />,
  },
};

const TRACE: TraceEvent[] = [
  { kind: "phase", n: "P1", label: "Parse patient" },
  { kind: "ledger", call: "get_patient_field('demographics.age')", value: "71" },
  { kind: "ledger", call: "get_patient_field('labs.spo2')", value: "83 %" },
  { kind: "ledger", call: "get_patient_field('diagnoses[0].icd10')", value: "J44.9" },
  { kind: "phase", n: "P2", label: "Retrieve policy" },
  { kind: "ledger", call: "fetch_policy('CMS NCD 240.2')", value: "cache hit", hit: true },
  { kind: "ledger", call: "decompose_criteria()", value: "4 clauses" },
  { kind: "phase", n: "P3", label: "Adjudicate criteria" },
  {
    kind: "argument",
    side: "payer",
    text: "SpO₂ 83 % is at or below the 88 % ceiling — threshold satisfied.",
    cite: "NCD 240.2 §A",
  },
  {
    kind: "argument",
    side: "advocate",
    text: "Reading taken at rest on room air per the vitals note; condition met.",
    cite: "note §Vitals",
  },
  { kind: "phase", n: "P4", label: "Arbitrate" },
  {
    kind: "arbiter",
    expr: "hard_met(3/3) ∧ hard_unknown(0) ∧ soft_unknown(1)",
    result: "approve",
    resultLabel: "APPROVE",
  },
];

export function DemoScreen() {
  const reduce = useReducedMotion();
  const [spo2, setSpo2] = useState(83);
  const [draft, setDraft] = useState("83");
  const [selected, setSelected] = useState("spo2");
  const [stampId, setStampId] = useState(0); // bumps on any resolve → re-stamp banner + re-meet evidence
  const [staggerId, setStaggerId] = useState(0); // bumps on full run only → re-stagger criteria
  const [lastAction, setLastAction] = useState<"resolve" | "counterfactual">("resolve");

  const spo2Status: CriterionStatus = spo2 <= 88 ? "met" : "not_met";
  const criteria: Criterion[] = [
    { id: "spo2", label: "Resting SpO₂ ≤ 88 % on room air", status: spo2Status, ref: "NCD 240.2 §A", kind: "hard" },
    { id: "dx", label: "Qualifying respiratory diagnosis (COPD)", status: "met", ref: "NCD 240.2 §B", kind: "hard" },
    { id: "mgmt", label: "Trial of optimal medical management documented", status: "met", ref: "NCD 240.2 §C", kind: "hard" },
    { id: "retest", label: "Repeat oximetry within 90 days of certification", status: "unknown", ref: "NCD 240.2 §E", kind: "soft" },
  ];

  const hard = criteria.filter((c) => c.kind === "hard");
  const verdict: Verdict = hard.some((c) => c.status === "not_met")
    ? "deny"
    : hard.some((c) => c.status === "unknown")
      ? "insufficient"
      : "approve";

  const rationale =
    verdict === "approve" ? (
      <>
        hard_met(<b>3/3</b>) · hard_unknown(<b>0</b>) · soft_unknown(1) → <b>APPROVE</b>
      </>
    ) : verdict === "deny" ? (
      <>
        hard_not_met(<b>1</b>) at <b>NCD 240.2 §A</b> · SpO₂ {spo2} % &gt; 88 % ceiling → fail-closed → <b>DENY</b>
      </>
    ) : (
      <>
        hard_unknown(<b>1</b>) · absent evidence → fail-closed → <b>INSUFFICIENT</b>
      </>
    );

  const runDetermination = () => {
    setLastAction("resolve");
    setStaggerId((n) => n + 1);
    setStampId((n) => n + 1);
  };

  const rerun = () => {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isNaN(parsed) ? spo2 : Math.max(40, Math.min(100, parsed));
    setSpo2(next);
    setDraft(String(next));
    setSelected("spo2");
    setLastAction("counterfactual");
    setStampId((n) => n + 1);
  };

  const ev = EVIDENCE[selected];
  const selectedCrit = criteria.find((c) => c.id === selected)!;
  const bannerDelay = lastAction === "resolve" ? 0.5 : 0;

  const staggerParent: Variants = reduce
    ? {}
    : { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
  const staggerItem: Variants = reduce
    ? {}
    : {
        hidden: { opacity: 0, y: 8 },
        show: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
        },
      };

  return (
    <div className="gl-shell">
      {/* ---------------- Left rail ---------------- */}
      <aside className="gl-rail">
        <div>
          <div className="gl-mark">
            <span className="gl-mark__light" />
            <span className="gl-mark__name">GreenLight</span>
          </div>
          <div className="gl-mark__sub">Clinical Prior-Authorization</div>
        </div>

        <div>
          <div className="gl-id__name">Margaret Ellison</div>
          <div className="gl-kv">
            <span className="gl-kv__k">MRN</span>
            <span className="gl-kv__v">A-0294471</span>
          </div>
          <div className="gl-kv">
            <span className="gl-kv__k">AGE / SEX</span>
            <span className="gl-kv__v">71 · F</span>
          </div>
          <div className="gl-kv">
            <span className="gl-kv__k">DOB</span>
            <span className="gl-kv__v">1955·03·11</span>
          </div>
          <div className="gl-kv">
            <span className="gl-kv__k">DX</span>
            <span className="gl-kv__v">J44.9</span>
          </div>
        </div>

        <div className="gl-field">
          <span className="gl-eyebrow gl-field__label">Policy</span>
          <div className="gl-select-wrap">
            <select className="gl-select" defaultValue="240.2">
              <option value="240.2">CMS NCD 240.2 · Home O₂</option>
              <option value="240.4">CMS NCD 240.4 · CPAP / OSA</option>
              <option value="280.1">CMS NCD 280.1 · Power Mobility</option>
            </select>
          </div>
        </div>

        <Button variant="go" dot onClick={runDetermination}>
          Run determination
        </Button>

        <div className="gl-rail__spacer" />
        <div className="gl-rail__foot">
          engine · deterministic arbiter
          <br />
          absent evidence → INSUFFICIENT
          <br />
          fail-closed · never a guess
        </div>
      </aside>

      {/* ---------------- Reading column ---------------- */}
      <main className="gl-read">
        <div className="gl-read__inner">
          <header>
            <div className="gl-eyebrow gl-doc__eyebrow">Determination · Case PA-4471</div>
            <h1 className="gl-doc__title">Home Oxygen Therapy</h1>
            <div className="gl-doc__sub">CMS NCD 240.2 · adjudicated 2026·07·18 14:22Z · reviewer agent v0.1</div>
          </header>

          {/* Determination stamp */}
          <div className="gl-block">
            <SectionRule label="Determination" index="§1" meta={verdict.toUpperCase()} />
            <DecisionBanner
              verdict={verdict}
              stampKey={`${verdict}-${stampId}`}
              delay={bannerDelay}
              seal={
                <>
                  CASE PA-4471
                  <br />
                  2026·07·18 14:22Z
                </>
              }
              rationale={rationale}
            />
          </div>

          {/* Criteria */}
          <div className="gl-block">
            <SectionRule label="Criteria" index="§2" meta={`${hard.length} hard · 1 soft`} />
            <motion.div
              className="gl-criteria"
              key={staggerId}
              variants={staggerParent}
              initial={reduce ? false : "hidden"}
              animate="show"
            >
              {criteria.map((c) => (
                <motion.div key={c.id} variants={staggerItem}>
                  <Tag
                    label={c.label}
                    status={c.status}
                    clauseRef={c.ref}
                    kind={c.kind}
                    active={selected === c.id}
                    onClick={() => setSelected(c.id)}
                  />
                </motion.div>
              ))}
            </motion.div>
          </div>

          {/* Evidence — the hero */}
          <div className="gl-block">
            <SectionRule label="Evidence" index="§3" meta={selectedCrit.ref} />
            <EvidenceRow
              replayKey={`${selected}-${stampId}`}
              clauseRef={ev.clauseRef}
              clauseText={ev.clauseText}
              clauseSource={ev.clauseSource}
              fieldPath={ev.fieldPath}
              patientValue={ev.value(spo2, selectedCrit.status)}
              patientSource={ev.patientSource}
            />
            {/* Counterfactual */}
            <div className="gl-cf">
              <div className="gl-cf__field">
                <span className="gl-eyebrow">Counterfactual · labs.spo2</span>
                <input
                  className="gl-input"
                  value={draft}
                  inputMode="numeric"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") rerun();
                  }}
                  aria-label="SpO2 value"
                />
              </div>
              <Button onClick={rerun}>Re-run</Button>
              <span className="gl-cf__hint">
                Edit the value and re-run — the criterion square cross-fades and the stamp
                re-settles.
              </span>
            </div>
          </div>

          {/* Patient data */}
          <div className="gl-block">
            <SectionRule label="Patient data" index="§4" meta="labs · encounter 2026·07·14" />
            <table className="gl-table">
              <thead>
                <tr>
                  <th>Element</th>
                  <th className="gl-num">Value</th>
                  <th className="gl-num">Reference</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>SpO₂ · resting · room air</td>
                  <td className="gl-num">
                    <DataValue value={spo2} unit="%" tone={spo2Status} />
                  </td>
                  <td className="gl-num">≥ 95 %</td>
                </tr>
                <tr>
                  <td>PaO₂ · arterial blood gas</td>
                  <td className="gl-num">
                    <DataValue value={54} unit="mmHg" />
                  </td>
                  <td className="gl-num">80–100</td>
                </tr>
                <tr>
                  <td>Respiratory rate</td>
                  <td className="gl-num">
                    <DataValue value={22} unit="/min" />
                  </td>
                  <td className="gl-num">12–20</td>
                </tr>
                <tr>
                  <td>Heart rate</td>
                  <td className="gl-num">
                    <DataValue value={88} unit="bpm" />
                  </td>
                  <td className="gl-num">60–100</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Procedure record */}
          <div className="gl-block">
            <SectionRule label="Procedure record" index="§5" meta="live · looping" />
            <TraceTheater events={TRACE} />
          </div>

          {/* Palette / type key */}
          <div className="gl-block">
            <SectionRule label="System" index="§6" meta="Fraunces · IBM Plex Sans · IBM Plex Mono" />
            <div className="gl-swatches">
              <span className="gl-swatch">
                <span className="gl-swatch__chip" style={{ background: "var(--green)" }} /> approve · #2E6B45
              </span>
              <span className="gl-swatch">
                <span className="gl-swatch__chip" style={{ background: "var(--red)" }} /> deny · #9C3230
              </span>
              <span className="gl-swatch">
                <span className="gl-swatch__chip" style={{ background: "var(--amber)" }} /> insufficient · #B0761B
              </span>
              <span className="gl-swatch">
                <span className="gl-swatch__chip" style={{ background: "var(--paper)" }} /> paper · #F5F1E8
              </span>
              <span className="gl-swatch">
                <span className="gl-swatch__chip" style={{ background: "var(--ink)" }} /> ink · #161E2D
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
