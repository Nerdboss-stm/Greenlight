import { useRef, useState } from "react";

interface FileDropProps {
  onFile: (file: File) => void;
  accept?: string;
  disabled?: boolean;
}

/** Squared drag-&-drop zone (no rounded corners, no shadow). Click or drop. */
export function FileDrop({ onFile, accept, disabled }: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const pick = (files: FileList | null) => {
    if (files && files.length) onFile(files[0]);
  };

  return (
    <div
      className={`gl-drop${over ? " gl-drop--over" : ""}${disabled ? " gl-drop--disabled" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) pick(e.dataTransfer.files);
      }}
    >
      <div className="gl-drop__mark" aria-hidden>
        <span className="gl-drop__square" />
      </div>
      <div className="gl-drop__title">Drop a patient record</div>
      <div className="gl-drop__hint">FHIR JSON · Synthea bundle · fax (PDF / image / text)</div>
      <div className="gl-drop__cta">or click to browse</div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
