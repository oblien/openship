import { describe, expect, it } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { Provider } from 'jotai';
import { TooltipProvider } from '../ui/tooltip';
import { RenderLabels } from './render-labels';
import type { Label } from '@/types';

const labels = [{ id: 'one', name: 'Personal' }, { id: 'two', name: 'Work' }] as Label[];

describe('mail label overflow', () => {
  it('renders the extra-label trigger through the real Radix slot without crashing', () => {
    const html = renderToString(
      <Provider><TooltipProvider><RenderLabels labels={labels} /></TooltipProvider></Provider>,
    );
    expect(html).toContain('Personal');
    expect(html).toContain('+<!-- -->1');
  });

  it('renders visible labels without an overflow trigger when they all fit', () => {
    const html = renderToString(
      <Provider><TooltipProvider><RenderLabels labels={labels} count={2} /></TooltipProvider></Provider>,
    );
    expect(html).toContain('Personal');
    expect(html).toContain('Work');
    expect(html).not.toContain('data-state=');
  });
});
