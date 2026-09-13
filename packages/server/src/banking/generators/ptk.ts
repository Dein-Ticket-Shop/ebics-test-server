import type { HacEvent } from '../../store/types.js';

const ACTION_TEXT: Record<string, string> = {
  FILE_UPLOAD: 'Datei-Upload',
  FILE_DOWNLOAD: 'Datei-Download',
  ES_UPLOAD: 'Upload EU',
  ES_DOWNLOAD: 'Download EU',
  ES_VERIFICATION: 'Pruefung EU',
  VEU_FORWARDING: 'Weiterleitung an VEU',
  VEU_VERIFICATION: 'Pruefung VEU',
  VEU_VERIFICATION_END: 'VEU-Pruefung abgeschlossen',
  VEU_CANCEL_ORDER: 'Storno in der VEU',
  ADDITIONAL: 'Zusatzinformation',
  ORDER_HAC_FINAL_POS: 'Auftrag abgeschlossen (positiv)',
  ORDER_HAC_FINAL_NEG: 'Auftrag abgeschlossen (negativ)',
};

const RULE = '='.repeat(78);
const THIN_RULE = '-'.repeat(78);

/** dd.mm.yyyy hh:mm:ss in UTC */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * PTK customer protocol: the HAC ledger as fixed-width German text (CRLF line endings). Clients read it
 * as ISO-8859-1, so the caller encodes it as latin1.
 */
export function generateCustomerProtocolText(
  events: HacEvent[],
  options: { hostId: string; partnerId: string; customerName: string; now?: Date },
): string {
  const lines = [
    'K U N D E N P R O T O K O L L',
    `Host-ID    : ${options.hostId}`,
    `Kunden-ID  : ${options.partnerId}  ${options.customerName}`,
    `Erstellt   : ${formatTimestamp((options.now ?? new Date()).toISOString())} UTC`,
    RULE,
    'Datum      Uhrzeit  Auftragsart Auftrag Teilnehmer Aktion',
    THIN_RULE,
  ];

  for (const event of events) {
    const action = ACTION_TEXT[event.action] ?? event.action;
    lines.push(
      `${formatTimestamp(event.eventAt)} ${event.adminOrderType.padEnd(11)} ${event.orderId.padEnd(7)} ${(event.userId ?? '').padEnd(10)} ${action}${event.reasonCode ? ` (${event.reasonCode})` : ''}`,
    );
    const btf = [event.serviceName, event.scope, event.serviceOption, event.containerType, event.msgName].filter(Boolean);
    if (btf.length > 0) lines.push(`    BTF      : ${btf.join(' / ')}`);
    if (event.orderIdRef) lines.push(`    Bezug    : ${[event.adminOrderTypeRef, event.orderIdRef].filter(Boolean).join(' ')}`);
    for (const info of event.additionalInfo) lines.push(`    ${info}`);
  }

  lines.push(RULE);
  return `${lines.join('\r\n')}\r\n`;
}
