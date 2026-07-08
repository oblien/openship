'use client';
import {
  ChevronDown,
  CurvedArrow,
  GitHub,
  Plus,
  Cube,
  MediumStack,
  Clock,
  PanelLeftOpen,
  Check,
  Filter,
  Search,
  User,
  Lightning,
  ExclamationTriangle,
  Bell,
  Tag,
  GroupPeople,
  X,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Figma,
  Docx,
  ImageFile,
  Expand,
  Sparkles,
  LockIcon,
  Mail,
  GmailColor,
  OutlookColor,
  Phone,
  Inbox,
  ArrowRight,
} from '../icons';
import { PixelatedBackground, PixelatedLeft, PixelatedRight } from './pixelated-bg';
import { Tabs, TabsContent } from '../ui/tabs';
import Link from 'next/link';
import { Button } from '../ui/button';
import { Balancer } from 'react-wrap-balancer';
import { motion } from 'motion/react';
import MailFooter from './footer';
import React from 'react';

const firstRowQueries: string[] = [
  'Invoices from Stripe',
  'Emails from Nick',
  'Unread this week',
];

const secondRowQueries: string[] = [
  'Attachments over 10MB',
  'Anything mentioning the design review',
];

const tabs = [
  { label: 'Chat With Your Inbox', value: 'smart-categorization' },
  { label: 'Smart Labels', value: 'ai-features' },
  { label: 'Write Better Emails', value: 'feature-3' },
];

export default function HomeContent() {
  return (
    <main
      data-section="dark"
      className="mail-home relative flex h-full flex-1 flex-col overflow-x-hidden bg-[#0F0F0F] px-2"
    >
      <PixelatedBackground
        className="z-1 absolute left-1/2 top-[-40px] h-auto w-screen min-w-[1920px] -translate-x-1/2 object-cover"
        style={{
          mixBlendMode: 'screen',
          maskImage: 'linear-gradient(to bottom, black, transparent)',
        }}
      />

      <section className="z-10 mt-32 flex flex-col items-center px-4">
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="text-center text-4xl font-medium md:text-6xl"
        >
          <Balancer className="mb-3 max-w-[1130px]">
            <span className="block">Your Mail Server,</span>
            <span className="block">On Your Hardware</span>
          </Balancer>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="mx-auto mb-4 max-w-2xl text-center text-base font-medium text-[#B7B7B7] md:text-lg"
        >
          Run your own email - domains, mailboxes, and a modern webmail - provisioned from a single panel.
          No SaaS, no per-seat pricing, no third party reading your inbox.
        </motion.p>
        <p className="mb-4 ml-0.5 text-xs text-[#B7B7B7]/60">Open source. Self-hosted. Yours.</p>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="border-input/50 mb-6 inline-flex items-center gap-2 rounded-full border border-[#2A2A2A] bg-[#1E1E1E] px-4 py-1"
        >
          <Link
            href="https://github.com/oblien/openship"
            target="_blank"
            className="flex items-center gap-2 text-sm"
          >
            <GitHub className="size-4 fill-white" />
            <span>100% open source · AGPL-3.0</span>
          </Link>
        </motion.div>

        {/* Get Started button only visible for mobile screens */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.6 }}
          className="mb-6 lg:hidden"
        >
          <Link href="/docs/install">
            <Button>Install Openship</Button>
          </Link>
        </motion.div>
      </section>

      <section className="relative mt-10 hidden flex-col justify-center md:flex">
        <div className="bg-border absolute left-1/2 top-0 h-px w-full -translate-x-1/2 md:container xl:max-w-7xl" />
        <Tabs
          defaultValue="smart-categorization"
          className="flex w-full flex-col items-center gap-0"
        >
          <div
            className="relative bottom-2 flex w-full justify-center md:border-t"
            style={{ clipPath: 'inset(0 0 0 0)', height: '110%' }}
          >
            <div className="container relative -top-1.5 md:border-x xl:max-w-7xl">
              <PixelatedLeft
                className="absolute left-0 top-0 -z-10 hidden h-full w-auto -translate-x-full opacity-50 md:block"
                style={{ mixBlendMode: 'screen' }}
              />
              <PixelatedRight
                className="absolute right-0 top-0 -z-10 hidden h-full w-auto translate-x-full opacity-50 md:block"
                style={{ mixBlendMode: 'screen' }}
              />
              {tabs.map((tab) => (
                <TabsContent key={tab.value} value={tab.value}>
                  <img
                    src="/email-preview.png"
                    alt="Zero Email Preview"
                    width={1920}
                    height={1080}
                    className="relative hidden md:block"
                    loading="eager"
                  />
                </TabsContent>
              ))}
            </div>
          </div>
        </Tabs>
      </section>

      <div className="flex items-center justify-center px-4 md:hidden">
        <img
          src="/email-preview.png"
          alt="Zero Email Preview"
          width={1920}
          height={1080}
          className="mt-10 h-fit w-full rounded-xl border"
          loading="eager"
        />
      </div>

      <div className="relative -top-3.5 hidden h-px w-full bg-[#313135] md:block" />

      <div className="relative mt-52">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex items-center justify-center"
        >
          <h1 className="text-lg font-light text-white/40 md:text-xl">
            Designed for power users who value time
          </h1>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-2 flex flex-col items-center justify-center md:mt-8"
        >
          <h1 className="text-center text-4xl font-medium text-white md:text-6xl">
            Speed Is Everything
          </h1>
          <h1 className="mb-3 text-center text-4xl font-medium text-white/40 md:text-6xl">
            Reply in seconds
          </h1>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="relative bottom-3 mx-12 flex items-center justify-center bg-[#0F0F0F] md:mx-0"
        >
          <div className="bg-panelDark mx-auto mt-10 inline-flex max-w-[600px] flex-col items-center justify-center overflow-hidden rounded-2xl shadow-md">
            <div className="inline-flex h-12 items-center justify-start gap-2 self-stretch border-b-[0.50px] p-4">
              <div className="text-base-gray-500/50 justify-start text-sm leading-none">To:</div>
              <div className="flex flex-1 items-center justify-start gap-1">
                <div className="outline-tokens-badge-default/10 flex items-center justify-start gap-1.5 rounded-full border border-[#2B2B2B] py-1 pl-1 pr-1.5">
                  <img
                    height={20}
                    width={20}
                    className="h-5 w-5 rounded-full"
                    src="https://randomuser.me/api/portraits/men/32.jpg"
                    alt="Alex"
                  />
                  <div className="flex items-center justify-start">
                    <div className="flex items-center justify-center gap-2.5 pr-0.5">
                      <div className="text-base-gray-950 justify-start text-sm leading-none">
                        Alex
                      </div>
                    </div>
                  </div>
                </div>
                <div className="outline-tokens-badge-default/10 flex items-center justify-start gap-1.5 rounded-full border border-[#2B2B2B] py-1 pl-1 pr-1.5">
                  <img
                    height={20}
                    width={20}
                    className="h-5 w-5 rounded-full"
                    src="https://randomuser.me/api/portraits/women/44.jpg"
                    alt="Jordan"
                  />{' '}
                  <div className="flex items-center justify-start">
                    <div className="flex items-center justify-center gap-2.5 pr-0.5">
                      <div className="text-base-gray-950 justify-start text-sm leading-none">
                        Jordan
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="inline-flex h-12 items-center justify-start gap-2.5 self-stretch p-4">
              <Clock className="relative h-3.5 w-3.5 overflow-hidden fill-[#9A9A9A]" />
              <div className="inline-flex flex-1 flex-col items-start justify-start gap-3">
                <div className="inline-flex items-center justify-start gap-1 self-stretch">
                  <div className="text-base-gray-950 flex-1 justify-start text-sm font-normal leading-none">
                    Re: Code review feedback
                  </div>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-start justify-start gap-12 self-stretch rounded-2xl bg-[#202020] px-4 py-3">
              <div className="flex flex-col items-start justify-start gap-3 self-stretch">
                <div className="justify-start self-stretch text-sm font-normal leading-normal text-white">
                  Hey team,
                </div>
                <div className="justify-start self-stretch text-sm font-normal leading-normal text-white">
                  I took a look at the code review feedback. Really like the keyboard navigation -
                  it makes everything much faster to access. The search implementation is clean,
                  though I'd love to see the link to test it out myself.
                </div>
                <div className="justify-start self-stretch text-sm font-normal leading-normal text-white">
                  Let me know when you can share the preview and I'll provide more detailed
                  feedback.
                </div>
              </div>
              <div className="inline-flex items-center justify-between self-stretch">
                <div className="flex items-center justify-start gap-3">
                  <div className="flex items-center justify-start rounded-md bg-white text-black">
                    <div className="flex h-7 items-center justify-center gap-1.5 overflow-hidden rounded-bl-md rounded-tl-md bg-white pl-1.5 pr-1">
                      <div className="flex items-center justify-center gap-2.5 pl-0.5">
                        <div className="justify-start text-center text-sm leading-none text-black">
                          Send <span className="hidden md:inline">now</span>
                        </div>
                      </div>
                      <div className="flex h-5 items-center justify-center gap-2.5 rounded bg-[#E7E7E7] px-1 outline outline-1 -outline-offset-1 outline-[#D2D2D2]">
                        <div className="text-tokens-shortcut-primary-symbol justify-start text-center text-sm font-semibold leading-none">
                          ⏎
                        </div>
                      </div>
                    </div>
                    <div className="bg-base-gray-950 flex items-center justify-start gap-2.5 self-stretch px-2 pr-3">
                      <div className="relative h-3 w-px rounded-full bg-[#D0D0D0]" />
                    </div>
                    <div className="bg-base-gray-950 flex h-7 items-center justify-center gap-1.5 overflow-hidden rounded-br-md rounded-tr-md pr-2">
                      <ChevronDown className="relative h-2 w-2 overflow-hidden fill-black" />
                    </div>
                  </div>
                  <div className="flex h-7 items-center justify-center gap-0.5 overflow-hidden rounded-md bg-[#373737] px-1.5">
                    <Plus className="relative h-2.5 w-2.5 overflow-hidden fill-[#9A9A9A]" />
                    <div className="flex items-center justify-center gap-2.5 px-0.5">
                      <div className="text-base-gray-950 justify-start text-sm leading-none">
                        Add <span className="hidden md:inline">files</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="hidden items-start justify-start gap-3 md:flex">
                  <div className="flex h-7 items-center justify-center gap-0.5 overflow-hidden rounded-md bg-[#373737] px-1.5">
                    <Cube className="relative h-3 w-3 overflow-hidden fill-[#9A9A9A]" />

                    <div className="flex items-center justify-center gap-2.5 px-0.5">
                      <div className="text-base-gray-950 justify-start text-sm leading-none">
                        Neutral
                      </div>
                    </div>
                  </div>
                  <div className="flex h-7 items-center justify-center gap-0.5 overflow-hidden rounded-md bg-[#373737] px-1.5">
                    <MediumStack className="relative mx-1 h-2.5 w-2.5 overflow-hidden fill-[#9A9A9A]" />

                    <div className="flex items-center justify-center gap-2.5 px-0.5">
                      <div className="text-base-gray-950 justify-start text-sm leading-none">
                        Medium-length
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="inline-flex items-start justify-start self-stretch">
              <div className="border-tokens-stroke-light/5 flex h-12 flex-1 items-center justify-center gap-2 border-r-[0.50px]">
                <div className="flex items-center justify-start gap-1">
                  <div className="flex h-5 w-5 items-center justify-center gap-2.5 rounded-[5px] bg-[#2B2B2B] px-1.5">
                    <div className="justify-start text-center text-sm font-semibold leading-none text-[#8C8C8C]">
                      ↓
                    </div>
                  </div>
                  <div className="flex h-5 w-5 items-center justify-center gap-2.5 rounded-[5px] bg-[#2B2B2B] px-1.5">
                    <div className="justify-start text-center text-sm font-semibold leading-none text-[#8C8C8C]">
                      ↑
                    </div>
                  </div>
                </div>
                <div className="justify-start text-sm leading-none text-[#8C8C8C]">to navigate</div>
              </div>
              <div className="flex h-12 flex-1 items-center justify-center gap-2">
                <div className="flex h-5 items-center justify-center gap-2.5 rounded-[5px] bg-[#2B2B2B] px-1">
                  <div className="justify-start text-center text-sm font-semibold leading-none text-[#8C8C8C]">
                    ⌘Z
                  </div>
                </div>
                <div className="justify-start text-sm leading-none text-[#8C8C8C]">
                  return generation
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      <div className="relative mt-52 flex items-center justify-center">
        <div className="mx-auto grid w-full! max-w-[1250px] grid-cols-1 gap-12 md:grid-cols-2 lg:grid-cols-3">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col"
          >
            <div className="relative aspect-square w-full overflow-hidden rounded-2xl md:h-96">
              <div className="absolute left-0 top-0 aspect-square w-full rounded-2xl border border-[#252525] bg-neutral-800 md:h-96 md:w-96" />
              <div className="outline-tokens-stroke-light/5 bg-panelDark absolute left-1/2 top-[34px] inline-flex h-[771px] w-72 -translate-x-1/2 flex-col items-start justify-start overflow-hidden rounded-lg">
                <div className="inline-flex h-10 items-center justify-start gap-3 self-stretch overflow-hidden border-b-[0.38px] border-[#252525] px-4 py-5">
                  <div className="flex flex-1 items-center justify-start gap-2">
                    <div className="flex flex-1 items-center justify-start gap-1.5">
                      <PanelLeftOpen className="h-3 w-3 fill-[#8C8C8C]" />
                      <div className="ml-1 justify-start text-xs leading-3 text-white">Inbox</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-start gap-1">
                    <Check className="h-2.5 w-2.5 fill-[#8C8C8C]" />
                    <div className="justify-start text-xs leading-3 text-[#8C8C8C]">Select</div>
                  </div>
                  <div className="relative h-2.5 w-[0.76px] rounded-full bg-[#252525]" />
                  <div className="flex items-center justify-start gap-2">
                    <Filter className="relative h-3 w-3 fill-[#8C8C8C]" />
                  </div>
                </div>
                <div className="flex flex-col items-start justify-start gap-3 self-stretch p-4">
                  <div className="inline-flex h-7 items-center justify-start gap-1 self-stretch overflow-hidden rounded bg-[#141414] pl-1.5 pr-[3.04px]">
                    <Search className="relative mr-1 h-3 w-3 overflow-hidden rounded-[1.14px] fill-[#8C8C8C]" />
                    <div className="flex-1 justify-start text-xs leading-3 text-[#929292]">
                      Search
                    </div>
                    <div className="flex h-5 items-center justify-center gap-2 rounded-sm bg-[#262626] px-1">
                      <div className="justify-start text-xs leading-3 text-[#929292]">⌘K</div>
                    </div>
                  </div>
                  <div className="inline-flex items-start justify-start gap-1.5 self-stretch">
                    <div className="flex h-6 w-6 items-center justify-center gap-[3.04px] overflow-hidden rounded bg-[#313131]">
                      <Lightning className="relative h-3 w-3 overflow-hidden fill-[#989898]" />
                    </div>
                    <div className="flex h-6 w-6 items-center justify-center gap-[3.04px] overflow-hidden rounded bg-[#313131]">
                      <ExclamationTriangle className="relative h-3.5 w-3.5 overflow-hidden fill-[#989898]" />
                    </div>
                    <div className="flex h-6 flex-1 items-center justify-center gap-[3.04px] overflow-hidden rounded bg-[#39AE4A] px-2.5">
                      <User className="relative h-3 w-3 overflow-hidden fill-white" />
                      <div className="flex items-center justify-center gap-2 px-[1.52px]">
                        <div className="justify-start text-xs leading-3 text-white">Personal</div>
                      </div>
                    </div>
                    <div className="flex h-6 w-6 items-center justify-center gap-[3.04px] overflow-hidden rounded bg-[#313131]">
                      <Bell className="relative h-3 w-3 overflow-hidden fill-[#989898]" />
                    </div>
                    <div className="flex h-6 w-6 items-center justify-center gap-[3.04px] overflow-hidden rounded bg-[#313131]">
                      <Tag className="relative h-3 w-3 overflow-hidden fill-[#989898]" />
                    </div>
                  </div>
                  <div className="relative flex flex-col items-start justify-center gap-2.5 self-stretch overflow-hidden rounded-md bg-[#12341D] px-2 py-2.5">
                    <div className="justify-start self-stretch text-xs leading-3 text-[#A3E1B3]">
                      Security, Deadlines, and Urgent Updates
                    </div>
                    <div className="justify-start self-stretch text-xs font-normal leading-none text-[#F4FBF6]">
                      Time-sensitive notifications, security alerts, <br />
                      and critical project updates.
                    </div>
                    <div className="absolute left-[239.80px] top-[6.07px] h-3 w-3 overflow-hidden opacity-50" />
                  </div>
                </div>
                <div className="inline-flex items-center justify-start gap-1 self-stretch px-4 pb-3 pt-5">
                  <div className="flex flex-1 items-center justify-start gap-1">
                    <div className="justify-start text-xs leading-3 text-[#8C8C8C]">Pinned</div>
                    <div className="justify-start text-xs leading-3 text-[#8C8C8C]">[3]</div>
                  </div>
                </div>
                <div className="flex flex-col items-start justify-start gap-1.5 self-stretch px-1.5">
                  <div className="inline-flex items-center justify-start gap-2.5 self-stretch rounded-md p-2.5">
                    <img
                      alt="Sam"
                      height={250}
                      width={250}
                      className="h-6 w-6 rounded-full object-cover"
                      src="https://randomuser.me/api/portraits/men/68.jpg"
                    />
                    <div className="inline-flex h-7 flex-1 flex-col items-start justify-start gap-2">
                      <div className="inline-flex items-start justify-start gap-2 self-stretch">
                        <div className="flex flex-1 items-center justify-start gap-2.5">
                          <div className="flex items-center justify-start gap-[3.04px]">
                            <div className="text-base-gray-950 justify-start text-xs leading-3">
                              Sam
                            </div>
                            <div className="justify-start text-center text-xs leading-3 text-[#8C8C8C]">
                              [9]
                            </div>
                          </div>
                        </div>
                        <div className="text-xs font-normal leading-3 text-[#8C8C8C]">Mar 29</div>
                      </div>
                      <div className="inline-flex items-center justify-start gap-2 self-stretch">
                        <div className="text-xs font-normal leading-3 text-[#8C8C8C]">
                          New design review
                        </div>
                        <div className="flex items-start justify-start gap-[3.04px]">
                          <div className="relative h-3.5 w-3.5 overflow-hidden" />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="inline-flex items-center justify-start gap-2.5 self-stretch rounded-lg p-2.5">
                    <div className="inline-flex h-6 w-6 flex-col items-center justify-center gap-2 overflow-hidden rounded-full bg-[#313131] px-1 py-2">
                      <GroupPeople className="relative h-5 w-5 overflow-hidden fill-[#989898]" />
                    </div>
                    <div className="inline-flex flex-1 flex-col items-start justify-start gap-2">
                      <div className="inline-flex items-start justify-start gap-2 self-stretch">
                        <div className="flex flex-1 items-center justify-start gap-2.5">
                          <div className="flex items-center justify-start gap-1">
                            <div className="text-base-gray-950 justify-start text-xs leading-3">
                              Alex, Ali, Sarah
                            </div>
                            <div className="justify-start text-center text-xs leading-3 text-[#8C8C8C]">
                              [6]
                            </div>
                          </div>
                        </div>
                        <div className="text-xs font-normal leading-3 text-[#8C8C8C]">Mar 28</div>
                      </div>
                      <div className="inline-flex items-center justify-start gap-2 self-stretch">
                        <div className="text-xs font-normal leading-3 text-[#8C8C8C]">
                          Re: Design review feedback
                        </div>
                        <div className="flex items-start justify-start gap-[3.04px]">
                          <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          <div className="relative h-3.5 w-3.5 overflow-hidden" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-4 gap-4">
              <h1 className="mb-2 text-xl font-medium leading-loose text-white">
                Lightning-Fast Interface
              </h1>
              <p className="max-w-sm text-sm font-light text-[#979797]">
                Email at the speed of thought. Navigate your entire inbox using just your keyboard.
                Process hundreds of emails in minutes.
              </p>
            </div>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="relative aspect-square w-full overflow-hidden rounded-2xl md:h-96">
              <div className="absolute left-0 top-0 aspect-square w-full rounded-2xl bg-[#2B2B2B] md:h-96 md:w-96" />
              <div className="absolute left-[44px] top-0 h-[720px] w-[610px]">
                <div className="absolute left-[31px] top-[29px] inline-flex h-[720px] w-[547px] flex-col items-start justify-start overflow-hidden rounded-lg bg-[#202020] opacity-20">
                  <div className="border-tokens-stroke-light/5 inline-flex h-9 items-center justify-between self-stretch overflow-hidden border-b-[0.35px] py-3 pl-3.5 pr-2">
                    <div className="flex items-center justify-start gap-3">
                      <X className="relative h-3 w-3 overflow-hidden fill-[#8C8C8C]" />
                      <div className="relative h-2 w-[0.71px] rounded-full bg-[#2B2B2B]" />
                      <div className="flex items-center justify-start gap-2">
                        <ChevronLeft className="relative h-3 w-3 overflow-hidden fill-[#8C8C8C]" />
                        <ChevronRight className="relative h-3 w-3 overflow-hidden fill-[#8C8C8C]" />
                      </div>
                    </div>
                    <div className="flex items-center justify-start gap-2">
                      <div className="bg-tokens-button-surface/10 flex h-5 w-5 items-center justify-center gap-[2.83px] overflow-hidden rounded">
                        <div className="relative h-4 w-4 overflow-hidden">
                          <div className="bg-base-warning-500 absolute left-[5.37px] top-[3.90px] h-2.5 w-1.5" />
                        </div>
                      </div>
                      <div className="bg-tokens-stroke-light/5 relative h-2 w-[0.71px] rounded-full" />
                      <div className="bg-tokens-button-surface/10 flex h-5 items-center justify-center gap-[1.42px] overflow-hidden rounded px-1">
                        <div className="relative h-3 w-3" />
                        <div className="flex items-center justify-center gap-2 pl-[0.71px] pr-[1.42px]">
                          <div className="text-base-gray-950 justify-start text-[9.92px] leading-[9.92px]">
                            Reply all
                          </div>
                        </div>
                      </div>
                      <div className="bg-tokens-button-surface/10 flex h-5 w-5 items-center justify-center gap-[2.83px] overflow-hidden rounded">
                        <div className="relative h-3 w-3 overflow-hidden" />
                      </div>
                      <div className="bg-tokens-button-surface/10 flex h-5 w-5 items-center justify-center gap-[2.83px] overflow-hidden rounded">
                        <div className="relative h-3 w-3" />
                      </div>
                      <div className="bg-tokens-button-surface/10 flex h-5 w-5 items-center justify-center gap-[2.83px] overflow-hidden rounded">
                        <div className="relative h-3 w-3 overflow-hidden" />
                      </div>
                      <div className="bg-base-danger-100 outline-base-danger-200 flex h-5 w-5 items-center justify-center gap-[2.83px] overflow-hidden rounded outline outline-[0.35px]">
                        <div className="relative h-3 w-3 overflow-hidden" />
                      </div>
                    </div>
                  </div>
                  <div className="border-tokens-stroke-light/5 flex flex-col items-start justify-start gap-6 self-stretch overflow-hidden border-b-[0.35px] p-3.5">
                    <div className="flex flex-col items-start justify-start gap-4 self-stretch">
                      <div className="flex flex-col items-start justify-start gap-2.5 self-stretch">
                        <div className="inline-flex items-start justify-start gap-[2.83px] self-stretch">
                          <div className="text-base-gray-950 justify-start text-xs leading-3">
                            Re: Design review feedback
                          </div>
                          <div className="text-base-gray-500/50 justify-start text-center text-xs leading-3">
                            [6]
                          </div>
                        </div>
                        <div className="inline-flex items-start justify-start gap-1 self-stretch">
                          <Calendar className="relative bottom-px h-2.5 w-2.5 overflow-hidden fill-[#8C8C8C]" />
                          <div className="text-base-gray-500/50 flex-1 justify-start text-[9.92px] font-normal leading-[9.92px]">
                            March 25 - March 29
                          </div>
                        </div>
                      </div>
                      <div className="inline-flex items-center justify-start gap-3">
                        <div className="flex items-center justify-start gap-1 overflow-hidden shadow-[0px_0.7086613774299622px_1.4173227548599243px_0px_rgba(255,255,255,0.00)] shadow-[0px_0px_0px_0.3543306887149811px_rgba(255,255,255,0.00)]">
                          <div className="flex items-center justify-start">
                            <div className="bg-base-success-500 outline-tokens-surface-secondary flex h-5 w-5 items-center justify-center gap-[2.83px] rounded px-2 outline outline-1">
                              <div className="relative h-3 w-3 overflow-hidden" />
                            </div>
                            <div className="bg-base-secondary-500 flex h-5 w-5 items-center justify-center gap-[2.83px] rounded px-2">
                              <div className="relative h-3 w-3 overflow-hidden" />
                            </div>
                          </div>
                          <div className="relative h-3 w-3 overflow-hidden" />
                        </div>
                        <div className="bg-tokens-stroke-light/5 relative h-2 w-[0.71px] rounded-full" />
                        <div className="flex items-center justify-start gap-[2.83px]">
                          <div className="outline-tokens-badge-default/10 flex items-center justify-start gap-1 overflow-hidden rounded-full py-[2.83px] pl-[2.83px] pr-2 outline outline-[0.35px] outline-offset-[-0.35px]">
                            <img
                              className="h-3.5 w-3.5 rounded-full px-[2.66px] py-1"
                              src="https://placehold.co/14x14"
                            />
                            <div className="text-base-gray-950 justify-start text-[9.92px] leading-[9.92px]">
                              Ali
                            </div>
                          </div>
                          <div className="outline-tokens-badge-default/10 flex items-center justify-start gap-1 overflow-hidden rounded-full py-[2.83px] pl-[2.83px] pr-2 outline outline-[0.35px] outline-offset-[-0.35px]">
                            <div className="inline-flex h-3.5 w-3.5 flex-col items-center justify-center gap-2 overflow-hidden rounded-full">
                              <img className="h-4 w-4" src="https://placehold.co/17x17" />
                            </div>
                            <div className="text-base-gray-950 justify-start text-[9.92px] leading-[9.92px]">
                              Nick
                            </div>
                          </div>
                          <div className="outline-tokens-badge-default/10 flex items-center justify-start gap-1 overflow-hidden rounded-full py-[2.83px] pl-[2.83px] pr-2 outline outline-[0.35px] outline-offset-[-0.35px]">
                            <img
                              className="h-3.5 w-3.5 rounded-full"
                              src="https://placehold.co/14x14"
                            />
                            <div className="text-base-gray-950 justify-start text-[9.92px] leading-[9.92px]">
                              Sarah
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="bg-tokens-surface-on-secondary/5 outline-base-secondary-500 flex flex-col items-start justify-start gap-3.5 self-stretch rounded-lg p-3 outline outline-[0.35px] outline-offset-[-0.35px]">
                      <div className="inline-flex items-center justify-start gap-1">
                        <div className="justify-start text-[9.92px] leading-[9.92px] text-[#948CA4]">
                          Privacy Status
                        </div>
                      </div>
                      <div className="text-base-gray-950 justify-start self-stretch text-[9.92px] font-normal leading-none">
                        Thread stored on your server. 4 attachments, 6 participants - encrypted at
                        rest, never indexed or scanned by a third party. You own the mailboxes,
                        the data, and the domain.
                      </div>
                    </div>
                    <div className="flex flex-col items-start justify-start gap-2.5 self-stretch">
                      <div className="inline-flex items-center justify-start gap-[2.83px]">
                        <div className="text-base-gray-950 justify-start text-[9.92px] leading-[9.92px]">
                          Attachments
                        </div>
                        <div className="text-base-gray-500/50 justify-start text-center text-[9.92px] leading-[9.92px]">
                          [4]
                        </div>
                      </div>
                      <div className="inline-flex flex-wrap content-start items-start justify-start gap-2 self-stretch">
                        <div className="outline-tokens-stroke-element/0 flex h-5 items-center justify-start gap-1 overflow-hidden rounded bg-[#26232C] px-1.5 py-1 shadow">
                          <div className="relative overflow-hidden">
                            <Figma className="relative h-2 w-2 overflow-hidden" />
                          </div>
                          <div className="flex items-center justify-start gap-[2.83px]">
                            <div className="text-base-gray-950 justify-start text-[9.92px] leading-[9.92px]">
                              cmd.center.fig
                            </div>
                            <div className="justify-start text-[9.92px] leading-[9.92px] opacity-50">
                              21 MB
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center justify-start gap-1 overflow-hidden rounded bg-[#26232C] py-1 pl-1 pr-1.5 shadow">
                          <Docx className="relative h-2 w-2 overflow-hidden fill-blue-500" />
                          <div className="flex items-center justify-start gap-[2.83px]">
                            <div className="text-base-gray-950 justify-start text-[9.92px] leading-[9.92px]">
                              comments.docx
                            </div>
                            <div className="justify-start text-[9.92px] leading-[9.92px] opacity-50">
                              3.7 MB
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center justify-start gap-1 overflow-hidden rounded bg-[#26232C] py-1 pl-1 pr-1.5 shadow">
                          <ImageFile className="relative h-2 w-2 overflow-hidden fill-purple-500" />
                          <div className="flex items-center justify-start gap-[2.83px]">
                            <div className="text-base-gray-950 justify-start text-[9.92px] leading-[9.92px]">
                              img.png
                            </div>
                            <div className="justify-start text-[9.92px] leading-[9.92px] opacity-50">
                              2.3 MB
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="border-tokens-stroke-light/5 flex-col items-start justify-start gap-6 self-stretch overflow-hidden border-b-[0.35px] p-3.5">
                    <div className="inline-flex items-center justify-start gap-3 self-stretch">
                      <img
                        alt="Taylor"
                        height={200}
                        width={200}
                        className="h-6 w-6 rounded-full"
                        src="https://randomuser.me/api/portraits/women/65.jpg"
                      />
                      <div className="inline-flex flex-1 flex-col items-start justify-start gap-2">
                        <div className="inline-flex items-start justify-start gap-2 self-stretch">
                          <div className="flex flex-1 items-center justify-start gap-2">
                            <div className="flex items-center justify-start gap-[2.83px]">
                              <div className="text-base-gray-950 justify-start text-[9.92px] leading-[9.92px]">
                                Taylor
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="inline-flex items-center justify-start gap-[2.83px] self-stretch opacity-50">
                          <div className="text-base-gray-500/50 justify-start text-[9.92px] font-normal leading-[9.92px]">
                            To:
                          </div>
                          <div className="text-base-gray-500/50 justify-start text-[9.92px] font-normal leading-[9.92px]">
                            Alex, Sarah
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="from-tokens-scroll-overlay-primary to-tokens-scroll-overlay-top/0 absolute left-0 top-[668.98px] h-12 w-[547.09px] bg-linear-to-l" />
                  <div className="bg-tokens-agent-surface/10 border-tokens-agent-stroke absolute left-[498.90px] top-[674.65px] h-8 w-8 rounded-full border-2 px-1 shadow-[0px_8.503936767578125px_17.00787353515625px_0px_rgba(0,0,0,0.15)] backdrop-blur-lg" />
                </div>
                <div className="absolute left-0 top-[121px] inline-flex w-[650px] flex-col items-start justify-start gap-4 overflow-hidden rounded-3xl border border-[#8B5CF6] bg-[#2A1D48] p-6 outline outline-[#3F325F]">
                  <div className="inline-flex items-center justify-start gap-1.5">
                    <div className="relative h-3.5 w-3.5">
                      <LockIcon className="h-3.5 w-3.5 fill-[#D8C8FC]" />
                    </div>
                    <div className="flex items-center justify-start gap-1 text-xs leading-3 text-[#948CA4]">
                      Privacy Status
                      <ChevronDown className="relative h-2 w-2 overflow-hidden fill-[#8C8C8C]" />
                    </div>
                  </div>
                  <div className="justify-start self-stretch text-base font-normal leading-snug text-white">
                    Thread stored on your server. 4 attachments and 6 participants -{' '}
                    <span className="text-[#D8C8FC]">
                      encrypted at rest, never indexed or scanned by a third party. You own the
                      mailboxes, the data, and the domain.
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div>
              <h1 className="mb-2 mt-4 text-lg font-medium leading-loose text-white">
                Your Inbox, Your Server
              </h1>
              <p className="max-w-sm text-sm font-light text-[#979797]">
                No SaaS scanning your messages. Every thread, every attachment, every contact lives
                on the hardware you control - yours alone, end to end.
              </p>
            </div>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="relative aspect-square w-full overflow-hidden rounded-2xl md:h-96">
              <div className="absolute left-0 top-0 aspect-square w-full rounded-2xl bg-[#2B2B2B] md:h-96 md:w-96" />
              <div className="bg-panelDark absolute left-[34px] top-[34px] inline-flex w-[600px] flex-col items-start justify-start overflow-hidden rounded-xl">
                <div className="bg-tokens-surface-secondary border-tokens-stroke-light/5 inline-flex h-12 items-center justify-center gap-3 self-stretch overflow-hidden border-b-[0.50px] px-4 py-3">
                  <div className="flex h-6 items-center justify-center overflow-hidden rounded bg-[#262626] pl-1 pr-1.5">
                    <X className="relative h-3.5 w-3.5 overflow-hidden fill-[#767676]" />
                    <div className="flex items-center justify-center gap-2.5 px-0.5 text-[#767676]">
                      esc
                    </div>
                  </div>
                  <div className="flex flex-1 items-center justify-start gap-1">
                    <div className="relative w-px self-stretch rounded-full bg-[#767676]" />
                    <div className="flex-1 justify-center text-sm font-normal leading-none text-[#767676]">
                      Search by sender, subject, or content...
                    </div>
                  </div>
                </div>
                <div className="bg-tokens-surface-secondary border-tokens-stroke-light/5 flex flex-col items-start justify-start self-stretch overflow-hidden border-b-[0.50px]">
                  <div className="inline-flex items-center justify-start gap-1.5 self-stretch px-5 pb-3 pt-5">
                    <div className="flex-1 justify-start text-sm leading-none text-[#8C8C8C]">
                      Recently interacted
                    </div>
                  </div>
                  <div className="flex flex-col items-start justify-start gap-2 self-stretch p-2">
                    <div className="inline-flex items-center justify-start gap-3 self-stretch rounded-lg p-3">
                      <div className="relative h-8 w-8 rounded-full bg-indigo-500/10">
                        <div className="absolute left-[10.2px] top-[4px] h-7 w-3 overflow-hidden">
                          <img
                            src="/stripe.svg"
                            alt="Stripe"
                            width={12}
                            height={24}
                            className="w-18 absolute h-6"
                          />
                        </div>
                      </div>
                      <div className="inline-flex flex-1 flex-col items-start justify-start gap-2.5">
                        <div className="inline-flex items-start justify-start gap-2.5 self-stretch">
                          <div className="flex flex-1 items-center justify-start gap-3">
                            <div className="flex items-center justify-start gap-1">
                              <div className="text-base-gray-950 justify-start text-sm leading-none">
                                Stripe
                              </div>
                            </div>
                          </div>
                          <div className="text-base-gray-500/50 justify-start text-sm font-normal leading-none">
                            Mar 29
                          </div>
                        </div>
                        <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                          <div className="flex-1 justify-start text-sm font-normal leading-none text-[#8C8C8C]">
                            Payment confirmation #1234
                          </div>
                          <div className="flex items-start justify-start gap-1">
                            <div className="relative h-3.5 w-3.5 overflow-hidden" />
                            <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="inline-flex items-center justify-start gap-3 self-stretch rounded-lg p-3">
                      <div className="relative h-8 w-8 rounded-full bg-red-600/10">
                        <div className="absolute left-0 top-0 h-8 w-8 rounded-full" />
                        <div className="absolute left-[11px] top-[4px] h-7 w-2.5">
                          <img
                            src="/netflix.svg"
                            alt="Stripe"
                            width={12}
                            height={24}
                            className="w-18 absolute h-6"
                          />
                        </div>
                      </div>
                      <div className="inline-flex flex-1 flex-col items-start justify-start gap-2.5">
                        <div className="inline-flex items-start justify-start gap-2.5 self-stretch">
                          <div className="flex flex-1 items-center justify-start gap-3">
                            <div className="flex items-center justify-start gap-1">
                              <div className="text-base-gray-950 justify-start text-sm leading-none">
                                Netflix
                              </div>
                            </div>
                          </div>
                          <div className="text-base-gray-500/50 justify-start text-sm font-normal leading-none">
                            Mar 29
                          </div>
                        </div>
                        <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                          <div className="flex-1 justify-start text-sm font-normal leading-none text-[#8C8C8C]">
                            New shows added to your list
                          </div>
                          <div className="flex items-start justify-start gap-1">
                            <div className="relative h-3.5 w-3.5 overflow-hidden" />
                            <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="inline-flex items-center justify-start gap-3 self-stretch rounded-[10px] bg-[#202020] p-3">
                      <img
                        className="h-8 w-8 rounded-full"
                        src="https://randomuser.me/api/portraits/men/15.jpg"
                        alt="Casey"
                        width={32}
                        height={32}
                      />
                      <div className="inline-flex h-9 flex-1 flex-col items-start justify-start gap-2.5">
                        <div className="inline-flex items-start justify-start gap-2.5 self-stretch">
                          <div className="flex flex-1 items-center justify-start gap-3">
                            <div className="flex items-center justify-start gap-1">
                              <div className="text-base-gray-950 justify-start text-sm leading-none">
                                Casey
                              </div>
                              <div className="justify-start text-center text-sm leading-none text-[#8C8C8C]">
                                [9]
                              </div>
                            </div>
                          </div>
                          <div className="text-base-gray-500/50 justify-start text-sm font-normal leading-none">
                            Mar 29
                          </div>
                        </div>
                        <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                          <div className="flex-1 justify-start text-sm font-normal leading-none text-[#8C8C8C]">
                            New design review
                          </div>
                          <div className="flex items-start justify-start gap-1">
                            <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="inline-flex items-center justify-start gap-3 self-stretch rounded-lg p-3">
                      <div className="inline-flex h-8 w-8 flex-col items-center justify-center gap-2.5 overflow-hidden rounded-full bg-[#2B2B2B]">
                        <div className="relative h-8 w-8 overflow-hidden">
                          <div className="absolute left-[10.60px] top-[8px] h-4 w-2.5 overflow-hidden">
                            <Figma className="relative h-4 w-2.5 overflow-hidden" />
                          </div>
                        </div>
                      </div>
                      <div className="inline-flex flex-1 flex-col items-start justify-start gap-2.5">
                        <div className="inline-flex items-start justify-start gap-2.5 self-stretch">
                          <div className="flex flex-1 items-center justify-start gap-3">
                            <div className="flex items-center justify-start gap-1">
                              <div className="text-base-gray-950 justify-start text-sm leading-none">
                                Figma
                              </div>
                              <div className="justify-start text-center text-sm leading-none text-[#8C8C8C]">
                                [5]
                              </div>
                            </div>
                          </div>
                          <div className="text-base-gray-500/50 justify-start text-sm font-normal leading-none">
                            Mar 26
                          </div>
                        </div>
                        <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                          <div className="text-base-gray-500/50 flex-1 justify-start text-sm font-normal leading-none">
                            Comments on "Landing Page v2"
                          </div>
                          <div className="flex items-start justify-start gap-1">
                            <div className="relative h-3.5 w-3.5 overflow-hidden" />
                            <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="inline-flex items-center justify-start gap-3 self-stretch rounded-lg p-3">
                      <div className="inline-flex h-8 w-8 flex-col items-center justify-center gap-2.5 overflow-hidden rounded-full bg-red-500/10 px-1.5 py-2.5">
                        <div className="relative h-8 w-8 overflow-hidden">
                          <div className="absolute left-[7.30px] top-[7px] h-4 w-4 overflow-hidden">
                            <div className="absolute left-0 top-0 h-4 w-4 bg-red-500" />
                          </div>
                        </div>
                      </div>
                      <div className="inline-flex flex-1 flex-col items-start justify-start gap-2.5">
                        <div className="inline-flex items-start justify-start gap-2.5 self-stretch">
                          <div className="flex flex-1 items-center justify-start gap-3">
                            <div className="flex items-center justify-start gap-1">
                              <div className="text-base-gray-950 justify-start text-sm leading-none">
                                Asana
                              </div>
                            </div>
                          </div>
                          <div className="text-base-gray-500/50 justify-start text-sm font-normal leading-none">
                            Mar 25
                          </div>
                        </div>
                        <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                          <div className="text-base-gray-500/50 flex-1 justify-start text-sm font-normal leading-none">
                            Weekly task summary
                          </div>
                          <div className="flex items-start justify-start gap-1">
                            <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="inline-flex items-center justify-start gap-3 self-stretch rounded-lg p-3">
                      <div className="relative inline-flex h-8 w-8 flex-col items-center justify-center gap-2.5 rounded-full px-1.5 py-2.5">
                        <div className="bg-base-primary-500 outline-tokens-surface-secondary absolute left-[24px] top-[24px] h-2 w-2 rounded-full outline outline-2" />
                      </div>
                      <div className="inline-flex flex-1 flex-col items-start justify-start gap-2.5">
                        <div className="inline-flex items-start justify-start gap-2.5 self-stretch">
                          <div className="flex flex-1 items-center justify-start gap-3">
                            <div className="flex items-center justify-start gap-1">
                              <div className="text-base-gray-950 justify-start text-sm leading-none">
                                Nick
                              </div>
                            </div>
                          </div>
                          <div className="text-base-gray-500/50 justify-start text-sm font-normal leading-none">
                            Mar 28
                          </div>
                        </div>
                        <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                          <div className="text-base-gray-500/50 flex-1 justify-start text-sm font-normal leading-none">
                            Coffee next week?
                          </div>
                          <div className="flex items-start justify-start gap-1">
                            <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="inline-flex items-center justify-between self-stretch overflow-hidden">
                  <div className="border-tokens-stroke-light/5 flex h-12 flex-1 items-center justify-center gap-2 border-r-[0.50px]">
                    <div className="bg-tokens-button-surface/10 flex h-5 items-center justify-center overflow-hidden rounded px-1.5">
                      <div className="bg-base-gray-500/50 h-2 w-3" />
                    </div>
                    <div className="text-base-gray-500/50 justify-start text-sm leading-none">
                      Open
                    </div>
                  </div>
                  <div className="border-tokens-stroke-light/5 flex h-12 flex-1 items-center justify-center gap-2 border-r-[0.50px]">
                    <div className="bg-tokens-button-surface/10 flex h-5 items-center justify-center overflow-hidden rounded px-1">
                      <div className="text-base-gray-500/50 justify-start text-center text-sm leading-none">
                        ⌘R
                      </div>
                    </div>
                    <div className="text-base-gray-500/50 justify-start text-sm leading-none">
                      Reply
                    </div>
                  </div>
                  <div className="border-tokens-stroke-light/5 flex h-12 flex-1 items-center justify-center gap-2 border-r-[0.50px]">
                    <div className="bg-tokens-button-surface/10 flex h-5 items-center justify-center overflow-hidden rounded px-1">
                      <div className="text-base-gray-500/50 justify-start text-center text-sm leading-none">
                        ⌘E
                      </div>
                    </div>
                    <div className="text-base-gray-500/50 justify-start text-sm leading-none">
                      Archive
                    </div>
                  </div>
                  <div className="border-tokens-stroke-light/5 flex h-12 flex-1 items-center justify-center gap-2 border-r-[0.50px]">
                    <div className="bg-tokens-button-surface/10 flex h-5 items-center justify-center overflow-hidden rounded px-1">
                      <div className="text-base-gray-500/50 justify-start text-center text-sm leading-none">
                        ⌘M
                      </div>
                    </div>
                    <div className="text-base-gray-500/50 justify-start text-sm leading-none">
                      Mark read
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-4">
              <h1 className="mb-2 text-lg font-medium leading-loose text-white">Smart Search</h1>
              <p className="max-w-sm text-sm font-light text-[#979797]">
                Your inbox, your rules. Create personalized email processing flows that match
                exactly how you organize,write, reply, and work.
              </p>
            </div>
          </motion.div>
        </div>
      </div>

      <div className="relative mt-52">
        <div className="z-1 relative w-full">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex items-center justify-center"
          >
            <h1 className="text-lg font-light text-white/40 md:text-xl">
              Full-text search across every mailbox you host
            </h1>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="mt-2 flex flex-col items-center justify-center md:mt-8"
          >
            <h1 className="text-4xl font-medium text-white md:text-6xl">Search anything</h1>
            <h1 className="mb-4 text-4xl font-medium text-white/40 md:text-6xl">
              Across your servers
            </h1>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.5 }}
            className="relative flex w-full items-center justify-center"
          >
            <div className="relative mx-auto flex h-[587px] w-full max-w-[894px] items-center justify-center rounded-xl">
              <div className="absolute left-0 top-[319px] mx-auto inline-flex w-full max-w-[894px] flex-col items-start justify-start overflow-hidden rounded-xl bg-zinc-900 opacity-30">
                <div className="inline-flex items-center justify-start gap-1.5 self-stretch px-5 pb-4 pt-7">
                  <div className="flex flex-1 items-center justify-start gap-1.5">
                    <div className="justify-start text-sm leading-none text-[#8C8C8C]">Pinned</div>
                    <div className="justify-start text-sm leading-none text-[#8C8C8C]">[3]</div>
                  </div>
                </div>
                <div className="flex flex-col items-start justify-start gap-2 self-stretch px-2 pb-2">
                  <div className="inline-flex items-center justify-start gap-3 self-stretch rounded-lg p-3">
                    <img
                      src="https://randomuser.me/api/portraits/men/32.jpg"
                      alt="avatar"
                      width={32}
                      height={32}
                      className="rounded-full"
                    />
                    <div className="inline-flex h-9 flex-1 flex-col items-start justify-start gap-2.5">
                      <div className="inline-flex items-start justify-start gap-2.5 self-stretch">
                        <div className="flex flex-1 items-center justify-start gap-3">
                          <div className="flex items-center justify-start gap-1">
                            <div className="text-base-gray-950 justify-start text-sm leading-none">
                              Alex from Openship
                            </div>
                            <div className="justify-start text-center text-sm leading-none text-[#8C8C8C]">
                              [9]
                            </div>
                          </div>
                        </div>
                        <div className="justify-start text-sm font-normal leading-none text-[#8C8C8C]">
                          Mar 29
                        </div>
                      </div>
                      <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                        <div className="flex-1 justify-start text-sm font-normal leading-none text-[#8C8C8C]">
                          New design review
                        </div>
                        <div className="flex items-start justify-start gap-1">
                          <div className="relative h-3.5 w-3.5 overflow-hidden" />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="inline-flex items-center justify-start gap-3 self-stretch rounded-[10px] p-3">
                    <div className="inline-flex h-8 w-8 flex-col items-center justify-center gap-2.5 overflow-hidden rounded-full bg-[#313131] px-1.5 py-2.5 shadow-[0px_0px_0px_0.5px_rgba(255,255,255,0.00)] shadow-[0px_1px_2px_0px_rgba(255,255,255,0.00)]">
                      <GroupPeople className="h-5 w-5 overflow-hidden fill-[#989898]" />
                    </div>
                    <div className="inline-flex flex-1 flex-col items-start justify-start gap-2.5">
                      <div className="inline-flex items-start justify-start gap-2.5 self-stretch">
                        <div className="flex flex-1 items-center justify-start gap-3">
                          <div className="flex items-center justify-start gap-1.5">
                            <div className="text-base-gray-950 justify-start text-sm leading-none">
                              Alex, Ali, Sarah
                            </div>
                            <div className="justify-start text-center text-sm leading-none text-[#8C8C8C]">
                              [6]
                            </div>
                          </div>
                        </div>
                        <div className="justify-start text-sm font-normal leading-none text-[#8C8C8C]">
                          Mar 28
                        </div>
                      </div>
                      <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                        <div className="flex-1 justify-start text-sm font-normal leading-none text-[#8C8C8C]">
                          Re: Design review feedback
                        </div>
                        <div className="flex items-start justify-start gap-1">
                          <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          <div className="relative h-3.5 w-3.5 overflow-hidden" />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="inline-flex items-center justify-start gap-3 self-stretch rounded-lg p-3">
                    <div className="bg-tokens-surface-primary inline-flex h-8 w-8 flex-col items-center justify-center gap-2.5 overflow-hidden rounded-full px-1.5 py-2.5">
                      <div className="relative h-fit">
                        <GitHub className="h-[25px] w-[25px] fill-white" />
                      </div>
                    </div>
                    <div className="inline-flex flex-1 flex-col items-start justify-start gap-2.5">
                      <div className="inline-flex items-start justify-start gap-2.5 self-stretch">
                        <div className="flex flex-1 items-center justify-start gap-3">
                          <div className="flex items-center justify-start gap-1">
                            <div className="text-base-gray-950 justify-start text-sm leading-none">
                              GitHub
                            </div>
                            <div className="justify-start text-center text-sm leading-none text-[#8C8C8C]">
                              [8]
                            </div>
                          </div>
                        </div>
                        <div className="justify-start text-sm font-normal leading-none text-[#8C8C8C]">
                          Mar 28
                        </div>
                      </div>
                      <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                        <div className="flex-1 justify-start text-sm font-normal leading-none text-[#8C8C8C]">
                          Security alert: Critical vulnerability
                        </div>
                        <div className="flex items-start justify-start gap-1">
                          <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          <div className="relative h-3.5 w-3.5 overflow-hidden" />
                          <div className="relative h-3.5 w-3.5 overflow-hidden" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="absolute top-0 inline-flex aspect-96/125 w-full flex-col items-center justify-center overflow-hidden rounded-xl bg-[#252525] md:h-[500px] md:w-96">
                <div className="border-tokens-stroke-light/5 inline-flex items-center justify-start gap-2 self-stretch overflow-hidden border-b-[0.50px] py-3.5 pl-5 pr-3.5">
                  <div className="flex flex-1 items-center justify-start gap-3">
                    <div className="text-base-gray-950 flex flex-1 items-center justify-start text-sm leading-none">
                      <X className="mr-2 h-4 w-4 fill-[#8C8C8C]" />
                      New chat
                    </div>
                  </div>
                  <div className="flex h-6 items-center justify-center gap-0.5 overflow-hidden rounded-md px-1">
                    <Plus className="h-3 w-3 overflow-hidden fill-[#8C8C8C]" />
                  </div>
                  <div className="flex h-6 items-center justify-center gap-0.5 overflow-hidden rounded-md px-1">
                    <PanelLeftOpen className="h-3 w-3 overflow-hidden fill-[#8C8C8C]" />
                  </div>
                  <div className="flex h-6 items-center justify-center gap-0.5 overflow-hidden rounded-md px-1">
                    <Expand className="h-2.5 w-2.5 overflow-hidden fill-[#8C8C8C]" />
                  </div>
                </div>
                <div className="relative flex h-full flex-1 flex-col items-center justify-between gap-8 self-stretch overflow-hidden px-5 py-4">
                  <Search className="h-7 w-7 fill-white" />
                  <div className="flex flex-col items-center justify-start gap-3">
                    <div className="text-base-gray-950 justify-start text-sm leading-none">
                      Search across every mailbox on your server
                    </div>
                    <div className="justify-start text-sm font-normal leading-none text-[#929292]">
                      Indexed locally on your hardware - no third-party search service
                    </div>
                  </div>
                  <div className="relative inline-flex w-96 flex-col items-start justify-center gap-2">
                    {/* First row */}
                    <div className="no-scrollbar relative flex w-full justify-center">
                      <div className="flex items-center justify-start gap-2 whitespace-nowrap">
                        {firstRowQueries.map((query) => (
                          <div
                            key={query}
                            className="flex h-7 shrink-0 items-center justify-start gap-1.5 overflow-hidden rounded-md bg-[#303030] px-2 py-1.5"
                          >
                            <div className="flex items-center justify-start gap-1 px-0.5">
                              <div className="justify-start text-sm leading-none text-[#8B8B8B]">
                                {query}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="absolute left-0 top-0 h-7 w-12 bg-linear-to-l from-neutral-800/0 to-neutral-800" />
                      <div className="absolute right-0 top-0 h-7 w-12 bg-linear-to-l from-neutral-800 to-neutral-800/0" />
                    </div>

                    {/* Second row */}
                    <div className="no-scrollbar relative flex w-full justify-center">
                      <div className="flex items-center justify-start gap-2 whitespace-nowrap">
                        {secondRowQueries.map((query) => (
                          <div
                            key={query}
                            className="flex h-7 shrink-0 items-center justify-start gap-1.5 overflow-hidden rounded-md bg-[#303030] px-2 py-1.5"
                          >
                            <div className="flex items-center justify-start gap-1 px-0.5">
                              <div className="justify-start text-sm leading-none text-[#8B8B8B]">
                                {query}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="absolute left-0 top-0 h-7 w-12 bg-linear-to-l from-neutral-800/0 to-neutral-800" />
                      <div className="absolute right-0 top-0 h-7 w-12 bg-linear-to-l from-neutral-800 to-neutral-800/0" />
                    </div>
                  </div>
                  <div className="inline-flex w-full items-center justify-start gap-4 overflow-hidden p-0 md:w-96 md:p-4 md:pb-0">
                    <div className="flex h-8 flex-1 items-center justify-start gap-1.5 overflow-hidden rounded-md bg-[#141414] pl-2.5 pr-1">
                      <div className="relative h-3 w-px rounded-full bg-white" />
                      <div className="flex-1 justify-start text-sm leading-none text-[#727272]">
                        Ask Zero to do anything...
                      </div>
                      <div className="flex h-6 items-center justify-center gap-2.5 rounded bg-[#262626] px-1">
                        <CurvedArrow className="relative left-px mt-1 h-4 w-4 fill-black dark:fill-[#929292]" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
          <img
            src="/pixel.svg"
            alt="hero"
            width={1920}
            height={1080}
            className="z-2 relative bottom-24 rotate-180 bg-transparent opacity-0"
            style={{ clipPath: 'inset(45% 0 0 0)' }}
          />
        </div>
      </div>

      {/* ════════════════════════════════════════════════════
           UNLIMITED - domains/mailboxes capped only by the box
           ════════════════════════════════════════════════════ */}
      <div className="relative mt-16 md:-mt-32">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5 }}
          className="flex items-center justify-center"
        >
          <h1 className="text-lg font-light text-white/40 md:text-xl">
            No SaaS metering, no per-seat tax
          </h1>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-2 flex flex-col items-center justify-center md:mt-8"
        >
          <h1 className="text-center text-4xl font-medium text-white md:text-6xl">
            Unlimited domains
          </h1>
          <h1 className="mb-3 text-center text-4xl font-medium text-white/40 md:text-6xl">
            Until your VPS taps out
          </h1>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="relative mx-4 flex w-full items-center justify-center md:mx-0"
        >
          <div className="relative mx-auto flex w-full max-w-[920px] items-start justify-center md:h-[820px]">
            {/* Wide backdrop - Sending now activity feed (desktop only) */}
            <div className="absolute left-0 right-0 top-[440px] mx-auto hidden w-full max-w-[920px] flex-col items-start justify-start overflow-hidden rounded-2xl bg-zinc-900 opacity-30 md:inline-flex">
              <div className="inline-flex items-center justify-start gap-1.5 self-stretch px-5 pb-4 pt-7">
                <div className="flex flex-1 items-center justify-start gap-1.5">
                  <div className="text-sm leading-none text-[#8C8C8C]">Sending now</div>
                  <div className="text-sm leading-none text-[#8C8C8C]">[247]</div>
                </div>
                <div className="inline-flex items-center gap-1 rounded-full bg-[#12341D] px-1.5 py-0.5 text-[10px] leading-none text-[#A3E1B3]">
                  <span className="h-1 w-1 rounded-full bg-[#39AE4A]" />
                  live
                </div>
              </div>
              <div className="flex flex-col items-start justify-start gap-2 self-stretch px-2 pb-2">
                {[
                  { from: 'oblien.com',        to: 'team@stripe.com',     subj: 'Receipt #4827',         when: 'now' },
                  { from: 'mail.openship.com', to: 'jordan@blackbird.io', subj: 'Welcome to Openship',   when: '12s' },
                  { from: 'acme.io',           to: 'alex@dev.acme.io',    subj: 'New device sign-in',    when: '34s' },
                  { from: 'shop.acme.io',      to: 'nick@figma.com',      subj: 'Order #1248 shipped',   when: '52s' },
                ].map((row) => (
                  <div
                    key={row.subj}
                    className="inline-flex items-center justify-start gap-3 self-stretch rounded-lg p-3"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#313131]">
                      <Mail className="h-4 w-4 fill-[#989898]" />
                    </div>
                    <div className="inline-flex flex-1 flex-col items-start justify-start gap-2">
                      <div className="inline-flex items-center justify-start gap-2.5 self-stretch">
                        <div className="flex flex-1 items-center justify-start gap-1.5">
                          <span className="text-base-gray-950 text-sm leading-none">{row.from}</span>
                          <ArrowRight className="h-2.5 w-2.5 fill-[#8C8C8C]" />
                          <span className="text-sm leading-none text-[#8C8C8C]">{row.to}</span>
                        </div>
                        <div className="text-sm leading-none text-[#8C8C8C]">{row.when}</div>
                      </div>
                      <div className="text-sm leading-none text-[#8C8C8C]">{row.subj}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Center admin panel card */}
            <div className="bg-panelDark relative z-10 mt-10 inline-flex w-full max-w-[640px] flex-col overflow-hidden rounded-2xl shadow-md md:absolute md:top-0 md:mt-0">
            {/* Window chrome */}
            <div className="inline-flex h-12 items-center justify-start gap-3 self-stretch overflow-hidden border-b-[0.50px] border-[#252525] px-4">
              <div className="flex flex-1 items-center justify-start gap-2">
                <div className="flex flex-1 items-center justify-start gap-1.5">
                  <PanelLeftOpen className="h-3.5 w-3.5 fill-[#8C8C8C]" />
                  <div className="ml-1 justify-start text-sm leading-none text-white">Domains</div>
                  <div className="ml-1 justify-start text-sm leading-none text-[#8C8C8C]">[12]</div>
                </div>
              </div>
              <div className="flex h-7 items-center justify-center gap-1.5 overflow-hidden rounded-md bg-white px-2.5">
                <Plus className="h-3 w-3 fill-black" />
                <div className="text-sm leading-none text-black">Add domain</div>
              </div>
            </div>

            {/* Search + filter chips */}
            <div className="flex flex-col items-start justify-start gap-3 self-stretch p-4">
              <div className="inline-flex h-9 items-center justify-start gap-1 self-stretch overflow-hidden rounded-md bg-[#141414] pl-2.5 pr-1.5">
                <Search className="relative mr-1.5 h-3.5 w-3.5 overflow-hidden fill-[#8C8C8C]" />
                <div className="flex-1 justify-start text-sm leading-none text-[#929292]">
                  Search domains
                </div>
                <div className="flex h-6 items-center justify-center gap-2 rounded-sm bg-[#262626] px-1.5">
                  <div className="justify-start text-sm leading-none text-[#929292]">⌘K</div>
                </div>
              </div>

              <div className="inline-flex items-start justify-start gap-1.5 self-stretch">
                <div className="flex h-7 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-md bg-[#39AE4A] px-2.5">
                  <Check className="h-3 w-3 text-white" />
                  <div className="flex items-center justify-center gap-2">
                    <div className="justify-start text-sm leading-none text-white">All</div>
                    <div className="justify-start text-sm leading-none text-white/80">[12]</div>
                  </div>
                </div>
                <div className="flex h-7 items-center justify-center gap-1 overflow-hidden rounded-md bg-[#313131] px-2.5">
                  <div className="text-sm leading-none text-[#989898]">Verified</div>
                  <div className="text-sm leading-none text-[#6F6F6F]">[12]</div>
                </div>
                <div className="flex h-7 items-center justify-center gap-1 overflow-hidden rounded-md bg-[#313131] px-2.5">
                  <div className="text-sm leading-none text-[#989898]">Sending</div>
                  <div className="text-sm leading-none text-[#6F6F6F]">[11]</div>
                </div>
                <div className="flex h-7 items-center justify-center gap-1 overflow-hidden rounded-md bg-[#313131] px-2.5">
                  <div className="text-sm leading-none text-[#989898]">Idle</div>
                  <div className="text-sm leading-none text-[#6F6F6F]">[1]</div>
                </div>
              </div>

              {/* Green status callout */}
              <div className="relative flex flex-col items-start justify-center gap-2 self-stretch overflow-hidden rounded-md bg-[#12341D] px-3 py-3">
                <div className="justify-start self-stretch text-sm leading-none text-[#A3E1B3]">
                  No metering, no per-seat tax
                </div>
                <div className="justify-start self-stretch text-sm font-normal leading-normal text-[#F4FBF6]">
                  Add as many domains and mailboxes as your VPS can carry.<br />
                  Cap moves with the hardware - no SKU change, no upgrade dialog.
                </div>
              </div>
            </div>

            {/* List header */}
            <div className="inline-flex items-center justify-start gap-1 self-stretch px-4 pb-3 pt-1">
              <div className="flex flex-1 items-center justify-start gap-1.5">
                <div className="justify-start text-sm leading-none text-[#8C8C8C]">Active</div>
                <div className="justify-start text-sm leading-none text-[#8C8C8C]">[6]</div>
              </div>
              <div className="hidden items-center justify-end gap-10 text-sm leading-none text-[#8C8C8C] sm:flex">
                <span>Mailboxes</span>
                <span>Activity</span>
              </div>
            </div>

            {/* Domain rows - densely styled like the inbox card */}
            <div className="flex flex-col items-start justify-start gap-1 self-stretch px-1.5 pb-2">
              {[
                { name: 'oblien.com',         mailboxes: 247, when: '2 min ago',  live: true,  pct: 38 },
                { name: 'mail.openship.com',  mailboxes: 412, when: 'live',       live: true,  pct: 62 },
                { name: 'acme.io',            mailboxes: 83,  when: '1 hr ago',   live: true,  pct: 18 },
                { name: 'team.acme.io',       mailboxes: 45,  when: '8 min ago',  live: true,  pct: 12 },
                { name: 'shop.acme.io',       mailboxes: 12,  when: '3 hr ago',   live: false, pct: 4 },
                { name: 'staging.dev',        mailboxes: 5,   when: 'yesterday',  live: false, pct: 2 },
              ].map((d, i) => (
                <div
                  key={d.name}
                  className={`inline-flex items-center justify-start gap-3 self-stretch rounded-lg p-3 ${
                    i === 1 ? 'bg-[#202020]' : ''
                  }`}
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#313131]">
                    <Check className="h-3.5 w-3.5 text-[#A3E1B3]" />
                  </div>
                  <div className="flex flex-1 flex-col items-start justify-center gap-2">
                    <div className="inline-flex items-center justify-start gap-2 self-stretch">
                      <div className="text-sm leading-none text-white">{d.name}</div>
                      {d.live && (
                        <div className="inline-flex items-center gap-1 rounded-full bg-[#12341D] px-2 py-0.5 text-[11px] leading-none text-[#A3E1B3]">
                          <span className="h-1 w-1 rounded-full bg-[#39AE4A]" />
                          live
                        </div>
                      )}
                    </div>
                    <div className="inline-flex items-center gap-2 self-stretch">
                      <div className="text-xs font-normal leading-none text-[#8C8C8C]">
                        SPF · DKIM · DMARC · TLS
                      </div>
                    </div>
                  </div>
                  <div className="hidden flex-col items-end gap-2 sm:flex">
                    <div className="text-sm leading-none text-white">{d.mailboxes}</div>
                    <div className="relative h-1 w-16 overflow-hidden rounded-full bg-[#262626]">
                      <div
                        className="absolute left-0 top-0 h-full rounded-full bg-[#39AE4A]"
                        style={{ width: `${d.pct}%` }}
                      />
                    </div>
                  </div>
                  <div className="hidden w-20 justify-end text-right text-xs leading-none text-[#8C8C8C] sm:flex">
                    {d.when}
                  </div>
                </div>
              ))}
            </div>

            {/* Bottom stat strip - matches the kbd-shortcut footer pattern from Smart Search card */}
            <div className="inline-flex items-start justify-start self-stretch border-t-[0.50px] border-[#252525]">
              <div className="border-tokens-stroke-light/5 flex h-16 flex-1 flex-col items-center justify-center gap-1.5 border-r-[0.50px]">
                <div className="text-2xl font-medium leading-none text-white">∞</div>
                <div className="text-xs uppercase tracking-[0.16em] text-[#8C8C8C]">Domains</div>
              </div>
              <div className="border-tokens-stroke-light/5 flex h-16 flex-1 flex-col items-center justify-center gap-1.5 border-r-[0.50px]">
                <div className="text-2xl font-medium leading-none text-white">∞</div>
                <div className="text-xs uppercase tracking-[0.16em] text-[#8C8C8C]">Mailboxes</div>
              </div>
              <div className="flex h-16 flex-1 flex-col items-center justify-center gap-1.5">
                <div className="text-2xl font-medium leading-none text-white">$0</div>
                <div className="text-xs uppercase tracking-[0.16em] text-[#8C8C8C]">Add-on cost</div>
              </div>
            </div>
          </div>
          </div>
        </motion.div>
      </div>

      {/* ════════════════════════════════════════════════════
           ACCESS - Gmail, Apple Mail, mobile, webmail, API
           ════════════════════════════════════════════════════ */}
      <div className="relative mt-52">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5 }}
          className="flex items-center justify-center"
        >
          <h1 className="text-lg font-light text-white/40 md:text-xl">
            Any client. Any device. Any protocol.
          </h1>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-2 flex flex-col items-center justify-center md:mt-8"
        >
          <h1 className="text-center text-4xl font-medium text-white md:text-6xl">
            Access from anywhere
          </h1>
          <h1 className="mb-3 text-center text-4xl font-medium text-white/40 md:text-6xl">
            Gmail app, mobile, your API
          </h1>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="relative bottom-3 mx-4 flex items-center justify-center bg-[#0F0F0F] md:mx-0"
        >
          <div className="bg-panelDark mx-auto mt-10 inline-flex w-full max-w-[920px] flex-col items-stretch overflow-hidden rounded-2xl shadow-md md:flex-row">
            {/* Left: client list */}
            <div className="flex flex-1 flex-col gap-2 border-b-[0.50px] p-4 md:border-b-0 md:border-r-[0.50px]">
              <div className="mb-1 px-2 text-[10.5px] font-medium uppercase tracking-[0.18em] text-[#8C8C8C]">
                Connect any client
              </div>

              {[
                {
                  icon: <GmailColor className="h-5 w-5" />,
                  name: 'Gmail',
                  desc: 'Add as a third-party account, send + receive from your domain.',
                  tag: 'IMAP · SMTP',
                },
                {
                  icon: <Mail className="h-5 w-5 fill-white" />,
                  name: 'Apple Mail',
                  desc: 'Native macOS and iOS. One-tap profile or manual SSL setup.',
                  tag: 'IMAP · SMTP',
                },
                {
                  icon: <OutlookColor className="h-5 w-5" />,
                  name: 'Outlook',
                  desc: 'Desktop and web - full calendar, contacts, sub-folders.',
                  tag: 'IMAP · SMTP',
                },
                {
                  icon: <Phone className="h-5 w-5 fill-white" />,
                  name: 'Mobile apps',
                  desc: 'K-9, Spark, Edison, FairEmail - anything that speaks IMAP.',
                  tag: 'IMAP · SMTP',
                },
                {
                  icon: <Inbox className="h-5 w-5 fill-white" />,
                  name: 'Openship Webmail',
                  desc: 'The bundled web client - fast, keyboard-driven, no install.',
                  tag: 'Built-in',
                },
              ].map((c) => (
                <div
                  key={c.name}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-white/[0.03]"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#1A1A1A]">
                    {c.icon}
                  </div>
                  <div className="flex flex-1 flex-col gap-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm leading-none text-white">{c.name}</div>
                      <div className="rounded-full bg-[#202020] px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.12em] text-[#8C8C8C]">
                        {c.tag}
                      </div>
                    </div>
                    <div className="text-xs leading-snug text-[#8C8C8C]">{c.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Right: protocol/API panel */}
            <div className="flex flex-1 flex-col gap-4 p-5">
              <div className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-[#8C8C8C]">
                Or talk to us directly
              </div>

              {/* Protocol pills */}
              <div className="flex flex-wrap gap-2">
                {['IMAP', 'IMAPS', 'SMTP', 'Submission', 'POP3', 'JMAP', 'REST API', 'Webhooks'].map((p) => (
                  <span
                    key={p}
                    className="rounded-full border border-[#2B2B2B] bg-[#1A1A1A] px-2.5 py-1 text-xs text-[#B7B7B7]"
                  >
                    {p}
                  </span>
                ))}
              </div>

              {/* Code example */}
              <div className="rounded-lg border border-[#2B2B2B] bg-[#141414] p-3">
                <div className="mb-2 flex items-center gap-2">
                  <CurvedArrow className="h-3 w-3 fill-[#8C8C8C]" />
                  <div className="text-[11px] font-medium text-[#8C8C8C]">Send from your code</div>
                </div>
                <pre className="overflow-x-auto whitespace-pre font-mono text-[11px] leading-[1.55] text-[#B7B7B7]">
                  <span className="text-[#8C8C8C]">$ </span>curl https://api.openship.email/v1/send \{'\n'}
                  {'    '}-H <span className="text-[#A3E1B3]">"Authorization: Bearer ..."</span> \{'\n'}
                  {'    '}-d <span className="text-[#A3E1B3]">'{`{"from":"alex@yours.com","to":...}`}'</span>{'\n'}
                  <span className="text-[#A3E1B3]">{'  '}→ 202 Accepted · queued</span>
                </pre>
              </div>

              {/* Auth note */}
              <div className="flex items-start gap-2 rounded-lg border border-[#2B2B2B] bg-[#1A1A1A] p-3">
                <LockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-[#D8C8FC]" />
                <div className="text-xs leading-relaxed text-[#B7B7B7]">
                  <span className="text-white">TLS everywhere.</span> SPF, DKIM, DMARC and
                  reverse-DNS are configured the second you add a domain - every client lands on a deliverable inbox.
                </div>
              </div>

              <Link
                href="/docs/clients"
                className="inline-flex items-center gap-1 text-xs text-[#8C8C8C] transition-colors hover:text-white"
              >
                Setup guides for every client
                <ArrowRight className="h-3 w-3 fill-current" />
              </Link>
            </div>
          </div>
        </motion.div>
      </div>

      {/* <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative hidden lg:block"
      >
        <div className="mx-auto max-w-[920px] text-center text-4xl font-normal leading-[48px] text-white">
          <span className="text-[#B7B7B7]">Work smarter, not harder.</span>{' '}
          <span className="pr-12 text-white">Automate repetitive</span>{' '}
          <span className="text-[#B7B7B7]">email</span>
          <span className="text-[#B7B7B7]"> tasks with</span>{' '}
          <span className="pr-14 text-white">smart templates, </span>{' '}
          <span className="text-white">scheduled sends</span>
          <span className="text-[#B7B7B7]">
            , follow-up reminders, and batch processing capabilities that
          </span>{' '}
          <br />
          <span className="text-white underline">save hours every week.</span>
        </div>
        <div className="flex items-center justify-center">
          <img
            className="relative bottom-12 right-[162px]"
            src="/verified-home.png"
            alt="tasks"
            width={50}
            height={50}
          />
          <img
            className="relative bottom-[145px] right-[47px]"
            src="/snooze-home.png"
            alt="tasks"
            width={50}
            height={50}
          />
          <img
            className="relative bottom-[195px] left-[210px]"
            src="/star-home.png"
            alt="tasks"
            width={50}
            height={50}
          />
        </div>
      </motion.div> */}

      {/* ════════════════════════════════════════════════════
           SETUP GUIDES - deep-link cards into /mail/setup-guide/<client>
           ════════════════════════════════════════════════════ */}
      <div className="relative mt-52">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5 }}
          className="flex items-center justify-center"
        >
          <h1 className="text-lg font-light text-white/40 md:text-xl">
            Step-by-step. Per client.
          </h1>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-2 flex flex-col items-center justify-center md:mt-8"
        >
          <h1 className="text-center text-4xl font-medium text-white md:text-6xl">
            Setup guides
          </h1>
          <h1 className="mb-3 text-center text-4xl font-medium text-white/40 md:text-6xl">
            for every client
          </h1>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="relative mx-4 mt-10 flex items-center justify-center md:mx-0"
        >
          <div className="mx-auto grid w-full max-w-[920px] grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              {
                slug: 'ios',
                title: 'iOS & macOS Mail',
                desc: 'Native Apple Mail on iPhone, iPad, and Mac.',
                tag: 'Apple',
              },
              {
                slug: 'android',
                title: 'Android Gmail app',
                desc: 'Add as a third-party IMAP account in Gmail.',
                tag: 'Android',
              },
              {
                slug: 'desktop',
                title: 'Desktop clients',
                desc: 'Thunderbird, Outlook, Spark, K-9 - same flow.',
                tag: 'IMAP · SMTP',
              },
              {
                slug: 'nodemailer',
                title: 'Send via code',
                desc: 'Node, Python, Go - any SMTP library works.',
                tag: 'SMTP',
              },
            ].map((g) => (
              <Link
                key={g.slug}
                href={`/mail/setup-guide/${g.slug}`}
                className="bg-panelDark group flex items-start gap-3 rounded-2xl border border-white/5 p-4 transition-colors hover:border-white/15"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#1A1A1A]">
                  <Mail className="h-4 w-4 fill-white" />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium leading-none text-white">
                      {g.title}
                    </div>
                    <div className="rounded-full bg-[#202020] px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.12em] text-[#8C8C8C]">
                      {g.tag}
                    </div>
                  </div>
                  <div className="text-xs leading-snug text-[#8C8C8C]">{g.desc}</div>
                </div>
                <ArrowRight className="mt-1 h-3 w-3 shrink-0 fill-[#8C8C8C] transition-colors group-hover:fill-white" />
              </Link>
            ))}
          </div>
        </motion.div>
      </div>

      <div className="relative mt-52">
        <MailFooter />
      </div>
    </main>
  );
}
