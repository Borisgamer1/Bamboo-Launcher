import React from "react";

const Mark = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

export const LockedMark = ({ className }: { className?: string }) => (
  <Mark className={className}>
    <path d="M8 10V7.4a4 4 0 0 1 8 0V10" />
    <rect x="5" y="10" width="14" height="10" rx="3" fill="currentColor" fillOpacity="0.16" />
    <rect x="5" y="10" width="14" height="10" rx="3" />
    <circle cx="12" cy="14.4" r="1.5" fill="currentColor" stroke="none" />
    <path d="M12 15.9v1.8" strokeWidth={1.9} />
  </Mark>
);

export const UnlockedMark = ({ className }: { className?: string }) => (
  <Mark className={className}>
    <path d="M8 10V7.4a4 4 0 0 1 7.7-1.55" />
    <rect x="5" y="10" width="14" height="10" rx="3" />
    <circle cx="12" cy="14.6" r="1.4" />
    <path d="M12 16v1.6" />
  </Mark>
);

export const VisibleMark = ({ className }: { className?: string }) => (
  <Mark className={className}>
    <path d="M2.9 12S6.6 5.9 12 5.9 21.1 12 21.1 12 17.4 18.1 12 18.1 2.9 12 2.9 12Z" />
    <circle cx="12" cy="12" r="2.7" fill="currentColor" stroke="none" />
  </Mark>
);

export const HiddenMark = ({ className }: { className?: string }) => (
  <Mark className={className}>
    <path d="M2.9 12S6.6 5.9 12 5.9 21.1 12 21.1 12 17.4 18.1 12 18.1 2.9 12 2.9 12Z" />
    <path d="M4.6 19.4 19.4 4.6" strokeWidth={1.9} />
  </Mark>
);

export const ExternalMark = ({ className }: { className?: string }) => (
  <Mark className={className}>
    <path d="M13.5 4.5H19.5V10.5" />
    <path d="M19.5 4.5 11.5 12.5" />
    <path d="M18.5 14.5v3.9a2.1 2.1 0 0 1-2.1 2.1H5.6a2.1 2.1 0 0 1-2.1-2.1V7.6a2.1 2.1 0 0 1 2.1-2.1h3.9" />
  </Mark>
);

export const DeleteMark = ({ className }: { className?: string }) => (
  <Mark className={className}>
    <path d="M4 7h16" />
    <path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7" />
    <path d="M6 7l.8 11.2A2 2 0 0 0 8.8 20h6.4a2 2 0 0 0 2-1.8L18 7" />
    <path d="M10 11v5M14 11v5" />
  </Mark>
);

export const UpdateMark = ({ className }: { className?: string }) => (
  <Mark className={className}>
    <path d="M12 15V4" />
    <path d="M7.5 8.5 12 4l4.5 4.5" />
    <path d="M4.5 20h15" />
  </Mark>
);
