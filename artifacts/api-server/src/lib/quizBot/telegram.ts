export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
};

type TelegramQuizPollMessage = TelegramMessage & {
  poll: { id: string; close_date?: number };
};

type TelegramApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }
  return token;
}

export async function telegramCall<T>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const token = getBotToken();
  const timeoutSeconds =
    typeof payload.timeout === "number" ? payload.timeout : 8;
  let response: Response;

  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout((timeoutSeconds + 8) * 1000),
    });
  } catch (error) {
    if (error instanceof Error && error.name.includes("Timeout")) {
      throw new Error(`Telegram ${method} request timed out.`);
    }
    throw new Error(`Could not reach the Telegram ${method} endpoint.`);
  }

  let body: TelegramApiEnvelope<T>;
  try {
    body = (await response.json()) as TelegramApiEnvelope<T>;
  } catch {
    throw new Error(`Telegram ${method} returned an unreadable response.`);
  }

  if (!response.ok || !body.ok || body.result === undefined) {
    throw new Error(
      body.description?.slice(0, 300) ?? `Telegram ${method} request failed.`,
    );
  }
  return body.result;
}

export function getTelegramBotInfo(): Promise<{
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}> {
  return telegramCall("getMe", {});
}

export async function isTelegramGroupAdmin(
  chatId: string,
  userId: number,
): Promise<boolean> {
  const member = await telegramCall<{ status: string }>("getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
  return member.status === "creator" || member.status === "administrator";
}

export function sendTelegramMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>,
  parseMode?: "HTML",
): Promise<TelegramMessage> {
  return telegramCall("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
    disable_web_page_preview: true,
  });
}

export function editTelegramMessage(
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<TelegramMessage> {
  return telegramCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    disable_web_page_preview: true,
  });
}

export function sendTelegramQuizPoll(
  chatId: string,
  poll: {
    question: string;
    options: string[];
    correctOptionIndex: number;
    explanation: string;
    openPeriodSeconds: number;
  },
): Promise<TelegramQuizPollMessage> {
  return telegramCall("sendPoll", {
    chat_id: chatId,
    question: poll.question,
    options: poll.options.map((text) => ({ text })),
    type: "quiz",
    is_anonymous: false,
    correct_option_id: poll.correctOptionIndex,
    explanation: poll.explanation,
    open_period: poll.openPeriodSeconds,
  });
}

export function pinTelegramMessage(
  chatId: string,
  messageId: number,
): Promise<boolean> {
  return telegramCall("pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

export async function acknowledgeTelegramCallback(
  callbackQueryId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  await telegramCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const file = await telegramCall<{ file_path?: string; file_size?: number }>(
    "getFile",
    { file_id: fileId },
  );
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path.");
  }
  const response = await fetch(
    `https://api.telegram.org/file/bot${getBotToken()}/${file.file_path}`,
    { signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) {
    throw new Error(`Telegram file download failed (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    caption?: string;
    document?: {
      file_id: string;
      file_name?: string;
      file_size?: number;
      mime_type?: string;
    };
    chat: { id: number; type: string; title?: string };
    from?: TelegramUser;
  };
  callback_query?: {
    id: string;
    data?: string;
    from: TelegramUser;
    message?: {
      message_id: number;
      chat: { id: number; type: string };
    };
  };
  poll_answer?: {
    poll_id: string;
    user?: TelegramUser;
    option_ids: number[];
  };
};

export type TelegramBotMessage = TelegramMessage;
