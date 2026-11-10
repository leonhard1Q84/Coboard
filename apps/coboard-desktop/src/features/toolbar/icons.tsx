import type { ReactNode } from 'react';
import type { Brush, ConnectorRoute, ShapeKind } from '../../ipc/types';
import type { ConnectorHeadsPreset, Tool } from '../../stores/tools';

// One family: 24-grid, 1.75 stroke, round caps (docs/design/ui-guidelines.md §3).
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const ToolIcons: Record<Tool, ReactNode> = {
  select: (
    <Icon>
      <path d="M5 3.5l13 7.2-5.6 1.5L9.6 18z" />
    </Icon>
  ),
  lasso: (
    <Icon>
      <path d="M12 4.5c4.6 0 8 2.6 8 5.9 0 3.2-3.4 5.8-8 5.8-4.6 0-8-2.6-8-5.8 0-3.3 3.4-5.9 8-5.9z" strokeDasharray="3 2.5" />
      <circle cx="9.5" cy="16.5" r="2" />
      <path d="M8.3 18.2L6.2 21" />
    </Icon>
  ),
  pen: (
    <Icon>
      <path d="M4 20l1.2-4.4L15.6 5.2a2 2 0 012.8 0l.4.4a2 2 0 010 2.8L8.4 18.8z" />
      <path d="M13.5 7.3l3.2 3.2" />
    </Icon>
  ),
  highlighter: (
    <Icon>
      <path d="M9 14l-2.5 2.5V19h4l2.5-2.5" />
      <path d="M9 14l7.5-9.5 4 4L11 16z" />
      <path d="M4 21h8" />
    </Icon>
  ),
  laser: (
    <Icon>
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </Icon>
  ),
  eraser: (
    <Icon>
      <path d="M8.5 19.5L3.8 14.8a1.8 1.8 0 010-2.6L12.2 3.8a1.8 1.8 0 012.6 0l5.4 5.4a1.8 1.8 0 010 2.6L12.5 19.5z" />
      <path d="M8 9l7 7M8.5 19.5H20" />
    </Icon>
  ),
  connector: (
    <Icon>
      <circle cx="5.5" cy="18.5" r="2.2" />
      <path d="M7.5 16.5C11 13 13 11 18.5 5.5" />
      <path d="M14 5.5h4.5V10" />
    </Icon>
  ),
  shape: (
    <Icon>
      <rect x="4" y="5" width="11" height="11" rx="2" />
      <circle cx="15.5" cy="15.5" r="4.5" />
    </Icon>
  ),
  text: (
    <Icon>
      <path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5" />
    </Icon>
  ),
};

// Shape picker glyphs: each button shows the shape itself.
export const ShapeIcons: Record<ShapeKind, ReactNode> = {
  rectangle: <Icon><rect x="4" y="6.5" width="16" height="11" rx="2" /></Icon>,
  ellipse: <Icon><ellipse cx="12" cy="12" rx="8" ry="5.5" /></Icon>,
  triangle: <Icon><path d="M12 5l8 13.5H4z" /></Icon>,
  diamond: <Icon><path d="M12 4.5l7.5 7.5-7.5 7.5L4.5 12z" /></Icon>,
  line: <Icon><path d="M5 19L19 5" /></Icon>,
  arrow: <Icon><path d="M5 19L19 5M13 5h6v6" /></Icon>,
  curve: <Icon><path d="M4.5 17C8 7 16 7 19.5 17" /></Icon>,
  wave: <Icon><path d="M3.5 12c2.2-5 4.4 5 6.6 0s4.4-5 6.6 0 3.8 5 3.8 0" /></Icon>,
};

export const ConnectorRouteIcons: Record<ConnectorRoute, ReactNode> = {
  straight: <Icon><path d="M5 18L19 6M14 6h5v5" /></Icon>,
  elbow: <Icon><path d="M4.5 17.5h6.5a1.5 1.5 0 001.5-1.5V8a1.5 1.5 0 011.5-1.5h5.5M16 4l3.5 2.5L16 9" /></Icon>,
  curve: <Icon><path d="M4.5 17.5C11 17.5 12.5 6.5 19.5 6.5M16 4l3.5 2.5L16 9" /></Icon>,
};

export const ConnectorHeadIcons: Record<ConnectorHeadsPreset, ReactNode> = {
  arrow: <Icon><path d="M5 12h14M14 7.5L19 12l-5 4.5" /></Icon>,
  both: <Icon><path d="M5 12h14M9.5 7.5L5 12l4.5 4.5M14.5 7.5L19 12l-4.5 4.5" /></Icon>,
  none: <Icon><path d="M5 12h14" /></Icon>,
};

// Brush picker glyphs: a stroke sample in the brush's own width/texture.
export const BrushIcons: Record<Brush, ReactNode> = {
  pen: <Icon><path d="M3 17 Q8 9 12 13 T21 11" /></Icon>,
  pencil: <Icon><path d="M3 17 Q8 9 12 13 T21 11" strokeDasharray="4 2.5" /></Icon>,
  fountain: <Icon><path d="M3 17 Q8 9 12 13 T21 11" strokeWidth="2.75" /></Icon>,
  marker: <Icon><path d="M3 17 Q8 9 12 13 T21 11" strokeWidth="5" /></Icon>,
  highlighter: <Icon><path d="M3 17 Q8 9 12 13 T21 11" strokeWidth="7" opacity="0.35" /></Icon>,
};

export const UndoIcon = (
  <Icon>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
  </Icon>
);

export const RedoIcon = (
  <Icon>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 000 11H13" />
  </Icon>
);

export const GroupIcon = (
  <Icon>
    <path d="M14 9V5.5A1.5 1.5 0 0012.5 4h-7A1.5 1.5 0 004 5.5v7A1.5 1.5 0 005.5 14H9" />
    <rect x="10" y="10" width="10" height="10" rx="1.5" />
    <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="20" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="20" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="20" cy="20" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
);

export const UngroupIcon = (
  <Icon>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
    <rect x="12" y="12" width="8" height="8" rx="1.5" />
    <path d="M4 16l3-3M17 7l3-3" strokeDasharray="2 2" />
  </Icon>
);

export const DuplicateIcon = (
  <Icon>
    <rect x="8" y="8" width="11" height="11" rx="2" />
    <path d="M5 15V6.5A1.5 1.5 0 016.5 5H15" />
  </Icon>
);

export const PassthroughIcon = (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3 3" />
    <path d="M9 12h6M12 9l3 3-3 3" />
  </Icon>
);

export const BackdropIcon = (
  <Icon>
    <path d="M12 3a9 9 0 100 18 9 9 0 000-18z" />
    <path d="M12 3v18" />
    <path d="M12 7l4.5 4.5M12 12l4.5 4.5" />
  </Icon>
);

export const HelpIcon = (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.3a2.5 2.5 0 014.8.8c0 1.5-2.4 2-2.4 3.4" />
    <circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const TrashIcon = (
  <Icon>
    <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
  </Icon>
);

export const CloseIcon = (
  <Icon>
    <path d="M18 6L6 18M6 6l12 12" />
  </Icon>
);

export const ScreenShareIcon = (
  <Icon>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
    <path d="M7 10l3-3 3 3M10 7v6" />
  </Icon>
);
