interface SectionRuleProps {
  label: string;
  /** printed-form index, e.g. "§3" */
  index?: string;
  /** right-aligned meta (mono), e.g. a timestamp or count */
  meta?: string;
}

/** A printed-form section divider: eyebrow label + extending hairline. */
export function SectionRule({ label, index, meta }: SectionRuleProps) {
  return (
    <div className="gl-section">
      {index && <span className="gl-section__index">{index}</span>}
      <span className="gl-section__label">{label}</span>
      <span className="gl-section__rule" />
      {meta && <span className="gl-section__meta">{meta}</span>}
    </div>
  );
}
