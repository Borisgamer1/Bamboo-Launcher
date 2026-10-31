import React from "react";

export const ContentHeader: React.FC<{
  title: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ title, actions, children }) => (
  <div className="h-11 shrink-0 px-4 flex items-center justify-between gap-4 border-b border-hairline">
    <div className="flex items-center gap-3 min-w-0">
      <h1 className="text-large font-semibold text-ink truncate">{title}</h1>
      {children}
    </div>
    <div className="flex items-center gap-2 shrink-0">{actions}</div>
  </div>
);
