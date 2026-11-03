import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { badRequest, conflict, notFound, forbidden } from "./errors.js";

export interface TaskCard { id: string; title: string; description: string; position: number; assigneeId: string | null; dueAt: string | null; createdAt: string; updatedAt: string }
export interface TaskList { id: string; title: string; position: number; cards: TaskCard[] }
export interface TaskBoard { id: string; organizationId: string; title: string; createdAt: string; lists: TaskList[] }
export interface Organization { id: string; name: string; role: "owner" | "member"; members: { id: string; name: string; email: string; role: string }[] }

const id = () => randomUUID();
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
function cleanText(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== "string") throw badRequest(`${field} must be text`);
  const result = value.trim();
  if (required && !result) throw badRequest(`${field} is required`);
  if (result.length > max) throw badRequest(`${field} must be ${max} characters or fewer`);
  return result;
}
function order(value: unknown): number { return Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, Math.floor(value as number))) : 0; }
function toCard(card: { id: string; title: string; description: string; position: number; assigneeId: string | null; dueAt: Date | null; createdAt: Date; updatedAt: Date }): TaskCard {
  return { ...card, dueAt: card.dueAt?.toISOString() ?? null, createdAt: card.createdAt.toISOString(), updatedAt: card.updatedAt.toISOString() };
}

/** Prisma-backed collaboration operations. Every board read/write includes a membership predicate. */
export class TasksService {
  constructor(private readonly prisma: PrismaClient) {}

  async organizations(userId: string): Promise<Organization[]> {
    const memberships = await this.prisma.organizationMember.findMany({ where: { userId }, include: { organization: true }, orderBy: { createdAt: "asc" } });
    return Promise.all(memberships.map(async ({ organization, role }) => ({ id: organization.id, name: organization.name, role: role as Organization["role"], members: await this.members(userId, organization.id) })));
  }

  async createOrganization(userId: string, body: Record<string, unknown>): Promise<Organization> {
    const name = cleanText(body.name, "Organization name", 80);
    const organizationId = id();
    await this.prisma.$transaction(async (tx) => {
      await tx.organization.create({ data: { id: organizationId, name, createdBy: userId } });
      await tx.organizationMember.create({ data: { organizationId, userId, role: "owner" } });
    });
    return { id: organizationId, name, role: "owner", members: await this.members(userId, organizationId) };
  }

  async renameOrganization(userId: string, organizationId: string, rawName: unknown): Promise<void> {
    const name = cleanText(rawName, "Organization name", 80);
    const role = await this.requireMember(userId, organizationId);
    if (role !== "owner") throw forbidden("Only organization owners can rename it");
    await this.prisma.organization.update({ where: { id: organizationId }, data: { name } });
  }

  async members(userId: string, organizationId: string): Promise<Organization["members"]> {
    await this.requireMember(userId, organizationId);
    return this.prisma.$queryRaw<Organization["members"]>(Prisma.sql`
      SELECT u.id,u.name,u.email,m.role FROM collaboration.organization_members m
      JOIN public."user" u ON u.id=m.user_id WHERE m.organization_id=${organizationId}::uuid ORDER BY m.created_at`);
  }

  async createInvite(userId: string, organizationId: string, body: Record<string, unknown>): Promise<{ token: string; expiresAt: string }> {
    const email = cleanText(body.email, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Enter a valid email address");
    if (body.role !== undefined && body.role !== "member") throw badRequest("Invitations can only grant member access");
    const role = await this.requireMember(userId, organizationId);
    if (role !== "owner") throw forbidden("Only organization owners can invite people");
    const members = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT m.user_id AS id FROM collaboration.organization_members m JOIN public."user" u ON u.id=m.user_id
      WHERE m.organization_id=${organizationId}::uuid AND lower(u.email)=${email}`);
    if (members.length) throw conflict("This person is already on the organization", "already_member");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.prisma.organizationInvitation.upsert({
      where: { organizationId_email: { organizationId, email } },
      create: { id: id(), organizationId, email, tokenHash: tokenHash(token), invitedBy: userId, expiresAt },
      update: { tokenHash: tokenHash(token), invitedBy: userId, expiresAt, createdAt: new Date() },
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async acceptInvite(userId: string, rawToken: unknown): Promise<{ organizationId: string }> {
    const token = cleanText(rawToken, "Invitation token", 128);
    return this.prisma.$transaction(async (tx) => {
      const invite = await tx.organizationInvitation.findFirst({ where: { tokenHash: tokenHash(token), expiresAt: { gt: new Date() } } });
      if (!invite) throw notFound("Invitation is invalid or has expired");
      const users = await tx.$queryRaw<{ email: string }[]>(Prisma.sql`SELECT email FROM public."user" WHERE id=${userId}`);
      if (!users[0] || users[0].email.toLowerCase() !== invite.email.toLowerCase()) throw forbidden("Sign in with the email address this invitation was sent to");
      await tx.organizationMember.upsert({ where: { organizationId_userId: { organizationId: invite.organizationId, userId } }, create: { organizationId: invite.organizationId, userId, role: "member" }, update: {} });
      const consumed = await tx.organizationInvitation.deleteMany({ where: { id: invite.id, tokenHash: tokenHash(token), expiresAt: { gt: new Date() } } });
      if (consumed.count !== 1) throw notFound("Invitation is invalid or has expired");
      return { organizationId: invite.organizationId };
    });
  }

  async createBoard(userId: string, organizationId: string, body: Record<string, unknown>): Promise<TaskBoard> {
    await this.requireMember(userId, organizationId);
    const title = cleanText(body.title, "Board name", 120);
    const boardId = id();
    await this.prisma.taskBoard.create({ data: { id: boardId, organizationId, title, createdBy: userId, lists: { create: ["To do", "In progress", "Done"].map((label, position) => ({ id: id(), title: label, position })) } } });
    return this.board(userId, boardId);
  }

  async boards(userId: string, organizationId: string) {
    await this.requireMember(userId, organizationId);
    const rows = await this.prisma.taskBoard.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } });
    return rows.map((row) => ({ id: row.id, organizationId: row.organizationId, title: row.title, createdAt: row.createdAt.toISOString() }));
  }

  async board(userId: string, boardId: string): Promise<TaskBoard> {
    const board = await this.prisma.taskBoard.findFirst({
      where: { id: boardId, organization: { members: { some: { userId } } } },
      include: { lists: { orderBy: [{ position: "asc" }, { id: "asc" }], include: { cards: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] } } } },
    });
    if (!board) throw notFound();
    return {
      id: board.id, organizationId: board.organizationId, title: board.title, createdAt: board.createdAt.toISOString(),
      lists: board.lists.map((list) => ({ id: list.id, title: list.title, position: list.position, cards: list.cards.map(toCard) })),
    };
  }

  async renameBoard(userId: string, boardId: string, title: unknown): Promise<void> {
    const name = cleanText(title, "Board name", 120);
    const result = await this.prisma.taskBoard.updateMany({ where: { id: boardId, organization: { members: { some: { userId } } } }, data: { title: name } });
    if (!result.count) throw notFound();
  }

  async deleteBoard(userId: string, boardId: string): Promise<void> {
    const board = await this.prisma.taskBoard.findFirst({ where: { id: boardId, organization: { members: { some: { userId, role: "owner" } } } }, select: { id: true } });
    if (!board) throw notFound("Board not found or owner access required");
    await this.prisma.taskBoard.delete({ where: { id: boardId } });
  }

  async saveList(userId: string, boardId: string, body: Record<string, unknown>, listId?: string): Promise<void> {
    await this.requireBoard(userId, boardId);
    const title = cleanText(body.title, "List name", 80);
    if (listId) {
      const result = await this.prisma.taskList.updateMany({ where: { id: listId, boardId }, data: { title, position: order(body.position) } });
      if (!result.count) throw notFound();
    } else {
      const max = await this.prisma.taskList.aggregate({ where: { boardId }, _max: { position: true } });
      await this.prisma.taskList.create({ data: { id: id(), boardId, title, position: (max._max.position ?? -1) + 1 } });
    }
  }

  async deleteList(userId: string, boardId: string, listId: string): Promise<void> {
    await this.requireBoard(userId, boardId);
    const result = await this.prisma.taskList.deleteMany({ where: { id: listId, boardId } });
    if (!result.count) throw notFound();
  }

  async saveCard(userId: string, boardId: string, body: Record<string, unknown>, cardId?: string): Promise<void> {
    await this.requireBoard(userId, boardId);
    const title = cleanText(body.title, "Card title", 200);
    const description = cleanText(body.description ?? "", "Description", 5000, false);
    const listId = cleanText(body.listId, "List", 64);
    const list = await this.prisma.taskList.findFirst({ where: { id: listId, boardId }, select: { id: true } });
    if (!list) throw badRequest("Choose a list on this board");
    const assigneeId = body.assigneeId == null || body.assigneeId === "" ? null : cleanText(body.assigneeId, "Assignee", 128);
    if (assigneeId && !(await this.prisma.organizationMember.findFirst({ where: { organization: { boards: { some: { id: boardId } } }, userId: assigneeId } }))) throw badRequest("Assignee must be on this organization");
    let dueAt: Date | null = null;
    if (body.dueAt) {
      dueAt = new Date(String(body.dueAt));
      if (!Number.isFinite(dueAt.getTime())) throw badRequest("Due date is invalid");
    }
    if (cardId) {
      const result = await this.prisma.taskCard.updateMany({ where: { id: cardId, list: { board: { id: boardId, organization: { members: { some: { userId } } } } } }, data: { listId, title, description, position: order(body.position), assigneeId, dueAt } });
      if (!result.count) throw notFound();
    } else {
      const max = await this.prisma.taskCard.aggregate({ where: { listId }, _max: { position: true } });
      await this.prisma.taskCard.create({ data: { id: id(), listId, title, description, position: (max._max.position ?? -1) + 1, assigneeId, dueAt, createdBy: userId } });
    }
  }

  async deleteCard(userId: string, boardId: string, cardId: string): Promise<void> {
    const result = await this.prisma.taskCard.deleteMany({ where: { id: cardId, list: { board: { id: boardId, organization: { members: { some: { userId } } } } } } });
    if (!result.count) throw notFound();
  }

  async requireBoard(userId: string, boardId: string): Promise<string> {
    const board = await this.prisma.taskBoard.findFirst({ where: { id: boardId, organization: { members: { some: { userId } } } }, select: { organizationId: true } });
    if (!board) throw notFound();
    return board.organizationId;
  }

  async requireMember(userId: string, organizationId: string): Promise<"owner" | "member"> {
    const membership = await this.prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
    if (!membership) throw notFound();
    return membership.role as "owner" | "member";
  }
}
