import type { SceneNode } from '../../ipc/types';
import { InlineText } from './InlineText';
import { MathView } from './MathView';

type Props = { node: SceneNode; selected: boolean; dx: number; dy: number };

/** DOM-rendered objects (text, formula, card, image). Ink is drawn on canvas instead. */
export function NodeView({ node, selected, dx, dy }: Props) {
  const { id, position } = node[1];
  const style = { left: position.x + dx, top: position.y + dy };
  const cls = `node${selected ? ' is-selected' : ''}`;
  switch (node[0]) {
    case 'paragraph':
      return <div className={`${cls} node-text`} style={style} data-node-id={id}><InlineText text={node[2][1]} /></div>;
    case 'math_block':
      return (
        <div className={`${cls} node-math`} style={style} data-node-id={id}>
          <MathView source={node[1].latex} />
        </div>
      );
    case 'derivation_card':
      return (
        <div className={`${cls} node-card`} style={style} data-node-id={id}>
          {node.slice(2).map((b, i) => {
            const block = b as Extract<SceneNode, ['derivation_card', ...unknown[]]>[2];
            return block[0] === 'paragraph' ? <p key={i}><InlineText text={block[2][1]} /></p> : <MathView key={i} source={block[1].latex} className="card-math" />;
          })}
        </div>
      );
    case 'image':
      return (
        <div className={`${cls} node-image`} style={{ ...style, width: node[1].width, height: node[1].height }} data-node-id={id}>
          图片
        </div>
      );
    default:
      return null;
  }
}

export const isDomNode = (node: SceneNode) =>
  node[0] === 'paragraph' || node[0] === 'math_block' || node[0] === 'derivation_card' || node[0] === 'image';
