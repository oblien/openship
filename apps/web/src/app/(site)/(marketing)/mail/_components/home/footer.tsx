'use client';
import { motion } from 'motion/react';
import { Button } from '../ui/button';
import Link from 'next/link';
import { useRef } from 'react';
import { Footer as OpenshipFooter } from '@/components/landing';

export default function MailFooter() {
  const ref = useRef(null);

  return (
    <div className="bg-panelDark mx-1 mb-3 md:mx-4 md:mb-3 flex-col items-center justify-center rounded-xl flex">
      <div>
        <div>
          <img
            src="/gradient.svg"
            alt="logo"
            width={1000}
            height={100}
            className="w-screen rounded-t-2xl"
          />
        </div>
        <div className="relative bottom-20 inline-flex w-full justify-center lg:bottom-60">
          <div
            ref={ref}
            className="relative inline-flex w-full flex-col items-center justify-center gap-20 rounded-full"
          >
            <div className="flex flex-col items-center justify-center px-2">
              <div className="flex flex-col items-center py-5">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5 }}
                  className="lg:to-panelDark inline-block text-center text-2xl font-bold text-white sm:text-4xl md:text-5xl lg:bg-linear-to-b lg:from-[#84878D] lg:via-[#84878D] lg:bg-clip-text lg:text-8xl lg:text-transparent"
                >
                  <span>Experience the Future of </span> <br />
                  Email Today
                </motion.div>
              </div>
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="hidden flex-col items-center justify-start md:flex"
              >
                <div className="justify-start text-center text-lg font-normal leading-7 text-white lg:text-2xl">
                  Self-host Openship and run your own mail server in minutes.
                </div>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.4 }}
                className="flex w-fit flex-col items-center justify-center md:pt-4"
              >
                <Link href="/docs/install">
                  <Button className="h-8 bg-white text-black cursor-pointer">
                    Install Openship
                  </Button>
                </Link>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
      <div className="w-full self-stretch">
        <OpenshipFooter />
      </div>
    </div>
  );
}
