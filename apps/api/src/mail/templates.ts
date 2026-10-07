/**
 * apps/api/src/mail/templates.ts
 *
 * Usage: plain-text email bodies. Each function returns { subject, text } to
 * pass to enqueueMail() together with the recipient:
 *
 *   await enqueueMail(queues.mail, { to: user.email, ...templates.passwordReset(user.name, link) });
 */

const sign = "\n\n— The billdude team";

export const templates = {
  verifyEmail: (name: string, link: string) => ({
    subject: "Confirm your email address",
    text: `Hi ${name},\n\nPlease confirm your email address to start creating servers:\n\n${link}\n\nThe link is valid for 48 hours.${sign}`,
  }),

  passwordReset: (name: string, link: string) => ({
    subject: "Reset your password",
    text: `Hi ${name},\n\nSomeone (hopefully you) asked to reset your password. Choose a new one here:\n\n${link}\n\nThe link is valid for 1 hour. If you did not ask for this, you can ignore this email.${sign}`,
  }),

  passwordChanged: (name: string) => ({
    subject: "Your password was changed",
    text: `Hi ${name},\n\nThe password for your account was just changed and all other sessions were signed out. If this was not you, reset your password immediately and contact support.${sign}`,
  }),

  ticketReply: (name: string, subject: string, link: string) => ({
    subject: `Support replied: ${subject}`,
    text: `Hi ${name},\n\nOur support team replied to your ticket "${subject}":\n\n${link}${sign}`,
  }),

  newTicket: (customer: string, subject: string, link: string) => ({
    subject: `New support ticket: ${subject}`,
    text: `${customer} opened a ticket "${subject}".\n\n${link}`,
  }),

  lowBalance: (name: string, balance: string, hours: number, link: string) => ({
    subject: "Your balance is running low",
    text: `Hi ${name},\n\nYour wallet balance is ${balance}, which covers about ${hours} more hours of your current servers. Add funds to keep them running:\n\n${link}${sign}`,
  }),

  overdue: (name: string, balance: string, graceHours: number, link: string) => ({
    subject: "Action needed: your balance is overdue",
    text: `Hi ${name},\n\nYour wallet balance is ${balance}. Running servers will be stopped in ${graceHours} hours unless you add funds. Stopped servers keep their data.\n\n${link}${sign}`,
  }),

  serversStopped: (name: string, count: number, link: string) => ({
    subject: "Your servers were stopped for non-payment",
    text: `Hi ${name},\n\n${count} of your servers ${count === 1 ? "was" : "were"} stopped because your balance stayed overdue. Their disks are kept and still billed. Add funds and start them again:\n\n${link}${sign}`,
  }),
};
