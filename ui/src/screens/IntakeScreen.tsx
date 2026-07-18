import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ApiClientError, getPolicies, retrievePolicy, summarize } from "../api";
import { Button, FileDrop, PatientContextView, PolicyView } from "../components";
import { ingestFile } from "../lib/ingest";
import type { PatientContext, Policy } from "../types";

interface Loaded {
  ctx: PatientContext;
  modality: string;
  filename: string;
}

interface Demo {
  title: string;
  sub: string;
  file: string;
}

const DEMOS: Demo[] = [
  { title: "COVID-19 / hypoxemia", sub: "Abridge · acute inpatient", file: "abridge-covid-hypoxemia.json" },
  { title: "Insulin diabetic", sub: "Synthea · on insulin", file: "synthea-cgm-insulin.json" },
  { title: "Diabetic, no foot condition", sub: "Synthea · outpatient", file: "synthea-footwear-no-foot.json" },
];

const POLICY_LABEL: Record<string, string> = {
  home_oxygen: "Home Oxygen · NCD 240.2",
  therapeutic_footwear: "Therapeutic Footwear · L33369",
  cgm: "Continuous Glucose Monitor · L33822",
};
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const labelFor = (slug: string) => POLICY_LABEL[slug] ?? titleCase(slug);

type View = "patient" | "policy";

export function IntakeScreen() {
  const reduce = useReducedMotion();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("Parsing patient context…");
  const [error, setError] = useState<string | null>(null);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [procedure, setProcedure] = useState("");
  const [view, setView] = useState<View>("patient");

  const [composing, setComposing] = useState(false);
  const [draftName, setDraftName] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = (attempt = 0) => {
      getPolicies()
        .then((ps) => {
          if (!cancelled) setPolicies(ps);
        })
        .catch(() => {
          if (!cancelled && attempt < 3) setTimeout(() => load(attempt + 1), 1500);
        });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const toMessage = (e: unknown) =>
    e instanceof ApiClientError ? `${e.type} — ${e.message}` : String((e as Error)?.message ?? e);

  const handleFile = async (file: File) => {
    setError(null);
    setPending(true);
    setLoaded(null);
    setStatus("Reading document…");
    try {
      const ing = await ingestFile(file, setStatus);
      setStatus("Parsing patient context…");
      const ctx = await summarize(ing.input);
      setLoaded({ ctx, modality: ing.label, filename: ing.filename });
      setView("patient");
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
    setStatus("Parsing patient context…");
    try {
      const res = await fetch(`/demo/${demo.file}`);
      if (!res.ok) throw new Error(`sample not found (${res.status})`);
      const json = (await res.json()) as Record<string, unknown>;
      const ctx = await summarize(json);
      setLoaded({ ctx, modality: "FHIR · JSON", filename: demo.file });
      setView("patient");
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  // Built-in and retrieved policies are held in `policies`, so selecting one is
  // just an in-memory lookup — no re-fetch, and the 3 built-ins always stay.
  const pickPolicy = (proc: string) => {
    setProcedure(proc);
    setComposing(false);
    setError(null);
    if (!proc) {
      setPolicy(null);
      setView("patient");
      return;
    }
    const found = policies.find((p) => p.procedure === proc);
    if (found) {
      setPolicy(found);
      setView("policy");
    }
  };

  const retrieveByName = async () => {
    if (!draftName.trim()) return;
    setError(null);
    setPending(true);
    setStatus("Retrieving policy — connector → web search → fetch → decompose…");
    try {
      const p = await retrievePolicy(draftName.trim());
      // Keep the existing policies (the 3 built-ins + any retrieved); add/replace this one.
      setPolicies((prev) => [...prev.filter((x) => x.procedure !== p.procedure), p]);
      setProcedure(p.procedure);
      setPolicy(p);
      setComposing(false);
      setView("policy");
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  const showToggle = loaded && policy && !composing && !pending && !error;

  return (
    <div className="gl-shell">
      {/* Left rail — intake */}
      <aside className="gl-rail">
        <div>
          <div className="gl-mark">
            <span className="gl-mark__light" />
            <span className="gl-mark__name">GreenLight</span>
          </div>
          <div className="gl-mark__sub">Patient Intake</div>
        </div>

        <FileDrop
          onFile={handleFile}
          accept=".json,.jsonl,.pdf,.txt,.md,.png,.jpg,.jpeg,.webp,.tif,.tiff,image/*"
          disabled={pending}
        />

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

        <div className="gl-field">
          <span className="gl-eyebrow gl-field__label">Policy</span>
          <div className="gl-select-wrap">
            <select
              className="gl-select"
              value={procedure}
              onChange={(e) => pickPolicy(e.target.value)}
              disabled={pending || policies.length === 0}
            >
              <option value="">— choose a policy —</option>
              {policies.map((p) => (
                <option key={p.procedure} value={p.procedure}>
                  {labelFor(p.procedure)}
                </option>
              ))}
            </select>
          </div>
          <button
            className="gl-btn gl-newpolicy"
            onClick={() => {
              setComposing(true);
              setPolicy(null);
              setProcedure("");
              setError(null);
              setView("policy");
            }}
            disabled={pending}
          >
            + New policy
          </button>
        </div>

        {(loaded || policy || composing) && (
          <button
            className="gl-btn"
            onClick={() => {
              setLoaded(null);
              setPolicy(null);
              setProcedure("");
              setComposing(false);
              setError(null);
            }}
          >
            New intake
          </button>
        )}

        <div className="gl-rail__spacer" />
        <div className="gl-rail__foot">
          intake · deterministic FHIR parse
          <br />
          policy · connector → search → fetch → cache
          <br />
          fail-closed · never a guess
        </div>
      </aside>

      {/* Reading column */}
      <main className="gl-read">
        {pending ? (
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
        ) : error ? (
          <div className="gl-read__inner">
            <div className="gl-errbox">
              <div className="gl-errbox__title">Something went wrong</div>
              <div className="gl-errbox__msg">{error}</div>
            </div>
          </div>
        ) : composing ? (
          <div className="gl-read__inner">
            <div className="gl-compose">
              <div>
                <div className="gl-eyebrow gl-doc__eyebrow">New policy</div>
                <h1 className="gl-compose__title">Retrieve a policy</h1>
                <p className="gl-compose__body">
                  Enter a procedure or policy name. GreenLight runs the retrieval chain — CMS
                  connector → web search on cms.gov → fetch → local cache — then decomposes the
                  policy into checkable criteria and validates every quote, shown exactly like the
                  built-in policies.
                </p>
              </div>
              <div>
                <span className="gl-eyebrow gl-compose__field-label">Policy / procedure name</span>
                <input
                  className="gl-input--text"
                  value={draftName}
                  placeholder="e.g. power mobility device, knee MRI, lumbar fusion"
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") retrieveByName();
                  }}
                  autoFocus
                />
              </div>
              <div className="gl-compose__actions">
                <Button variant="go" dot onClick={retrieveByName} disabled={!draftName.trim()}>
                  Retrieve policy
                </Button>
                <Button onClick={() => setComposing(false)}>Cancel</Button>
              </div>
              <p className="gl-compose__body">
                Built-in names (home oxygen, therapeutic footwear, CGM) resolve instantly from the
                pinned cache. Any other name runs the live web chain — expect a few seconds.
              </p>
            </div>
          </div>
        ) : view === "policy" && policy ? (
          <>
            {showToggle && <ViewToggle view={view} onView={setView} />}
            <PolicyView policy={policy} label={labelFor(policy.procedure)} />
          </>
        ) : loaded ? (
          <>
            {showToggle && <ViewToggle view={view} onView={setView} />}
            <PatientContextView ctx={loaded.ctx} modality={loaded.modality} filename={loaded.filename} />
          </>
        ) : (
          <div className="gl-read__inner">
            <div className="gl-prompt">
              <div className="gl-prompt__eyebrow gl-eyebrow">Awaiting record</div>
              <h1 className="gl-prompt__title">Upload a patient record</h1>
              <p className="gl-prompt__body">
                Drop a FHIR JSON file or a fax document on the left, or load a sample. GreenLight parses
                it into a source-attributed <span className="gl-mono">PatientContext</span>. Then pick a
                CMS policy to see it retrieved and decomposed into checkable criteria.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ViewToggle({ view, onView }: { view: View; onView: (v: View) => void }) {
  return (
    <div className="gl-read__inner" style={{ paddingBottom: 0 }}>
      <div className="gl-toggle">
        <button data-active={view === "patient"} onClick={() => onView("patient")}>
          Patient context
        </button>
        <button data-active={view === "policy"} onClick={() => onView("policy")}>
          Policy
        </button>
      </div>
    </div>
  );
}
