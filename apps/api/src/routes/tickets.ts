/**
 * apps/api/src/routes/tickets.ts
 *
 * Usage: support tickets (mounted under /api). Customers see their own
 * tickets; admins see everyone's and reply as "Support".
 *   GET  /tickets                       -> own tickets, newest activity first
 *   POST /tickets { subject, body, serverId? } -> open a ticket
 *   GET  /tickets/:id                   -> ticket + messages (owner or admin)
 *   POST /tickets/:id/messages { body } -> reply; customer reply -> "open", staff reply -> "answered"
 *   POST /tickets/:id/close             -> close (owner or admin); a later customer reply reopens it
 *   GET  /admin/tickets?status=open     -> every ticket (admins)
 */
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { servers, ticketMessages, tickets, users, type ticketStatus } from "../db/schema.js";
import { enqueueMail } from "../jobs/queue.js";
import { templates } from "../mail/templates.js";

const createBody = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
  serverId: z.string().uuid().optional(),
});
const replyBody = z.object({ body: z.string().trim().min(1).max(10_000) });
const idParams = z.object({ id: z.string().uuid() });
const adminQuery = z.object({ status: z.enum(["open", "answered", "closed"]).optional() });

type TicketStatus = (typeof ticketStatus.enumValues)[number];

export async function ticketRoutes(app: FastifyInstance, { db, queues, config }: AppDeps) {
  const link = (id: string) => `${config.PUBLIC_URL.replace(/\/+$/, "")}/support/${id}`;

  async function loadVisible(req: FastifyRequest) {
    const { id } = idParams.parse(req.params);
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id));
    if (!ticket) return null;
    return ticket.userId === req.user.id || req.user.role === "admin" ? ticket : null;
  }

  app.get("/tickets", { preHandler: app.authenticate }, async (req) => ({
    tickets: await db.select().from(tickets).where(eq(tickets.userId, req.user.id)).orderBy(desc(tickets.updatedAt)),
  }));

  app.post("/tickets", { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = createBody.parse(req.body);
    if (body.serverId) {
      const [server] = await db
        .select({ id: servers.id })
        .from(servers)
        .where(and(eq(servers.id, body.serverId), eq(servers.ownerId, req.user.id)));
      if (!server) return reply.code(400).send({ error: "Unknown server" });
    }
    const ticket = await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(tickets)
        .values({ userId: req.user.id, subject: body.subject, serverId: body.serverId })
        .returning();
      await tx.insert(ticketMessages).values({ ticketId: t!.id, authorId: req.user.id, body: body.body });
      return t!;
    });
    await audit(db, { actorId: req.user.id, action: "ticket.create", targetType: "ticket", targetId: ticket.id });
    for (const to of config.SUPPORT_NOTIFY_EMAILS) {
      await enqueueMail(queues.mail, { to, ...templates.newTicket(`${req.user.name} <${req.user.email}>`, ticket.subject, link(ticket.id)) });
    }
    return reply.code(201).send({ ticket });
  });

  app.get("/tickets/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const ticket = await loadVisible(req);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found" });
    const messages = await db
      .select({
        id: ticketMessages.id,
        body: ticketMessages.body,
        fromStaff: ticketMessages.fromStaff,
        authorName: users.name,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .innerJoin(users, eq(users.id, ticketMessages.authorId))
      .where(eq(ticketMessages.ticketId, ticket.id))
      .orderBy(ticketMessages.createdAt);
    // Customers see staff replies as "Support", not the admin's personal name.
    const isAdmin = req.user.role === "admin";
    return {
      ticket,
      messages: messages.map((m) => ({ ...m, authorName: m.fromStaff && !isAdmin ? "Support" : m.authorName })),
    };
  });

  app.post("/tickets/:id/messages", { preHandler: app.authenticate }, async (req, reply) => {
    const ticket = await loadVisible(req);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found" });
    const { body } = replyBody.parse(req.body);
    const fromStaff = req.user.role === "admin" && ticket.userId !== req.user.id;
    const status: TicketStatus = fromStaff ? "answered" : "open";
    await db.transaction(async (tx) => {
      await tx.insert(ticketMessages).values({ ticketId: ticket.id, authorId: req.user.id, body, fromStaff });
      await tx.update(tickets).set({ status }).where(eq(tickets.id, ticket.id));
    });
    await audit(db, { actorId: req.user.id, action: "ticket.reply", targetType: "ticket", targetId: ticket.id });
    if (fromStaff) {
      const [customer] = await db.select().from(users).where(eq(users.id, ticket.userId));
      if (customer) {
        await enqueueMail(queues.mail, { to: customer.email, ...templates.ticketReply(customer.name, ticket.subject, link(ticket.id)) });
      }
    }
    return reply.code(201).send({ status });
  });

  app.post("/tickets/:id/close", { preHandler: app.authenticate }, async (req, reply) => {
    const ticket = await loadVisible(req);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found" });
    await db.update(tickets).set({ status: "closed" }).where(eq(tickets.id, ticket.id));
    await audit(db, { actorId: req.user.id, action: "ticket.close", targetType: "ticket", targetId: ticket.id });
    return { status: "closed" };
  });

  app.get("/admin/tickets", { preHandler: app.requireAdmin }, async (req) => {
    const { status } = adminQuery.parse(req.query);
    const rows = await db
      .select({
        id: tickets.id,
        subject: tickets.subject,
        status: tickets.status,
        userId: tickets.userId,
        customerEmail: users.email,
        customerName: users.name,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
      })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.userId))
      .where(status ? eq(tickets.status, status) : undefined)
      .orderBy(desc(tickets.updatedAt))
      .limit(200);
    return { tickets: rows };
  });
}
