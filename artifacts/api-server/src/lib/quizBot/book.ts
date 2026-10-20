import { asc, inArray, sql } from "drizzle-orm";
import { db, quizBookPagesTable } from "@workspace/db";
import { extractText, getDocumentProxy } from "unpdf";

const MIN_PAGE_CHARS = 20;

function cleanPageText(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map(cleanPageText);
}

export async function saveBookPart(
  pages: string[],
  startPage: number,
): Promise<{ saved: number; empty: number; from: number; to: number }> {
  const rows = pages
    .map((content, index) => ({ pageNumber: startPage + index, content }))
    .filter((row) => row.content.length >= MIN_PAGE_CHARS);

  for (let i = 0; i < rows.length; i += 100) {
    await db
      .insert(quizBookPagesTable)
      .values(rows.slice(i, i + 100))
      .onConflictDoUpdate({
        target: quizBookPagesTable.pageNumber,
        set: { content: sql`excluded.content` },
      });
  }
  return {
    saved: rows.length,
    empty: pages.length - rows.length,
    from: startPage,
    to: startPage + pages.length - 1,
  };
}

export async function getBookStats(): Promise<{
  count: number;
  first: number | null;
  last: number | null;
}> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      first: sql<number | null>`min(${quizBookPagesTable.pageNumber})`,
      last: sql<number | null>`max(${quizBookPagesTable.pageNumber})`,
    })
    .from(quizBookPagesTable);
  return {
    count: row?.count ?? 0,
    first: row?.first ?? null,
    last: row?.last ?? null,
  };
}

export async function clearBook(): Promise<void> {
  await db.delete(quizBookPagesTable);
}

/** "S. 45-47, 52" -> [45, 46, 47, 52] (at most `limit` pages). */
export function parsePageRanges(value: string | null, limit = 12): number[] {
  if (!value) return [];
  const pages: number[] = [];
  const pattern = /(\d{1,4})\s*[-–—]\s*(\d{1,4})|(\d{1,4})/g;
  for (const match of value.matchAll(pattern)) {
    if (match[1] && match[2]) {
      const from = Number(match[1]);
      const to = Number(match[2]);
      for (let page = from; page <= Math.min(to, from + limit); page += 1) {
        pages.push(page);
      }
    } else if (match[3]) {
      pages.push(Number(match[3]));
    }
    if (pages.length >= limit) break;
  }
  return [...new Set(pages)].slice(0, limit);
}

/**
 * Returns the stored text for the pages named in the topic (printed page
 * numbers + offset = PDF page numbers), or null when nothing is available.
 */
export async function getBookExcerpt(
  bookPages: string | null,
  offset: number,
  maxChars = 18_000,
): Promise<{ text: string; pages: number[] } | null> {
  const wanted = parsePageRanges(bookPages).map((page) => page + offset);
  if (wanted.length === 0) return null;

  const rows = await db
    .select()
    .from(quizBookPagesTable)
    .where(inArray(quizBookPagesTable.pageNumber, wanted))
    .orderBy(asc(quizBookPagesTable.pageNumber));
  if (rows.length === 0) return null;

  let text = "";
  const used: number[] = [];
  for (const row of rows) {
    const block = `[PDF page ${row.pageNumber}]\n${row.content}\n\n`;
    if (text.length + block.length > maxChars) break;
    text += block;
    used.push(row.pageNumber);
  }
  return text ? { text: text.trim(), pages: used } : null;
}
