import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { Window } from 'happy-dom';
import { useComposerHeaders, type ComposerHeaders } from './use-composer-headers';

let browser: Window;
let root: Root;
let form: UseFormReturn<ComposerHeaders>;
let shown: string[];
const globals = new Map<string, PropertyDescriptor | undefined>();
const empty = (): ComposerHeaders => ({ to: [], cc: [], bcc: [], subject: '' });

function Composer({ defaults }: { defaults: ComposerHeaders }) {
  form = useForm<ComposerHeaders>({ defaultValues: defaults });
  useComposerHeaders(defaults, form.getValues, form.setValue, field => shown.push(field));
  return <output>{JSON.stringify(form.watch())}</output>;
}

beforeEach(() => {
  browser = new Window();
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  root = createRoot(document.createElement('div'));
  shown = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});

async function render(defaults: ComposerHeaders) {
  await act(async () => root.render(<Composer defaults={defaults} />));
}

describe('composer header initialization with a real React Hook Form', () => {
  it('populates late message defaults and reveals Cc/Bcc fields', async () => {
    await render(empty());
    const loaded = { to: ['sender@example.test'], cc: ['cc@example.test'], bcc: ['bcc@example.test'], subject: 'Re: Hello' };
    await render(loaded);
    expect(form.getValues()).toEqual(loaded);
    expect(shown).toEqual(['cc', 'bcc']);
  });

  it('updates untouched recipients when switching to reply-all or loading aliases', async () => {
    const reply = { ...empty(), to: ['sender@example.test'], subject: 'Re: Hello' };
    await render(reply);
    await render({ ...reply, to: [...reply.to, 'teammate@example.test', 'alias@example.test'] });
    await render({ ...reply, to: [...reply.to, 'teammate@example.test'] });
    expect(form.getValues('to')).toEqual(['sender@example.test', 'teammate@example.test']);
  });

  it('preserves typed recipients and subject even when callers do not mark fields dirty', async () => {
    await render(empty());
    await act(async () => {
      form.setValue('to', ['chosen@example.test']);
      form.setValue('subject', 'My subject');
    });
    await render({ ...empty(), to: ['sender@example.test'], subject: 'Re: Hello', cc: ['copy@example.test'] });
    expect(form.getValues()).toEqual({ ...empty(), to: ['chosen@example.test'], subject: 'My subject', cc: ['copy@example.test'] });
  });

  it('preserves an explicitly cleared value and ignores equivalent new prop arrays', async () => {
    const loaded = { ...empty(), to: ['sender@example.test'], subject: 'Re: Hello' };
    await render(loaded);
    await act(async () => { form.setValue('to', []); form.setValue('subject', ''); });
    await render({ ...loaded, to: [...loaded.to] });
    await render({ ...loaded, to: ['other@example.test'], subject: 'Re: Other' });
    expect(form.getValues('to')).toEqual([]);
    expect(form.getValues('subject')).toBe('');
  });
});
