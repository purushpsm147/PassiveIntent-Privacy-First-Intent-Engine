import React from 'react';

interface Props {
  value: string | number | React.ReactNode;
  label: string;
}

export default function MetricCard({ value, label }: Props) {
  return (
    <div className="metric-card">
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}
