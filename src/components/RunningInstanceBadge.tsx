import React, { useEffect, useState } from "react";
import { Clock } from "lucide-react";

interface RunningInstance {
  name: string;
  startedAt: number;
}

interface RunningInstanceBadgeProps {
  instances: RunningInstance[];
}

const formatUptime = (s: number) =>
  `${Math.floor(s / 3600).toString().padStart(2, "0")}:${Math.floor((s % 3600) / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

export const RunningInstanceBadge: React.FC<RunningInstanceBadgeProps> = ({ instances }) => {
  const [, tick] = useState(0);

  // Local 1-second timer — only this component re-renders, not the entire App
  useEffect(() => {
    if (instances.length === 0) return;
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [instances.length]);

  if (instances.length === 0) return null;

  return (
    <>
      {instances.map((ri, idx) => {
        const elapsed = Math.floor((Date.now() - ri.startedAt) / 1000);
        return (
          <div key={idx} className="flex items-center gap-2">
            {idx > 0 && <div className="w-px h-3 bg-slate-800" />}
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500 font-bold">Active:</span>
              <span className="text-slate-200 font-black">{ri.name}</span>
              <Clock className="w-3 h-3 text-slate-500 ml-1.5" />
              <span className="text-slate-200 font-black font-mono">{formatUptime(elapsed)}</span>
            </div>
          </div>
        );
      })}
    </>
  );
};
