import type { ReactNode } from 'react';
import type { Brush, ShapeKind } from '../../ipc/types';
import type { Tool } from '../../stores/tools';

// One family: 24-grid, 1.75 stroke, round caps (docs/design/ui-guidelines.md §3).
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const ToolIcons: Record<Tool, ReactNode> = {
  shape: <Icon><rect x="4" y="5" width="12" height="12" rx="2" /><circle cx="16" cy="16" r="5" /></Icon>,
  select: (
    <Icon>
      <path d="M5 3.5l13 7.2-5.6 1.5L9.6 18z" />
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
  text: (
    <Icon>
      <path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5" />
    </Icon>
  ),
};

// Shape picker glyphs: each button shows the shape itself, not its name.
export const ShapeIcons: Record<ShapeKind, ReactNode> = {
  line: <Icon><path d="M5 19L19 5" /></Icon>,
  arrow: <Icon><path d="M5 19L19 5M13 5h6v6" /></Icon>,
  rectangle: <Icon><rect x="4" y="7" width="16" height="11" rx="1.5" /></Icon>,
  ellipse: <Icon><ellipse cx="12" cy="12" rx="8" ry="5.5" /></Icon>,
};

// Brush picker glyphs: a stroke sample in the brush's own width/texture.
export const BrushIcons: Record<Brush, ReactNode> = {
  pen: <Icon><path d="M3 17 Q8 9 12 13 T21 11" /></Icon>,
  pencil: <Icon><path d="M3 17 Q8 9 12 13 T21 11" strokeDasharray="4 2.5" /></Icon>,
  fountain: <Icon><path d="M3 17 Q8 9 12 13 T21 11" strokeWidth="2.75" /></Icon>,
  marker: <Icon><path d="M3 17 Q8 9 12 13 T21 11" strokeWidth="5" /></Icon>,
  highlighter: <Icon><path d="M3 17 Q8 9 12 13 T21 11" strokeWidth="7" opacity="0.35" /></Icon>,
};

// Hold-still-to-shape toggle: a rough stroke snapping into a straight segment.
export const AutoShapeIcon = (
  <Icon>
    <path d="M3 15l3-6 3 4 3-7" />
    <path d="M14 17l6-8" strokeDasharray="3 2" />
    <path d="M17 9l3 2-2 3" />
  </Icon>
);

export const AutoRecognizeIcon = (
  <Icon>
    <path d="M3 16c2-5 4 2 6-3" />
    <path d="M12 12h3m-1.5-1.5L15 12l-1.5 1.5" />
    <path d="M16.5 16l2.2-7 2.2 7m-3.6-2h2.8" />
  </Icon>
);

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

export const PassthroughIcon = (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3 3" />
    <path d="M9 12l6 0M12 9l3 3-3 3" />
  </Icon>
);

export const BackdropIcon = (
  <Icon>
    <path d="M12 3a9 9 0 100 18 9 9 0 000-18z" />
    <path d="M12 3v18" />
    <path d="M12 6l5 5M12 11l5 5M12 16l3 3" />
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
