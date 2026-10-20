import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { randomInt, randomUUID } from "node:crypto";
import {
  db,
  quizAnswersTable,
  quizBotAdminsTable,
  quizBotSettingsTable,
  quizParticipantsTable,
  quizPreviewsTable,
  quizQuestionsTable,
  quizSessionParticipantsTable,
  quizSessionsTable,
  quizStudentDailyQueriesTable,
  quizTopicsTable,
  telegramAdminLinkCodesTable,
} from "@workspace/db";
import { logger } from "../logger";
import {
  getOverallLeaderboardText,
  getSessionResultsText,
  handleRoleMenuCommand,
  handleStudentMenuCallback,
  handleStudentPrivateMessage,
  handleTestSetupMessage,
  handleAdminMenuCallback,
  handleAdminCommand,
  handleAdminNaturalQuizRequest,
  handleTopicWizardMessage,
  hasActiveTopicWizard,
  isConfiguredAdmin,
  sendRoleMenu,
  sendLongTelegramMessage,
} from "./adminCommands";
import {
  clearBook,
  extractPdfPages,
  getBookExcerpt,
  getBookStats,
  saveBookPart,
} from "./book";
import {
  answerStudentGrammarQuestion,
  generateVerifiedQuestions,
  parseAdminQuizRequest,
  summarizeQuizPerformance,
  type QuizDifficulty,
} from "./ai";
import {
  TELEGRAM_DOWNLOAD_LIMIT_BYTES,
  acknowledgeTelegramCallback,
  downloadTelegramFile,
  getTelegramBotInfo,
  isTelegramGroupAdmin,
  pinTelegramMessage,
  sendTelegramMessage,
  sendTelegramQuizPoll,
  telegramCall,
  type TelegramUpdate,
  type TelegramUser,
} from "./telegram";

// The preferred free model runs first; OPENROUTER_MODELS and these defaults
// remain available as fallbacks.
const defaultModels = [
  "nvidia/nemotron-3.5-super-vl:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-31b-it:free",
];

function getAiModels(): string[] {
  const fromEnv = (process.env.OPENROUTER_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return [
    ...new Set([defaultModels[0]!, ...fromEnv, ...defaultModels.slice(1)]),
  ];
}

type RuntimeStatus = {
  polling: boolean;
  telegramConnected: boolean;
  botUsername: string | null;
  lastError: string | null;
};

const runtimeStatus: RuntimeStatus = {
  polling: false,
  telegramConnected: false,
  botUsername: null,
  lastError: null,
};

let runtimeStarted = false;
let scheduleCheckInProgress = false;
let scheduledQuizCheckInProgress = false;
let activeQuizTasks = new Set<string>();
let latestQuizAnalysisContext: string | null = null;
let latestQuizAnalysisSessionId: string | null = null;
const scheduledQuizRetryAt = new Map<string, number>();
const activeQuizPolls = new Map<
  string,
  { sessionId: string; questionId: string; correctOptionIndex: number }
>();
const GROUP_QUIZ_COOLDOWN_MS = 2 * 60 * 1000;
function withDifficultyNote(
  notes: string | null,
  difficulty?: QuizDifficulty | null,
): string | null {
  if (!difficulty) return notes;
  const existing = (notes ?? "")
    .replace(/\[quiz-difficulty:(?:easy|intermediate|hard|A1|A2|B1|B2)\]/gi, "")
    .trim();
  return [existing, `[quiz-difficulty:${difficulty}]`]
    .filter(Boolean)
    .join("\n");
}

function readTopicDifficulty(notes: string | null): QuizDifficulty | null {
  const value = /\[quiz-difficulty:(easy|intermediate|hard|A1|A2|B1|B2)\]/i.exec(
    notes ?? "",
  )?.[1];
  if (!value) return null;
  return value.toUpperCase().startsWith("A") || value.toUpperCase().startsWith("B")
    ? (value.toUpperCase() as QuizDifficulty)
    : (value.toLowerCase() as QuizDifficulty);
}

type PreparedQuizQuestion = Pick<
  typeof quizQuestionsTable.$inferSelect,
  "prompt" | "options" | "correctOptionIndex" | "explanation" | "fingerprint"
>;

type QuizSignupResult =
  | { status: "started"; sessionId: string }
  | { status: "cooldown"; secondsRemaining: number }
  | { status: "active" }
  | { status: "topic-unavailable" }
  | { status: "questions-unavailable" }
  | { status: "preview-unavailable" }
  | { status: "already-published" };

async function getPreparedQuestionSet(
  topicId: string | null,
  topicTitle: string,
  questionCount: number,
): Promise<PreparedQuizQuestion[] | null> {
  if (questionCount < 1) return null;

  const topicMatch = topicId
    ? or(
        eq(quizSessionsTable.topicId, topicId),
        sql`lower(${quizSessionsTable.topicTitle}) = lower(${topicTitle})`,
      )
    : sql`lower(${quizSessionsTable.topicTitle}) = lower(${topicTitle})`;

  const [sourceSession] = await db
    .select({ id: quizSessionsTable.id })
    .from(quizSessionsTable)
    .innerJoin(
      quizQuestionsTable,
      eq(quizQuestionsTable.sessionId, quizSessionsTable.id),
    )
    .where(
      and(
        inArray(quizSessionsTable.status, ["completed", "cancelled"]),
        topicMatch,
      ),
    )
    .groupBy(quizSessionsTable.id, quizSessionsTable.createdAt)
    .having(sql`count(${quizQuestionsTable.id}) >= ${questionCount}`)
    .orderBy(desc(quizSessionsTable.createdAt))
    .limit(1);
  if (!sourceSession) return null;

  const questions = await db
    .select({
      id: quizQuestionsTable.id,
      prompt: quizQuestionsTable.prompt,
      options: quizQuestionsTable.options,
      correctOptionIndex: quizQuestionsTable.correctOptionIndex,
      explanation: quizQuestionsTable.explanation,
      fingerprint: quizQuestionsTable.fingerprint,
    })
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.sessionId, sourceSession.id))
    .orderBy(quizQuestionsTable.position)
    .limit(questionCount);
  if (
    questions.length < questionCount ||
    questions.some(
      (question) =>
        Array.from(question.prompt).length > 300 ||
        question.options.some((option) => Array.from(option).length > 100),
    )
  ) {
    return null;
  }
  return questions;
}

function shuffleQuestion(question: PreparedQuizQuestion): PreparedQuizQuestion {
  const shuffled = question.options.map((option, index) => ({
    option,
    originalIndex: index,
  }));
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex]!,
      shuffled[index]!,
    ];
  }
  return {
    ...question,
    options: shuffled.map(
      ({ option }) => option,
    ) as PreparedQuizQuestion["options"],
    correctOptionIndex: shuffled.findIndex(
      ({ originalIndex }) => originalIndex === question.correctOptionIndex,
    ),
  };
}

async function generateQuestionsForSession(
  session: Pick<
    typeof quizSessionsTable.$inferSelect,
    "topicId" | "topicTitle" | "questionCount"
  >,
  settings: Awaited<ReturnType<typeof getOrCreateBotSettings>>,
  additionalRecentPrompts: string[] = [],
  requestedDifficulty?: QuizDifficulty | null,
): Promise<PreparedQuizQuestion[]> {
  const [topic] = session.topicId
    ? await db
        .select()
        .from(quizTopicsTable)
        .where(eq(quizTopicsTable.id, session.topicId))
        .limit(1)
    : await db
        .select()
        .from(quizTopicsTable)
        .where(
          sql`lower(${quizTopicsTable.title}) = lower(${session.topicTitle})`,
        )
        .orderBy(desc(quizTopicsTable.updatedAt))
        .limit(1);
  const topicMatch = topic
    ? or(
        eq(quizSessionsTable.topicId, topic.id),
        sql`lower(${quizSessionsTable.topicTitle}) = lower(${session.topicTitle})`,
      )
    : sql`lower(${quizSessionsTable.topicTitle}) = lower(${session.topicTitle})`;
  const [bookExcerpt, recentQuestions] = await Promise.all([
    topic
      ? getBookExcerpt(topic.bookPages, settings.bookPageOffset)
      : Promise.resolve(null),
    db
      .select({ prompt: quizQuestionsTable.prompt })
      .from(quizQuestionsTable)
      .innerJoin(
        quizSessionsTable,
        eq(quizQuestionsTable.sessionId, quizSessionsTable.id),
      )
      .where(
        and(
          inArray(quizSessionsTable.status, ["completed", "cancelled"]),
          topicMatch,
        ),
      )
      .orderBy(desc(quizQuestionsTable.createdAt))
      .limit(60),
  ]);
  const storedDifficulty = readTopicDifficulty(topic?.notes ?? null);
  const notes = (topic?.notes ?? "")
    .replace(/\[quiz-difficulty:(?:easy|intermediate|hard|A1|A2|B1|B2)\]/gi, "")
    .trim();
  return generateVerifiedQuestions({
    models: getAiModels(),
    bookExcerpt: bookExcerpt?.text ?? null,
    bookTitle: settings.bookTitle,
    topicTitle: session.topicTitle,
    bookUnit: topic?.bookUnit ?? null,
    bookPages: topic?.bookPages ?? null,
    notes: notes || null,
    count: session.questionCount,
    difficulty: requestedDifficulty ?? storedDifficulty ?? null,
    recentPrompts: [
      ...recentQuestions.map(({ prompt }) => prompt),
      ...additionalRecentPrompts,
    ],
  });
}

function getSignupFailureMessage(result: QuizSignupResult): string {
  switch (result.status) {
    case "cooldown":
      return `Yangi test boshlashdan oldin ${result.secondsRemaining} soniya kuting.`;
    case "active":
      return "Guruhda testga yozilish yoki testning o‘zi allaqachon davom etmoqda.";
    case "topic-unavailable":
      return "Bu mavzu endi rejalashtirilmagan. Mavzular ro‘yxatini yangilang.";
    case "questions-unavailable":
      return "Bu mavzuda tayyor savollar yetarli emas. Admin preview orqali savollarni tayyorlang.";
    case "preview-unavailable":
      return "Test preview topilmadi yoki muddati tugagan. Testni qayta tayyorlang.";
    case "already-published":
      return "Bu preview guruhga allaqachon yuborilgan.";
    case "started":
      return "";
  }
}

export async function getOrCreateBotSettings() {
  await db
    .insert(quizBotSettingsTable)
    .values({ id: 1, aiModel: getAiModels()[0]! })
    .onConflictDoNothing();
  const primaryModel = getAiModels()[0]!;
  await db
    .update(quizBotSettingsTable)
    .set({ aiModel: primaryModel })
    .where(
      and(
        eq(quizBotSettingsTable.id, 1),
        sql`${quizBotSettingsTable.aiModel} <> ${primaryModel}`,
      ),
    );
  const [settings] = await db
    .select()
    .from(quizBotSettingsTable)
    .where(eq(quizBotSettingsTable.id, 1))
    .limit(1);
  if (!settings) {
    throw new Error("Quiz bot settings could not be initialized.");
  }
  return settings;
}

export function getQuizBotRuntimeStatus(): RuntimeStatus & {
  telegramTokenConfigured: boolean;
  openRouterKeyConfigured: boolean;
} {
  return {
    ...runtimeStatus,
    telegramTokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    openRouterKeyConfigured: Boolean(process.env.OPENROUTER_API_KEY),
  };
}

function localClock(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const fields = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return {
    date: `${fields.year}-${fields.month}-${fields.day}`,
    time: `${fields.hour}:${fields.minute}`,
  };
}

function localDateTimeToUtc(
  date: string,
  time: string,
  timezone: string,
): Date | null {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeParts = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!dateParts || !timeParts) return null;
  const [, yearText, monthText, dayText] = dateParts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(timeParts[1]);
  const minute = Number(timeParts[2]);
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute);
  if (
    new Date(localEpoch).getUTCFullYear() !== year ||
    new Date(localEpoch).getUTCMonth() !== month - 1 ||
    new Date(localEpoch).getUTCDate() !== day
  ) {
    return null;
  }

  let candidate = localEpoch;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clock = localClock(new Date(candidate), timezone);
    const representedLocalEpoch = Date.parse(
      `${clock.date}T${clock.time}:00.000Z`,
    );
    const adjustment = localEpoch - representedLocalEpoch;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const result = new Date(candidate);
  const resolved = localClock(result, timezone);
  return resolved.date === date && resolved.time === time ? result : null;
}

function displayName(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
}

async function saveTelegramParticipant(user: TelegramUser): Promise<void> {
  await db
    .insert(quizParticipantsTable)
    .values({
      telegramUserId: String(user.id),
      firstName: user.first_name,
      lastName: user.last_name ?? null,
      username: user.username ?? null,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: quizParticipantsTable.telegramUserId,
      set: {
        firstName: user.first_name,
        lastName: user.last_name ?? null,
        username: user.username ?? null,
        lastSeenAt: new Date(),
      },
    });
}

async function respondToGroupSetup(
  chat: { id: number; type: string; title?: string },
  user: TelegramUser,
): Promise<void> {
  if (chat.type !== "group" && chat.type !== "supergroup") {
    await sendTelegramMessage(
      String(chat.id),
      "Guruhni ulash uchun botni Telegram guruhingizga qo‘shib, guruh ichida /setup buyrug‘ini yuboring.",
    );
    return;
  }

  const settings = await getOrCreateBotSettings();
  const chatId = String(chat.id);
  if (settings.groupChatId && settings.groupChatId !== chatId) {
    await sendTelegramMessage(
      chatId,
      "Bot boshqa guruhga ulangan. Guruhni almashtirish uchun loyiha egasiga murojaat qiling.",
    );
    return;
  }

  let isAdmin = false;
  try {
    isAdmin = await isTelegramGroupAdmin(chatId, user.id);
  } catch {
    await sendTelegramMessage(
      chatId,
      "Guruh adminligini tekshirib bo‘lmadi. Botni guruhga administrator qilib qo‘shing, so‘ng /setup ni yana yuboring.",
    );
    return;
  }
  if (!isAdmin) {
    await sendTelegramMessage(
      chatId,
      "Guruhni faqat Telegram guruhi administratori ulashi mumkin.",
    );
    return;
  }

  await saveTelegramParticipant(user);
  const name = displayName(user);
  await db
    .insert(quizBotAdminsTable)
    .values({
      telegramUserId: String(user.id),
      clerkUserId: null,
      username: user.username ?? null,
      displayName: name,
    })
    .onConflictDoUpdate({
      target: quizBotAdminsTable.telegramUserId,
      set: { username: user.username ?? null, displayName: name },
    });
  await db
    .update(quizBotSettingsTable)
    .set({ groupChatId: chatId, updatedAt: new Date() })
    .where(eq(quizBotSettingsTable.id, 1));
  await sendTelegramMessage(
    chatId,
    [
      "Guruh ulandi.",
      "Endi botni shaxsiy chatda boshqarishingiz mumkin. Buyruqlar ro‘yxati uchun /yordam yuboring.",
      "Bot guruh adminligini tekshira olishi uchun Telegram’da unga administrator huquqini bering.",
    ].join("\n\n"),
  );
}

async function linkTelegramAdmin(
  chat: { id: number; type: string },
  user: TelegramUser,
  rawCode: string,
): Promise<void> {
  const chatId = String(chat.id);
  const settings = await getOrCreateBotSettings();
  if (!settings.groupChatId || settings.groupChatId !== chatId) {
    await sendTelegramMessage(
      chatId,
      "Bu guruh botga ulanmagan. Ulangan guruh ichida /link buyrug‘ini yuboring.",
    );
    return;
  }
  if (chat.type !== "group" && chat.type !== "supergroup") {
    await sendTelegramMessage(
      chatId,
      "Admin ulanishi faqat guruh ichida ishlaydi.",
    );
    return;
  }

  let isAdmin = false;
  try {
    isAdmin = await isTelegramGroupAdmin(chatId, user.id);
  } catch {
    await sendTelegramMessage(
      chatId,
      "Adminlikni tekshirib bo‘lmadi. Bot guruhda administrator ekanini tekshiring.",
    );
    return;
  }
  if (!isAdmin) {
    await sendTelegramMessage(
      chatId,
      "Bu kodni faqat guruh administratori faollashtira oladi.",
    );
    return;
  }

  const now = new Date();
  const [linkCode] = await db
    .select()
    .from(telegramAdminLinkCodesTable)
    .where(
      and(
        eq(telegramAdminLinkCodesTable.code, rawCode.toUpperCase()),
        gt(telegramAdminLinkCodesTable.expiresAt, now),
        isNull(telegramAdminLinkCodesTable.consumedAt),
      ),
    )
    .limit(1);
  if (!linkCode) {
    await sendTelegramMessage(
      chatId,
      "Kod topilmadi, muddati tugagan yoki oldin ishlatilgan. Paneldan yangi kod yarating.",
    );
    return;
  }

  const [existingTelegramLink] = await db
    .select()
    .from(quizBotAdminsTable)
    .where(eq(quizBotAdminsTable.telegramUserId, String(user.id)))
    .limit(1);
  const [existingWebLink] = await db
    .select()
    .from(quizBotAdminsTable)
    .where(eq(quizBotAdminsTable.clerkUserId, linkCode.clerkUserId))
    .limit(1);
  if (
    (existingTelegramLink?.clerkUserId &&
      existingTelegramLink.clerkUserId !== linkCode.clerkUserId) ||
    (existingWebLink && existingWebLink.telegramUserId !== String(user.id))
  ) {
    await sendTelegramMessage(
      chatId,
      "Telegram yoki web akkaunti boshqa admin bilan bog‘langan. Yordam uchun guruh egasiga murojaat qiling.",
    );
    return;
  }

  const [consumed] = await db
    .update(telegramAdminLinkCodesTable)
    .set({ consumedAt: now })
    .where(
      and(
        eq(telegramAdminLinkCodesTable.code, linkCode.code),
        isNull(telegramAdminLinkCodesTable.consumedAt),
        gt(telegramAdminLinkCodesTable.expiresAt, now),
      ),
    )
    .returning();
  if (!consumed) {
    await sendTelegramMessage(
      chatId,
      "Kod allaqachon ishlatilgan. Yangi kod yarating.",
    );
    return;
  }

  const name = displayName(user);
  await db
    .insert(quizBotAdminsTable)
    .values({
      telegramUserId: String(user.id),
      clerkUserId: linkCode.clerkUserId,
      username: user.username ?? null,
      displayName: name,
      linkedAt: now,
    })
    .onConflictDoUpdate({
      target: quizBotAdminsTable.telegramUserId,
      set: {
        clerkUserId: linkCode.clerkUserId,
        username: user.username ?? null,
        displayName: name,
        linkedAt: now,
      },
    });

  await sendTelegramMessage(
    chatId,
    `${name}, Telegram admini web boshqaruv paneliga ulandi.`,
  );
}

async function handleGroupCommand(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const user = message?.from;
  const text = message?.text?.trim();
  if (!message || !user || !text || !text.startsWith("/")) return;

  const command = text.split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  if (command === "/setup") {
    await respondToGroupSetup(message.chat, user);
    return;
  }
  if (command === "/reyting") {
    const settings = await getOrCreateBotSettings();
    if (String(message.chat.id) !== settings.groupChatId) return;
    const argument = text.slice(text.split(/\s+/)[0]?.length ?? 0).trim();
    const days = argument ? Number(argument) : undefined;
    if (
      days !== undefined &&
      (!Number.isInteger(days) || days < 1 || days > 120)
    ) {
      await sendLongTelegramMessage(
        String(message.chat.id),
        "Kunlar soni 1–120 oralig‘idagi butun son bo‘lsin.",
      );
      return;
    }
    await sendLongTelegramMessage(
      String(message.chat.id),
      await getOverallLeaderboardText(days),
      undefined,
      "HTML",
    );
    return;
  }
  if (command === "/link") {
    const code = text.split(/\s+/)[1];
    if (!code || !/^[A-F0-9]{8}$/i.test(code)) {
      await sendTelegramMessage(
        String(message.chat.id),
        "Paneldan olingan 8 belgili kod bilan /link KOD shaklida yuboring.",
      );
      return;
    }
    await linkTelegramAdmin(message.chat, user, code);
  }
}

async function joinQuiz(
  callback: NonNullable<TelegramUpdate["callback_query"]>,
  sessionId: string,
): Promise<void> {
  const message = callback.message;
  const settings = await getOrCreateBotSettings();
  const [session] = await db
    .select()
    .from(quizSessionsTable)
    .where(eq(quizSessionsTable.id, sessionId))
    .limit(1);
  if (
    !message ||
    !session ||
    session.chatType !== "group" ||
    String(message.chat.id) !== (session.chatId ?? settings.groupChatId)
  ) {
    await acknowledgeTelegramCallback(
      callback.id,
      "Bu tugma guruh uchun amal qilmaydi.",
    );
    return;
  }
  if (session.status !== "signup") {
    await acknowledgeTelegramCallback(callback.id, "Qatnashish vaqti tugagan.");
    return;
  }

  await saveTelegramParticipant(callback.from);
  await db
    .insert(quizSessionParticipantsTable)
    .values({
      sessionId,
      telegramUserId: String(callback.from.id),
    })
    .onConflictDoNothing();
  await acknowledgeTelegramCallback(
    callback.id,
    "Qatnashishingiz qayd etildi.",
  );

  const [participantCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(quizSessionParticipantsTable)
    .where(eq(quizSessionParticipantsTable.sessionId, sessionId));
  if ((participantCount?.count ?? 0) >= settings.minimumParticipants) {
    const [started] = await db
      .update(quizSessionsTable)
      .set({ status: "generating" })
      .where(
        and(
          eq(quizSessionsTable.id, sessionId),
          eq(quizSessionsTable.status, "signup"),
        ),
      )
      .returning({ id: quizSessionsTable.id });
    if (started) {
      void runQuizSession(sessionId);
    }
  }
}

async function handleQuizPollAnswer(
  pollAnswer: NonNullable<TelegramUpdate["poll_answer"]>,
): Promise<void> {
  const activePoll = activeQuizPolls.get(pollAnswer.poll_id);
  if (!activePoll) return;
  if (!pollAnswer.user) {
    logger.warn(
      { pollId: pollAnswer.poll_id },
      "Received an anonymous answer for a non-anonymous quiz poll",
    );
    return;
  }
  if (
    pollAnswer.option_ids.length > 1 ||
    pollAnswer.option_ids.some((option) => option < 0 || option > 3)
  ) {
    logger.warn(
      { pollId: pollAnswer.poll_id, optionIds: pollAnswer.option_ids },
      "Received invalid option IDs for a quiz poll answer",
    );
    return;
  }

  const telegramUserId = String(pollAnswer.user.id);
  let [joined] = await db
    .select({ telegramUserId: quizSessionParticipantsTable.telegramUserId })
    .from(quizSessionParticipantsTable)
    .where(
      and(
        eq(quizSessionParticipantsTable.sessionId, activePoll.sessionId),
        eq(quizSessionParticipantsTable.telegramUserId, telegramUserId),
      ),
    )
    .limit(1);
  if (!joined && pollAnswer.option_ids.length > 0) {
    const [session] = await db
      .select({
        chatType: quizSessionsTable.chatType,
        signupDeadline: quizSessionsTable.signupDeadline,
      })
      .from(quizSessionsTable)
      .where(eq(quizSessionsTable.id, activePoll.sessionId))
      .limit(1);
    if (session?.chatType !== "group" || session.signupDeadline !== null) {
      return;
    }
    await saveTelegramParticipant(pollAnswer.user);
    await db
      .insert(quizSessionParticipantsTable)
      .values({
        sessionId: activePoll.sessionId,
        telegramUserId,
      })
      .onConflictDoNothing();
    joined = { telegramUserId };
  }
  if (!joined) return;

  if (pollAnswer.option_ids.length === 0) {
    await db
      .delete(quizAnswersTable)
      .where(
        and(
          eq(quizAnswersTable.questionId, activePoll.questionId),
          eq(quizAnswersTable.telegramUserId, telegramUserId),
        ),
      );
    return;
  }

  const selectedOptionIndex = pollAnswer.option_ids[0]!;
  await saveTelegramParticipant(pollAnswer.user);
  await db
    .insert(quizAnswersTable)
    .values({
      sessionId: activePoll.sessionId,
      questionId: activePoll.questionId,
      telegramUserId,
      selectedOptionIndex,
      isCorrect: selectedOptionIndex === activePoll.correctOptionIndex,
    })
    .onConflictDoUpdate({
      target: [quizAnswersTable.questionId, quizAnswersTable.telegramUserId],
      set: {
        selectedOptionIndex,
        isCorrect: selectedOptionIndex === activePoll.correctOptionIndex,
        answeredAt: new Date(),
      },
    });
}

async function handleCallback(update: TelegramUpdate): Promise<void> {
  const callback = update.callback_query;
  const data = callback?.data;
  if (!callback || !data) return;

  if (data.startsWith("m:")) {
    let answered = false;
    try {
      const isAdmin = isConfiguredAdmin(callback.from.id);
      const isPublicMenuAction =
        data === "m:home" || data.startsWith("m:student:");
      if (!isAdmin && !isPublicMenuAction) {
        await acknowledgeTelegramCallback(callback.id, "Faqat adminlar uchun");
        answered = true;
        return;
      }
      const chat = callback.message?.chat;
      if (!chat || chat.type !== "private") {
        await acknowledgeTelegramCallback(
          callback.id,
          "Menyu shaxsiy chatda ishlaydi.",
        );
        answered = true;
        return;
      }
      const isPreviewAction = data.startsWith("m:preview:");
      if (!isPreviewAction) {
        await acknowledgeTelegramCallback(callback.id, "");
        answered = true;
      }
      const chatId = String(chat.id);
      if (data === "m:home") {
        await sendRoleMenu(chatId, callback.from.id);
      } else if (data.startsWith("m:student:")) {
        if (isAdmin) {
          await sendTelegramMessage(chatId, "Bu tugma talabalar uchun.");
        } else {
          await handleStudentMenuCallback(callback.from.id, chatId, data);
        }
      } else {
        await handleAdminMenuCallback(
          callback.from.id,
          chatId,
          data,
          {
            getSettings: getOrCreateBotSettings,
            startQuizNow,
            getBookStatus: getBookStatusText,
            startConfiguredQuiz,
            parseQuizRequest: parseAdminRequestText,
            scheduleQuiz,
            regenerateQuizPreview,
            getQuizPreview,
            publishQuizPreview,
            cancelQuizPreview,
          },
          {
            messageId: callback.message?.message_id,
            answer: async (text: string, showAlert = false) => {
              await acknowledgeTelegramCallback(callback.id, text, showAlert);
              answered = true;
            },
          },
        );
      }
    } catch (error) {
      if (!answered) {
        await acknowledgeTelegramCallback(
          callback.id,
          "Xatolik yuz berdi.",
        ).catch((ackError: unknown) => {
          logger.warn(
            { err: ackError },
            "Could not acknowledge admin menu callback",
          );
        });
      }
      throw error;
    }
    return;
  }

  if (data.startsWith("join:")) {
    const sessionId = data.slice("join:".length);
    await joinQuiz(callback, sessionId);
    return;
  }
  await acknowledgeTelegramCallback(callback.id, "Noma’lum tugma.");
}

async function isBotAdmin(userId: number): Promise<boolean> {
  const [admin] = await db
    .select({ id: quizBotAdminsTable.telegramUserId })
    .from(quizBotAdminsTable)
    .where(eq(quizBotAdminsTable.telegramUserId, String(userId)))
    .limit(1);
  return Boolean(admin);
}

async function getBookStatusText(): Promise<string> {
  const stats = await getBookStats();
  const settings = await getOrCreateBotSettings();
  return [
    stats.count > 0
      ? `📚 Kitob: ${stats.count} bet saqlangan (PDF ${stats.first}–${stats.last}). Bet siljishi: ${settings.bookPageOffset}.`
      : "📚 Kitob hali yuklanmagan.",
    "Kitobni PDF qilib shu yerga yuboring (har bir fayl 20 MB gacha, ketma-ket).",
    "Buyruqlar: /kitob — holat, /offset N — bet siljishi, /kitob_tozalash — o‘chirish.",
  ].join("\n");
}

let bookQueue: Promise<void> = Promise.resolve();

function describeUploadError(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      name: typeof error,
      message: String(error),
    };
  }
  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  if (error.cause !== undefined && depth < 5) {
    details.cause = describeUploadError(error.cause, depth + 1);
  }
  return details;
}

async function processBookUpload(
  chatId: string,
  document: NonNullable<NonNullable<TelegramUpdate["message"]>["document"]>,
  caption: string | undefined,
): Promise<void> {
  const startedAt = Date.now();
  let stage = "telegram-download";
  let stageStartedAt = Date.now();
  let downloadedBytes = 0;
  let pageCount: number | undefined;
  logger.info(
    {
      fileName: document.file_name ?? null,
      declaredBytes: document.file_size ?? null,
    },
    "Book upload processing started",
  );
  try {
    const buffer = await downloadTelegramFile(document.file_id);
    downloadedBytes = buffer.byteLength;
    logger.info(
      { downloadedBytes, durationMs: Date.now() - stageStartedAt },
      "Book PDF download completed",
    );

    stage = "pdf-extraction";
    stageStartedAt = Date.now();
    const pages = await extractPdfPages(buffer);
    pageCount = pages.length;
    logger.info(
      {
        pageCount,
        textPages: pages.filter((page) => page.length >= 20).length,
        durationMs: Date.now() - stageStartedAt,
      },
      "Book PDF text extraction completed",
    );

    stage = "database-read";
    stageStartedAt = Date.now();
    const stats = await getBookStats();
    const captionPage = /^\s*(\d{1,4})\s*$/.exec(caption ?? "");
    const startPage = captionPage
      ? Number(captionPage[1])
      : (stats.last ?? 0) + 1;
    stage = "database-save";
    stageStartedAt = Date.now();
    const result = await saveBookPart(pages, startPage);
    logger.info(
      {
        savedPages: result.saved,
        emptyPages: result.empty,
        firstPage: result.from,
        lastPage: result.to,
        durationMs: Date.now() - stageStartedAt,
      },
      "Book PDF pages saved",
    );
    if (result.saved === 0) {
      await sendTelegramMessage(
        chatId,
        "Bu PDF dan matn o‘qib bo‘lmadi: u skaner (rasm) ko‘rinishida bo‘lishi mumkin. Matnli (belgilanadigan) PDF yuboring yoki OCR qilingan variantini yuklang.",
      );
      return;
    }
    stage = "success-notification";
    stageStartedAt = Date.now();
    await sendTelegramMessage(
      chatId,
      [
        `✅ ${result.saved} bet saqlandi (PDF sahifalari ${result.from}–${result.to}).`,
        result.empty > 0
          ? `Matni topilmagan sahifalar: ${result.empty} (rasm yoki bo‘sh bet).`
          : "",
        "Keyingi bo‘lakni yuborsangiz, u shu sahifadan davom etadi. Aniq boshlanish sahifasini berish uchun fayl izohiga (caption) raqam yozing.",
        "Bosma bet raqami PDF raqamidan farq qilsa: /offset 6 (bosma 1-bet = PDF 7-bet).",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    logger.info(
      { totalDurationMs: Date.now() - startedAt },
      "Book upload processing completed",
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        errorDetails: describeUploadError(error),
        stage,
        stageDurationMs: Date.now() - stageStartedAt,
        totalDurationMs: Date.now() - startedAt,
        fileName: document.file_name ?? null,
        declaredBytes: document.file_size ?? null,
        downloadedBytes,
        pageCount: pageCount ?? null,
      },
      "Book upload failed",
    );
    const failureMessage =
      stage === "success-notification"
        ? "PDF matni saqlandi, lekin tasdiq xabarini yuborishda xatolik bo‘ldi. /kitob orqali holatni tekshiring."
        : "Kitobni qayta ishlashda xatolik bo‘ldi. Xatolik bosqichi va to‘liq tafsilotlar server logiga yozildi.";
    try {
      await sendTelegramMessage(chatId, failureMessage);
    } catch (notificationError) {
      logger.error(
        {
          err: notificationError,
          errorDetails: describeUploadError(notificationError),
          originalFailureStage: stage,
        },
        "Could not notify user about book upload failure",
      );
    }
  }
}

async function answerStudentQuestion(
  message: NonNullable<TelegramUpdate["message"]>,
  text: string,
): Promise<void> {
  const user = message.from;
  if (!user) return;
  const chatId = String(message.chat.id);
  if (text.length > 1500) {
    await sendTelegramMessage(
      chatId,
      "Iltimos, savolingizni 1500 belgigacha qisqartiring.",
    );
    return;
  }

  const settings = await getOrCreateBotSettings();
  const now = new Date();
  const queryDate = localClock(now, settings.timezone).date;
  await saveTelegramParticipant(user);
  const [usage] = await db
    .insert(quizStudentDailyQueriesTable)
    .values({
      telegramUserId: String(user.id),
      queryDate,
      queryCount: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        quizStudentDailyQueriesTable.telegramUserId,
        quizStudentDailyQueriesTable.queryDate,
      ],
      set: {
        queryCount: sql`${quizStudentDailyQueriesTable.queryCount} + 1`,
        updatedAt: now,
      },
      setWhere: lt(quizStudentDailyQueriesTable.queryCount, 5),
    })
    .returning({ queryCount: quizStudentDailyQueriesTable.queryCount });

  if (!usage) {
    await sendTelegramMessage(
      chatId,
      "Assalomu alaykum! Ustozimiz belgilagan intizomga ko‘ra bugungi 5 ta savol limitingiz tugadi. Qolgan tushunmovchiliklarni ertaga darsda Ustozimizdan so‘rashingiz mumkin.",
    );
    return;
  }

  try {
    const answer = await answerStudentGrammarQuestion({
      models: getAiModels(),
      bookTitle: settings.bookTitle,
      question: text,
    });
    if (!answer) throw new Error("The grammar tutor returned an empty answer.");
    await sendLongTelegramMessage(
      chatId,
      `${answer}\n\n📊 Bugungi AI savollar: ${usage.queryCount}/5`,
    );
  } catch (error) {
    logger.error(
      { err: error, telegramUserId: user.id, queryDate },
      "Student grammar question could not be answered",
    );
    await sendTelegramMessage(
      chatId,
      "Savolingiz uchun javobni hozir tayyorlay olmadim. Iltimos, birozdan so‘ng qayta urinib ko‘ring.",
    );
  }
}

async function parseAdminRequestText(
  requestText: string,
  previous?: {
    previousTopicTitle: string | null;
    previousQuestionCount: number | null;
    previousSecondsPerQuestion: number | null;
    previousDifficulty: QuizDifficulty | null;
    recentMessages: string[];
  },
) {
  const settings = await getOrCreateBotSettings();
  const current = localClock(new Date(), settings.timezone);
  return parseAdminQuizRequest(requestText, getAiModels(), {
    ...previous,
    currentLocalDate: current.date,
    currentLocalTime: current.time,
    timezone: settings.timezone,
    latestQuizSummary: await getLatestQuizStatusContext(),
  });
}

async function getLatestQuizStatusContext(): Promise<string | null> {
  const [session] = await db
    .select({
      id: quizSessionsTable.id,
      topicTitle: quizSessionsTable.topicTitle,
      status: quizSessionsTable.status,
      questionCount: quizSessionsTable.questionCount,
      currentQuestionIndex: quizSessionsTable.currentQuestionIndex,
    })
    .from(quizSessionsTable)
    .orderBy(desc(quizSessionsTable.createdAt))
    .limit(1);
  if (!session) return null;
  if (
    session.status === "completed" &&
    latestQuizAnalysisSessionId === session.id &&
    latestQuizAnalysisContext
  ) {
    return latestQuizAnalysisContext;
  }
  if (session.status === "running") {
    return `Eng so'nggi test: "${session.topicTitle}" davom etyapti, savol ${Math.max(1, session.currentQuestionIndex + 1)}/${session.questionCount}.`;
  }
  if (session.status === "signup") {
    return `Eng so'nggi test: "${session.topicTitle}" uchun guruhda qatnashchilar yig'ilmoqda.`;
  }
  if (session.status === "generating") {
    return `Eng so'nggi test: "${session.topicTitle}" savollari tayyorlanmoqda.`;
  }
  if (session.status !== "completed") {
    return `Eng so'nggi test "${session.topicTitle}" yakunlanmagan (holati: ${session.status}).`;
  }

  const [totals] = await db
    .select({
      totalAnswers: sql<number>`count(${quizAnswersTable.id})::int`,
      correctAnswers:
        sql<number>`count(${quizAnswersTable.id}) filter (where ${quizAnswersTable.isCorrect})::int`,
    })
    .from(quizQuestionsTable)
    .leftJoin(
      quizAnswersTable,
      eq(quizAnswersTable.questionId, quizQuestionsTable.id),
    )
    .where(eq(quizQuestionsTable.sessionId, session.id));
  const accuracy = totals?.totalAnswers
    ? Math.round((totals.correctAnswers / totals.totalAnswers) * 100)
    : 0;
  return `Eng so'nggi test "${session.topicTitle}" yakunlandi: ${totals?.totalAnswers ?? 0} ta javobdan ${accuracy}% to'g'ri.`;
}

async function handlePrivateMessage(
  message: NonNullable<TelegramUpdate["message"]>,
): Promise<void> {
  const user = message.from;
  if (!user) return;
  const chatId = String(message.chat.id);

  const text = message.text?.trim() ?? "";
  const command = text.startsWith("/")
    ? text.split(/\s+/)[0]?.split("@")[0]?.toLowerCase()
    : undefined;

  if (await handleRoleMenuCommand(message)) return;

  if (!isConfiguredAdmin(user.id)) {
    if (
      message.text &&
      (await handleStudentPrivateMessage(message, startPrivateQuiz))
    ) {
      return;
    }
    if (text && !command) await answerStudentQuestion(message, text);
    return;
  }

  const adminContext = {
    getSettings: getOrCreateBotSettings,
    startQuizNow,
    getBookStatus: getBookStatusText,
    startConfiguredQuiz,
    parseQuizRequest: parseAdminRequestText,
    scheduleQuiz,
    regenerateQuizPreview,
    getQuizPreview,
    publishQuizPreview,
    cancelQuizPreview,
  };
  if (message.text) {
    if (await handleTestSetupMessage(message)) return;
    if (await handleTopicWizardMessage(message)) return;
    if (await handleAdminCommand(message, adminContext)) return;
    if (await handleAdminNaturalQuizRequest(message, adminContext)) return;
  }

  if (
    !message.document &&
    !command &&
    (!message.text || !hasActiveTopicWizard(user.id))
  ) {
    return;
  }

  if (message.document) {
    const document = message.document;
    const isPdf =
      document.mime_type === "application/pdf" ||
      document.file_name?.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      await sendTelegramMessage(
        chatId,
        "Iltimos, kitobni PDF fayl sifatida yuboring.",
      );
      return;
    }
    if ((document.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
      await sendTelegramMessage(
        chatId,
        [
          "Telegram botlarga 20 MB dan katta fayl yuklab olishga ruxsat bermaydi.",
          "PDF ni 20 MB dan kichik bo‘laklarga bo‘ling (masalan, ilovepdf.com → Split PDF, yoki Compress PDF) va bo‘laklarni ketma-ket yuboring.",
        ].join("\n"),
      );
      return;
    }
    await sendTelegramMessage(
      chatId,
      "Fayl qabul qilindi, o‘qilyapti. Bir necha daqiqa ketishi mumkin…",
    );
    const caption = message.caption;
    bookQueue = bookQueue.then(() =>
      processBookUpload(chatId, document, caption),
    );
    return;
  }

  if (command === "/offset") {
    const value = Number(text.split(/\s+/)[1]);
    if (!Number.isInteger(value) || value < -50 || value > 500) {
      await sendTelegramMessage(
        chatId,
        "Misol: /offset 6  (bosma 1-bet = PDF 7-bet)",
      );
      return;
    }
    await getOrCreateBotSettings();
    await db
      .update(quizBotSettingsTable)
      .set({ bookPageOffset: value, updatedAt: new Date() })
      .where(eq(quizBotSettingsTable.id, 1));
    await sendTelegramMessage(
      chatId,
      `Saqlandi: PDF bet raqami = bosma bet + ${value}.`,
    );
    return;
  }

  if (command === "/kitob_tozalash") {
    await clearBook();
    await sendTelegramMessage(chatId, "Kitob matni o‘chirildi.");
    return;
  }

  if (command === "/kitob" || command === "/start") {
    const stats = await getBookStats();
    const settings = await getOrCreateBotSettings();
    await sendTelegramMessage(
      chatId,
      [
        stats.count > 0
          ? `📚 Kitob: ${stats.count} bet saqlangan (PDF ${stats.first}–${stats.last}). Bet siljishi: ${settings.bookPageOffset}.`
          : "📚 Kitob hali yuklanmagan.",
        "Kitobni PDF qilib shu yerga yuboring (har bir fayl 20 MB gacha, ketma-ket).",
        "Buyruqlar: /kitob — holat, /offset N — bet siljishi, /kitob_tozalash — o‘chirish.",
      ].join("\n"),
    );
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.message) {
    if (update.message.chat.type === "private") {
      await handlePrivateMessage(update.message);
    } else {
      await handleGroupCommand(update);
    }
  } else if (update.callback_query) {
    await handleCallback(update);
  } else if (update.poll_answer) {
    await handleQuizPollAnswer(update.poll_answer);
  }
}

async function createQuizSignup(
  topic: typeof quizTopicsTable.$inferSelect,
  scheduledDate: string,
  settings: Awaited<ReturnType<typeof getOrCreateBotSettings>>,
  preparedQuestions?: PreparedQuizQuestion[],
  publishPreview?: {
    id: string;
    adminTelegramUserId: string;
    source: "ai" | "database";
  },
  questionSource: "ai" | "database" = publishPreview?.source ?? "database",
  startImmediately = false,
): Promise<QuizSignupResult> {
  if (!settings.groupChatId) {
    throw new Error("The Telegram group is not configured.");
  }
  const signupQuestions =
    preparedQuestions ??
    (readTopicDifficulty(topic.notes)
      ? null
      : (
          await getPreparedQuestionSet(
            topic.id,
            topic.title,
            settings.questionCount,
          )
        )?.map(shuffleQuestion));
  if (!signupQuestions) return { status: "questions-unavailable" };
  const now = new Date();
  const deadline = new Date(
    now.getTime() + settings.signupWindowMinutes * 60_000,
  );
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${settings.groupChatId}, 0))`,
    );

    if (publishPreview) {
      const [preview] = await tx
        .select()
        .from(quizPreviewsTable)
        .where(
          and(
            eq(quizPreviewsTable.id, publishPreview.id),
            eq(
              quizPreviewsTable.adminTelegramUserId,
              publishPreview.adminTelegramUserId,
            ),
            gt(quizPreviewsTable.expiresAt, now),
          ),
        )
        .limit(1)
        .for("update");
      if (!preview) return { status: "preview-unavailable" as const };
      if (preview.publishedSessionId) {
        return { status: "already-published" as const };
      }
    }

    const [activeSession] = await tx
      .select({ id: quizSessionsTable.id })
      .from(quizSessionsTable)
      .where(
        and(
          eq(quizSessionsTable.chatType, "group"),
          sql`(${quizSessionsTable.chatId} = ${settings.groupChatId} OR ${quizSessionsTable.chatId} IS NULL)`,
          inArray(quizSessionsTable.status, [
            "signup",
            "generating",
            "running",
          ]),
        ),
      )
      .limit(1);
    if (activeSession) return { status: "active" as const };

    const [recentCompleted] = await tx
      .select({ endedAt: quizSessionsTable.endedAt })
      .from(quizSessionsTable)
      .where(
        and(
          eq(quizSessionsTable.chatType, "group"),
          sql`(${quizSessionsTable.chatId} = ${settings.groupChatId} OR ${quizSessionsTable.chatId} IS NULL)`,
          eq(quizSessionsTable.status, "completed"),
          gt(
            quizSessionsTable.endedAt,
            new Date(now.getTime() - GROUP_QUIZ_COOLDOWN_MS),
          ),
        ),
      )
      .orderBy(desc(quizSessionsTable.endedAt))
      .limit(1);
    if (recentCompleted?.endedAt) {
      const remainingMs =
        recentCompleted.endedAt.getTime() +
        GROUP_QUIZ_COOLDOWN_MS -
        now.getTime();
      return {
        status: "cooldown" as const,
        secondsRemaining: Math.max(1, Math.ceil(remainingMs / 1000)),
      };
    }

    const [plannedTopic] = await tx
      .select({ id: quizTopicsTable.id })
      .from(quizTopicsTable)
      .where(
        and(
          eq(quizTopicsTable.id, topic.id),
          inArray(quizTopicsTable.status, [
            "planned",
            "preview",
            "announcing",
            "announced",
          ]),
        ),
      )
      .limit(1)
      .for("update");
    if (!plannedTopic) return { status: "topic-unavailable" as const };

    const [session] = await tx
      .insert(quizSessionsTable)
      .values({
        topicId: topic.id,
        topicTitle: topic.title,
        scheduledDate,
        chatId: settings.groupChatId,
        chatType: "group",
        status: startImmediately ? "generating" : "signup",
        signupDeadline: startImmediately ? null : deadline,
        questionCount: settings.questionCount,
        secondsPerQuestion: settings.secondsPerQuestion,
        questionSource,
      })
      .onConflictDoNothing()
      .returning();
    if (!session) return { status: "active" as const };

    if (signupQuestions.length !== settings.questionCount) {
      throw new Error("Preview question count does not match quiz settings.");
    }
    await tx.insert(quizQuestionsTable).values(
      signupQuestions.map((question, position) => ({
        sessionId: session.id,
        position,
        prompt: question.prompt,
        options: question.options,
        correctOptionIndex: question.correctOptionIndex,
        explanation: question.explanation,
        fingerprint: question.fingerprint,
      })),
    );

    if (publishPreview) {
      await tx
        .update(quizPreviewsTable)
        .set({ publishedSessionId: session.id, updatedAt: now })
        .where(
          and(
            eq(quizPreviewsTable.id, publishPreview.id),
            eq(
              quizPreviewsTable.adminTelegramUserId,
              publishPreview.adminTelegramUserId,
            ),
          ),
        );
    }

    await tx
      .update(quizTopicsTable)
      .set({ status: "used", updatedAt: now })
      .where(eq(quizTopicsTable.id, topic.id));
    return { status: "created" as const, session };
  });

  if (outcome.status !== "created") return outcome;
  const { session } = outcome;

  if (startImmediately) {
    void runQuizSession(session.id);
    logger.info(
      { topicId: topic.id, sessionId: session.id, scheduledDate },
      "Started scheduled Telegram quiz immediately",
    );
    return { status: "started", sessionId: session.id };
  }

  try {
    const message = await sendTelegramMessage(
      settings.groupChatId,
      [
        `Nemis tili grammatikasi testi: ${topic.title}`,
        topic.bookUnit ? `Grammatik Aktiv, ${topic.bookUnit}` : "",
        `${settings.signupWindowMinutes} daqiqa ichida qatnashing. Kamida ${settings.minimumParticipants} kishi ro‘yxatdan o‘tsa, test avtomatik boshlanadi.`,
      ]
        .filter(Boolean)
        .join("\n"),
      {
        inline_keyboard: [
          [
            {
              text: "✅ Qatnashaman",
              callback_data: `join:${session.id}`,
            },
          ],
        ],
      },
    );
    await db
      .update(quizSessionsTable)
      .set({ signupMessageId: message.message_id })
      .where(eq(quizSessionsTable.id, session.id));
    logger.info(
      { topicId: topic.id, sessionId: session.id, scheduledDate },
      "Started Telegram quiz signup",
    );
    return { status: "started", sessionId: session.id };
  } catch (error) {
    await db
      .update(quizSessionsTable)
      .set({ status: "cancelled", endedAt: new Date() })
      .where(eq(quizSessionsTable.id, session.id));
    await db
      .update(quizTopicsTable)
      .set({
        status: topic.scheduledAt
          ? "announced"
          : publishPreview
            ? "preview"
            : "planned",
        updatedAt: new Date(),
      })
      .where(eq(quizTopicsTable.id, topic.id));
    if (publishPreview) {
      await db
        .update(quizPreviewsTable)
        .set({ publishedSessionId: null, updatedAt: new Date() })
        .where(eq(quizPreviewsTable.id, publishPreview.id));
    }
    throw error;
  }
}

async function findNextPlannedTopic(
  date: string,
): Promise<typeof quizTopicsTable.$inferSelect | null> {
  const todayTopics = await db
    .select()
    .from(quizTopicsTable)
    .where(
      and(
        eq(quizTopicsTable.scheduledFor, date),
        eq(quizTopicsTable.status, "planned"),
        isNull(quizTopicsTable.scheduledAt),
      ),
    )
    .orderBy(quizTopicsTable.createdAt);
  const overdueTopics = await db
    .select()
    .from(quizTopicsTable)
    .where(
      and(
        lt(quizTopicsTable.scheduledFor, date),
        eq(quizTopicsTable.status, "planned"),
        isNull(quizTopicsTable.scheduledAt),
      ),
    )
    .orderBy(quizTopicsTable.scheduledFor, quizTopicsTable.createdAt);

  return [...todayTopics, ...overdueTopics][0] ?? null;
}

async function startPrivateQuiz(
  chatId: string,
  user: TelegramUser,
  topicTitle: string,
): Promise<string> {
  if (chatId !== String(user.id)) {
    throw new Error(
      "Private quizzes can only be started in the user's private chat.",
    );
  }

  const settings = await getOrCreateBotSettings();
  const { date } = localClock(new Date(), settings.timezone);
  const [activeSession] = await db
    .select({
      topicTitle: quizSessionsTable.topicTitle,
      status: quizSessionsTable.status,
    })
    .from(quizSessionsTable)
    .where(
      and(
        eq(quizSessionsTable.chatType, "private"),
        eq(quizSessionsTable.chatId, chatId),
        inArray(quizSessionsTable.status, ["generating", "running"]),
      ),
    )
    .limit(1);
  if (activeSession) {
    return `Sizda “${activeSession.topicTitle}” shaxsiy testi hali ${activeSession.status === "generating" ? "tayyorlanmoqda" : "davom etmoqda"}.`;
  }

  const [topic] = await db
    .select()
    .from(quizTopicsTable)
    .where(sql`lower(${quizTopicsTable.title}) = lower(${topicTitle})`)
    .orderBy(desc(quizTopicsTable.updatedAt))
    .limit(1);
  await saveTelegramParticipant(user);
  const session = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(quizSessionsTable)
      .values({
        topicId: topic?.id ?? null,
        topicTitle,
        scheduledDate: date,
        chatId,
        chatType: "private",
        status: "generating",
        questionCount: settings.questionCount,
        secondsPerQuestion: settings.secondsPerQuestion,
      })
      .onConflictDoNothing()
      .returning({ id: quizSessionsTable.id });
    if (!created) return undefined;

    await tx
      .insert(quizSessionParticipantsTable)
      .values({
        sessionId: created.id,
        telegramUserId: String(user.id),
      })
      .onConflictDoNothing();
    return created;
  });
  if (!session) {
    return "Sizda allaqachon faol shaxsiy test bor. Avval uni yakunlang.";
  }

  void runQuizSession(session.id);
  logger.info(
    { topicId: topic?.id ?? null, sessionId: session.id, userId: user.id },
    "Started private Telegram quiz immediately",
  );
  return `“${topicTitle}” bo‘yicha shaxsiy test boshlandi. Savollar bazadan olinadi, yetarli bo‘lmasa Nemotron orqali tayyorlanadi.`;
}

async function startQuizNow(): Promise<string> {
  const settings = await getOrCreateBotSettings();
  if (!settings.groupChatId) {
    return "Avval guruhda /setup yuborib botni guruhga ulang.";
  }
  const { date } = localClock(new Date(), settings.timezone);
  const topic = await findNextPlannedTopic(date);
  if (!topic) {
    return "Bugun yoki oldingi sanalar uchun rejalashtirilgan mavzu topilmadi.";
  }
  const result = await createQuizSignup(topic, date, settings);
  if (result.status !== "started") {
    return getSignupFailureMessage(result);
  }
  return `Testga yozilish boshlandi: ${topic.title}. Guruhga qatnashish xabari yuborildi.`;
}

async function getAdminQuizPreview(
  preview: typeof quizPreviewsTable.$inferSelect,
) {
  return {
    id: preview.id,
    topicTitle: preview.topicTitle,
    questionCount: preview.questionCount,
    secondsPerQuestion: preview.secondsPerQuestion,
    source: preview.source === "ai" ? ("ai" as const) : ("database" as const),
    questions: preview.questions.map(
      ({ prompt, options, correctOptionIndex, explanation }) => ({
        prompt,
        options,
        correctOptionIndex,
        explanation,
      }),
    ),
  };
}

async function startConfiguredQuiz(
  adminTelegramUserId: number,
  topicTitle: string,
  questionCount: number,
  secondsPerQuestion: number,
  requestedDifficulty?: QuizDifficulty | null,
) {
  const settings = await getOrCreateBotSettings();
  if (!settings.groupChatId) {
    throw new Error("Avval guruhda /setup yuborib botni ulang.");
  }
  if (
    ![5, 10, 15, 20, 30].includes(questionCount)
  ) {
    throw new Error("Test savollari soni 5, 10, 15, 20 yoki 30 bo‘lishi kerak.");
  }
  if (![15, 20, 25, 30].includes(secondsPerQuestion)) {
    throw new Error("Savol vaqti 15, 20, 25 yoki 30 soniya bo‘lishi kerak.");
  }
  const { date } = localClock(new Date(), settings.timezone);
  const [previousPreview] = await db
    .select()
    .from(quizPreviewsTable)
    .where(
      eq(quizPreviewsTable.adminTelegramUserId, String(adminTelegramUserId)),
    )
    .limit(1);
  const [matchingTopic] = await db
    .select()
    .from(quizTopicsTable)
    .where(sql`lower(${quizTopicsTable.title}) = lower(${topicTitle})`)
    .orderBy(desc(quizTopicsTable.updatedAt))
    .limit(1);
  const [topic] = await db
    .insert(quizTopicsTable)
    .values({
      title: topicTitle,
      bookUnit: matchingTopic?.bookUnit ?? null,
      bookPages: matchingTopic?.bookPages ?? null,
      notes: withDifficultyNote(matchingTopic?.notes ?? null, requestedDifficulty),
      scheduledFor: date,
      status: "preview",
    })
    .returning();
  if (!topic) throw new Error("Test mavzusini saqlab bo‘lmadi.");

  try {
    const difficulty = requestedDifficulty ?? readTopicDifficulty(topic.notes);
    const storedQuestions = difficulty
      ? null
      : await getPreparedQuestionSet(topic.id, topicTitle, questionCount);
    const source = storedQuestions ? "database" : "ai";
    const questions =
      storedQuestions ??
      (await generateQuestionsForSession(
        { topicId: topic.id, topicTitle, questionCount },
        settings,
        [],
        difficulty,
      ));
    const now = new Date();
    const [preview] = await db
      .insert(quizPreviewsTable)
      .values({
        adminTelegramUserId: String(adminTelegramUserId),
        topicId: topic.id,
        topicTitle,
        scheduledDate: date,
        questionCount,
        secondsPerQuestion,
        source,
        questions: questions.map(shuffleQuestion),
        expiresAt: new Date(now.getTime() + 30 * 60_000),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: quizPreviewsTable.adminTelegramUserId,
        set: {
          id: randomUUID(),
          topicId: topic.id,
          topicTitle,
          scheduledDate: date,
          questionCount,
          secondsPerQuestion,
          source,
          publishedSessionId: null,
          questions: questions.map(shuffleQuestion),
          expiresAt: new Date(now.getTime() + 30 * 60_000),
          updatedAt: now,
        },
      })
      .returning();
    if (!preview)
      throw new Error("Test preview ma’lumotlarini saqlab bo‘lmadi.");
    if (previousPreview?.topicId && previousPreview.topicId !== topic.id) {
      await db
        .delete(quizTopicsTable)
        .where(
          and(
            eq(quizTopicsTable.id, previousPreview.topicId),
            eq(quizTopicsTable.status, "preview"),
          ),
        );
    }
    logger.info(
      {
        previewId: preview.id,
        adminTelegramUserId,
        topicId: topic.id,
        questionCount,
        source,
      },
      "Prepared admin quiz preview",
    );
    return getAdminQuizPreview(preview);
  } catch (error) {
    await db
      .delete(quizTopicsTable)
      .where(
        and(
          eq(quizTopicsTable.id, topic.id),
          eq(quizTopicsTable.status, "preview"),
        ),
      );
    throw error;
  }
}

async function regenerateQuizPreview(
  adminTelegramUserId: number,
  previewId: string,
) {
  const [preview] = await db
    .select()
    .from(quizPreviewsTable)
    .where(
      and(
        eq(quizPreviewsTable.id, previewId),
        eq(quizPreviewsTable.adminTelegramUserId, String(adminTelegramUserId)),
        gt(quizPreviewsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!preview || preview.publishedSessionId) {
    throw new Error(
      "Test preview topilmadi, muddati tugagan yoki allaqachon yuborilgan.",
    );
  }
  const settings = await getOrCreateBotSettings();
  const [topic] = preview.topicId
    ? await db
        .select({ notes: quizTopicsTable.notes })
        .from(quizTopicsTable)
        .where(eq(quizTopicsTable.id, preview.topicId))
        .limit(1)
    : [];
  const questions = await generateQuestionsForSession(
    {
      topicId: preview.topicId,
      topicTitle: preview.topicTitle,
      questionCount: preview.questionCount,
    },
    settings,
    preview.questions.map(({ prompt }) => prompt),
    readTopicDifficulty(topic?.notes ?? null),
  );
  const now = new Date();
  const [updated] = await db
    .update(quizPreviewsTable)
    .set({
      id: randomUUID(),
      source: "ai",
      questions: questions.map(shuffleQuestion),
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      updatedAt: now,
    })
    .where(
      and(
        eq(quizPreviewsTable.id, previewId),
        eq(quizPreviewsTable.adminTelegramUserId, String(adminTelegramUserId)),
        isNull(quizPreviewsTable.publishedSessionId),
        gt(quizPreviewsTable.expiresAt, now),
      ),
    )
    .returning();
  if (!updated) throw new Error("Preview yangilanmadi; qayta urinib ko‘ring.");
  logger.info(
    { previewId, adminTelegramUserId, questionCount: preview.questionCount },
    "Regenerated admin quiz preview",
  );
  return getAdminQuizPreview(updated);
}

async function scheduleQuiz(
  scheduledDate: string,
  scheduledTime: string,
  topicTitle: string,
  requestedDifficulty?: QuizDifficulty | null,
): Promise<string> {
  const settings = await getOrCreateBotSettings();
  if (!settings.groupChatId) {
    throw new Error("Avval guruhda /setup yuborib botni ulang.");
  }
  const scheduledAt = localDateTimeToUtc(
    scheduledDate,
    scheduledTime,
    settings.timezone,
  );
  if (!scheduledAt) {
    throw new Error("Ko‘rsatilgan sana yoki vaqt yaroqsiz.");
  }
  if (scheduledAt.getTime() <= Date.now()) {
    throw new Error("Rejalashtirilgan vaqt kelajakda bo‘lishi kerak.");
  }

  const [existingTopic] = await db
    .select()
    .from(quizTopicsTable)
    .where(
      and(
        sql`lower(${quizTopicsTable.title}) = lower(${topicTitle})`,
        eq(quizTopicsTable.scheduledFor, scheduledDate),
        eq(quizTopicsTable.status, "planned"),
      ),
    )
    .orderBy(desc(quizTopicsTable.updatedAt))
    .limit(1);
  const [matchingTopic] = await db
    .select({
      bookUnit: quizTopicsTable.bookUnit,
      bookPages: quizTopicsTable.bookPages,
      notes: quizTopicsTable.notes,
    })
    .from(quizTopicsTable)
    .where(sql`lower(${quizTopicsTable.title}) = lower(${topicTitle})`)
    .orderBy(desc(quizTopicsTable.updatedAt))
    .limit(1);
  const now = new Date();
  const [topic] = existingTopic
    ? await db
        .update(quizTopicsTable)
        .set({
          notes: withDifficultyNote(existingTopic.notes, requestedDifficulty),
          scheduledAt,
          scheduleAnnouncementMessageId: null,
          updatedAt: now,
        })
        .where(eq(quizTopicsTable.id, existingTopic.id))
        .returning()
    : await db
        .insert(quizTopicsTable)
        .values({
          title: topicTitle,
          bookUnit: matchingTopic?.bookUnit ?? null,
          bookPages: matchingTopic?.bookPages ?? null,
          notes: withDifficultyNote(matchingTopic?.notes ?? null, requestedDifficulty),
          scheduledFor: scheduledDate,
          scheduledAt,
          status: "planned",
        })
        .returning();
  if (!topic) throw new Error("Test rejasini saqlab bo‘lmadi.");

  const announcement = await sendTelegramMessage(
    settings.groupChatId,
    `📢 Assalomu alaykum! Muhtaram Ustozimiz belgilagan rejadagidek, soat ${scheduledTime}da ${topic.title} bo‘yicha test boshlanadi.`,
  );
  const [recordedTopic] = await db
    .update(quizTopicsTable)
    .set({
      status: "announced",
      scheduleAnnouncementMessageId: announcement.message_id,
      updatedAt: new Date(),
    })
    .where(eq(quizTopicsTable.id, topic.id))
    .returning({ id: quizTopicsTable.id });
  if (!recordedTopic) {
    throw new Error("Guruh e’loni test rejasiga biriktirilmadi.");
  }

  try {
    const pinned = await pinTelegramMessage(
      settings.groupChatId,
      announcement.message_id,
    );
    if (!pinned) throw new Error("Telegram e’lonni qadashni tasdiqlamadi.");
  } catch (error) {
    logger.error(
      { err: error, topicId: topic.id, messageId: announcement.message_id },
      "Could not immediately pin scheduled quiz announcement",
    );
    return `Test ${scheduledDate} kuni ${scheduledTime} ga rejalashtirildi va e’lon guruhga yuborildi. Hozir pin qilish bajarilmadi; rejalashtiruvchi belgilangan vaqt kelganda qayta urinadi.`;
  }

  logger.info(
    {
      topicId: topic.id,
      scheduledAt: scheduledAt.toISOString(),
      announcementMessageId: announcement.message_id,
    },
    "Scheduled Telegram quiz",
  );
  return `Tushundim. “${topic.title}” testi ${scheduledDate} kuni ${scheduledTime} (${settings.timezone}) ga rejalashtirildi. E’lon guruhga yuborildi va qadandi; test belgilangan vaqtda boshlanadi.`;
}

async function getQuizPreview(adminTelegramUserId: number, previewId: string) {
  const [preview] = await db
    .select()
    .from(quizPreviewsTable)
    .where(
      and(
        eq(quizPreviewsTable.id, previewId),
        eq(quizPreviewsTable.adminTelegramUserId, String(adminTelegramUserId)),
        gt(quizPreviewsTable.expiresAt, new Date()),
        isNull(quizPreviewsTable.publishedSessionId),
      ),
    )
    .limit(1);
  return preview ? getAdminQuizPreview(preview) : null;
}

async function publishQuizPreview(
  adminTelegramUserId: number,
  previewId: string,
): Promise<{ published: boolean; message: string }> {
  const [preview] = await db
    .select()
    .from(quizPreviewsTable)
    .where(
      and(
        eq(quizPreviewsTable.id, previewId),
        eq(quizPreviewsTable.adminTelegramUserId, String(adminTelegramUserId)),
        gt(quizPreviewsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!preview) {
    return {
      published: false,
      message: "Test preview topilmadi yoki 30 daqiqalik muddati tugagan.",
    };
  }
  if (preview.publishedSessionId) {
    return {
      published: false,
      message: "Bu test preview’i guruhga allaqachon yuborilgan.",
    };
  }

  const settings = await getOrCreateBotSettings();
  if (!settings.groupChatId) {
    return {
      published: false,
      message: "Guruh sozlanmagan. Guruhda /setup buyrug‘ini yuboring.",
    };
  }
  const [topic] = preview.topicId
    ? await db
        .select()
        .from(quizTopicsTable)
        .where(eq(quizTopicsTable.id, preview.topicId))
        .limit(1)
    : [];
  if (!topic) {
    return {
      published: false,
      message: "Test mavzusi topilmadi. Test preview’ini qayta yarating.",
    };
  }

  const result = await createQuizSignup(
    topic,
    preview.scheduledDate,
    {
      ...settings,
      questionCount: preview.questionCount,
      secondsPerQuestion: preview.secondsPerQuestion,
      signupWindowMinutes: 1,
    },
    preview.questions,
    {
      id: preview.id,
      adminTelegramUserId: String(adminTelegramUserId),
      source: preview.source === "ai" ? "ai" : "database",
    },
  );
  if (result.status !== "started") {
    return { published: false, message: getSignupFailureMessage(result) };
  }
  await db
    .delete(quizPreviewsTable)
    .where(
      and(
        eq(quizPreviewsTable.id, previewId),
        eq(quizPreviewsTable.adminTelegramUserId, String(adminTelegramUserId)),
      ),
    );
  logger.info(
    { previewId, sessionId: result.sessionId, adminTelegramUserId },
    "Published approved quiz preview to group",
  );
  return {
    published: true,
    message: `“${preview.topicTitle}” testi uchun 1 daqiqalik qatnashish xabari guruhga yuborildi. Har bir savolga ${preview.secondsPerQuestion} soniya.`,
  };
}

async function cancelQuizPreview(
  adminTelegramUserId: number,
  previewId: string,
): Promise<void> {
  const [preview] = await db
    .select({ topicId: quizPreviewsTable.topicId })
    .from(quizPreviewsTable)
    .where(
      and(
        eq(quizPreviewsTable.id, previewId),
        eq(quizPreviewsTable.adminTelegramUserId, String(adminTelegramUserId)),
        isNull(quizPreviewsTable.publishedSessionId),
      ),
    )
    .limit(1);
  if (!preview) return;
  await db.delete(quizPreviewsTable).where(eq(quizPreviewsTable.id, previewId));
  if (preview.topicId) {
    await db
      .delete(quizTopicsTable)
      .where(
        and(
          eq(quizTopicsTable.id, preview.topicId),
          eq(quizTopicsTable.status, "preview"),
        ),
      );
  }
}

async function attemptScheduledQuizStart(): Promise<void> {
  if (scheduledQuizCheckInProgress) return;
  scheduledQuizCheckInProgress = true;
  let retryTopicId: string | undefined;
  try {
    const settings = await getOrCreateBotSettings();
    if (!settings.enabled || !settings.groupChatId) return;
    const now = new Date();
    const dueTopics = await db
      .select()
      .from(quizTopicsTable)
      .where(
        and(
          sql`${quizTopicsTable.scheduledAt} <= ${now}`,
          or(
            eq(quizTopicsTable.status, "planned"),
            eq(quizTopicsTable.status, "announced"),
            and(
              eq(quizTopicsTable.status, "announcing"),
              lt(
                quizTopicsTable.updatedAt,
                new Date(now.getTime() - 120_000),
              ),
            ),
          ),
        ),
      )
      .orderBy(quizTopicsTable.scheduledAt)
      .limit(10);
    const topic = dueTopics.find(
      (dueTopic) =>
        (scheduledQuizRetryAt.get(dueTopic.id) ?? 0) <= now.getTime(),
    );
    if (!topic || !topic.scheduledAt) return;
    retryTopicId = topic.id;

    let claimedTopic = topic;
    if (topic.status === "planned") {
      const [claimed] = await db
        .update(quizTopicsTable)
        .set({ status: "announcing", updatedAt: now })
        .where(
          and(
            eq(quizTopicsTable.id, topic.id),
            eq(quizTopicsTable.status, "planned"),
          ),
        )
        .returning();
      if (!claimed) return;
      claimedTopic = claimed;
    }

    if (!claimedTopic.scheduleAnnouncementMessageId) {
      const scheduledAt = claimedTopic.scheduledAt;
      if (!scheduledAt) {
        throw new Error("Scheduled quiz has no scheduled start time.");
      }
      const scheduledTime = localClock(
        scheduledAt,
        settings.timezone,
      ).time;
      const announcement = await sendTelegramMessage(
        settings.groupChatId,
        `📢 Assalomu alaykum! Muhtaram Ustozimiz belgilagan rejadagidek, soat ${scheduledTime}da ${claimedTopic.title} bo‘yicha test boshlanadi.`,
      );
      const [updated] = await db
        .update(quizTopicsTable)
        .set({
          status: "announced",
          scheduleAnnouncementMessageId: announcement.message_id,
          updatedAt: new Date(),
        })
        .where(eq(quizTopicsTable.id, claimedTopic.id))
        .returning();
      if (!updated) {
        throw new Error("Scheduled quiz announcement could not be recorded.");
      }
      claimedTopic = updated;
    } else if (claimedTopic.status === "announcing") {
      const [updated] = await db
        .update(quizTopicsTable)
        .set({ status: "announced", updatedAt: new Date() })
        .where(eq(quizTopicsTable.id, claimedTopic.id))
        .returning();
      if (updated) claimedTopic = updated;
    }

    const announcementMessageId =
      claimedTopic.scheduleAnnouncementMessageId;
    if (!announcementMessageId) {
      throw new Error("Scheduled quiz announcement has no Telegram message ID.");
    }
    const pinned = await pinTelegramMessage(
      settings.groupChatId,
      announcementMessageId,
    );
    if (!pinned) {
      throw new Error("Telegram did not pin the scheduled quiz announcement.");
    }

    const [activeSession] = await db
      .select({ id: quizSessionsTable.id })
      .from(quizSessionsTable)
      .where(
        and(
          eq(quizSessionsTable.chatType, "group"),
          sql`(${quizSessionsTable.chatId} = ${settings.groupChatId} OR ${quizSessionsTable.chatId} IS NULL)`,
          inArray(quizSessionsTable.status, [
            "signup",
            "generating",
            "running",
          ]),
        ),
      )
      .limit(1);
    if (activeSession) {
      scheduledQuizRetryAt.set(claimedTopic.id, Date.now() + 60_000);
      return;
    }

    const [recentSession] = await db
      .select({ endedAt: quizSessionsTable.endedAt })
      .from(quizSessionsTable)
      .where(
        and(
          eq(quizSessionsTable.chatType, "group"),
          sql`(${quizSessionsTable.chatId} = ${settings.groupChatId} OR ${quizSessionsTable.chatId} IS NULL)`,
          eq(quizSessionsTable.status, "completed"),
          gt(
            quizSessionsTable.endedAt,
            new Date(Date.now() - GROUP_QUIZ_COOLDOWN_MS),
          ),
        ),
      )
      .orderBy(desc(quizSessionsTable.endedAt))
      .limit(1);
    if (recentSession?.endedAt) {
      scheduledQuizRetryAt.set(
        claimedTopic.id,
        recentSession.endedAt.getTime() + GROUP_QUIZ_COOLDOWN_MS,
      );
      return;
    }

    const difficulty = readTopicDifficulty(claimedTopic.notes);
    const bankQuestions = difficulty
      ? null
      : await getPreparedQuestionSet(
          claimedTopic.id,
          claimedTopic.title,
          settings.questionCount,
        );
    const questionSource = bankQuestions ? "database" : "ai";
    const questions =
      bankQuestions ??
      (await generateQuestionsForSession(
        {
          topicId: claimedTopic.id,
          topicTitle: claimedTopic.title,
          questionCount: settings.questionCount,
        },
        settings,
        [],
        difficulty,
      ));
    const result = await createQuizSignup(
      claimedTopic,
      claimedTopic.scheduledFor,
      settings,
      questions.map(shuffleQuestion),
      undefined,
      questionSource,
      true,
    );
    if (result.status === "started") {
      scheduledQuizRetryAt.delete(claimedTopic.id);
      runtimeStatus.lastError = null;
      logger.info(
        { topicId: claimedTopic.id, sessionId: result.sessionId },
        "Started scheduled Telegram quiz signup",
      );
      return;
    }
    if (result.status === "cooldown") {
      scheduledQuizRetryAt.set(
        claimedTopic.id,
        Date.now() + result.secondsRemaining * 1000,
      );
      return;
    }
    if (result.status === "active") {
      scheduledQuizRetryAt.set(claimedTopic.id, Date.now() + 60_000);
      return;
    }
    scheduledQuizRetryAt.set(claimedTopic.id, Date.now() + 120_000);
    logger.warn(
      { topicId: claimedTopic.id, result: result.status },
      "Scheduled quiz could not start; it will be retried",
    );
  } catch (error) {
    if (retryTopicId) {
      scheduledQuizRetryAt.set(retryTopicId, Date.now() + 120_000);
    }
    runtimeStatus.lastError =
      error instanceof Error ? error.message : "Scheduled quiz start failed.";
    logger.error({ err: error }, "Scheduled quiz start failed");
    if (retryTopicId && process.env.TELEGRAM_BOT_TOKEN) {
      const adminChatId =
        process.env.ADMIN_TELEGRAM_ID?.trim() || "1967786876";
      try {
        await sendTelegramMessage(
          adminChatId,
          `Rejalangan test (${retryTopicId.slice(0, 8)})ni boshlashda xatolik yuz berdi. Bot qayta urinadi.`,
        );
      } catch (notificationError) {
        logger.error(
          { err: notificationError, topicId: retryTopicId },
          "Could not notify admin about scheduled quiz failure",
        );
      }
    }
  } finally {
    scheduledQuizCheckInProgress = false;
  }
}

async function attemptDailyQuizStart(): Promise<void> {
  if (scheduleCheckInProgress) return;
  scheduleCheckInProgress = true;
  try {
    const settings = await getOrCreateBotSettings();
    if (!settings.enabled || !settings.groupChatId) return;

    const now = new Date();
    const clock = localClock(now, settings.timezone);
    if (
      clock.time < settings.dailyTime ||
      settings.lastScheduleAttemptDate === clock.date
    ) {
      return;
    }

    const topic = await findNextPlannedTopic(clock.date);
    if (!topic) {
      await db
        .update(quizBotSettingsTable)
        .set({ lastScheduleAttemptDate: clock.date, updatedAt: now })
        .where(eq(quizBotSettingsTable.id, 1));
      await sendTelegramMessage(
        settings.groupChatId,
        `Bugun (${clock.date}) yoki undan oldin uchun kamida ${settings.questionCount} ta tayyor savoli bor mavzu topilmadi. Test boshlanmadi.`,
      );
      return;
    }

    const result = await createQuizSignup(topic, clock.date, settings);
    if (result.status === "cooldown") return;
    await db
      .update(quizBotSettingsTable)
      .set({ lastScheduleAttemptDate: clock.date, updatedAt: now })
      .where(eq(quizBotSettingsTable.id, 1));
    if (result.status !== "started" && result.status !== "active") {
      await sendTelegramMessage(
        settings.groupChatId,
        getSignupFailureMessage(result),
      );
    }
  } catch (error) {
    runtimeStatus.lastError =
      error instanceof Error ? error.message : "Daily quiz scheduling failed.";
    logger.error({ err: error }, "Daily quiz scheduler failed");
  } finally {
    scheduleCheckInProgress = false;
  }
}

async function expireQuizSignups(): Promise<void> {
  const now = new Date();
  const expired = await db
    .select()
    .from(quizSessionsTable)
    .where(
      and(
        eq(quizSessionsTable.status, "signup"),
        eq(quizSessionsTable.chatType, "group"),
        sql`${quizSessionsTable.signupDeadline} <= ${now}`,
      ),
    );

  for (const session of expired) {
    const settings = await getOrCreateBotSettings();
    const [participantCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(quizSessionParticipantsTable)
      .where(eq(quizSessionParticipantsTable.sessionId, session.id));
    if ((participantCount?.count ?? 0) >= settings.minimumParticipants) {
      const [started] = await db
        .update(quizSessionsTable)
        .set({ status: "generating" })
        .where(
          and(
            eq(quizSessionsTable.id, session.id),
            eq(quizSessionsTable.status, "signup"),
          ),
        )
        .returning({ id: quizSessionsTable.id });
      if (started) void runQuizSession(session.id);
      continue;
    }

    const [cancelled] = await db
      .update(quizSessionsTable)
      .set({ status: "cancelled", endedAt: now })
      .where(
        and(
          eq(quizSessionsTable.id, session.id),
          eq(quizSessionsTable.status, "signup"),
        ),
      )
      .returning({ id: quizSessionsTable.id });
    const chatId = session.chatId ?? settings.groupChatId;
    if (cancelled && chatId) {
      await sendTelegramMessage(
        chatId,
        `Test boshlanmadi: ${settings.minimumParticipants} kishi qatnashishga ulgurmagan.`,
      );
    }
  }
}

async function analyzeAndNotifyQuizPerformance(
  sessionId: string,
  topicTitle: string,
): Promise<void> {
  try {
    const [participants] = await db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(quizSessionParticipantsTable)
      .where(eq(quizSessionParticipantsTable.sessionId, sessionId));
    const rows = await db
      .select({
        id: quizQuestionsTable.id,
        prompt: quizQuestionsTable.prompt,
        options: quizQuestionsTable.options,
        selectedOptionIndex: quizAnswersTable.selectedOptionIndex,
        isCorrect: quizAnswersTable.isCorrect,
      })
      .from(quizQuestionsTable)
      .leftJoin(
        quizAnswersTable,
        eq(quizAnswersTable.questionId, quizQuestionsTable.id),
      )
      .where(eq(quizQuestionsTable.sessionId, sessionId));

    let totalAnswers = 0;
    let correctAnswers = 0;
    const perQuestion = new Map<
      string,
      {
        prompt: string;
        incorrectAnswers: number;
        totalAnswers: number;
        wrongOptions: Map<string, number>;
      }
    >();
    for (const row of rows) {
      let stats = perQuestion.get(row.id);
      if (!stats) {
        stats = {
          prompt: row.prompt,
          incorrectAnswers: 0,
          totalAnswers: 0,
          wrongOptions: new Map(),
        };
        perQuestion.set(row.id, stats);
      }
      if (row.selectedOptionIndex === null) continue;
      totalAnswers += 1;
      stats.totalAnswers += 1;
      if (row.isCorrect) {
        correctAnswers += 1;
      } else {
        stats.incorrectAnswers += 1;
        const wrongOption = row.options[row.selectedOptionIndex];
        if (wrongOption) {
          stats.wrongOptions.set(
            wrongOption,
            (stats.wrongOptions.get(wrongOption) ?? 0) + 1,
          );
        }
      }
    }
    const mostMissedQuestions = [...perQuestion.values()]
      .filter(({ incorrectAnswers }) => incorrectAnswers > 0)
      .sort((a, b) => b.incorrectAnswers - a.incorrectAnswers)
      .slice(0, 3)
      .map((question) => ({
        prompt: question.prompt,
        incorrectAnswers: question.incorrectAnswers,
        totalAnswers: question.totalAnswers,
        commonWrongOptions: [...question.wrongOptions.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([option, count]) => `${option} (${count})`),
      }));
    const overallAccuracyPercent = totalAnswers
      ? Math.round((correctAnswers / totalAnswers) * 100)
      : 0;
    let summary: string;
    if (totalAnswers === 0) {
      summary = `Ishtirokchilar: ${participants?.count ?? 0}. Hozircha javoblar kelib tushmagan.`;
    } else {
      try {
        summary = await summarizeQuizPerformance({
          models: getAiModels(),
          topicTitle,
          participantCount: participants?.count ?? 0,
          overallAccuracyPercent,
          questionCount: perQuestion.size,
          mostMissedQuestions,
        });
      } catch (error) {
        logger.warn(
          { err: error, sessionId },
          "AI quiz analysis failed; sending a calculated summary",
        );
        const mostMissed = mostMissedQuestions[0];
        summary = [
          `${participants?.count ?? 0} qatnashchi, umumiy aniqlik ${overallAccuracyPercent}%.`,
          mostMissed
            ? `Eng ko‘p xato qilingan savol: “${mostMissed.prompt.slice(0, 150)}” (${mostMissed.incorrectAnswers}/${mostMissed.totalAnswers} xato).`
            : "Savollarda takroriy xato kuzatilmadi.",
        ].join(" ");
      }
    }
    latestQuizAnalysisSessionId = sessionId;
    latestQuizAnalysisContext =
      `Test "${topicTitle}" yakunlandi. Qatnashchilar: ${participants?.count ?? 0}; javoblar aniqligi: ${overallAccuracyPercent}%. ${summary}`;

    const adminChatIds = new Set(
      ["1967786876", process.env.ADMIN_TELEGRAM_ID?.trim()].filter(
        (id): id is string => Boolean(id),
      ),
    );
    for (const adminChatId of adminChatIds) {
      await sendTelegramMessage(
        adminChatId,
        `📊 Test tahlili — ${topicTitle}\n${summary}`,
      );
    }
  } catch (error) {
    logger.error(
      { err: error, sessionId },
      "Could not analyze completed quiz results",
    );
  }
}

async function runQuizSession(sessionId: string): Promise<void> {
  if (activeQuizTasks.has(sessionId)) return;
  activeQuizTasks.add(sessionId);
  let targetChatId: string | null = null;
  try {
    const settings = await getOrCreateBotSettings();
    const [session] = await db
      .select()
      .from(quizSessionsTable)
      .where(eq(quizSessionsTable.id, sessionId))
      .limit(1);
    if (!session || session.status !== "generating") return;
    targetChatId = session.chatId ?? settings.groupChatId;
    if (!targetChatId) {
      throw new Error("The quiz destination chat is not configured.");
    }

    const previouslyStored = await db
      .select()
      .from(quizQuestionsTable)
      .where(eq(quizQuestionsTable.sessionId, sessionId))
      .orderBy(quizQuestionsTable.position);
    let questions: PreparedQuizQuestion[];
    let questionSource = session.questionSource;
    if (previouslyStored.length === session.questionCount) {
      questions = previouslyStored;
    } else {
      const [topic] = session.topicId
        ? await db
            .select({ notes: quizTopicsTable.notes })
            .from(quizTopicsTable)
            .where(eq(quizTopicsTable.id, session.topicId))
            .limit(1)
        : [];
      const difficulty = readTopicDifficulty(topic?.notes ?? null);
      const storedQuestionSet = difficulty
        ? null
        : await getPreparedQuestionSet(
            session.topicId,
            session.topicTitle,
            session.questionCount,
          );
      if (storedQuestionSet) {
        questions = storedQuestionSet;
        questionSource = "database";
      } else {
        questions = await generateQuestionsForSession(
          session,
          settings,
          [],
          difficulty,
        );
        questionSource = "ai";
      }
      if (previouslyStored.length > 0) {
        await db
          .delete(quizQuestionsTable)
          .where(eq(quizQuestionsTable.sessionId, sessionId));
      }
    }

    if (previouslyStored.length !== session.questionCount) {
      const preparedQuestions = questions.map(shuffleQuestion);
      await db.insert(quizQuestionsTable).values(
        preparedQuestions.map((question, position) => ({
          sessionId,
          position,
          prompt: question.prompt,
          options: question.options,
          correctOptionIndex: question.correctOptionIndex,
          explanation: question.explanation,
          fingerprint: question.fingerprint,
        })),
      );
    }

    await db
      .update(quizSessionsTable)
      .set({
        status: "running",
        startedAt: new Date(),
        currentQuestionIndex: 0,
        questionSource,
      })
      .where(eq(quizSessionsTable.id, sessionId));

    const sourceLabel =
      questionSource === "ai"
        ? "Darslik va Grammatik aktiv (Nemotron AI)"
        : "Darslik va Grammatik aktiv (tayyor savollar bazasi)";
    await sendTelegramMessage(
      targetChatId,
      `Test boshlandi: ${session.topicTitle}. Har bir savolga ${session.secondsPerQuestion} soniya beriladi.\n📚 Manba: ${sourceLabel}`,
    );

    const storedQuestions = await db
      .select()
      .from(quizQuestionsTable)
      .where(eq(quizQuestionsTable.sessionId, sessionId))
      .orderBy(quizQuestionsTable.position);

    for (const question of storedQuestions) {
      await db
        .update(quizSessionsTable)
        .set({ currentQuestionIndex: question.position })
        .where(eq(quizSessionsTable.id, sessionId));
      const pollOpenedAt = new Date();
      const explanation = question.explanation
        .replace(/(?:manba|source)\s*:\s*.*$/gim, "")
        .replace(/platform architect:.*$/gim, "")
        .replace(/ustoz dilshodbek fayziyev.*$/gim, "")
        .replace(/🎉.*$/gm, "")
        .replace(/─{3,}/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      const sent = await sendTelegramQuizPoll(targetChatId, {
        question: question.prompt,
        options: question.options,
        correctOptionIndex: question.correctOptionIndex,
        explanation,
        openPeriodSeconds: session.secondsPerQuestion,
      });
      activeQuizPolls.set(sent.poll.id, {
        sessionId,
        questionId: question.id,
        correctOptionIndex: question.correctOptionIndex,
      });
      await db
        .update(quizQuestionsTable)
        .set({ telegramMessageId: sent.message_id, pollOpenedAt })
        .where(eq(quizQuestionsTable.id, question.id));

      const pollDeadline =
        sent.poll.close_date !== undefined
          ? sent.poll.close_date * 1000
          : pollOpenedAt.getTime() + session.secondsPerQuestion * 1000;
      const remainingPollTime = pollDeadline - Date.now();
      if (remainingPollTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingPollTime));
      }
      const correctOption = question.options[question.correctOptionIndex];
      await sendTelegramMessage(
        targetChatId,
        `✅ To‘g‘ri javob: ${String.fromCharCode(65 + question.correctOptionIndex)}. ${correctOption}\n\n📘 Izoh: ${question.explanation}`,
      );
    }

    await db
      .update(quizSessionsTable)
      .set({
        status: "completed",
        endedAt: new Date(),
        currentQuestionIndex: -1,
      })
      .where(eq(quizSessionsTable.id, sessionId));
    runtimeStatus.lastError = null;
    try {
      await sendLongTelegramMessage(
        targetChatId,
        await getSessionResultsText(sessionId),
        undefined,
        "HTML",
      );
    } catch (error) {
      runtimeStatus.lastError =
        error instanceof Error ? error.message : "Could not send quiz results.";
      logger.error({ err: error, sessionId }, "Could not send quiz results");
    }
    await analyzeAndNotifyQuizPerformance(sessionId, session.topicTitle);
  } catch (error) {
    runtimeStatus.lastError =
      error instanceof Error ? error.message : "Quiz session failed.";
    logger.error({ err: error, sessionId }, "Telegram quiz session failed");
    try {
      await db
        .update(quizSessionsTable)
        .set({ status: "cancelled", endedAt: new Date() })
        .where(eq(quizSessionsTable.id, sessionId));
      const settings = await getOrCreateBotSettings();
      const chatId = targetChatId ?? settings.groupChatId;
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          "Testni ishonchli savollar bilan davom ettirib bo‘lmadi, shu sabab test bekor qilindi. Admin panelidagi Bot holatini tekshiring.",
        );
      }
    } catch (notifyError) {
      logger.error(
        { err: notifyError, sessionId },
        "Could not report cancelled quiz session",
      );
    }
  } finally {
    for (const [pollId, poll] of activeQuizPolls) {
      if (poll.sessionId === sessionId) activeQuizPolls.delete(pollId);
    }
    activeQuizTasks.delete(sessionId);
  }
}

async function pollTelegramUpdates(): Promise<void> {
  while (runtimeStarted && process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const settings = await getOrCreateBotSettings();
      const updates = await telegramCall<TelegramUpdate[]>("getUpdates", {
        offset: (settings.lastTelegramUpdateId ?? 0) + 1,
        timeout: 25,
        allowed_updates: ["message", "callback_query", "poll_answer"],
      });
      runtimeStatus.polling = true;
      runtimeStatus.telegramConnected = true;
      runtimeStatus.lastError = null;

      for (const update of updates) {
        try {
          await handleUpdate(update);
        } catch (error) {
          logger.error(
            { err: error, updateId: update.update_id },
            "Telegram update failed",
          );
          runtimeStatus.lastError =
            error instanceof Error ? error.message : "Telegram update failed.";
        }
        await db
          .update(quizBotSettingsTable)
          .set({ lastTelegramUpdateId: update.update_id })
          .where(eq(quizBotSettingsTable.id, 1));
      }
    } catch (error) {
      runtimeStatus.polling = false;
      runtimeStatus.telegramConnected = false;
      runtimeStatus.lastError =
        error instanceof Error ? error.message : "Telegram polling failed.";
      logger.error({ err: error }, "Telegram long polling failed");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  runtimeStatus.polling = false;
}

async function cancelInterruptedSessions(): Promise<void> {
  const interrupted = await db
    .update(quizSessionsTable)
    .set({ status: "cancelled", endedAt: new Date() })
    .where(inArray(quizSessionsTable.status, ["generating", "running"]))
    .returning({
      title: quizSessionsTable.topicTitle,
      date: quizSessionsTable.scheduledDate,
      chatId: quizSessionsTable.chatId,
      chatType: quizSessionsTable.chatType,
    });
  if (interrupted.length === 0) return;

  logger.warn(
    { count: interrupted.length },
    "Cancelled quiz sessions interrupted by a previous process",
  );
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const settings = await getOrCreateBotSettings();
  const groupSessions = interrupted.filter(
    ({ chatType }) => chatType === "group",
  );
  if (groupSessions.length > 0) {
    const groupChatId = settings.groupChatId;
    if (groupChatId) {
      await sendLongTelegramMessage(
        groupChatId,
        [
          "Server qayta ishga tushgani sabab tugallanmagan guruh testlari bekor qilindi:",
          ...groupSessions.map(({ title, date }) => `• ${date} — ${title}`),
        ].join("\n"),
      );
    }
  }
  for (const session of interrupted) {
    if (session.chatType !== "private" || !session.chatId) continue;
    await sendTelegramMessage(
      session.chatId,
      `Server qayta ishga tushgani sabab “${session.title}” shaxsiy testi bekor qilindi. /menu orqali qaytadan boshlashingiz mumkin.`,
    );
  }
}

async function registerTelegramCommands(): Promise<void> {
  const description = [
    "🤖 Dwiso — Nemis tili AI Test Platformasi",
    "🎓 Ustoz Dilshodbek Fayziyev o'quv kursi uchun maxsus",
    "💡 Loyiha me'mori: Bilol Muzaffarov",
  ].join("\n");
  try {
    await telegramCall<boolean>("setMyDescription", { description });
  } catch (error) {
    logger.warn({ err: error }, "Could not update Telegram bot description");
  }

  const studentCommands = [
    { command: "start", description: "Botni boshlash" },
    { command: "menu", description: "Menyuni ochish" },
    { command: "yordam", description: "Yordam olish" },
  ];
  const adminCommands = [
    { command: "start", description: "Admin menyusini ochish" },
    { command: "menu", description: "Admin menyusini ochish" },
    { command: "natija", description: "Test natijalarini ko‘rish" },
    { command: "reyting", description: "Umumiy reytingni ko‘rish" },
    { command: "ishtirokchi", description: "Ishtirokchi natijalarini ko‘rish" },
    { command: "savollar", description: "Test savollari va javoblari" },
    { command: "tarix", description: "Oxirgi testlar tarixi" },
    { command: "mavzu", description: "Test mavzusini qo‘shish" },
    { command: "mavzular", description: "Rejalashtirilgan mavzular" },
    { command: "mavzu_ochir", description: "Rejadagi mavzuni o‘chirish" },
    { command: "rejalash", description: "Test mavzusi va vaqtini rejalashtirish" },
    { command: "test_hozir", description: "Test yozilishini boshlash" },
    { command: "sozlamalar", description: "Bot sozlamalarini ko‘rish" },
    { command: "vaqt", description: "Kunlik test vaqtini belgilash" },
    { command: "savol_soni", description: "Savollar sonini belgilash" },
    { command: "minimum", description: "Qatnashchilar minimumi" },
    { command: "soniya", description: "Savol vaqtini belgilash" },
    { command: "royxat", description: "Yozilish vaqtini belgilash" },
    { command: "toxtat", description: "Avtomatik testlarni to‘xtatish" },
    { command: "davom", description: "Avtomatik testlarni davom ettirish" },
    { command: "kitob", description: "Kitob holatini ko‘rish" },
    { command: "offset", description: "Kitob betlari siljishini belgilash" },
    {
      command: "kitob_tozalash",
      description: "Saqlangan kitob matnini o‘chirish",
    },
    { command: "yordam", description: "Admin buyruqlari haqida" },
  ];
  const adminIds = [
    ...new Set(
      ["1967786876", process.env.ADMIN_TELEGRAM_ID?.trim()].filter(
        (telegramId): telegramId is string => Boolean(telegramId),
      ),
    ),
  ];
  try {
    await telegramCall<boolean>("setMyCommands", {
      scope: { type: "all_private_chats" },
      commands: studentCommands,
    });
    for (const adminId of adminIds) {
      await telegramCall<boolean>("setMyCommands", {
        scope: { type: "chat", chat_id: adminId },
        commands: adminCommands,
      });
    }
  } catch (error) {
    logger.warn({ err: error }, "Could not register Telegram bot commands");
  }
}

export function startQuizBotRuntime(): void {
  if (runtimeStarted) return;
  runtimeStarted = true;

  void (async () => {
    try {
      await cancelInterruptedSessions();
    } catch (error) {
      runtimeStatus.lastError =
        error instanceof Error
          ? error.message
          : "Interrupted session recovery failed.";
      logger.error(
        { err: error },
        "Could not recover interrupted quiz sessions",
      );
    }

    if (!process.env.TELEGRAM_BOT_TOKEN) {
      runtimeStatus.lastError = "Telegram bot token is not configured.";
      logger.warn(
        "Telegram bot polling is disabled because its token is missing",
      );
      return;
    }

    await registerTelegramCommands();
    try {
      const bot = await getTelegramBotInfo();
      runtimeStatus.telegramConnected = true;
      runtimeStatus.botUsername = bot.username;
      logger.info({ botUsername: bot.username }, "Telegram bot connected");
    } catch (error) {
      runtimeStatus.lastError =
        error instanceof Error ? error.message : "Telegram connection failed.";
      logger.error({ err: error }, "Telegram startup check failed");
    }
    void pollTelegramUpdates();
    const timer = setInterval(() => {
      void attemptScheduledQuizStart();
      void attemptDailyQuizStart();
      void expireQuizSignups().catch((error: unknown) => {
        logger.error({ err: error }, "Quiz signup expiration check failed");
      });
    }, 20_000);
    timer.unref();
  })();
}

export async function testTelegramBotConnection(): Promise<{
  telegramConnected: boolean;
  botUsername: string | null;
  groupConnected: boolean;
  message: string;
}> {
  const settings = await getOrCreateBotSettings();
  const bot = await getTelegramBotInfo();
  let groupConnected = false;
  if (settings.groupChatId) {
    const membership = await telegramCall<{ status: string }>("getChatMember", {
      chat_id: settings.groupChatId,
      user_id: bot.id,
    });
    groupConnected =
      membership.status === "administrator" || membership.status === "creator";
  }
  return {
    telegramConnected: true,
    botUsername: bot.username,
    groupConnected,
    message: groupConnected
      ? "Telegram bot va guruh administrator huquqi bilan ulangan."
      : settings.groupChatId
        ? "Bot tokeni ishlaydi, ammo bot sozlangan guruhda administrator emas."
        : "Bot tokeni ishlaydi. Guruh ichida /setup yuborib guruhni ulang.",
  };
}
