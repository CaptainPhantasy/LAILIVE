import { createAssistantHandlers, createOwnerMailer } from './assistant.js';
import { getDb, getStore } from './concierge/database.js';

export const assistantHandlers = createAssistantHandlers({ getDb, getStore, mail: createOwnerMailer() });
