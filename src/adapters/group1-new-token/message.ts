/**
 * The group1 alert body.
 *
 * DISTINGUISHABLE FROM GROUP2 AT A GLANCE. Both land in #newtoken, so the two
 * must not be mistaken for one another. group2's message deliberately has no
 * header -- its first line is the dashboard URL -- so a bold header line here is
 * the cheapest unambiguous difference: if the message starts with bold text it
 * is group1, if it starts with a link it is group2. The Discord embed title
 * differs too, but a title is easy to skim past; the first body line is not.
 *
 * Everything else is group2's renderer, imported rather than copied: the
 * wallet-count sort, the duplicate-symbol asterisks, the singular/plural, the
 * growth suffix and the part splitting are one implementation shared by both,
 * so they cannot drift apart. group2's module is imported, never modified.
 */
import { renderAlert as renderShared, type AlertLine } from '../group2-new-token/message.js';

export type { AlertLine };

/** First line of every group1 message. group2 has no header at all. */
export const HEADER = '**GROUP 1 · bought and held**';

export function renderAlert(
  dashboardUrl: string, lines: AlertLine[],
): { parts: string[]; duplicateSymbols: number } {
  const out = renderShared(dashboardUrl, lines);
  // Header on the FIRST part only: repeating it on a continuation would read as
  // a second alert rather than the rest of this one.
  if (out.parts.length) out.parts[0] = `${HEADER}\n${out.parts[0]}`;
  return out;
}
