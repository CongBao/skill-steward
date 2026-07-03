export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${30 - ((value - min) / range) * 28}`)
    .join(" ");
  return (
    <svg className="sparkline" viewBox="0 0 100 32" role="img" aria-label={label} preserveAspectRatio="none">
      <polyline points={points} />
    </svg>
  );
}
