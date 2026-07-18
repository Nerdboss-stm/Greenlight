import { motion, useReducedMotion } from "motion/react";
import type { PatientContext } from "../types";
import { DataValue } from "./DataValue";
import { SectionRule } from "./SectionRule";

interface PatientContextViewProps {
  ctx: PatientContext;
  /** modality chip, e.g. "FHIR · JSON" or "Fax · PDF → transcript" */
  modality?: string;
  /** source filename */
  filename?: string;
}

/** Renders a parsed PatientContext as an auditable clinical document. */
export function PatientContextView({ ctx, modality, filename }: PatientContextViewProps) {
  const reduce = useReducedMotion();
  const { demographics: d } = ctx;

  return (
    <motion.div
      className="gl-read__inner"
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <header>
        <div className="gl-eyebrow gl-doc__eyebrow">Patient Context {filename ? `· ${filename}` : ""}</div>
        <h1 className="gl-doc__title">
          {d.age}
          <span className="gl-pc__sex"> · {d.sex}</span>
        </h1>
        <div className="gl-pc__chips">
          {modality && <span className="gl-chip gl-chip--accent">{modality}</span>}
          <span className="gl-chip">{ctx.diagnoses.length} dx</span>
          <span className="gl-chip">{ctx.labs.length} labs</span>
          <span className="gl-chip">{ctx.meds.length} meds</span>
          <span className="gl-chip">{Object.keys(ctx.source_spans).length} sourced fields</span>
        </div>
      </header>

      {/* Diagnoses */}
      <div className="gl-block">
        <SectionRule label="Diagnoses" index="§1" meta={`${ctx.diagnoses.length}`} />
        {ctx.diagnoses.length ? (
          ctx.diagnoses.map((dx, i) => (
            <div className="gl-rec" key={i}>
              <span className="gl-rec__code">{dx.icd10 || "—"}</span>
              <span className="gl-rec__text">{dx.display}</span>
            </div>
          ))
        ) : (
          <div className="gl-empty">— none documented —</div>
        )}
      </div>

      {/* Foot conditions (called out explicitly — absence is meaningful) */}
      <div className="gl-block">
        <SectionRule label="Foot conditions" index="§2" meta={`${ctx.foot_conditions.length}`} />
        {ctx.foot_conditions.length ? (
          ctx.foot_conditions.map((fc, i) => (
            <div className="gl-rec" key={i}>
              <span className="gl-rec__code">{fc.icd10 || "—"}</span>
              <span className="gl-rec__text">{fc.display}</span>
            </div>
          ))
        ) : (
          <div className="gl-empty">— none documented —</div>
        )}
      </div>

      {/* Medications */}
      <div className="gl-block">
        <SectionRule label="Medications" index="§3" meta={`${ctx.meds.length}`} />
        {ctx.meds.length ? (
          ctx.meds.map((m, i) => (
            <div className="gl-rec" key={i}>
              <span className="gl-rec__code">{m.rxnorm ? `rxnorm ${m.rxnorm}` : "—"}</span>
              <span className="gl-rec__text">{m.name}</span>
            </div>
          ))
        ) : (
          <div className="gl-empty">— none documented —</div>
        )}
      </div>

      {/* Labs */}
      <div className="gl-block">
        <SectionRule label="Labs" index="§4" meta={`${ctx.labs.length} observations`} />
        {ctx.labs.length ? (
          <div className="gl-scroll">
            <table className="gl-table gl-table--sticky">
              <thead>
                <tr>
                  <th>Observation</th>
                  <th className="gl-num">Code</th>
                  <th className="gl-num">Value</th>
                  <th className="gl-num">Date</th>
                </tr>
              </thead>
              <tbody>
                {ctx.labs.map((l, i) => (
                  <tr key={i}>
                    <td>{l.display}</td>
                    <td className="gl-num">{l.code || "—"}</td>
                    <td className="gl-num">
                      <DataValue value={l.value} unit={l.unit} />
                    </td>
                    <td className="gl-num">{(l.date || "").slice(0, 10) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="gl-empty">— none documented —</div>
        )}
      </div>

      {/* Encounters */}
      <div className="gl-block">
        <SectionRule label="Encounters" index="§5" meta={`${ctx.encounters.length}`} />
        {ctx.encounters.length ? (
          ctx.encounters.map((e, i) => (
            <div className="gl-rec" key={i}>
              <span className="gl-rec__code">{e.class || "—"}</span>
              <span className="gl-rec__text">{e.reason || "—"}</span>
              <span className="gl-rec__meta">{(e.date || "").slice(0, 10)}</span>
            </div>
          ))
        ) : (
          <div className="gl-empty">— none documented —</div>
        )}
      </div>

      {/* Symptoms / prior treatments */}
      <div className="gl-block">
        <SectionRule label="Symptoms" index="§6" meta={`${ctx.symptoms.length}`} />
        {ctx.symptoms.length ? (
          <div className="gl-chips">
            {ctx.symptoms.map((s, i) => (
              <span className="gl-chip" key={i}>
                {s}
              </span>
            ))}
          </div>
        ) : (
          <div className="gl-empty">— none extracted (structured FHIR carries none; use a fax/transcript) —</div>
        )}
      </div>

      <div className="gl-block">
        <SectionRule label="Prior treatments" index="§7" meta={`${ctx.prior_treatments.length}`} />
        {ctx.prior_treatments.length ? (
          <div className="gl-chips">
            {ctx.prior_treatments.map((t, i) => (
              <span className="gl-chip" key={i}>
                {t}
              </span>
            ))}
          </div>
        ) : (
          <div className="gl-empty">— none documented —</div>
        )}
      </div>

      {/* Provenance */}
      <div className="gl-block">
        <SectionRule label="Provenance" index="§8" meta="source_spans" />
        <div className="gl-scroll">
          <table className="gl-table gl-table--sticky">
            <thead>
              <tr>
                <th>Field</th>
                <th>Origin</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ctx.source_spans).map(([field, origin]) => (
                <tr key={field}>
                  <td className="gl-mono">{field}</td>
                  <td className="gl-mono gl-value--muted">{origin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </motion.div>
  );
}
