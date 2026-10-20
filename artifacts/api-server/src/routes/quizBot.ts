import { randomBytes } from "node:crypto";
import { getAuth } from "@clerk/express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  sql,
} from "drizzle-orm";
import { Router, type Request, type RequestHandler, type Response } from "express";
import {
  CreateQuizTopicBody,
  CreateQuizTopicResponse,
  CreateTelegramAdminLinkCodeResponse,
  DeleteQuizTopicParams,
  GetQuizParticipantParams,
  GetQuizParticipantResponse,
  GetQuizSessionParams,
  GetQuizSessionResponse,
  GetQuizBotAccessResponse,
  GetQuizBotDashboardResponse,
  GetQuizBotSettingsResponse,
  GetTelegramBotStatusResponse,
  GetQuizLeaderboardResponse,
  ListQuizParticipantsResponse,
  ListQuizSessionsQueryParams,
  ListQuizSessionsResponse,
  ListQuizTopicsResponse,
  QuestionAnswer,
  QuizParticipant as QuizParticipantDto,
  QuizParticipantDetail,
  QuizQuestionDetail,
  QuizSessionDetail,
  QuizSessionSummary,
  SessionParticipantResult,
  TestTelegramBotConnectionResponse,
  UpdateQuizBotSettingsBody,
  UpdateQuizBotSettingsResponse,
  UpdateQuizTopicBody,
  UpdateQuizTopicParams,
  UpdateQuizTopicResponse,
} from "@workspace/api-zod";
import {
  db,
  quizAnswersTable,
  quizBotAdminsTable,
  quizBotSettingsTable,
  quizParticipantsTable,
  quizQuestionsTable,
  quizSessionParticipantsTable,
  quizSessionsTable,
  quizTopicsTable,
  telegramAdminLinkCodesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  getOrCreateBotSettings,
  getQuizBotRuntimeStatus,
  testTelegramBotConnection,
} from "../lib/quizBot/runtime";

const router = Router();

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function handler(
  action: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return async (req, res) => {
    try {
      await action(req, res);
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof Error && error.name === "ZodError") {
        res.status(400).json({ error: error.message });
        return;
      }
      logger.error({ err: error, route: req.path }, "Quiz bot API request failed");
      res.status(500).json({ error: "So‘rovni bajarib bo‘lmadi." });
    }
  };
}

const requireSignIn: RequestHandler = (req, res, next) => {
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "Avval tizimga kiring." });
    return;
  }
  next();
};

const requireAdmin: RequestHandler = async (req, res, next) => {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) {
    res.status(401).json({ error: "Avval tizimga kiring." });
    return;
  }
  const [admin] = await db
    .select({ telegramUserId: quizBotAdminsTable.telegramUserId })
    .from(quizBotAdminsTable)
    .where(eq(quizBotAdminsTable.clerkUserId, clerkUserId))
    .limit(1);
  if (!admin) {
    res.status(403).json({ error: "Bu bo‘lim faqat ulangan Telegram adminlari uchun." });
    return;
  }
  res.locals.telegramAdminId = admin.telegramUserId;
  next();
};

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatParticipantName(
  participant:
    | { firstName: string; lastName: string | null; username: string | null }
    | undefined,
): string {
  if (!participant) return "Noma’lum ishtirokchi";
  const name = [participant.firstName, participant.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || participant.username || "Telegram ishtirokchisi";
}

async function analyzeSession(session: typeof quizSessionsTable.$inferSelect): Promise<{
  summary: QuizSessionSummary;
  participants: SessionParticipantResult[];
  questions: QuizQuestionDetail[];
}> {
  const members = await db
    .select({
      telegramUserId: quizSessionParticipantsTable.telegramUserId,
      firstName: quizParticipantsTable.firstName,
      lastName: quizParticipantsTable.lastName,
      username: quizParticipantsTable.username,
    })
    .from(quizSessionParticipantsTable)
    .innerJoin(
      quizParticipantsTable,
      eq(
        quizSessionParticipantsTable.telegramUserId,
        quizParticipantsTable.telegramUserId,
      ),
    )
    .where(eq(quizSessionParticipantsTable.sessionId, session.id));

  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.sessionId, session.id))
    .orderBy(asc(quizQuestionsTable.position));
  const answers = await db
    .select()
    .from(quizAnswersTable)
    .where(eq(quizAnswersTable.sessionId, session.id));

  const answerByMemberAndQuestion = new Map(
    answers.map((answer) => [
      `${answer.telegramUserId}:${answer.questionId}`,
      answer,
    ]),
  );
  const resultByMember = members.map((member) => {
    const memberAnswers = answers.filter(
      (answer) => answer.telegramUserId === member.telegramUserId,
    );
    const correctAnswers = memberAnswers.filter((answer) => answer.isCorrect).length;
    const incorrectAnswers = memberAnswers.length - correctAnswers;
    const unanswered = Math.max(0, questions.length - memberAnswers.length);
    const scorePercent =
      questions.length > 0 ? roundPercent((correctAnswers / questions.length) * 100) : 0;
    return {
      telegramUserId: member.telegramUserId,
      displayName: formatParticipantName(member),
      username: member.username,
      correctAnswers,
      incorrectAnswers,
      unanswered,
      scorePercent,
    } satisfies SessionParticipantResult;
  });

  const questionDetails = questions.map((question) => {
    const questionAnswers = members.map((member) => {
      const answer = answerByMemberAndQuestion.get(
        `${member.telegramUserId}:${question.id}`,
      );
      return {
        telegramUserId: member.telegramUserId,
        displayName: formatParticipantName(member),
        selectedOptionIndex: answer?.selectedOptionIndex ?? null,
        isCorrect: answer?.isCorrect ?? null,
      } satisfies QuestionAnswer;
    });
    return {
      id: question.id,
      position: question.position,
      prompt: question.prompt,
      options: question.options,
      correctOptionIndex: question.correctOptionIndex,
      explanation: question.explanation,
      answers: questionAnswers,
    } satisfies QuizQuestionDetail;
  });

  return {
    summary: {
      id: session.id,
      topicTitle: session.topicTitle,
      scheduledDate: new Date(`${session.scheduledDate}T00:00:00.000Z`),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      status: session.status as QuizSessionSummary["status"],
      participantCount: members.length,
      questionCount: questions.length,
      averageScorePercent:
        resultByMember.length > 0
          ? roundPercent(
              resultByMember.reduce((sum, participant) => sum + participant.scorePercent, 0) /
                resultByMember.length,
            )
          : 0,
    },
    participants: resultByMember,
    questions: questionDetails,
  };
}

type AggregateData = {
  participant: typeof quizParticipantsTable.$inferSelect;
  history: Array<{
    session: typeof quizSessionsTable.$inferSelect;
    correct: number;
    incorrect: number;
    unanswered: number;
    scorePercent: number;
  }>;
};

async function getAllParticipantAggregates(): Promise<AggregateData[]> {
  const [participants, sessions] = await Promise.all([
    db.select().from(quizParticipantsTable),
    db
      .select()
      .from(quizSessionsTable)
      .where(eq(quizSessionsTable.status, "completed"))
      .orderBy(desc(quizSessionsTable.scheduledDate)),
  ]);
  if (sessions.length === 0) {
    return participants.map((participant) => ({
      participant,
      history: [],
    }));
  }
  const sessionIds = sessions.map((session) => session.id);
  const [members, questionRows, answers] = await Promise.all([
    db
      .select({
        sessionId: quizSessionParticipantsTable.sessionId,
        telegramUserId: quizSessionParticipantsTable.telegramUserId,
      })
      .from(quizSessionParticipantsTable)
      .where(inArray(quizSessionParticipantsTable.sessionId, sessionIds)),
    db
      .select({ sessionId: quizQuestionsTable.sessionId })
      .from(quizQuestionsTable)
      .where(inArray(quizQuestionsTable.sessionId, sessionIds)),
    db
      .select({
        sessionId: quizAnswersTable.sessionId,
        telegramUserId: quizAnswersTable.telegramUserId,
        isCorrect: quizAnswersTable.isCorrect,
      })
      .from(quizAnswersTable)
      .where(inArray(quizAnswersTable.sessionId, sessionIds)),
  ]);

  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const questionsBySession = new Map<string, number>();
  for (const question of questionRows) {
    questionsBySession.set(
      question.sessionId,
      (questionsBySession.get(question.sessionId) ?? 0) + 1,
    );
  }
  const membersBySessionAndUser = new Set(
    members.map((member) => `${member.sessionId}:${member.telegramUserId}`),
  );
  const answersBySessionAndUser = new Map<
    string,
    { answered: number; correct: number }
  >();
  for (const answer of answers) {
    const key = `${answer.sessionId}:${answer.telegramUserId}`;
    const stats = answersBySessionAndUser.get(key) ?? { answered: 0, correct: 0 };
    stats.answered += 1;
    if (answer.isCorrect) stats.correct += 1;
    answersBySessionAndUser.set(key, stats);
  }

  return participants.map((participant) => {
    const history = sessions
      .filter((session) =>
        membersBySessionAndUser.has(`${session.id}:${participant.telegramUserId}`),
      )
      .map((session) => {
        const questionsCount = questionsBySession.get(session.id) ?? 0;
        const answerStats =
          answersBySessionAndUser.get(`${session.id}:${participant.telegramUserId}`) ??
          { answered: 0, correct: 0 };
        const incorrect = answerStats.answered - answerStats.correct;
        return {
          session,
          correct: answerStats.correct,
          incorrect,
          unanswered: Math.max(0, questionsCount - answerStats.answered),
          scorePercent:
            questionsCount > 0
              ? roundPercent((answerStats.correct / questionsCount) * 100)
              : 0,
        };
      });
    return {
      participant,
      history: history.filter((result) => (questionsBySession.get(result.session.id) ?? 0) > 0),
    };
  });
}

function participantView(data: AggregateData): QuizParticipantDto {
  const totalCorrect = data.history.reduce((sum, result) => sum + result.correct, 0);
  const totalIncorrect = data.history.reduce((sum, result) => sum + result.incorrect, 0);
  const averageScorePercent =
    data.history.length > 0
      ? roundPercent(
          data.history.reduce((sum, result) => sum + result.scorePercent, 0) /
            data.history.length,
        )
      : 0;
  return {
    telegramUserId: data.participant.telegramUserId,
    displayName: formatParticipantName(data.participant),
    username: data.participant.username,
    quizzesPlayed: data.history.length,
    correctAnswers: totalCorrect,
    incorrectAnswers: totalIncorrect,
    averageScorePercent,
    lastSeenAt: data.participant.lastSeenAt,
  };
}

function leaderboardViews(data: AggregateData[]): Array<QuizParticipantDto & { rank: number }> {
  const sorted = data
    .map((entry) => ({ ...participantView(entry), played: entry.history.length }))
    .filter((entry) => entry.played > 0)
    .sort(
      (left, right) =>
        right.averageScorePercent - left.averageScorePercent ||
        right.quizzesPlayed - left.quizzesPlayed ||
        right.correctAnswers - left.correctAnswers ||
        left.displayName.localeCompare(right.displayName),
    );
  return sorted.map(({ played: _played, ...entry }, index) => ({
    ...entry,
    rank: index + 1,
  }));
}

function nextQuizAt(date: string, time: string, timezone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const targetUtcGuess = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const localParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(targetUtcGuess));
  const local = Object.fromEntries(
    localParts.map(({ type, value }) => [type, Number(value)]),
  );
  const representedAsUtc = Date.UTC(
    local.year!,
    local.month! - 1,
    local.day!,
    local.hour!,
    local.minute!,
  );
  return new Date(targetUtcGuess + (targetUtcGuess - representedAsUtc)).toISOString();
}

router.get(
  "/quiz-bot/access",
  requireSignIn,
  handler(async (req, res) => {
    const clerkUserId = getAuth(req).userId!;
    const settings = await getOrCreateBotSettings();
    const [admin] = await db
      .select({ telegramUserId: quizBotAdminsTable.telegramUserId })
      .from(quizBotAdminsTable)
      .where(eq(quizBotAdminsTable.clerkUserId, clerkUserId))
      .limit(1);
    const data = {
      isAdmin: Boolean(admin),
      isTelegramLinked: Boolean(admin),
      telegramUserId: admin?.telegramUserId ?? null,
      groupSetupCompleted: Boolean(settings.groupChatId),
    };
    res.json(GetQuizBotAccessResponse.parse(data));
  }),
);

router.post(
  "/quiz-bot/access/link-code",
  requireSignIn,
  handler(async (req, res) => {
    const clerkUserId = getAuth(req).userId!;
    const [alreadyLinked] = await db
      .select({ telegramUserId: quizBotAdminsTable.telegramUserId })
      .from(quizBotAdminsTable)
      .where(eq(quizBotAdminsTable.clerkUserId, clerkUserId))
      .limit(1);
    if (alreadyLinked) {
      throw new ApiError(409, "Bu web akkaunti Telegram admini bilan allaqachon ulangan.");
    }

    const code = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await db
      .delete(telegramAdminLinkCodesTable)
      .where(eq(telegramAdminLinkCodesTable.clerkUserId, clerkUserId));
    await db.insert(telegramAdminLinkCodesTable).values({
      code,
      clerkUserId,
      expiresAt,
    });
    const data = CreateTelegramAdminLinkCodeResponse.parse({
      code,
      expiresAt: expiresAt.toISOString(),
    });
    res.status(201).json(data);
  }),
);

router.use("/quiz-bot", requireSignIn, requireAdmin);

router.get(
  "/quiz-bot/dashboard",
  handler(async (_req, res) => {
    const settings = await getOrCreateBotSettings();
    const [sessions, totalSessions, totalParticipants, aggregates, upcomingTopics] =
      await Promise.all([
        db
          .select()
          .from(quizSessionsTable)
          .orderBy(desc(quizSessionsTable.scheduledDate))
          .limit(5),
        db.select({ value: count() }).from(quizSessionsTable),
        db.select({ value: count() }).from(quizParticipantsTable),
        getAllParticipantAggregates(),
        db
          .select()
          .from(quizTopicsTable)
          .where(eq(quizTopicsTable.status, "planned"))
          .orderBy(asc(quizTopicsTable.scheduledFor))
          .limit(1),
      ]);
    const summaries = await Promise.all(
      sessions.map(async (session) => (await analyzeSession(session)).summary),
    );
    const scoreValues = aggregates
      .flatMap((aggregate) => aggregate.history.map((item) => item.scorePercent));
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const quizzesThisWeek = await db
      .select({ value: count() })
      .from(quizSessionsTable)
      .where(gte(quizSessionsTable.scheduledDate, weekAgo));
    const nextTopic = upcomingTopics[0];
    const payload = {
      totalSessions: totalSessions[0]?.value ?? 0,
      totalParticipants: totalParticipants[0]?.value ?? 0,
      averageScorePercent:
        scoreValues.length > 0
          ? roundPercent(scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length)
          : 0,
      quizzesThisWeek: quizzesThisWeek[0]?.value ?? 0,
      nextQuizAt: nextTopic
        ? nextQuizAt(nextTopic.scheduledFor, settings.dailyTime, settings.timezone)
        : null,
      nextTopicTitle: nextTopic?.title ?? null,
      recentSessions: summaries,
    };
    res.json(GetQuizBotDashboardResponse.parse(payload));
  }),
);

router.get(
  "/quiz-bot/settings",
  handler(async (_req, res) => {
    const settings = await getOrCreateBotSettings();
    const [adminCount] = await db
      .select({ value: count() })
      .from(quizBotAdminsTable)
      .where(sql`${quizBotAdminsTable.clerkUserId} IS NOT NULL`);
    res.json(
      GetQuizBotSettingsResponse.parse({
          groupChatId: settings.groupChatId,
          dailyTime: settings.dailyTime,
          timezone: settings.timezone,
          minimumParticipants: settings.minimumParticipants,
          signupWindowMinutes: settings.signupWindowMinutes,
          questionCount: settings.questionCount,
          secondsPerQuestion: settings.secondsPerQuestion,
          enabled: settings.enabled,
          bookTitle: settings.bookTitle,
          aiModel: settings.aiModel,
          linkedAdminCount: adminCount?.value ?? 0,
        }),
    );
  }),
);

router.patch(
  "/quiz-bot/settings",
  handler(async (req, res) => {
    const body = UpdateQuizBotSettingsBody.parse(req.body);
    if (
      ![5, 10, 15, 20, 30].includes(body.questionCount) ||
      ![15, 20, 25, 30].includes(body.secondsPerQuestion)
    ) {
      throw new ApiError(
        400,
        "Savollar soni yoki savol vaqti ruxsat etilgan variantlardan biri bo‘lishi kerak.",
      );
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
    } catch {
      throw new ApiError(400, "IANA vaqt mintaqasi noto‘g‘ri.");
    }
    const current = await getOrCreateBotSettings();
    const groupChatId = Object.hasOwn(body, "groupChatId")
      ? body.groupChatId
      : current.groupChatId;
    const [updated] = await db
      .update(quizBotSettingsTable)
      .set({
        groupChatId,
        dailyTime: body.dailyTime,
        timezone: body.timezone,
        minimumParticipants: body.minimumParticipants,
        signupWindowMinutes: body.signupWindowMinutes,
        questionCount: body.questionCount,
        secondsPerQuestion: body.secondsPerQuestion,
        enabled: body.enabled,
        bookTitle: body.bookTitle,
        lastScheduleAttemptDate: null,
        updatedAt: new Date(),
      })
      .where(eq(quizBotSettingsTable.id, 1))
      .returning();
    const [adminCount] = await db
      .select({ value: count() })
      .from(quizBotAdminsTable)
      .where(sql`${quizBotAdminsTable.clerkUserId} IS NOT NULL`);
    res.json(
      UpdateQuizBotSettingsResponse.parse({
          groupChatId: updated?.groupChatId ?? null,
          dailyTime: updated?.dailyTime,
          timezone: updated?.timezone,
          minimumParticipants: updated?.minimumParticipants,
          signupWindowMinutes: updated?.signupWindowMinutes,
          questionCount: updated?.questionCount,
          secondsPerQuestion: updated?.secondsPerQuestion,
          enabled: updated?.enabled,
          bookTitle: updated?.bookTitle,
          aiModel: updated?.aiModel,
          linkedAdminCount: adminCount?.value ?? 0,
        }),
    );
  }),
);

router.get(
  "/quiz-bot/bot/status",
  handler(async (_req, res) => {
    const settings = await getOrCreateBotSettings();
    const runtime = getQuizBotRuntimeStatus();
    let groupConnected = false;
    let lastError = runtime.lastError;
    if (runtime.telegramTokenConfigured) {
      try {
        const test = await testTelegramBotConnection();
        groupConnected = test.groupConnected;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Telegram holatini tekshirib bo‘lmadi.";
      }
    }
    res.json(
      GetTelegramBotStatusResponse.parse(
        {
          telegramTokenConfigured: runtime.telegramTokenConfigured,
          telegramConnected: runtime.telegramConnected,
          botUsername: runtime.botUsername,
          groupConnected,
          polling: runtime.polling,
          openRouterKeyConfigured: runtime.openRouterKeyConfigured,
          aiModel: settings.aiModel,
          lastError,
        },
      ),
    );
  }),
);

router.post(
  "/quiz-bot/bot/test",
  handler(async (_req, res) => {
    try {
      const result = await testTelegramBotConnection();
      res.json(TestTelegramBotConnectionResponse.parse(result));
    } catch (error) {
      const result = {
        telegramConnected: false,
        botUsername: null,
        groupConnected: false,
        message: error instanceof Error ? error.message : "Telegram bot bilan aloqa yo‘q.",
      };
      res.json(TestTelegramBotConnectionResponse.parse(result));
    }
  }),
);

router.get(
  "/quiz-bot/topics",
  handler(async (_req, res) => {
    const topics = await db
      .select({
        id: quizTopicsTable.id,
        title: quizTopicsTable.title,
        bookUnit: quizTopicsTable.bookUnit,
        bookPages: quizTopicsTable.bookPages,
        notes: quizTopicsTable.notes,
        scheduledFor: quizTopicsTable.scheduledFor,
        scheduledAt: quizTopicsTable.scheduledAt,
        status: quizTopicsTable.status,
        createdAt: quizTopicsTable.createdAt,
      })
      .from(quizTopicsTable)
      .orderBy(asc(quizTopicsTable.scheduledFor), desc(quizTopicsTable.createdAt));
    res.json(ListQuizTopicsResponse.parse(topics));
  }),
);

router.post(
  "/quiz-bot/topics",
  handler(async (req, res) => {
    const body = CreateQuizTopicBody.parse(req.body);
    const scheduledFor = dateOnly(body.scheduledFor);
    const [conflict] = await db
      .select({ id: quizTopicsTable.id })
      .from(quizTopicsTable)
      .where(
        and(
          eq(quizTopicsTable.scheduledFor, scheduledFor),
          eq(quizTopicsTable.status, "planned"),
        ),
      )
      .limit(1);
    if (conflict) {
      throw new ApiError(409, "Bu kunga allaqachon mavzu rejalashtirilgan.");
    }
    const [topic] = await db
      .insert(quizTopicsTable)
      .values({
        title: body.title,
        bookUnit: body.bookUnit ?? null,
        bookPages: body.bookPages ?? null,
        notes: body.notes ?? null,
        scheduledFor,
      })
      .returning();
    res.status(201).json(CreateQuizTopicResponse.parse(topic));
  }),
);

router.patch(
  "/quiz-bot/topics/:topicId",
  handler(async (req, res) => {
    const { topicId } = UpdateQuizTopicParams.parse(req.params);
    const body = UpdateQuizTopicBody.parse(req.body);
    const [current] = await db
      .select()
      .from(quizTopicsTable)
      .where(eq(quizTopicsTable.id, topicId))
      .limit(1);
    if (!current) throw new ApiError(404, "Mavzu topilmadi.");
    const nextStatus = body.status ?? current.status;
    const nextScheduledFor = body.scheduledFor
      ? dateOnly(body.scheduledFor)
      : current.scheduledFor;
    if (nextStatus === "planned") {
      const [conflict] = await db
        .select({ id: quizTopicsTable.id })
        .from(quizTopicsTable)
        .where(
          and(
            eq(quizTopicsTable.scheduledFor, nextScheduledFor),
            eq(quizTopicsTable.status, "planned"),
            sql`${quizTopicsTable.id} <> ${topicId}`,
          ),
        )
        .limit(1);
      if (conflict) {
        throw new ApiError(409, "Bu kunga allaqachon boshqa mavzu rejalashtirilgan.");
      }
    }
    const { scheduledFor, ...updateFields } = body;
    const [topic] = await db
      .update(quizTopicsTable)
      .set({
        ...updateFields,
        ...(scheduledFor ? { scheduledFor: dateOnly(scheduledFor) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(quizTopicsTable.id, topicId))
      .returning({
        id: quizTopicsTable.id,
        title: quizTopicsTable.title,
        bookUnit: quizTopicsTable.bookUnit,
        bookPages: quizTopicsTable.bookPages,
        notes: quizTopicsTable.notes,
        scheduledFor: quizTopicsTable.scheduledFor,
        scheduledAt: quizTopicsTable.scheduledAt,
        status: quizTopicsTable.status,
        createdAt: quizTopicsTable.createdAt,
      });
    if (!topic) throw new ApiError(404, "Mavzu topilmadi.");
    res.json(UpdateQuizTopicResponse.parse(topic));
  }),
);

router.delete(
  "/quiz-bot/topics/:topicId",
  handler(async (req, res) => {
    const { topicId } = DeleteQuizTopicParams.parse(req.params);
    const deleted = await db
      .delete(quizTopicsTable)
      .where(eq(quizTopicsTable.id, topicId))
      .returning({ id: quizTopicsTable.id });
    if (deleted.length === 0) throw new ApiError(404, "Mavzu topilmadi.");
    res.status(204).end();
  }),
);

router.get(
  "/quiz-bot/history",
  handler(async (req, res) => {
    const { limit } = ListQuizSessionsQueryParams.parse(req.query);
    const sessions = await db
      .select()
      .from(quizSessionsTable)
      .orderBy(desc(quizSessionsTable.scheduledDate))
      .limit(limit);
    const summaries = await Promise.all(
      sessions.map(async (session) => (await analyzeSession(session)).summary),
    );
    res.json(ListQuizSessionsResponse.parse(summaries));
  }),
);

router.get(
  "/quiz-bot/history/:sessionId",
  handler(async (req, res) => {
    const { sessionId } = GetQuizSessionParams.parse(req.params);
    const [session] = await db
      .select()
      .from(quizSessionsTable)
      .where(eq(quizSessionsTable.id, sessionId))
      .limit(1);
    if (!session) throw new ApiError(404, "Test topilmadi.");
    const data = await analyzeSession(session);
    const detail: QuizSessionDetail = {
      session: data.summary,
      participants: data.participants,
      questions: data.questions,
    };
    res.json(GetQuizSessionResponse.parse(detail));
  }),
);

router.get(
  "/quiz-bot/participants",
  handler(async (_req, res) => {
    const aggregates = await getAllParticipantAggregates();
    const participants = aggregates.map(participantView);
    res.json(ListQuizParticipantsResponse.parse(participants));
  }),
);

router.get(
  "/quiz-bot/participants/:telegramUserId",
  handler(async (req, res) => {
    const { telegramUserId } = GetQuizParticipantParams.parse(req.params);
    const [aggregate] = (await getAllParticipantAggregates()).filter(
      (entry) => entry.participant.telegramUserId === telegramUserId,
    );
    if (!aggregate) throw new ApiError(404, "Ishtirokchi topilmadi.");
    const data: QuizParticipantDetail = {
      participant: participantView(aggregate),
      history: aggregate.history.map((result) => ({
        sessionId: result.session.id,
        topicTitle: result.session.topicTitle,
        scheduledDate: new Date(`${result.session.scheduledDate}T00:00:00.000Z`),
        correctAnswers: result.correct,
        incorrectAnswers: result.incorrect,
        unanswered: result.unanswered,
        scorePercent: result.scorePercent,
      })),
    };
    res.json(GetQuizParticipantResponse.parse(data));
  }),
);

router.get(
  "/quiz-bot/leaderboard",
  handler(async (_req, res) => {
    const leaderboard = leaderboardViews(await getAllParticipantAggregates());
    res.json(GetQuizLeaderboardResponse.parse(leaderboard));
  }),
);

export default router;
