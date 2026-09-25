import { streamText } from 'ai';
import { createBoardHandler } from '../lib/board-handler.js';
import { withBoardLead } from '../lib/board-lead.js';
import { getStore } from '../lib/concierge/database.js';
import { createAppGateway } from '../lib/gateway.js';
const gateway = createAppGateway();
const handler=withBoardLead(createBoardHandler({streamText: options => streamText({...options, model: gateway(options.model)})}),getStore);
export default {fetch:handler};
