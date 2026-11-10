// Mirrors coboard-domain serialization. Keep in sync until types are generated from Rust (ADR-003 §6).
export type Point = { x: number; y: number };
export type InkPoint = { x: number; y: number; pressure: number; elapsed_ms: number };
export type SourceRef = { asset: string; rect: [number, number, number, number]; page: number | null };
export type Attrs = { id: string; position: Point; source?: SourceRef; group_ids?: string[] };
export type Brush = 'pen' | 'highlighter' | 'pencil' | 'fountain' | 'marker';
export type ShapeKind = 'line' | 'arrow' | 'curve' | 'wave' | 'rectangle' | 'ellipse' | 'triangle' | 'diamond';
export type ConnectorAnchor = 'auto' | 'top' | 'right' | 'bottom' | 'left' | 'center';
export type ConnectorRoute = 'straight' | 'elbow' | 'curve';
export type ConnectorHead = 'none' | 'arrow';
export type Block = ['paragraph', Record<string, never>, ['text', string]] | ['math_block', { latex: string }];

export type ParagraphNode = ['paragraph', Attrs, ['text', string]];
export type MathNode = ['math_block', Attrs & { latex: string }];
export type CardNode = ['derivation_card', Attrs & { pinned: boolean }, ...Block[]];
export type ImageNode = ['image', Attrs & { asset: string; width: number; height: number }];
export type StrokeNode = [
  'stroke',
  Attrs & { points: InkPoint[]; width: number; color: string; brush?: Brush; opacity?: number },
];
export type ShapeNode = [
  'shape',
  Attrs & {
    kind: ShapeKind;
    end: Point;
    width: number;
    color: string;
    fill?: string;
    corner_radius?: number;
    text?: string;
    rotation?: number;
    points?: Point[];
  },
];
export type ConnectorNode = [
  'connector',
  Attrs & {
    from?: string;
    to?: string;
    from_point?: Point;
    to_point?: Point;
    from_anchor?: ConnectorAnchor;
    to_anchor?: ConnectorAnchor;
    route?: ConnectorRoute;
    start_head?: ConnectorHead;
    end_head?: ConnectorHead;
    dashed?: boolean;
    width?: number;
    color?: string;
    waypoints?: Point[];
    label?: string;
  },
];
export type SceneNode = ParagraphNode | MathNode | CardNode | ImageNode | StrokeNode | ShapeNode | ConnectorNode;

export type Document = {
  schema_version: number;
  id: string;
  title: string;
  revision: number;
  nodes: Record<string, SceneNode>;
};

export type SessionView = {
  document: Document;
  package_path: string;
  can_undo: boolean;
  can_redo: boolean;
  recovery: { snapshot_revision: number; replayed_updates: number; elapsed_ms: number; missing_assets: string[] };
  gateway: { base_url: string; token: string } | null;
  gateway_unavailable: boolean;
};

export type Operation =
  | { type: 'insert' | 'replace'; node: SceneNode }
  | { type: 'move'; id: string; position: Point }
  | { type: 'translate'; ids: string[]; dx: number; dy: number }
  | { type: 'group'; id: string; node_ids: string[] }
  | { type: 'ungroup'; id: string; node_ids: string[] }
  | { type: 'delete'; id: string }
  | { type: 'rename'; title: string };
export type Action = { type: 'edit'; operations: Operation[] } | { type: 'undo' } | { type: 'redo' };
export type EditRequest = { request_id: string; expected_revision: number; action: Action };
export type ApiError = { code: string; message: string };

export type BackdropConfig = {
  dim_opacity: number;
  desaturate: number;
  blur_px: number;
  peek_through: boolean;
};

export type DisplayFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale_factor: number;
};

export type OverlayState = {
  visible: boolean;
  passthrough: boolean;
  backdrop: BackdropConfig;
  display: DisplayFrame;
};

export type RecognitionCandidate = {
  text: string;
  score: number;
};

export type RecognitionOutput = {
  candidates: RecognitionCandidate[];
  elapsed_ms: number;
};

export type RecognitionInk = { id: string; points: [number, number][] };
export type IncrementalRecognitionRequest = {
  session_id: string;
  sequence: number;
  from: number;
  strokes: RecognitionInk[];
};
export type IncrementalRecognitionResponse = RecognitionOutput & {
  session_id: string;
  sequence: number;
  stroke_ids: string[];
  stable_stroke_ids: string[];
  stable_text: string;
  classifier_calls: number;
  cache_hits: number;
};
