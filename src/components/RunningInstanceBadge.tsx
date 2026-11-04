import React, { useEffect, useState } from "react";
import { Clock } from "lucide-react";

interface RunningInstance {
  name: string;
  folderName?: string;
  startedAt: number;
}

interface RunningInstanceBadgeProps {
  instances: RunningInstance[];
}

const formatUptime = (s: number) =>
  `${Math.floor(s / 3600).toString().padStart(2, "0")}:${Math.floor((s % 3600) / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

export const RunningInstanceBadge: React.FC<RunningInstanceBadgeProps> = ({ instances }) => {
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (instances.length === 0) return;
    const update = () => setNow(Date.now());
    const first = window.setTimeout(update, 0);
    const id = window.setInterval(update, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [instances.length]);

  if (instances.length === 0) return null;

  return (
    <>
      {instances.map((ri, idx) => {
        const elapsed = now === 0 ? 0 : Math.floor((now - ri.startedAt) / 1000);
        return (
          <div key={ri.folderName || `${ri.name}-${idx}`} className="flex items-center gap-2">
            {idx > 0 && <div className="w-px h-3 bg-raised" />}
            <div className="flex items-center gap-1.5">
              <span className="text-ink-tertiary font-medium">Active:</span>
              <span className="text-ink font-semibold">{ri.name}</span>
              <Clock className="w-3 h-3 text-ink-tertiary ml-1.5" />
              <span className="text-ink font-semibold font-mono">{formatUptime(elapsed)}</span>
            </div>
          </div>
        );
      })}
    </>
  );
};
