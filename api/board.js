import { streamText } from 'ai';
import { createBoardHandler } from '../lib/board-handler.js';
import { withBoardLead } from '../lib/board-lead.js';
import { getStore } from '../lib/concierge/database.js';
const handler=withBoardLead(createBoardHandler({streamText}),getStore);
export default {fetch:handler};
