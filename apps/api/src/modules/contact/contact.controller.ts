import type { Context } from "hono";
import { sendMail } from "../../lib/mail";

export async function submit(c: Context) {
  const body = await c.req.json().catch(() => null);

  if (
    !body ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    typeof body.email !== "string" ||
    !body.email.trim() ||
    typeof body.subject !== "string" ||
    !body.subject.trim() ||
    typeof body.message !== "string" ||
    !body.message.trim()
  ) {
    return c.json({ error: "All fields are required." }, 400);
  }

  const { name, email, subject, message } = body as {
    name: string;
    email: string;
    subject: string;
    message: string;
  };

  const text = `Name: ${name}\nEmail: ${email}\nSubject: ${subject}\nMessage:\n${message}`;

  try {
    await sendMail({
      to: "support@oblien.com",
      subject: `[Contact] ${subject}`,
      html: text,
      text,
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error("[contact] sendMail failed:", err);
    return c.json({ error: "Failed to send message. Please try again later." }, 500);
  }
}
