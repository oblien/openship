"use client";

import { useState } from 'react';
import { useCopy } from '@/i18n/use-copy';
import { Check, Clock, CurvedArrow, Expand, GroupPeople, NotesList, PanelLeftOpen, PencilCompose, Search, Sparkles } from '../icons';

const examples = [
  { label: 'Find a message', Icon: Search, prompt: 'Find the thread about our design review.', result: 'Found six messages from Alex, Ali and Sarah about the design review.' },
  { label: 'Summarize a thread', Icon: NotesList, prompt: 'What did we agree on in the design review?', result: 'The team liked the new categories and suggested moving the quick actions.' },
  { label: 'Draft a reply', Icon: PencilCompose, prompt: 'Draft a reply asking for a link to the preview.', result: 'Thanks for the walkthrough. Could you send the preview link so I can try the new search?' },
  { label: 'Prepare a follow-up', Icon: Clock, prompt: 'Prepare a follow-up for tomorrow morning.', result: 'I’ve prepared a reply asking if the preview is ready. Review it in Scheduled to approve the send.' },
] as const;

const pinned = [
  { sender: 'Maya', subject: 'New design review' },
  { sender: 'Alex, Ali, Sarah', subject: 'Re: Design review feedback' },
  { sender: 'Sam', subject: 'Anything mentioning the design review' },
] as const;

export function MailChatExample() {
  const copy = useCopy();
  const [selected, setSelected] = useState(2);
  const current = examples[selected];
  return (
    <div className="mail-assistant-demo">
      <div className="grid min-w-0 grid-cols-2 gap-2 text-start md:grid-cols-1" role="group" aria-labelledby="mail-assistant-title">
        {examples.map(({ label, Icon }, index) => (
          <button key={label} type="button" aria-pressed={selected === index} aria-controls="mail-chat-result" onClick={() => setSelected(index)}
            className="mail-example-choice">
            <Icon className="size-5 shrink-0 fill-current" />
            <span className="grow">{copy(label)}</span>
            {selected === index && <Check className="hidden size-4 shrink-0 fill-current md:block" />}
          </button>
        ))}
      </div>
      <div className="relative isolate flex min-w-0 justify-center pb-16 sm:pb-20">
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 -z-10 overflow-hidden rounded-xl bg-zinc-900 px-3 py-4 text-start text-[#999] sm:px-5">
          <p className="mb-3 text-sm">{copy("Pinned")} <span>[3]</span></p>
          {pinned.map(({ sender, subject }) => (
            <div key={sender} className="flex items-center gap-3 p-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#313131]"><GroupPeople className="size-4 fill-[#aaa]" /></span>
              <div className="text-sm"><p className="text-[#ddd]">{sender}</p><p>{copy(subject)}</p></div>
            </div>
          ))}
        </div>
        <div className="flex min-h-80 w-[min(90%,420px)] flex-col overflow-hidden rounded-xl bg-[#252525] text-start shadow-xl">
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-sm">
            <Sparkles className="size-4 fill-[#d8c8fc]" />{copy("Ask your inbox.")}
            <div aria-hidden="true" className="ms-auto flex items-center gap-3"><PanelLeftOpen className="size-3 fill-[#999]" /><Expand className="size-3 fill-[#999]" /></div>
          </div>
          <div id="mail-chat-result" aria-live="polite" aria-atomic="true" className="flex flex-1 flex-col justify-center gap-5 p-4 text-sm leading-relaxed sm:p-6">
            <p className="ms-8 self-end rounded-xl bg-[#3a3541] px-4 py-2.5 text-[#f2edf8]">{copy(current.prompt)}</p>
            <div className="flex items-start gap-3">
              <Sparkles className="mt-1 size-4 shrink-0 fill-[#d8c8fc]" />
              <p>{copy(current.result)}</p>
            </div>
          </div>
          <div aria-hidden="true" className="m-4 mt-0 flex items-center gap-2 rounded-lg bg-[#151515] px-3 py-2 text-sm text-[#aaa]">
            <span className="h-3 w-px bg-white" />{copy("Ask your inbox.")}<CurvedArrow className="ms-auto size-4 fill-[#999]" />
          </div>
        </div>
      </div>
    </div>
  );
}
