/**
 * apps/api/src/mail/mailer.ts
 *
 * Usage: sends email. The API never sends directly — it enqueues messages
 * (enqueueMail in jobs/queue.ts) and the worker calls mailer.send() with retries.
 *
 *   const mailer = createMailer(config);                 // SMTP when SMTP_URL is set, else logs to stdout
 *   await mailer.send({ to, subject, text });
 *   const test = createMemoryMailer(); test.outbox       // captured messages, for tests
 */
import nodemailer from "nodemailer";
import type { Config } from "../config.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function createMailer(config: Pick<Config, "SMTP_URL" | "MAIL_FROM">): Mailer {
  if (!config.SMTP_URL) {
    return {
      async send(message) {
        console.log(`[mail] (not sent: SMTP_URL is empty)\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`);
      },
    };
  }
  const transport = nodemailer.createTransport(config.SMTP_URL);
  return {
    async send(message) {
      await transport.sendMail({ from: config.MAIL_FROM, ...message });
    },
  };
}

export function createMemoryMailer(): Mailer & { outbox: MailMessage[] } {
  const outbox: MailMessage[] = [];
  return {
    outbox,
    async send(message) {
      outbox.push(message);
    },
  };
}
