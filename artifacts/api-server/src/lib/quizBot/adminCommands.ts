import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  quizAnswersTable,
  quizBookPagesTable,
  quizBotSettingsTable,
  quizParticipantsTable,
  quizQuestionsTable,
  quizSessionParticipantsTable,
  quizSessionsTable,
  quizTopicsTable,
} from "@workspace/db";
import {
  acknowledgeTelegramCallback,
  editTelegramMessage,
  sendTelegramMessage,
  type TelegramUser,
  type TelegramUpdate,
} from "./telegram";
import { logger } from "../logger";
import type { QuizDifficulty } from "./ai";

type PrivateMessage = NonNullable<TelegramUpdate["message"]>;
export type AdminCommandContext = {
  getSettings: () => Promise<{
    groupChatId: string | null;
    dailyTime: string;
    timezone: string;
    minimumParticipants: number;
    signupWindowMinutes: number;
    questionCount: number;
    secondsPerQuestion: number;
    enabled: boolean;
    bookPageOffset: number;
  }>;
  startQuizNow: () => Promise<string>;
  getBookStatus: () => Promise<string>;
  startConfiguredQuiz: (
    adminTelegramUserId: number,
    topicTitle: string,
    questionCount: number,
    secondsPerQuestion: number,
    difficulty?: QuizDifficulty | null,
  ) => Promise<AdminQuizPreview>;
  parseQuizRequest: (
    text: string,
    previous?: {
      previousTopicTitle: string | null;
      previousQuestionCount: number | null;
      previousSecondsPerQuestion: number | null;
      previousDifficulty: QuizDifficulty | null;
      recentMessages: string[];
    },
  ) => Promise<{
    intent: "create_quiz" | "schedule_quiz" | "other";
    topicTitle: string | null;
    questionCount: number | null;
    secondsPerQuestion: number | null;
    scheduledDate: string | null;
    scheduledTime: string | null;
    difficulty: QuizDifficulty | null;
    reply: string;
  }>;
  scheduleQuiz: (
    scheduledDate: string,
    scheduledTime: string,
    topicTitle: string,
    difficulty?: QuizDifficulty | null,
  ) => Promise<string>;
  regenerateQuizPreview: (
    adminTelegramUserId: number,
    previewId: string,
  ) => Promise<AdminQuizPreview>;
  getQuizPreview: (
    adminTelegramUserId: number,
    previewId: string,
  ) => Promise<AdminQuizPreview | null>;
  publishQuizPreview: (
    adminTelegramUserId: number,
    previewId: string,
  ) => Promise<{ published: boolean; message: string }>;
  cancelQuizPreview: (
    adminTelegramUserId: number,
    previewId: string,
  ) => Promise<void>;
};

type AdminQuizPreview = {
  id: string;
  topicTitle: string;
  questionCount: number;
  secondsPerQuestion: number;
  source: "database" | "ai";
  questions: Array<{
    prompt: string;
    options: [string, string, string, string];
    correctOptionIndex: number;
    explanation: string;
  }>;
};

type RankedResult = {
  userId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  total: number;
  correct: number;
  answered: number;
  averageAnswerSeconds: number | null;
};

function displayName(person: {
  firstName: string;
  lastName: string | null;
  username: string | null;
}): string {
  const name = [person.firstName, person.lastName].filter(Boolean).join(" ");
  return person.username ? `${name} (@${person.username})` : name;
}

export async function sendLongTelegramMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>,
  parseMode?: "HTML",
): Promise<void> {
  let remaining = text;
  while (remaining.length > 3800) {
    let splitAt = remaining.lastIndexOf("\n", 3800);
    if (splitAt < 1) splitAt = 3800;
    await sendTelegramMessage(
      chatId,
      remaining.slice(0, splitAt),
      undefined,
      parseMode,
    );
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining) {
    await sendTelegramMessage(chatId, remaining, replyMarkup, parseMode);
  }
}

function localDate(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function parseQuizDate(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (value === "bugun") return localDate();
  if (value === "ertaga") return localDate(1);
  let year: number;
  let month: number;
  let day: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
    if (!match) return null;
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export const parseDateInput = parseQuizDate;

function percent(correct: number, total: number): number {
  return total > 0 ? Math.round((correct / total) * 100) : 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sortRankings(rows: RankedResult[]): RankedResult[] {
  return rows.sort((a, b) => {
    const percentOrder =
      percent(b.correct, b.total) - percent(a.correct, a.total);
    return (
      b.correct - a.correct ||
      percentOrder ||
      (a.averageAnswerSeconds ?? Number.POSITIVE_INFINITY) -
        (b.averageAnswerSeconds ?? Number.POSITIVE_INFINITY) ||
      a.total - a.answered - (b.total - b.answered) ||
      displayName(a).localeCompare(displayName(b), "uz")
    );
  });
}

async function getSessionResults(sessionId: string): Promise<RankedResult[]> {
  const rows = await db
    .select({
      userId: quizParticipantsTable.telegramUserId,
      firstName: quizParticipantsTable.firstName,
      lastName: quizParticipantsTable.lastName,
      username: quizParticipantsTable.username,
      total: sql<number>`count(distinct ${quizQuestionsTable.id})::int`,
      correct: sql<number>`count(${quizAnswersTable.id}) filter (where ${quizAnswersTable.isCorrect})::int`,
      answered: sql<number>`count(${quizAnswersTable.id})::int`,
      averageAnswerSeconds: sql<number | null>`
        avg(extract(epoch from (${quizAnswersTable.answeredAt} - ${quizQuestionsTable.pollOpenedAt})))
        FILTER (WHERE ${quizQuestionsTable.pollOpenedAt} IS NOT NULL)::double precision
      `,
    })
    .from(quizSessionParticipantsTable)
    .innerJoin(
      quizParticipantsTable,
      eq(
        quizParticipantsTable.telegramUserId,
        quizSessionParticipantsTable.telegramUserId,
      ),
    )
    .leftJoin(
      quizQuestionsTable,
      eq(quizQuestionsTable.sessionId, quizSessionParticipantsTable.sessionId),
    )
    .leftJoin(
      quizAnswersTable,
      and(
        eq(quizAnswersTable.questionId, quizQuestionsTable.id),
        eq(
          quizAnswersTable.telegramUserId,
          quizSessionParticipantsTable.telegramUserId,
        ),
      ),
    )
    .where(eq(quizSessionParticipantsTable.sessionId, sessionId))
    .groupBy(
      quizParticipantsTable.telegramUserId,
      quizParticipantsTable.firstName,
      quizParticipantsTable.lastName,
      quizParticipantsTable.username,
    );
  return sortRankings(rows);
}

async function findSession(date?: string) {
  const [session] = await db
    .select()
    .from(quizSessionsTable)
    .where(
      date
        ? and(
            eq(quizSessionsTable.status, "completed"),
            eq(quizSessionsTable.scheduledDate, date),
          )
        : eq(quizSessionsTable.status, "completed"),
    )
    .orderBy(
      desc(quizSessionsTable.scheduledDate),
      desc(quizSessionsTable.createdAt),
    )
    .limit(1);
  return session;
}

function formatResults(title: string, rows: RankedResult[]): string {
  if (rows.length === 0) {
    return `<b>🏆 TEST NATIJALARI</b>\n<b>${escapeHtml(title)}</b>\n\n❌ Ishtirokchilar bo‘lmagan.\n\n${QUIZ_FOOTER}`;
  }
  const totalQuestions = rows[0]?.total ?? 0;
  const average =
    rows.reduce((sum, row) => sum + percent(row.correct, row.total), 0) /
    rows.length;
  const winners = rows.slice(0, 3).map((row, index) => {
    const medal = ["🥇", "🥈", "🥉"][index]!;
    const time =
      row.averageAnswerSeconds === null
        ? "—"
        : `${row.averageAnswerSeconds.toFixed(1)} s`;
    return `${medal} <b>${escapeHtml(displayName(row))}</b> — <code>${row.correct}/${row.total} · ${percent(row.correct, row.total)}%</code> · ⏱ <code>${time}</code>`;
  });
  const remaining = rows.slice(3).map(
    (row, index) =>
      `<code>${String(index + 4).padStart(2)} │</code> <b>${escapeHtml(displayName(row))}</b> <code>│ ${row.correct}/${row.total} │ ${percent(row.correct, row.total)}%</code>`,
  );
  return [
    "<b>🏆 TEST NATIJALARI</b>",
    `<b>${escapeHtml(title)}</b>`,
    "",
    `🎉 O‘rtacha natija: <code>${average.toFixed(1)}%</code>`,
    `📊 <code>${rows.length}</code> qatnashchi · <code>${totalQuestions}</code> savol`,
    "",
    ...winners,
    ...(remaining.length > 0
      ? [
          "",
          "<b>Qolgan qatnashchilar</b>",
          "<code># │ Ishtirokchi │ Ball │ Natija</code>",
          ...remaining,
        ]
      : []),
    "",
    QUIZ_FOOTER,
  ].join("\n");
}

export async function getSessionResultsText(
  sessionId: string,
): Promise<string> {
  const [session] = await db
    .select({
      title: quizSessionsTable.topicTitle,
      date: quizSessionsTable.scheduledDate,
    })
    .from(quizSessionsTable)
    .where(eq(quizSessionsTable.id, sessionId))
    .limit(1);
  if (!session) throw new Error("Test sessiyasi topilmadi.");
  const rows = await getSessionResults(sessionId);
  return formatResults(
    `Test natijalari: ${session.title} (${session.date})`,
    rows,
  );
}

export async function getOverallLeaderboardText(
  days?: number,
): Promise<string> {
  const perSession = db
    .select({
      userId: quizSessionParticipantsTable.telegramUserId,
      sessionId: quizSessionsTable.id,
      total: sql<number>`count(distinct ${quizQuestionsTable.id})::int`.as(
        "total",
      ),
      correct:
        sql<number>`count(${quizAnswersTable.id}) filter (where ${quizAnswersTable.isCorrect})::int`.as(
          "correct",
        ),
    })
    .from(quizSessionParticipantsTable)
    .innerJoin(
      quizSessionsTable,
      and(
        eq(quizSessionsTable.id, quizSessionParticipantsTable.sessionId),
        eq(quizSessionsTable.status, "completed"),
        eq(quizSessionsTable.chatType, "group"),
        ...(days
          ? [
              gte(
                quizSessionsTable.scheduledDate,
                sql`current_date - ${days - 1}::int`,
              ),
            ]
          : []),
      ),
    )
    .leftJoin(
      quizQuestionsTable,
      eq(quizQuestionsTable.sessionId, quizSessionsTable.id),
    )
    .leftJoin(
      quizAnswersTable,
      and(
        eq(quizAnswersTable.questionId, quizQuestionsTable.id),
        eq(
          quizAnswersTable.telegramUserId,
          quizSessionParticipantsTable.telegramUserId,
        ),
      ),
    )
    .groupBy(quizSessionParticipantsTable.telegramUserId, quizSessionsTable.id)
    .as("per_session");

  const rows = await db
    .select({
      userId: quizParticipantsTable.telegramUserId,
      firstName: quizParticipantsTable.firstName,
      lastName: quizParticipantsTable.lastName,
      username: quizParticipantsTable.username,
      correct: sql<number>`sum(${perSession.correct})::int`,
      total: sql<number>`sum(${perSession.total})::int`,
      sessions: sql<number>`count(*)::int`,
    })
    .from(perSession)
    .innerJoin(
      quizParticipantsTable,
      eq(quizParticipantsTable.telegramUserId, perSession.userId),
    )
    .groupBy(
      quizParticipantsTable.telegramUserId,
      quizParticipantsTable.firstName,
      quizParticipantsTable.lastName,
      quizParticipantsTable.username,
    );

  const ranked = rows.sort(
    (a, b) =>
      b.correct - a.correct ||
      percent(b.correct, b.total) - percent(a.correct, a.total) ||
      displayName(a).localeCompare(displayName(b), "uz"),
  );
  const title = days
    ? `Umumiy reyting (so‘nggi ${days} kun)`
    : "Umumiy reyting (barcha yakunlangan testlar)";
  if (ranked.length === 0)
    return `${title}\nHozircha yakunlangan testlar yo‘q.`;
  return [
    title,
    "",
    ...ranked.map(
      (row, index) =>
        `${index + 1}. ${displayName(row)} — ${row.correct}/${row.total} (${percent(row.correct, row.total)}%), ${row.sessions} test`,
    ),
  ].join("\n");
}

async function showSessionResults(chatId: string, rawDate?: string) {
  const date = rawDate ? parseQuizDate(rawDate) : undefined;
  if (rawDate && !date) {
    await sendLongTelegramMessage(
      chatId,
      "Sana formati noto‘g‘ri. YYYY-MM-DD, DD.MM.YYYY, bugun yoki ertaga kiriting.",
    );
    return;
  }
  const session = await findSession(date ?? undefined);
  if (!session) {
    await sendLongTelegramMessage(
      chatId,
      date
        ? `${date} sanasida yakunlangan test topilmadi.`
        : "Hali yakunlangan test yo‘q.",
    );
    return;
  }
  await sendLongTelegramMessage(
    chatId,
    formatResults(
      `Test natijalari: ${session.topicTitle} (${session.scheduledDate})`,
      await getSessionResults(session.id),
    ),
  );
}

async function showParticipant(
  chatId: string,
  rawSearch: string,
  telegramUserId?: string,
) {
  const search = rawSearch.trim().replace(/^@/, "");
  if (!search && !telegramUserId) {
    await sendLongTelegramMessage(
      chatId,
      "Foydalanish: /ishtirokchi ism yoki @username",
    );
    return;
  }
  const exact = await db
    .select()
    .from(quizParticipantsTable)
    .where(
      telegramUserId
        ? eq(quizParticipantsTable.telegramUserId, telegramUserId)
        : sql`lower(coalesce(${quizParticipantsTable.username}, '')) = lower(${search})
            or lower(concat_ws(' ', ${quizParticipantsTable.firstName}, ${quizParticipantsTable.lastName})) = lower(${search})`,
    )
    .orderBy(desc(quizParticipantsTable.lastSeenAt))
    .limit(1);
  const [person] =
    exact.length > 0
      ? exact
      : telegramUserId
        ? []
        : await db
            .select()
            .from(quizParticipantsTable)
            .where(
              sql`position(lower(${search}) in lower(concat_ws(' ', ${quizParticipantsTable.firstName}, ${quizParticipantsTable.lastName}, ${quizParticipantsTable.username}))) > 0`,
            )
            .orderBy(desc(quizParticipantsTable.lastSeenAt))
            .limit(1);
  if (!person) {
    await sendLongTelegramMessage(
      chatId,
      `Ishtirokchi topilmadi: ${rawSearch}`,
    );
    return;
  }
  const [totals] = await db
    .select({
      correct: sql<number>`count(${quizAnswersTable.id}) filter (where ${quizAnswersTable.isCorrect})::int`,
      total: sql<number>`count(distinct ${quizQuestionsTable.id})::int`,
      tests: sql<number>`count(distinct ${quizSessionsTable.id})::int`,
    })
    .from(quizSessionParticipantsTable)
    .innerJoin(
      quizSessionsTable,
      and(
        eq(quizSessionsTable.id, quizSessionParticipantsTable.sessionId),
        eq(quizSessionsTable.status, "completed"),
      ),
    )
    .leftJoin(
      quizQuestionsTable,
      eq(quizQuestionsTable.sessionId, quizSessionsTable.id),
    )
    .leftJoin(
      quizAnswersTable,
      and(
        eq(quizAnswersTable.questionId, quizQuestionsTable.id),
        eq(quizAnswersTable.telegramUserId, person.telegramUserId),
      ),
    )
    .where(
      eq(quizSessionParticipantsTable.telegramUserId, person.telegramUserId),
    );

  const sessions = await db
    .select({
      id: quizSessionsTable.id,
      title: quizSessionsTable.topicTitle,
      date: quizSessionsTable.scheduledDate,
    })
    .from(quizSessionParticipantsTable)
    .innerJoin(
      quizSessionsTable,
      and(
        eq(quizSessionsTable.id, quizSessionParticipantsTable.sessionId),
        eq(quizSessionsTable.status, "completed"),
      ),
    )
    .where(
      eq(quizSessionParticipantsTable.telegramUserId, person.telegramUserId),
    )
    .orderBy(
      desc(quizSessionsTable.scheduledDate),
      desc(quizSessionsTable.createdAt),
    )
    .limit(5);

  const history: string[] = [];
  for (const session of sessions) {
    const [score] = await db
      .select({
        total: sql<number>`count(distinct ${quizQuestionsTable.id})::int`,
        correct: sql<number>`count(${quizAnswersTable.id}) filter (where ${quizAnswersTable.isCorrect})::int`,
      })
      .from(quizQuestionsTable)
      .leftJoin(
        quizAnswersTable,
        and(
          eq(quizAnswersTable.questionId, quizQuestionsTable.id),
          eq(quizAnswersTable.telegramUserId, person.telegramUserId),
        ),
      )
      .where(eq(quizQuestionsTable.sessionId, session.id));
    history.push(
      `• ${session.date} — ${session.title}: ${score?.correct ?? 0}/${score?.total ?? 0} (${percent(score?.correct ?? 0, score?.total ?? 0)}%)`,
    );
  }

  const correct = totals?.correct ?? 0;
  const total = totals?.total ?? 0;
  await sendLongTelegramMessage(
    chatId,
    [
      `Ishtirokchi: ${displayName(person)}`,
      `Jami: ${correct}/${total} (${percent(correct, total)}%), ${totals?.tests ?? 0} test`,
      "",
      "Oxirgi testlar:",
      ...(history.length > 0 ? history : ["Hali yakunlangan test yo‘q."]),
    ].join("\n"),
  );
}

export async function showMyResults(
  chatId: string,
  telegramUserId: number,
): Promise<void> {
  await showParticipant(chatId, "", String(telegramUserId));
}

async function showQuestions(chatId: string, rawDate?: string) {
  const date = rawDate ? parseQuizDate(rawDate) : undefined;
  if (rawDate && !date) {
    await sendLongTelegramMessage(
      chatId,
      "Sana formati: YYYY-MM-DD yoki DD.MM.YYYY.",
    );
    return;
  }
  const session = await findSession(date ?? undefined);
  if (!session) {
    await sendLongTelegramMessage(
      chatId,
      date
        ? `${date} sanasida yakunlangan test topilmadi.`
        : "Yakunlangan test yo‘q.",
    );
    return;
  }
  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.sessionId, session.id))
    .orderBy(asc(quizQuestionsTable.position));
  const lines = [`Savollar: ${session.topicTitle} (${session.scheduledDate})`];
  for (const question of questions) {
    lines.push(
      "",
      `${question.position + 1}. ${question.prompt}`,
      ...question.options.map(
        (option, index) =>
          `${String.fromCharCode(65 + index)}. ${option}${index === question.correctOptionIndex ? " ✓ (to‘g‘ri)" : ""}`,
      ),
    );
    const answers = await db
      .select({
        selected: quizAnswersTable.selectedOptionIndex,
        isCorrect: quizAnswersTable.isCorrect,
        firstName: quizParticipantsTable.firstName,
        lastName: quizParticipantsTable.lastName,
        username: quizParticipantsTable.username,
      })
      .from(quizAnswersTable)
      .innerJoin(
        quizParticipantsTable,
        eq(
          quizParticipantsTable.telegramUserId,
          quizAnswersTable.telegramUserId,
        ),
      )
      .where(eq(quizAnswersTable.questionId, question.id))
      .orderBy(asc(quizParticipantsTable.firstName));
    if (answers.length === 0) {
      lines.push("Javob berganlar: yo‘q");
    } else {
      lines.push(
        "Javoblar:",
        ...answers.map(
          (answer) =>
            `• ${displayName(answer)} — ${String.fromCharCode(65 + answer.selected)}${answer.isCorrect ? " ✓" : " ✗"}`,
        ),
      );
    }
  }
  await sendLongTelegramMessage(chatId, lines.join("\n"));
}

async function showHistory(chatId: string) {
  const sessions = await db
    .select()
    .from(quizSessionsTable)
    .orderBy(
      desc(quizSessionsTable.scheduledDate),
      desc(quizSessionsTable.createdAt),
    )
    .limit(10);
  if (sessions.length === 0) {
    await sendLongTelegramMessage(chatId, "Testlar tarixi bo‘sh.");
    return;
  }
  const lines = ["Oxirgi 10 test:"];
  for (const session of sessions) {
    const rows = await getSessionResults(session.id);
    const average =
      rows.length > 0
        ? rows.reduce((sum, row) => sum + percent(row.correct, row.total), 0) /
          rows.length
        : 0;
    const averageText =
      session.status === "completed" ? `${average.toFixed(1)}%` : "—";
    lines.push(
      `• ${session.scheduledDate} — ${session.topicTitle}; holat: ${session.status}; qatnashgan: ${rows.length}; o‘rtacha: ${averageText}`,
    );
  }
  await sendLongTelegramMessage(chatId, lines.join("\n"));
}

export function parsePageRanges(value: string): Array<[number, number]> | null {
  if (value.trim() === "-" || value.trim() === "") return [];
  const ranges: Array<[number, number]> = [];
  for (const part of value.split(",")) {
    const match = /^\s*(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?\s*$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || to < from || to - from > 500) return null;
    ranges.push([from, to]);
  }
  return ranges;
}

async function addTopic(
  chatId: string,
  rawArguments: string,
  context: AdminCommandContext,
) {
  const parts = rawArguments.split("|").map((part) => part.trim());
  if (parts.length !== 3 || !parts[1]) {
    await sendLongTelegramMessage(
      chatId,
      "Foydalanish: /mavzu sana | mavzu nomi | betlar (bet bo‘lmasa -).",
    );
    return;
  }
  const date = parseQuizDate(parts[0] ?? "");
  const pages = parsePageRanges(parts[2] ?? "");
  if (!date) {
    await sendLongTelegramMessage(
      chatId,
      "Sana bugun, ertaga, YYYY-MM-DD yoki DD.MM.YYYY bo‘lishi kerak.",
    );
    return;
  }
  if (!pages) {
    await sendLongTelegramMessage(
      chatId,
      "Betlarni masalan 45-52, 45 yoki 45-48, 51-52 ko‘rinishida kiriting.",
    );
    return;
  }
  const settings = await context.getSettings();
  const [topic] = await db
    .insert(quizTopicsTable)
    .values({
      scheduledFor: date,
      title: parts[1]!,
      bookPages: pages.length > 0 ? parts[2]! : null,
      status: "planned",
    })
    .returning({ id: quizTopicsTable.id });
  if (!topic) throw new Error("Mavzuni saqlab bo‘lmadi.");

  let warning = "";
  if (pages.length > 0) {
    const pdfPages = pages.flatMap(([from, to]) =>
      Array.from(
        { length: to - from + 1 },
        (_, index) => from + index + settings.bookPageOffset,
      ),
    );
    const [stored] = await db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(quizBookPagesTable)
      .where(
        and(
          inArray(quizBookPagesTable.pageNumber, pdfPages),
          sql`btrim(${quizBookPagesTable.content}) <> ''`,
        ),
      );
    if ((stored?.count ?? 0) === 0) {
      warning =
        "\nOgohlantirish: ko‘rsatilgan betlar uchun saqlangan kitob matni topilmadi; savollar mavzu nomidan tuziladi.";
    }
  }
  await sendLongTelegramMessage(
    chatId,
    `Mavzu qo‘shildi: ${date} — ${parts[1]} (ID: ${topic.id.slice(0, 8)}).${warning}`,
  );
}

async function listTopics(chatId: string) {
  const [settings] = await db
    .select({ timezone: quizBotSettingsTable.timezone })
    .from(quizBotSettingsTable)
    .where(eq(quizBotSettingsTable.id, 1))
    .limit(1);
  const topics = await db
    .select()
    .from(quizTopicsTable)
    .where(inArray(quizTopicsTable.status, ["planned", "announcing", "announced"]))
    .orderBy(asc(quizTopicsTable.scheduledFor), asc(quizTopicsTable.createdAt));
  if (topics.length === 0) {
    await sendLongTelegramMessage(chatId, "Rejalashtirilgan mavzular yo‘q.");
    return;
  }
  await sendLongTelegramMessage(
    chatId,
    [
      "Rejalashtirilgan mavzular:",
      ...topics.map(
        (topic) =>
          `• ${topic.scheduledFor}${topic.scheduledAt ? ` ${new Intl.DateTimeFormat("uz-UZ", { timeZone: settings?.timezone ?? "Asia/Tashkent", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(topic.scheduledAt)}` : ""} — ${topic.title}; betlar: ${topic.bookPages ?? "—"}; ID: ${topic.id.slice(0, 8)}`,
      ),
      "",
      "O‘chirish yoki test vaqtini bekor qilish: /mavzu_ochir ID",
    ].join("\n"),
  );
}

async function deleteTopic(chatId: string, idPrefix: string) {
  const prefix = idPrefix.trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(prefix)) {
    await sendLongTelegramMessage(
      chatId,
      "ID mavzular ro‘yxatidagi 8 belgili ID bo‘lsin.",
    );
    return;
  }
  const matches = await db
    .select({ id: quizTopicsTable.id, title: quizTopicsTable.title })
    .from(quizTopicsTable)
    .where(
      and(
        inArray(quizTopicsTable.status, [
          "planned",
          "announcing",
          "announced",
        ]),
        sql`left(${quizTopicsTable.id}::text, 8) = ${prefix}`,
      ),
    )
    .limit(2);
  if (matches.length !== 1) {
    await sendLongTelegramMessage(
      chatId,
      matches.length > 1
        ? "Bu ID bir nechta mavzuga mos keldi; to‘liqroq ID yuboring."
        : "Shu ID bilan rejalashtirilgan mavzu topilmadi.",
    );
    return;
  }
  await db
    .delete(quizTopicsTable)
    .where(eq(quizTopicsTable.id, matches[0]!.id));
  await sendLongTelegramMessage(
    chatId,
    `Mavzu o‘chirildi: ${matches[0]!.title}`,
  );
}

async function showSettings(
  chatId: string,
  context: AdminCommandContext,
  replyMarkup?: Record<string, unknown>,
) {
  const settings = await context.getSettings();
  await sendLongTelegramMessage(
    chatId,
    [
      "Bot sozlamalari:",
      `Holat: ${settings.enabled ? "ishlayapti" : "to‘xtatilgan"}`,
      `Kunlik vaqt: ${settings.dailyTime} (${settings.timezone})`,
      `Savollar soni: ${settings.questionCount}`,
      `Guruh uchun minimum qatnashchi: ${settings.minimumParticipants}`,
      `Har savolga: ${settings.secondsPerQuestion} soniya`,
      `Ro‘yxatdan o‘tish: ${settings.signupWindowMinutes} daqiqa`,
      "Test tugagach, keyingi guruh testi uchun 2 daqiqalik tanaffus bor.",
      "Savollar avval bazadagi tayyor to‘plamdan olinadi; yetarli bo‘lmasa Nemotron AI yordamida tayyorlanadi.",
      "Savol soni variantlari: 5, 10, 15, 20 yoki 30. Savol vaqti: 15, 20, 25 yoki 30 soniya.",
      "",
      "Buyruqlar: /vaqt HH:MM, /savol_soni 5|10|15|20|30, /minimum 1-50 (guruh uchun), /soniya 15|20|25|30, /royxat 1-120, /toxtat, /davom",
    ].join("\n"),
    replyMarkup,
  );
}

type AdjustableSetting =
  | "questionCount"
  | "minimumParticipants"
  | "secondsPerQuestion"
  | "signupWindowMinutes";

async function updateNumberSetting(
  chatId: string,
  argument: string,
  field: AdjustableSetting,
  label: string,
  minimum: number,
  maximum: number,
  allowedValues?: readonly number[],
) {
  const value = Number(argument);
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum ||
    (allowedValues && !allowedValues.includes(value))
  ) {
    await sendLongTelegramMessage(
      chatId,
      allowedValues
        ? `Qiymat quyidagilardan biri bo‘lsin: ${allowedValues.join(", ")}.`
        : `Qiymat ${minimum}–${maximum} oralig‘idagi butun son bo‘lsin.`,
    );
    return;
  }
  await db
    .update(quizBotSettingsTable)
    .set({ [field]: value, updatedAt: new Date() })
    .where(eq(quizBotSettingsTable.id, 1));
  await sendLongTelegramMessage(chatId, `${label}: ${value}.`);
}

async function updateTimeSetting(chatId: string, argument: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(argument)) {
    await sendLongTelegramMessage(
      chatId,
      "Vaqt HH:MM ko‘rinishida bo‘lsin, masalan /vaqt 20:00.",
    );
    return;
  }
  await db
    .update(quizBotSettingsTable)
    .set({ dailyTime: argument, updatedAt: new Date() })
    .where(eq(quizBotSettingsTable.id, 1));
  await sendLongTelegramMessage(
    chatId,
    `Kunlik vaqt o‘zgartirildi: ${argument}.`,
  );
}

const HELP = [
  "Bot admin buyruqlari (shaxsiy chatda):",
  "/natija [sana] — oxirgi yoki tanlangan sana natijalari",
  "/reyting [kun] — umumiy reyting, ixtiyoriy 1–120 kun",
  "/ishtirokchi ism|@username — ishtirokchi statistikasi",
  "/savollar [sana] — savollar va javoblar",
  "/tarix — oxirgi 10 test",
  "/mavzu sana | nom | betlar — mavzu qo‘shish",
  "/mavzular — rejalashtirilgan mavzular",
  "/mavzu_ochir ID — mavzuni o‘chirish yoki rejalangan testni bekor qilish",
  "/rejalash YYYY-MM-DD HH:MM | mavzu — guruh testi vaqtini belgilash",
  "Erkin buyruq: “Passiv bo‘yicha 15 ta test, 20 soniyadan”.",
  "/test_hozir — bugungi testga yozilishni boshlash",
  "/sozlamalar, /vaqt HH:MM, /savol_soni 5|10|15|20|30",
  "/minimum 1-50 — guruh qatnashchilari minimumi; shaxsiy test bir kishida darhol boshlanadi",
  "/toxtat, /davom",
  "/kitob, /offset N, /kitob_tozalash — kitob boshqaruvi",
  "Sana: bugun, ertaga, YYYY-MM-DD yoki DD.MM.YYYY.",
].join("\n");

export const QUIZ_FOOTER = [
  "🎉 Ajoyib natija! Muhtaram Ustozimiz va o'quv markazimiz nomidan barcha g'oliblarni chin dildan tabriklaymiz!",
  "───────────────────",
  "🎓 Ustoz Dilshodbek Fayziyev Test Tizimi",
  "💡 Platform Architect: Bilol Muzaffarov",
].join("\n");

const MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🚀 Yangi test sozlash", callback_data: "m:test:setup" },
      { text: "📥 Kelgan takliflar", callback_data: "m:proposals" },
    ],
    [
      { text: "📊 Natijalar va Reyting", callback_data: "m:results" },
      { text: "⚙️ Sozlamalar", callback_data: "m:settings" },
    ],
  ],
};

const STUDENT_MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🧩 Shaxsiy test boshlash", callback_data: "m:student:quiz" }],
    [{ text: "💡 Test taklifi yuborish", callback_data: "m:student:suggest" }],
    [{ text: "📊 Mening natijalarim", callback_data: "m:student:results" }],
    [{ text: "❓ Yordam", callback_data: "m:student:help" }],
  ],
};

const HOME_KEYBOARD = {
  inline_keyboard: [[{ text: "🏠 Menyu", callback_data: "m:home" }]],
};

const RESULTS_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "📊 Oxirgi natija", callback_data: "m:result" },
      { text: "🏆 Reyting", callback_data: "m:leaderboard" },
    ],
    [
      { text: "📝 Savollar", callback_data: "m:questions" },
      { text: "📚 Tarix", callback_data: "m:history" },
    ],
    [{ text: "🏠 Menyu", callback_data: "m:home" }],
  ],
};

const SETTINGS_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "18:00", callback_data: "m:set:time:18:00" },
      { text: "19:00", callback_data: "m:set:time:19:00" },
      { text: "20:00", callback_data: "m:set:time:20:00" },
      { text: "21:00", callback_data: "m:set:time:21:00" },
    ],
    [
      { text: "Minimum 1", callback_data: "m:set:minimum:1" },
      { text: "2", callback_data: "m:set:minimum:2" },
      { text: "3", callback_data: "m:set:minimum:3" },
      { text: "5", callback_data: "m:set:minimum:5" },
    ],
    [
      { text: "Savol 5", callback_data: "m:set:questions:5" },
      { text: "10", callback_data: "m:set:questions:10" },
      { text: "15", callback_data: "m:set:questions:15" },
    ],
    [
      { text: "20", callback_data: "m:set:questions:20" },
      { text: "30", callback_data: "m:set:questions:30" },
    ],
    [
      { text: "15 soniya", callback_data: "m:set:seconds:15" },
      { text: "20 soniya", callback_data: "m:set:seconds:20" },
      { text: "25 soniya", callback_data: "m:set:seconds:25" },
      { text: "30 soniya", callback_data: "m:set:seconds:30" },
    ],
    [{ text: "🏠 Menyu", callback_data: "m:home" }],
  ],
};

type TopicWizard = {
  expiresAt: number;
  step: "date" | "manual-date" | "title" | "pages" | "confirm";
  date?: string;
  title?: string;
  pages?: string;
};

const topicWizards = new Map<number, TopicWizard>();
const WIZARD_TTL_MS = 10 * 60_000;

type TestSetupWizard = {
  expiresAt: number;
  step: "topic" | "questions" | "seconds" | "confirm";
  topicTitle?: string;
  questionCount?: number;
  secondsPerQuestion?: number;
  proposalId?: string;
};

type TestProposal = {
  expiresAt: number;
  topicTitle: string;
  studentId: number;
  studentName: string;
  studentUsername?: string;
};

const testSetupWizards = new Map<number, TestSetupWizard>();
const studentSuggestionWizards = new Map<number, number>();
const studentPrivateQuizWizards = new Map<number, number>();
const pendingTestProposals = new Map<string, TestProposal>();
const adminRequestMemory = new Map<
  number,
  {
    topicTitle: string;
    questionCount: number | null;
    secondsPerQuestion: number | null;
    difficulty: QuizDifficulty | null;
  }
>();
const adminConversationMemory = new Map<number, string[]>();
const adminStartGreetingShown = new Set<number>();
const DEFAULT_ADMIN_TELEGRAM_ID = "1967786876";

export function isConfiguredAdmin(userId: number): boolean {
  return (
    String(userId) === DEFAULT_ADMIN_TELEGRAM_ID ||
    String(userId) === process.env.ADMIN_TELEGRAM_ID?.trim()
  );
}

function activeTestSetupWizard(userId: number): TestSetupWizard | undefined {
  const wizard = testSetupWizards.get(userId);
  if (wizard && wizard.expiresAt <= Date.now()) {
    testSetupWizards.delete(userId);
    return undefined;
  }
  return wizard;
}

export function hasActiveAdminFlow(userId: number): boolean {
  return (
    Boolean(activeTopicWizard(userId)) ||
    Boolean(activeTestSetupWizard(userId)) ||
    studentSuggestionWizards.has(userId)
  );
}

function refreshTestSetupWizard(userId: number, wizard: TestSetupWizard) {
  wizard.expiresAt = Date.now() + WIZARD_TTL_MS;
  testSetupWizards.set(userId, wizard);
}

export async function sendRoleMenu(
  chatId: string,
  userId: number,
): Promise<void> {
  const isAdmin = isConfiguredAdmin(userId);
  await sendTelegramMessage(
    chatId,
    isAdmin ? "Nimani qilamiz?" : "Talaba menyusi:",
    isAdmin ? MENU_KEYBOARD : STUDENT_MENU_KEYBOARD,
  );
}

export async function handleRoleMenuCommand(
  message: PrivateMessage,
): Promise<boolean> {
  const text = message.text?.trim();
  const userId = message.from?.id;
  if (!text || userId === undefined) return false;
  const command = text.split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  if (command !== "/menu" && command !== "/start" && command !== "/yordam") {
    return false;
  }
  if (command === "/yordam" && isConfiguredAdmin(userId)) return false;
  const chatId = String(message.chat.id);
  if (command === "/yordam") {
    await sendLongTelegramMessage(
      chatId,
      "Yordam:\n💡 Test taklifi yuborish — domlaga mavzu taklif qiling.\n📊 Mening natijalarim — yakunlangan testlardagi natijalaringiz.\n/menu — menyuni ochish.",
      HOME_KEYBOARD,
    );
    return true;
  }
  if (
    command === "/start" &&
    isConfiguredAdmin(userId) &&
    !adminStartGreetingShown.has(userId)
  ) {
    adminStartGreetingShown.add(userId);
    await sendTelegramMessage(
      chatId,
      "Assalomu alaykum, muhtaram Ustoz!\nNimani qilamiz?",
      MENU_KEYBOARD,
    );
    return true;
  }
  await sendRoleMenu(chatId, userId);
  return true;
}

function activeTopicWizard(userId: number): TopicWizard | undefined {
  const wizard = topicWizards.get(userId);
  if (wizard && wizard.expiresAt <= Date.now()) {
    topicWizards.delete(userId);
    return undefined;
  }
  return wizard;
}

export function hasActiveTopicWizard(userId: number): boolean {
  return Boolean(activeTopicWizard(userId));
}

function refreshWizard(userId: number, wizard: TopicWizard): void {
  wizard.expiresAt = Date.now() + WIZARD_TTL_MS;
  topicWizards.set(userId, wizard);
}

function wizardCancelKeyboard() {
  return {
    inline_keyboard: [[{ text: "❌ Bekor", callback_data: "m:wiz:cancel" }]],
  };
}

async function showTopicDateStep(chatId: string) {
  await sendTelegramMessage(chatId, "Mavzu qaysi sanaga rejalashtirilsin?", {
    inline_keyboard: [
      [
        { text: "Bugun", callback_data: "m:wiz:date:today" },
        { text: "Ertaga", callback_data: "m:wiz:date:tomorrow" },
        { text: "Boshqa sana", callback_data: "m:wiz:date:other" },
      ],
      [{ text: "❌ Bekor", callback_data: "m:wiz:cancel" }],
    ],
  });
}

async function askTopicTitle(chatId: string) {
  await sendTelegramMessage(chatId, "Mavzu nomi?", wizardCancelKeyboard());
}

async function askTopicPages(chatId: string) {
  await sendTelegramMessage(
    chatId,
    "Kitob betlari? Masalan: 45-52 yoki 45. Bet bo‘lmasa «Betsiz» tugmasini bosing.",
    {
      inline_keyboard: [
        [{ text: "Betsiz", callback_data: "m:wiz:pages:none" }],
        [{ text: "❌ Bekor", callback_data: "m:wiz:cancel" }],
      ],
    },
  );
}

async function showTopicSummary(chatId: string, wizard: TopicWizard) {
  await sendTelegramMessage(
    chatId,
    [
      "Mavzuni saqlaymizmi?",
      `Sana: ${wizard.date}`,
      `Mavzu: ${wizard.title}`,
      `Kitob betlari: ${wizard.pages === "-" ? "yo‘q" : wizard.pages}`,
    ].join("\n"),
    {
      inline_keyboard: [
        [
          { text: "✅ Saqlash", callback_data: "m:wiz:save" },
          { text: "❌ Bekor", callback_data: "m:wiz:cancel" },
        ],
      ],
    },
  );
}

export async function sendAdminMenu(chatId: string): Promise<void> {
  await sendTelegramMessage(chatId, "Nimani qilamiz?", MENU_KEYBOARD);
}

async function sendHomeButton(chatId: string): Promise<void> {
  await sendTelegramMessage(chatId, "🏠 Menyu", HOME_KEYBOARD);
}

function testSetupKeyboard(
  step: "questions" | "seconds" | "confirm",
  wizard: TestSetupWizard,
) {
  if (step === "questions") {
    return {
      inline_keyboard: [
        [5, 10, 15].map((count) => ({
          text: String(count),
          callback_data: `m:testwiz:count:${count}`,
        })),
        [20, 30].map((count) => ({
          text: String(count),
          callback_data: `m:testwiz:count:${count}`,
        })),
        [{ text: "❌ Bekor qilish", callback_data: "m:testwiz:cancel" }],
      ],
    };
  }
  if (step === "seconds") {
    return {
      inline_keyboard: [
        [15, 20, 25, 30].map((seconds) => ({
          text: `${seconds}s`,
          callback_data: `m:testwiz:seconds:${seconds}`,
        })),
        [{ text: "❌ Bekor qilish", callback_data: "m:testwiz:cancel" }],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        {
          text: "✅ Test tayyorlash (preview)",
          callback_data: "m:testwiz:confirm",
        },
      ],
      [
        { text: "✏️ Qayta kiritish", callback_data: "m:testwiz:edit" },
        { text: "❌ Bekor qilish", callback_data: "m:testwiz:cancel" },
      ],
    ],
  };
}

async function beginTestSetup(
  chatId: string,
  userId: number,
  topicTitle?: string,
  proposalId?: string,
): Promise<void> {
  const wizard: TestSetupWizard = {
    expiresAt: Date.now() + WIZARD_TTL_MS,
    step: topicTitle ? "questions" : "topic",
    topicTitle,
    proposalId,
  };
  refreshTestSetupWizard(userId, wizard);
  if (topicTitle) {
    await sendTelegramMessage(
      chatId,
      `Mavzu: ${topicTitle}\nSavollar sonini tanlang:`,
      testSetupKeyboard("questions", wizard),
    );
  } else {
    await sendTelegramMessage(
      chatId,
      "Mavzu nomini yozing (masalan: Perfekt).",
      {
        inline_keyboard: [
          [{ text: "❌ Bekor qilish", callback_data: "m:testwiz:cancel" }],
        ],
      },
    );
  }
}

async function showTestSetupSummary(chatId: string, wizard: TestSetupWizard) {
  wizard.step = "confirm";
  await sendTelegramMessage(
    chatId,
    [
      "Test sozlamalari:",
      `Mavzu: ${wizard.topicTitle}`,
      `Savollar: ${wizard.questionCount}`,
      `Har savol uchun vaqt: ${wizard.secondsPerQuestion} soniya`,
      "Tasdiqlasangiz, test avval faqat sizga preview sifatida yuboriladi. Guruhga alohida tugma bilan chiqarasiz.",
    ].join("\n"),
    testSetupKeyboard("confirm", wizard),
  );
}

async function sendQuizPreview(
  chatId: string,
  preview: AdminQuizPreview,
  messageId?: number,
  pageIndex = 0,
): Promise<void> {
  const pageCount = preview.questions.length;
  if (pageCount === 0) throw new Error("Quiz preview has no questions.");
  const currentPage = Math.max(0, Math.min(pageIndex, pageCount - 1));
  const sample = preview.questions[currentPage];
  if (!sample) throw new Error("Quiz preview has no sample question.");
  const options = sample.options.map(
    (option, index) => `${String.fromCharCode(65 + index)}) ${option}`,
  );
  const text = [
    `✅ Test tayyor: ${preview.topicTitle}`,
    `Savollar: ${preview.questionCount} · Har biriga: ${preview.secondsPerQuestion} soniya`,
    `Manba: ${preview.source === "ai" ? "Darslik va Grammatik aktiv (Nemotron AI)" : "Darslik va Grammatik aktiv (tayyor savollar bazasi)"}`,
    `🔎 Savol ${currentPage + 1}/${pageCount}`,
    "",
    sample.prompt,
    ...options,
    "",
    `✅ To‘g‘ri javob: ${String.fromCharCode(65 + sample.correctOptionIndex)}. ${sample.options[sample.correctOptionIndex]}`,
    `📘 Izoh: ${Array.from(sample.explanation).slice(0, 300).join("")}`,
    "",
    "Guruhga faqat quyidagi tugmani bossangiz yuboriladi.",
  ].join("\n");
  const navigation = [
    ...(currentPage > 0
      ? [
          {
            text: "⬅️ Oldingi",
            callback_data: `m:preview:page:${preview.id}:${currentPage - 1}`,
          },
        ]
      : []),
    ...(currentPage < pageCount - 1
      ? [
          {
            text: "➡️ Keyingi",
            callback_data: `m:preview:page:${preview.id}:${currentPage + 1}`,
          },
        ]
      : []),
  ];
  const replyMarkup = {
    inline_keyboard: [
      ...(navigation.length > 0 ? [navigation] : []),
      [
        {
          text: "✅ Guruhga yuborish",
          callback_data: `m:preview:publish:${preview.id}`,
        },
      ],
      [
        {
          text: "🔄 Qayta yaratish",
          callback_data: `m:preview:regenerate:${preview.id}`,
        },
        {
          text: "❌ Bekor qilish",
          callback_data: `m:preview:cancel:${preview.id}`,
        },
      ],
    ],
  };
  if (messageId !== undefined) {
    await editTelegramMessage(chatId, messageId, text, replyMarkup);
  } else {
    await sendTelegramMessage(chatId, text, replyMarkup);
  }
}

export async function handleTestSetupMessage(
  message: PrivateMessage,
): Promise<boolean> {
  const userId = message.from?.id;
  const text = message.text?.trim();
  if (userId === undefined || !text) return false;
  const wizard = activeTestSetupWizard(userId);
  if (!wizard) return false;
  const chatId = String(message.chat.id);
  if (text.startsWith("/")) {
    if (!/^\/bekor(?:@\w+)?$/i.test(text)) return false;
    testSetupWizards.delete(userId);
    await sendTelegramMessage(
      chatId,
      "Test sozlash bekor qilindi.",
      HOME_KEYBOARD,
    );
    return true;
  }
  if (wizard.step !== "topic") {
    await sendTelegramMessage(
      chatId,
      "Davom etish uchun quyidagi tugmalardan birini bosing.",
      testSetupKeyboard(wizard.step, wizard),
    );
    return true;
  }
  if (text.length < 2 || text.length > 120) {
    await sendTelegramMessage(chatId, "Mavzu nomi 2–120 belgi bo‘lishi kerak.");
    return true;
  }
  wizard.topicTitle = text;
  wizard.step = "questions";
  refreshTestSetupWizard(userId, wizard);
  await sendTelegramMessage(
    chatId,
    "Savollar sonini tanlang:",
    testSetupKeyboard("questions", wizard),
  );
  return true;
}

export async function handleAdminNaturalQuizRequest(
  message: PrivateMessage,
  context: AdminCommandContext,
): Promise<boolean> {
  const userId = message.from?.id;
  const text = message.text?.trim();
  if (userId === undefined || !text || text.startsWith("/")) {
    return false;
  }

  const chatId = String(message.chat.id);
  const progress = await sendTelegramMessage(
    chatId,
    "Xabaringizni tahlil qilyapman…",
  );
  const previous = adminRequestMemory.get(userId);
  const recentMessages = adminConversationMemory.get(userId) ?? [];
  let request: Awaited<ReturnType<AdminCommandContext["parseQuizRequest"]>>;
  try {
    request = await context.parseQuizRequest(text, {
      previousTopicTitle: previous?.topicTitle ?? null,
      previousQuestionCount: previous?.questionCount ?? null,
      previousSecondsPerQuestion: previous?.secondsPerQuestion ?? null,
      previousDifficulty: previous?.difficulty ?? null,
      recentMessages,
    });
  } catch (error) {
    logger.error({ err: error, adminUserId: userId }, "Could not parse admin quiz request");
    await editTelegramMessage(
      chatId,
      progress.message_id,
      "Xabaringizni hozir tushuna olmadim. Test tayyorlash uchun mavzu va savollar sonini, rejalash uchun esa mavzu, sana va vaqtni aniqroq yozing.",
    );
    return true;
  }

  if (request.intent === "other") {
    const reply =
      request.reply ||
      "Xabaringizni oldim. Test tayyorlash yoki rejalash uchun mavzu va kerakli ma’lumotlarni yozing.";
    await editTelegramMessage(
      chatId,
      progress.message_id,
      reply,
    );
    rememberAdminExchange(userId, text, reply);
    return true;
  }

  if (request.intent === "schedule_quiz") {
    if (!request.topicTitle || !request.scheduledDate || !request.scheduledTime) {
      await editTelegramMessage(
        chatId,
        progress.message_id,
        "Rejalash uchun mavzu va kelajakdagi sana-vaqtni yozing. Oldingi test mavzusiga ishora qilsangiz, “shu mavzuni ertaga 15:00 ga rejalashtir” deb yuboring.",
      );
      return true;
    }
    try {
      const confirmation = await context.scheduleQuiz(
        request.scheduledDate,
        request.scheduledTime,
        request.topicTitle,
        request.difficulty,
      );
      adminRequestMemory.set(userId, {
        topicTitle: request.topicTitle,
        questionCount: request.questionCount ?? previous?.questionCount ?? null,
        secondsPerQuestion:
          request.secondsPerQuestion ?? previous?.secondsPerQuestion ?? null,
        difficulty: request.difficulty ?? previous?.difficulty ?? null,
      });
      await editTelegramMessage(chatId, progress.message_id, confirmation);
      rememberAdminExchange(userId, text, confirmation);
    } catch (error) {
      logger.error(
        { err: error, adminUserId: userId },
        "Could not schedule natural-language admin quiz",
      );
      await editTelegramMessage(
        chatId,
        progress.message_id,
        `Testni rejalashtirib bo‘lmadi: ${error instanceof Error ? error.message : "Noma'lum xatolik."}`,
      );
    }
    return true;
  }

  if (!request.topicTitle || request.questionCount === null) {
    await editTelegramMessage(
      chatId,
      progress.message_id,
      "Test tayyorlash uchun grammatik mavzu va savollar sonini yozing. Masalan: “Modalverben bo‘yicha 5 ta test tuz”.",
    );
    return true;
  }
  if (![5, 10, 15, 20, 30].includes(request.questionCount)) {
    await editTelegramMessage(
      chatId,
      progress.message_id,
      "Savollar sonidan 5, 10, 15, 20 yoki 30 tasini tanlang.",
    );
    return true;
  }
  if (
    request.secondsPerQuestion !== null &&
    ![15, 20, 25, 30].includes(request.secondsPerQuestion)
  ) {
    await editTelegramMessage(
      chatId,
      progress.message_id,
      "Har savol uchun 15, 20, 25 yoki 30 soniyadan birini tanlang.",
    );
    return true;
  }

  try {
    const settings = await context.getSettings();
    const preview = await context.startConfiguredQuiz(
      userId,
      request.topicTitle,
      request.questionCount,
      request.secondsPerQuestion ?? settings.secondsPerQuestion,
      request.difficulty,
    );
    adminRequestMemory.set(userId, {
      topicTitle: request.topicTitle,
      questionCount: request.questionCount,
      secondsPerQuestion:
        request.secondsPerQuestion ?? settings.secondsPerQuestion,
      difficulty: request.difficulty,
    });
    await sendQuizPreview(chatId, preview, progress.message_id);
    rememberAdminExchange(
      userId,
      text,
      `Preview tayyor: ${preview.topicTitle}, ${preview.questionCount} ta savol.`,
    );
  } catch (error) {
    logger.error({ err: error, adminUserId: userId }, "Could not prepare admin quiz preview");
    const detail =
      error instanceof Error ? error.message : "Testni tayyorlashda xatolik yuz berdi.";
    await editTelegramMessage(
      chatId,
      progress.message_id,
      `Testni tayyorlay olmadim: ${detail}`,
    );
  }

  function rememberAdminExchange(
    userId: number,
    request: string,
    response: string,
  ): void {
    const history = adminConversationMemory.get(userId) ?? [];
    history.push(`Ustoz: ${request}\nYordamchi: ${response}`);
    adminConversationMemory.set(userId, history.slice(-5));
  }
  return true;
}

export async function handleStudentPrivateMessage(
  message: PrivateMessage,
  startPrivateQuiz: (
    chatId: string,
    user: TelegramUser,
    topicTitle: string,
  ) => Promise<string>,
): Promise<boolean> {
  const userId = message.from?.id;
  const text = message.text?.trim();
  if (userId === undefined || !text) return false;

  const privateQuizExpiresAt = studentPrivateQuizWizards.get(userId);
  if (
    privateQuizExpiresAt !== undefined &&
    privateQuizExpiresAt <= Date.now()
  ) {
    studentPrivateQuizWizards.delete(userId);
  }
  if (studentPrivateQuizWizards.has(userId)) {
    const chatId = String(message.chat.id);
    if (text.startsWith("/")) {
      if (!/^\/bekor(?:@\w+)?$/i.test(text)) return false;
      studentPrivateQuizWizards.delete(userId);
      await sendTelegramMessage(
        chatId,
        "Shaxsiy test bekor qilindi.",
        HOME_KEYBOARD,
      );
      return true;
    }
    if (text.length < 2 || text.length > 120) {
      await sendTelegramMessage(
        chatId,
        "Mavzu nomi 2–120 belgi bo‘lishi kerak.",
      );
      return true;
    }
    const user = message.from;
    if (!user) return false;
    studentPrivateQuizWizards.delete(userId);
    const result = await startPrivateQuiz(chatId, user, text);
    await sendLongTelegramMessage(chatId, result, HOME_KEYBOARD);
    return true;
  }

  const expiresAt = studentSuggestionWizards.get(userId);
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    studentSuggestionWizards.delete(userId);
  }
  if (!studentSuggestionWizards.has(userId)) return false;
  const chatId = String(message.chat.id);
  if (text.startsWith("/")) {
    if (!/^\/bekor(?:@\w+)?$/i.test(text)) return false;
    studentSuggestionWizards.delete(userId);
    await sendTelegramMessage(
      chatId,
      "Taklif yuborish bekor qilindi.",
      HOME_KEYBOARD,
    );
    return true;
  }
  if (text.length < 2 || text.length > 120) {
    await sendTelegramMessage(chatId, "Mavzu nomi 2–120 belgi bo‘lishi kerak.");
    return true;
  }
  const adminId =
    process.env.ADMIN_TELEGRAM_ID?.trim() || DEFAULT_ADMIN_TELEGRAM_ID;
  if (!adminId || !/^\d+$/.test(adminId)) {
    studentSuggestionWizards.delete(userId);
    await sendTelegramMessage(
      chatId,
      "Hozircha domla bilan bog‘lanib bo‘lmadi.",
    );
    return true;
  }
  const proposalId = randomUUID();
  const studentName = [message.from?.first_name, message.from?.last_name]
    .filter(Boolean)
    .join(" ");
  const proposal: TestProposal = {
    expiresAt: Date.now() + WIZARD_TTL_MS,
    topicTitle: text,
    studentId: userId,
    studentName: studentName || `Foydalanuvchi ${userId}`,
    studentUsername: message.from?.username,
  };
  pendingTestProposals.set(proposalId, proposal);
  studentSuggestionWizards.delete(userId);
  await sendTelegramMessage(
    adminId,
    [
      "Yangi test taklifi:",
      `Mavzu: ${text}`,
      `Taklif qiluvchi: ${proposal.studentName}${proposal.studentUsername ? ` (@${proposal.studentUsername})` : ""}`,
    ].join("\n"),
    {
      inline_keyboard: [
        [
          {
            text: "🚀 Testni sozlash",
            callback_data: `m:proposal:setup:${proposalId}`,
          },
          {
            text: "❌ Rad etish",
            callback_data: `m:proposal:reject:${proposalId}`,
          },
        ],
      ],
    },
  );
  await sendTelegramMessage(
    chatId,
    "Taklif domlaga yuborildi. Rahmat!",
    HOME_KEYBOARD,
  );
  return true;
}

async function showPendingProposals(chatId: string): Promise<void> {
  const now = Date.now();
  const proposals = [...pendingTestProposals.entries()].filter(
    ([, proposal]) => {
      if (proposal.expiresAt <= now) return false;
      return true;
    },
  );
  for (const [id, proposal] of pendingTestProposals) {
    if (proposal.expiresAt <= now) pendingTestProposals.delete(id);
  }
  if (proposals.length === 0) {
    await sendTelegramMessage(chatId, "Yangi takliflar yo‘q.", HOME_KEYBOARD);
    return;
  }
  for (const [id, proposal] of proposals) {
    await sendTelegramMessage(
      chatId,
      `Mavzu: ${proposal.topicTitle}\nTaklif qiluvchi: ${proposal.studentName}${proposal.studentUsername ? ` (@${proposal.studentUsername})` : ""}`,
      {
        inline_keyboard: [
          [
            {
              text: "🚀 Testni sozlash",
              callback_data: `m:proposal:setup:${id}`,
            },
            { text: "❌ Rad etish", callback_data: `m:proposal:reject:${id}` },
          ],
        ],
      },
    );
  }
  await sendHomeButton(chatId);
}

export async function handleStudentMenuCallback(
  userId: number,
  chatId: string,
  data: string,
): Promise<boolean> {
  if (data === "m:student:quiz") {
    studentPrivateQuizWizards.set(userId, Date.now() + WIZARD_TTL_MS);
    await sendTelegramMessage(
      chatId,
      "Qaysi mavzu bo‘yicha shaxsiy test ishlaysiz? Mavzu nomini yozing.",
      {
        inline_keyboard: [
          [{ text: "❌ Bekor", callback_data: "m:student:quiz:cancel" }],
        ],
      },
    );
    return true;
  }
  if (data === "m:student:quiz:cancel") {
    studentPrivateQuizWizards.delete(userId);
    await sendTelegramMessage(
      chatId,
      "Shaxsiy test bekor qilindi.",
      HOME_KEYBOARD,
    );
    return true;
  }
  if (data === "m:student:suggest") {
    studentSuggestionWizards.set(userId, Date.now() + WIZARD_TTL_MS);
    await sendTelegramMessage(
      chatId,
      "Qaysi mavzu bo‘yicha test taklif qilasiz? Mavzu nomini yozing.",
      {
        inline_keyboard: [
          [{ text: "❌ Bekor", callback_data: "m:student:cancel" }],
        ],
      },
    );
    return true;
  }
  if (data === "m:student:cancel") {
    studentSuggestionWizards.delete(userId);
    await sendTelegramMessage(
      chatId,
      "Taklif yuborish bekor qilindi.",
      HOME_KEYBOARD,
    );
    return true;
  }
  if (data === "m:student:results") {
    await showMyResults(chatId, userId);
    await sendHomeButton(chatId);
    return true;
  }
  if (data === "m:student:help") {
    await sendLongTelegramMessage(
      chatId,
      "Yordam:\n🧩 Shaxsiy test boshlash — mavzu yozing, test darhol boshlanadi.\n💬 Istalgan nemis tili grammatikasi savolingizni yozing — AI yordam beradi (kuniga 5 ta savol).\n💡 Test taklifi yuborish — mavzuni domlaga yuboring.\n📊 Mening natijalarim — yakunlangan testlardagi natijalaringiz.",
      HOME_KEYBOARD,
    );
    return true;
  }
  return false;
}

export async function handleTopicWizardMessage(
  message: PrivateMessage,
): Promise<boolean> {
  const userId = message.from?.id;
  const text = message.text?.trim();
  if (userId === undefined || !text) return false;
  const wizard = activeTopicWizard(userId);
  if (!wizard) return false;

  if (text.startsWith("/")) {
    if (!/^\/bekor(?:@\w+)?$/i.test(text)) return false;
    topicWizards.delete(userId);
    await sendTelegramMessage(
      String(message.chat.id),
      "Mavzu qo‘shish bekor qilindi.",
      HOME_KEYBOARD,
    );
    return true;
  }

  const chatId = String(message.chat.id);
  if (wizard.step === "manual-date") {
    const date = parseDateInput(text);
    if (!date) {
      await sendTelegramMessage(
        chatId,
        "Sanani YYYY-MM-DD yoki DD.MM.YYYY ko‘rinishida kiriting.",
        wizardCancelKeyboard(),
      );
      return true;
    }
    wizard.date = date;
    wizard.step = "title";
    refreshWizard(userId, wizard);
    await askTopicTitle(chatId);
    return true;
  }
  if (wizard.step === "title") {
    if (!text) {
      await askTopicTitle(chatId);
      return true;
    }
    wizard.title = text;
    wizard.step = "pages";
    refreshWizard(userId, wizard);
    await askTopicPages(chatId);
    return true;
  }
  if (wizard.step === "pages") {
    if (!parsePageRanges(text)) {
      await sendTelegramMessage(
        chatId,
        "Betlarni 45-52 yoki 45 ko‘rinishida kiriting.",
        {
          inline_keyboard: [
            [{ text: "Betsiz", callback_data: "m:wiz:pages:none" }],
            [{ text: "❌ Bekor", callback_data: "m:wiz:cancel" }],
          ],
        },
      );
      return true;
    }
    wizard.pages = text;
    wizard.step = "confirm";
    refreshWizard(userId, wizard);
    await showTopicSummary(chatId, wizard);
    return true;
  }
  return true;
}

async function runAdminAction(
  command: string,
  argument: string,
  chatId: string,
  context: AdminCommandContext,
): Promise<boolean> {
  switch (command) {
    case "/menu":
    case "/start":
      await sendAdminMenu(chatId);
      return true;
    case "/yordam":
      await sendLongTelegramMessage(chatId, HELP);
      return true;
    case "/natija":
      await showSessionResults(chatId, argument || undefined);
      return true;
    case "/reyting": {
      const days = argument ? Number(argument) : undefined;
      if (
        days !== undefined &&
        (!Number.isInteger(days) || days < 1 || days > 120)
      ) {
        await sendLongTelegramMessage(
          chatId,
          "Kunlar soni 1–120 oralig‘idagi butun son bo‘lsin.",
        );
      } else {
        await sendLongTelegramMessage(
          chatId,
          await getOverallLeaderboardText(days),
          undefined,
          "HTML",
        );
      }
      return true;
    }
    case "/ishtirokchi":
      await showParticipant(chatId, argument);
      return true;
    case "/savollar":
      await showQuestions(chatId, argument || undefined);
      return true;
    case "/tarix":
      await showHistory(chatId);
      return true;
    case "/mavzu":
      await addTopic(chatId, argument, context);
      return true;
    case "/mavzular":
      await listTopics(chatId);
      return true;
    case "/mavzu_ochir":
      await deleteTopic(chatId, argument);
      return true;
    case "/rejalash": {
      const match =
        /^(\d{4}-\d{2}-\d{2})\s+((?:[01]\d|2[0-3]):[0-5]\d)\s*\|\s*(.{2,120})$/s.exec(
          argument,
        );
      const scheduledDate = match ? parseQuizDate(match[1]!) : null;
      const topicTitle = match?.[3]?.trim();
      if (!match || !scheduledDate || !topicTitle || topicTitle.length < 2) {
        await sendLongTelegramMessage(
          chatId,
          "Foydalanish: /rejalash YYYY-MM-DD HH:MM | mavzu nomi",
        );
        return true;
      }
      try {
        await sendLongTelegramMessage(
          chatId,
          await context.scheduleQuiz(
            scheduledDate,
            match[2]!,
            topicTitle,
          ),
        );
      } catch (error) {
        logger.error({ err: error }, "Could not schedule admin quiz");
        const reason =
          error instanceof Error ? error.message : "Testni rejalab bo‘lmadi.";
        await sendLongTelegramMessage(
          chatId,
          `Testni rejalashda xatolik yuz berdi: ${reason}`,
        );
      }
      return true;
    }
    case "/test_hozir":
      await sendLongTelegramMessage(chatId, await context.startQuizNow());
      return true;
    case "/sozlamalar":
      await showSettings(chatId, context);
      return true;
    case "/kitob":
      await sendLongTelegramMessage(chatId, await context.getBookStatus());
      return true;
    case "/vaqt":
      await updateTimeSetting(chatId, argument);
      return true;
    case "/savol_soni":
      await updateNumberSetting(
        chatId,
        argument,
        "questionCount",
        "Savollar soni",
        5,
        30,
        [5, 10, 15, 20, 30],
      );
      return true;
    case "/minimum":
      await updateNumberSetting(
        chatId,
        argument,
        "minimumParticipants",
        "Minimal qatnashchilar",
        1,
        50,
      );
      return true;
    case "/soniya":
      await updateNumberSetting(
        chatId,
        argument,
        "secondsPerQuestion",
        "Har savolga soniya",
        15,
        30,
        [15, 20, 25, 30],
      );
      return true;
    case "/royxat":
      await updateNumberSetting(
        chatId,
        argument,
        "signupWindowMinutes",
        "Ro‘yxatdan o‘tish daqiqasi",
        1,
        120,
      );
      return true;
    case "/toxtat":
      await db
        .update(quizBotSettingsTable)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(quizBotSettingsTable.id, 1));
      await sendLongTelegramMessage(
        chatId,
        "Kunlik avtomatik testlar to‘xtatildi.",
      );
      return true;
    case "/davom":
      await db
        .update(quizBotSettingsTable)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(quizBotSettingsTable.id, 1));
      await sendLongTelegramMessage(
        chatId,
        "Kunlik avtomatik testlar davom ettirildi.",
      );
      return true;
    default:
      return false;
  }
}

export async function handleAdminMenuCallback(
  userId: number,
  chatId: string,
  data: string,
  context: AdminCommandContext,
  callback: {
    messageId?: number;
    answer: (text: string, showAlert?: boolean) => Promise<void>;
  },
): Promise<boolean> {
  if (data === "m:home") {
    await sendRoleMenu(chatId, userId);
    return true;
  }

  if (data === "m:test:setup") {
    await beginTestSetup(chatId, userId);
    return true;
  }
  if (data === "m:proposals") {
    await showPendingProposals(chatId);
    return true;
  }
  if (data === "m:results") {
    await sendTelegramMessage(
      chatId,
      "Natijalar va reyting:",
      RESULTS_KEYBOARD,
    );
    return true;
  }
  const previewPage = /^m:preview:page:([0-9a-f-]{36}):(\d+)$/i.exec(data);
  if (previewPage) {
    await callback.answer("");
    const preview = await context.getQuizPreview(userId, previewPage[1]!);
    if (!preview) {
      if (callback.messageId !== undefined) {
        await editTelegramMessage(
          chatId,
          callback.messageId,
          "⌛ Bu test preview’i topilmadi yoki muddati tugagan.",
          HOME_KEYBOARD,
        );
      }
      return true;
    }
    await sendQuizPreview(
      chatId,
      preview,
      callback.messageId,
      Number(previewPage[2]),
    );
    return true;
  }

  const previewAction =
    /^m:preview:(publish|regenerate|cancel):([0-9a-f-]{36})$/i.exec(data);
  if (previewAction) {
    const previewId = previewAction[2]!;
    if (previewAction[1] === "cancel") {
      await callback.answer("");
      await context.cancelQuizPreview(userId, previewId);
      if (callback.messageId !== undefined) {
        await editTelegramMessage(
          chatId,
          callback.messageId,
          "❌ Test preview bekor qilindi.",
          HOME_KEYBOARD,
        );
      }
      return true;
    }
    if (previewAction[1] === "regenerate") {
      await callback.answer("");
      const preview = await context.regenerateQuizPreview(userId, previewId);
      await sendQuizPreview(chatId, preview, callback.messageId);
      return true;
    }
    const result = await context.publishQuizPreview(userId, previewId);
    if (result.published) {
      await callback.answer("🚀 Test guruhga muvaffaqiyatli yuborildi!", true);
      if (callback.messageId !== undefined) {
        await editTelegramMessage(
          chatId,
          callback.messageId,
          "✅ Ushbu test guruhga joylandi",
          HOME_KEYBOARD,
        );
      }
    } else {
      await callback.answer(result.message, true);
    }
    return true;
  }
  const proposalAction = /^m:proposal:(setup|reject):([0-9a-f-]{36})$/i.exec(
    data,
  );
  if (proposalAction) {
    const proposalId = proposalAction[2]!;
    const proposal = pendingTestProposals.get(proposalId);
    if (!proposal || proposal.expiresAt <= Date.now()) {
      pendingTestProposals.delete(proposalId);
      await sendTelegramMessage(
        chatId,
        "Taklif topilmadi yoki muddati tugagan.",
        HOME_KEYBOARD,
      );
      return true;
    }
    if (proposalAction[1] === "reject") {
      pendingTestProposals.delete(proposalId);
      await sendTelegramMessage(
        String(proposal.studentId),
        `“${proposal.topicTitle}” mavzusidagi taklifingiz rad etildi.`,
      );
      await sendTelegramMessage(chatId, "Taklif rad etildi.", HOME_KEYBOARD);
      return true;
    }
    await beginTestSetup(chatId, userId, proposal.topicTitle, proposalId);
    return true;
  }

  const wizard = activeTestSetupWizard(userId);
  if (data === "m:testwiz:cancel") {
    const proposalId = wizard?.proposalId;
    testSetupWizards.delete(userId);
    if (proposalId) pendingTestProposals.delete(proposalId);
    await sendTelegramMessage(
      chatId,
      "Test sozlash bekor qilindi.",
      HOME_KEYBOARD,
    );
    return true;
  }
  if (data === "m:testwiz:edit") {
    if (!wizard || wizard.step !== "confirm") {
      await sendTelegramMessage(
        chatId,
        "Test sozlash jarayoni tugagan yoki eskirgan.",
        HOME_KEYBOARD,
      );
      return true;
    }
    wizard.step = "topic";
    wizard.topicTitle = undefined;
    wizard.questionCount = undefined;
    wizard.secondsPerQuestion = undefined;
    refreshTestSetupWizard(userId, wizard);
    await sendTelegramMessage(chatId, "Mavzu nomini qayta kiriting:", {
      inline_keyboard: [
        [{ text: "❌ Bekor qilish", callback_data: "m:testwiz:cancel" }],
      ],
    });
    return true;
  }
  const questionCount = /^m:testwiz:count:(5|10|15|20|30)$/.exec(data);
  if (questionCount) {
    if (!wizard || wizard.step !== "questions" || !wizard.topicTitle) {
      await sendTelegramMessage(
        chatId,
        "Test sozlash jarayoni tugagan yoki eskirgan.",
        HOME_KEYBOARD,
      );
      return true;
    }
    wizard.questionCount = Number(questionCount[1]);
    wizard.step = "seconds";
    refreshTestSetupWizard(userId, wizard);
    await sendTelegramMessage(
      chatId,
      "Har bir savol uchun vaqtni tanlang:",
      testSetupKeyboard("seconds", wizard),
    );
    return true;
  }
  const seconds = /^m:testwiz:seconds:(15|20|25|30)$/.exec(data);
  if (seconds) {
    if (
      !wizard ||
      wizard.step !== "seconds" ||
      !wizard.questionCount ||
      !wizard.topicTitle
    ) {
      await sendTelegramMessage(
        chatId,
        "Test sozlash jarayoni tugagan yoki eskirgan.",
        HOME_KEYBOARD,
      );
      return true;
    }
    wizard.secondsPerQuestion = Number(seconds[1]);
    refreshTestSetupWizard(userId, wizard);
    await showTestSetupSummary(chatId, wizard);
    return true;
  }
  if (data === "m:testwiz:confirm") {
    if (
      !wizard ||
      wizard.step !== "confirm" ||
      !wizard.topicTitle ||
      !wizard.questionCount ||
      !wizard.secondsPerQuestion
    ) {
      await sendTelegramMessage(
        chatId,
        "Test sozlash jarayoni tugagan yoki eskirgan.",
        HOME_KEYBOARD,
      );
      return true;
    }
    const preview = await context.startConfiguredQuiz(
      userId,
      wizard.topicTitle,
      wizard.questionCount,
      wizard.secondsPerQuestion,
    );
    testSetupWizards.delete(userId);
    if (wizard.proposalId) pendingTestProposals.delete(wizard.proposalId);
    await sendQuizPreview(chatId, preview, callback.messageId);
    return true;
  }

  if (data === "m:topic:add") {
    topicWizards.set(userId, {
      step: "date",
      expiresAt: Date.now() + WIZARD_TTL_MS,
    });
    await showTopicDateStep(chatId);
    return true;
  }
  if (data === "m:wiz:cancel") {
    topicWizards.delete(userId);
    await sendTelegramMessage(
      chatId,
      "Mavzu qo‘shish bekor qilindi.",
      HOME_KEYBOARD,
    );
    return true;
  }

  const topicWizard = activeTopicWizard(userId);
  if (data === "m:wiz:date:other") {
    if (!topicWizard || topicWizard.step !== "date") return true;
    topicWizard.step = "manual-date";
    refreshWizard(userId, topicWizard);
    await sendTelegramMessage(
      chatId,
      "Sanani YYYY-MM-DD yoki DD.MM.YYYY ko‘rinishida yuboring.",
      wizardCancelKeyboard(),
    );
    return true;
  }
  if (data === "m:wiz:date:today" || data === "m:wiz:date:tomorrow") {
    if (!topicWizard || topicWizard.step !== "date") return true;
    topicWizard.date = parseDateInput(
      data.endsWith("today") ? "bugun" : "ertaga",
    )!;
    topicWizard.step = "title";
    refreshWizard(userId, topicWizard);
    await askTopicTitle(chatId);
    return true;
  }
  if (data === "m:wiz:pages:none") {
    if (!topicWizard || topicWizard.step !== "pages") return true;
    topicWizard.pages = "-";
    topicWizard.step = "confirm";
    refreshWizard(userId, topicWizard);
    await showTopicSummary(chatId, topicWizard);
    return true;
  }
  if (data === "m:wiz:save") {
    if (
      !topicWizard ||
      topicWizard.step !== "confirm" ||
      !topicWizard.date ||
      !topicWizard.title ||
      topicWizard.pages === undefined
    ) {
      await sendTelegramMessage(
        chatId,
        "Mavzu qo‘shish jarayoni tugagan yoki eskirgan.",
      );
      await sendAdminMenu(chatId);
      return true;
    }
    await addTopic(
      chatId,
      `${topicWizard.date} | ${topicWizard.title} | ${topicWizard.pages}`,
      context,
    );
    topicWizards.delete(userId);
    await sendHomeButton(chatId);
    return true;
  }
  if (data === "m:start:ask") {
    await sendTelegramMessage(
      chatId,
      "Bugungi testga yozilishni hozir boshlaymizmi?",
      {
        inline_keyboard: [
          [
            { text: "✅ Ha", callback_data: "m:start:yes" },
            { text: "❌ Yo‘q", callback_data: "m:start:no" },
          ],
          [{ text: "🏠 Menyu", callback_data: "m:home" }],
        ],
      },
    );
    return true;
  }
  if (data === "m:start:yes" || data === "m:start:no") {
    await sendLongTelegramMessage(
      chatId,
      data.endsWith(":yes")
        ? await context.startQuizNow()
        : "Test boshlash bekor qilindi.",
    );
    await sendHomeButton(chatId);
    return true;
  }
  if (data === "m:settings") {
    await showSettings(chatId, context, SETTINGS_KEYBOARD);
    return true;
  }
  if (data.startsWith("m:set:")) {
    const [, , field, ...valueParts] = data.split(":");
    const value = valueParts.join(":");
    if (field === "time") {
      await runAdminAction("/vaqt", value, chatId, context);
    } else if (field === "minimum") {
      await runAdminAction("/minimum", value, chatId, context);
    } else if (field === "questions") {
      await runAdminAction("/savol_soni", value, chatId, context);
    } else if (field === "seconds") {
      await runAdminAction("/soniya", value, chatId, context);
    } else {
      return false;
    }
    await sendHomeButton(chatId);
    return true;
  }

  const commandByAction: Record<string, string> = {
    "m:result": "/natija",
    "m:leaderboard": "/reyting",
    "m:questions": "/savollar",
    "m:history": "/tarix",
    "m:topics": "/mavzular",
    "m:book": "/kitob",
  };
  const command = commandByAction[data];
  if (!command) return false;
  await runAdminAction(command, "", chatId, context);
  if (data === "m:settings") {
    return true;
  }
  await sendHomeButton(chatId);
  return true;
}

export async function handleAdminCommand(
  message: PrivateMessage,
  context: AdminCommandContext,
): Promise<boolean> {
  const text = message.text?.trim();
  if (!text?.startsWith("/")) return false;
  const [rawCommand = "", ...parts] = text.split(/\s+/);
  const command = rawCommand.split("@")[0]?.toLowerCase() ?? "";
  const argument = parts.join(" ").trim();
  const chatId = String(message.chat.id);
  return runAdminAction(command, argument, chatId, context);
}
