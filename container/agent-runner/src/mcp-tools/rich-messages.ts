import { extendTool } from './server.js';
let richOffered = false;
export function offerRichMessages(): void {
  if (richOffered) return;
  richOffered = true;
  extendTool('send_message', {
    properties: {
      rich: {
        type: 'boolean',
        description:
          'Telegram only: send as a Rich Message, with real tables, headings, task lists and collapsible <details> blocks (up to 32768 chars). Single line breaks collapse there, so separate lines with a blank line. Leave it off for normal chat; other channels ignore it.',
      },
    },
  });
}

