import type { HandlerContext, HandlerResult } from './handler-types.js';
import { buildHevResponse } from '../protocol/xml-builder.js';
import { xpathString } from '../protocol/xml-parser.js';
import { ReturnCode, getReportText } from '../protocol/return-codes.js';
import { EBICS_VERSION, EBICS_RELEASE } from '../protocol/constants.js';

export function handleHev(ctx: HandlerContext, configuredHostId: string): HandlerResult {
  const requestHostId = xpathString('//hev:HostID/text()', ctx.doc);

  if (!requestHostId || requestHostId !== configuredHostId) {
    return {
      responseXml: buildHevResponse(
        ReturnCode.EBICS_INVALID_HOST_ID,
        getReportText(ReturnCode.EBICS_INVALID_HOST_ID),
        [],
      ),
    };
  }

  return {
    responseXml: buildHevResponse(
      ReturnCode.EBICS_OK,
      getReportText(ReturnCode.EBICS_OK),
      [{ protocol: EBICS_VERSION, release: EBICS_RELEASE }],
    ),
  };
}
