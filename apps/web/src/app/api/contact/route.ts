import { NextResponse } from "next/server";

/** Old proxy hid the browser's IP from intake. The form now calls the protected API directly. */
export function POST() {
  return NextResponse.json({ error: "Open the contact form and complete the bot check before sending." }, { status: 410 });
}
