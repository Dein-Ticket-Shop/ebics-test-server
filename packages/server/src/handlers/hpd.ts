import { create } from 'xmlbuilder2';
import type { HandlerContext } from './handler-types.js';
import type { Subscriber, HostConfig, EbicsStore } from '../store/types.js';
import { EBICS_NS } from '../protocol/constants.js';

export function handleHpd(
  _ctx: HandlerContext,
  _subscriber: Subscriber,
  hostConfig: HostConfig,
  _store: EbicsStore,
): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(EBICS_NS.H005, 'HPDResponseOrderData');

  const access = root.ele(EBICS_NS.H005, 'AccessParams');
  access.ele(EBICS_NS.H005, 'URL').txt('http://localhost:4150/ebics');
  access.ele(EBICS_NS.H005, 'Institute').txt('EBICS Test Server');
  access.ele(EBICS_NS.H005, 'HostID').txt(hostConfig.hostId);

  const protocol = root.ele(EBICS_NS.H005, 'ProtocolParams');
  const version = protocol.ele(EBICS_NS.H005, 'Version');
  version.ele(EBICS_NS.H005, 'Protocol').txt('H005');
  version.ele(EBICS_NS.H005, 'Authentication').txt('X002');
  version.ele(EBICS_NS.H005, 'Encryption').txt('E002');
  version.ele(EBICS_NS.H005, 'Signature').txt('A006');
  protocol.ele(EBICS_NS.H005, 'Recovery').att('supported', 'false');
  protocol.ele(EBICS_NS.H005, 'PreValidation').att('supported', 'false');
  protocol.ele(EBICS_NS.H005, 'ClientDataDownload').att('supported', 'true');
  protocol.ele(EBICS_NS.H005, 'DownloadableOrderData').att('supported', 'true');

  return root.end({ prettyPrint: true });
}
