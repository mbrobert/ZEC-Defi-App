export default function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="my-5 flex items-center gap-2 overflow-x-auto" aria-label="Progress">
      {steps.map((s, i) => (
        <div key={s} className="contents">
          <div className={`step ${i === current ? "on" : i < current ? "done" : ""}`} aria-current={i === current ? "step" : undefined}>
            <span className="n">{i < current ? "✓" : i + 1}</span>
            {s}
          </div>
          {i < steps.length - 1 && <div className="step-bar" />}
        </div>
      ))}
    </div>
  );
}
