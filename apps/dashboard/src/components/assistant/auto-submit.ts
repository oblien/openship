"use client";

import { createAutoSubmitIntent } from "@/hooks/use-auto-submit";

// Shared by assistant action links and their destination, never derived from a URL alone.
export const assistantAutoSubmit = createAutoSubmitIntent();
