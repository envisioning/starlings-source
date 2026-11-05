import { Fragment, type ReactNode } from 'react';
import { t } from './index';

/**
 * `t()` for a sentence with an element inside it, a link most often: the
 * sentence stays one key, so a translator can move the link where their
 * language puts it. `{name}` takes a node; the rest is text.
 *
 *   tx('Read what we are researching this week in {link}, our newsletter.', { link: <a …>Artificial Insights</a> })
 */
export function tx(key: string, nodes: Record<string, ReactNode>): ReactNode {
  return t(key).split(/\{(\w+)\}/g).map((part, index) => (
    <Fragment key={index}>{index % 2 ? (part in nodes ? nodes[part] : `{${part}}`) : part}</Fragment>
  ));
}
