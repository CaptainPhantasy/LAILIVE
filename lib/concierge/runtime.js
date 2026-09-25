import { getStore } from './database.js'
import { createGeneration } from './generation.js'
import { createOwnerAuth } from './auth.js'
import { createHandlers } from './handlers.js'

export const conciergeHandlers = createHandlers({ getStore, generation: createGeneration(), requireOwner: createOwnerAuth() })
