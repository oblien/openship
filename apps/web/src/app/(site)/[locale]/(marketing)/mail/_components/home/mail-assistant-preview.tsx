import Image from 'next/image';
import { useCopy } from '@/i18n/use-copy';
import { MailChatExample } from './mail-chat-example';

// The three feature illustrations and the layered chat follow Zero's original mail landing.
const features = [
  { title: 'Inbox', description: 'Read, reply and file a message without leaving the keyboard.', src: '/mail-list.png' },
  { title: 'Summarize a thread', description: 'Catch up on a long conversation before you reply.', src: '/ai-summary.png' },
  { title: 'Smart Search', description: 'Find the receipt, attachment or conversation you remember.', src: '/mail-search.png' },
] as const;

export function MailAssistantPreview() {
  const copy = useCopy();
  return (
    <>
      <div className="mail-showcase-width mail-feature-grid relative grid grid-cols-1 gap-x-8 gap-y-9 sm:grid-cols-3 lg:gap-12">
        {features.map(({ title, description, src }) => (
          <figure key={src} className="min-w-0">
            <Image src={src} width={1140} height={1140} alt="" sizes="(min-width: 1280px) 385px, (min-width: 640px) 31vw, 94vw" className="block aspect-square w-full rounded-2xl" />
            <figcaption className="mt-4">
              <h3 className="mb-1 text-xl font-medium">{copy(title)}</h3>
              <p className="max-w-sm text-sm leading-relaxed text-[#aaa]">{copy(description)}</p>
            </figcaption>
          </figure>
        ))}
      </div>
      <section id="mail-assistant" aria-labelledby="mail-assistant-title" className="mail-section">
        <h2 id="mail-assistant-title" className="mail-heading">
          {copy("Ask your inbox.")}
          <span className="block text-white/45">{copy("Get the short version.")}</span>
        </h2>
        <p className="mail-intro">{copy("On your server or in a dedicated Cloud inbox, let the assistant prepare replies and follow-ups. You approve what gets sent.")}</p>
        <MailChatExample />
      </section>
    </>
  );
}
